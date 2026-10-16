import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Config } from "./config.js";
import { stackNames, principalKey } from "./config.js";
import { verifyPlan, digest, canonical, type Plan } from "./approval.js";
import { sourceInventory, packageSource, ROOT } from "./source.js";
import { asObject, type Aws } from "./aws.js";
import {
  workspace,
  readJson,
  writeJson,
  withDeploymentLock,
} from "./workspace.js";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type DeploymentState = {
  account: string;
  region: string;
  deploymentId: string;
  sourceDigest: string;
  configurationDigest: string;
  stacks: Record<
    string,
    {
      id: string;
      phase: string;
      templateDigest: string;
      requestParametersDigest: string;
      cloudParametersDigest?: string;
      outputs?: Record<string, string>;
    }
  >;
  buildId?: string;
  buildOutcome?: string;
  pending?: string;
  deletedStacks?: string[];
  cleanupPlanId?: string;
  images?: { sourceDigest: string; runtime: string; app: string };
};
export const outputs = (stack: any) =>
  Object.fromEntries(
    (stack.Outputs ?? []).map((o: any) => [o.OutputKey, o.OutputValue]),
  );
export function loadState(c: Config): DeploymentState {
  const p = join(workspace(c.deploymentId), "state.json");
  const s = existsSync(p)
    ? readJson(p)
    : {
        account: c.account,
        region: c.region,
        deploymentId: c.deploymentId,
        sourceDigest: sourceInventory().digest,
        configurationDigest: digest(canonical(c)),
        stacks: {},
      };
  if (
    s.account !== c.account ||
    s.region !== c.region ||
    s.deploymentId !== c.deploymentId ||
    s.configurationDigest !== digest(canonical(c))
  )
    throw Error(
      "State belongs to another account/region/deployment/configuration; create-only reuse cannot change grants",
    );
  return s;
}
export function save(c: Config, s: DeploymentState) {
  writeJson(join(workspace(c.deploymentId), "state.json"), s);
}
export function ownedStack(
  c: Config,
  s: DeploymentState,
  aws: Aws,
  name: string,
) {
  const row = s.stacks[name];
  if (!row?.id) throw Error("No recorded stack identity");
  const stack = asObject(
    aws.call(["cloudformation", "describe-stacks", "--stack-name", row.id]),
  ).Stacks?.[0];
  if (
    !stack ||
    stack.StackName !== name ||
    stack.StackId !== row.id ||
    !stack.Tags?.some(
      (t: any) =>
        t.Key === "DocIntelDeploymentId" && t.Value === c.deploymentId,
    )
  )
    throw Error("Cloud stack ownership mismatch");
  return stack;
}
async function createStack(
  c: Config,
  s: DeploymentState,
  aws: Aws,
  name: string,
  template: unknown,
  plan: Plan,
  parameters: Record<string, string>,
  wait: (ms: number) => Promise<void>,
) {
  if (s.pending)
    throw Error(
      "Prior outcome is ambiguous; use status and reconcile manually before another write",
    );
  if (s.stacks[name]?.id) {
    const cloud = ownedStack(c, s, aws, name);
    if (cloud.StackStatus !== "CREATE_COMPLETE")
      throw Error("Recorded stack is not complete; no write replay");
    const observed = asObject(
      aws.call([
        "cloudformation",
        "get-template",
        "--stack-name",
        cloud.StackId,
        "--template-stage",
        "Original",
      ]),
    ).TemplateBody;
    const body = typeof observed === "string" ? JSON.parse(observed) : observed;
    if (
      s.stacks[name].templateDigest !== digest(canonical(template)) ||
      s.stacks[name].requestParametersDigest !==
        digest(canonical(parameters)) ||
      digest(canonical(body)) !== digest(canonical(template)) ||
      s.stacks[name].cloudParametersDigest !==
        digest(canonical(cloud.Parameters ?? []))
    )
      throw Error(
        "Recorded stack template/parameters changed; an explicit reviewed migration is required",
      );
    return outputs(cloud);
  }
  const listed = asObject(
    aws.call([
      "cloudformation",
      "list-stacks",
      "--stack-status-filter",
      "CREATE_COMPLETE",
      "CREATE_IN_PROGRESS",
      "UPDATE_COMPLETE",
      "ROLLBACK_COMPLETE",
      "UPDATE_ROLLBACK_COMPLETE",
    ]),
  );
  if (listed.StackSummaries?.some((x: any) => x.StackName === name))
    throw Error(
      "Stack name already exists without this deployment's ownership record",
    );
  const path = join(workspace(c.deploymentId), name + ".template.json");
  writeJson(path, template);
  if (Buffer.byteLength(JSON.stringify(template)) > 51200)
    throw Error(
      "Template exceeds direct CloudFormation size; no implicit template publication",
    );
  s.pending = "create:" + name;
  save(c, s);
  const result = asObject(
    aws.call([
      "cloudformation",
      "create-stack",
      "--stack-name",
      name,
      "--template-body",
      "file://" + path,
      "--capabilities",
      "CAPABILITY_NAMED_IAM",
      "--client-request-token",
      plan.id + "-" + digest(name).slice(0, 8),
      "--tags",
      JSON.stringify([
        { Key: "DocIntelDeploymentId", Value: c.deploymentId },
        { Key: "DocIntelPlanId", Value: plan.id },
      ]),
      ...(Object.keys(parameters).length
        ? [
            "--parameters",
            JSON.stringify(
              Object.entries(parameters).map(
                ([ParameterKey, ParameterValue]) => ({
                  ParameterKey,
                  ParameterValue,
                }),
              ),
            ),
          ]
        : []),
    ]),
  );
  if (!result.StackId)
    throw Error(
      "Stack creation response missing identity; reconcile before retry",
    );
  s.stacks[name] = {
    id: result.StackId,
    phase: plan.phase,
    templateDigest: digest(canonical(template)),
    requestParametersDigest: digest(canonical(parameters)),
  };
  delete s.pending;
  save(c, s);
  for (let n = 0; n < 180; n++) {
    const cloud = ownedStack(c, s, aws, name);
    if (cloud.StackStatus === "CREATE_COMPLETE") {
      const out = outputs(cloud);
      s.stacks[name].outputs = out;
      s.stacks[name].cloudParametersDigest = digest(
        canonical(cloud.Parameters ?? []),
      );
      save(c, s);
      return out;
    }
    if (
      !["CREATE_IN_PROGRESS", "REVIEW_IN_PROGRESS"].includes(cloud.StackStatus)
    )
      throw Error(
        "CloudFormation did not complete; inspect owned stack events",
      );
    await wait(10000);
  }
  throw Error("Stack wait timed out; no write repeated, use status");
}
async function applyPlanLocked(
  c: Config,
  plan: Plan,
  approval: string,
  aws: Aws,
  wait = delay,
) {
  const inventory = sourceInventory();
  verifyPlan(plan, approval, c, inventory.digest);
  const identity = asObject(aws.call(["sts", "get-caller-identity"]));
  if (identity.Account !== c.account) throw Error("AWS account mismatch");
  const s = loadState(c);
  if (s.sourceDigest !== inventory.digest)
    throw Error("Deployment source changed; reconcile old state explicitly");
  const names = stackNames(c);
  if (plan.phase === "build") {
    const out = await createStack(
      c,
      s,
      aws,
      names.build,
      plan.templates[names.build],
      plan,
      {},
      wait,
    );
    if (s.pending) throw Error("Prior operation needs reconciliation");
    if (!s.buildId) {
      const zip = join(
        workspace(c.deploymentId),
        inventory.digest + "-" + randomUUID() + ".zip",
      );
      // Never execute a verifier from an unverified cached archive.
      if (packageSource(zip).digest !== inventory.digest)
        throw Error("Source changed during packaging; do not upload");
      s.pending = "upload-source";
      save(c, s);
      const upload = asObject(
        aws.call([
          "s3api",
          "put-object",
          "--bucket",
          out.SourceBucket,
          "--key",
          `source/${inventory.digest}.zip`,
          "--body",
          zip,
          "--server-side-encryption",
          "AES256",
          "--metadata",
          JSON.stringify({
            sourceDigest: inventory.digest,
            sha256: digest(readFileSync(zip)),
          }),
        ]),
      );
      if (!upload.VersionId)
        throw Error(
          "Expected versioned source object; do not start a mutable build",
        );
      s.pending = "start-build";
      save(c, s);
      const started = asObject(
        aws.call([
          "codebuild",
          "start-build",
          "--project-name",
          out.ProjectName,
          "--source-version",
          upload.VersionId,
          "--idempotency-token",
          plan.id,
        ]),
      );
      if (!started.build?.id)
        throw Error("Build start uncertain; reconcile before another paid job");
      s.buildId = started.build.id;
      delete s.pending;
      save(c, s);
    }
    for (let n = 0; n < 190; n++) {
      const build = asObject(
        aws.call(["codebuild", "batch-get-builds", "--ids", s.buildId!]),
      ).builds?.[0];
      if (!build || build.projectName !== out.ProjectName)
        throw Error("Build ownership mismatch");
      if (build.buildStatus === "SUCCEEDED") {
        const path = join(
          workspace(c.deploymentId),
          "image-result-" + randomUUID() + ".json",
        );
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
        aws.call([
          "s3api",
          "get-object",
          "--bucket",
          out.SourceBucket,
          "--key",
          `results/${inventory.digest}.json`,
          path,
        ]);
        const images = readJson(path);
        if (
          images.sourceDigest !== inventory.digest ||
          !/^sha256:[a-f0-9]{64}$/.test(images.runtime) ||
          (c.mode === "hosted" && !/^sha256:[a-f0-9]{64}$/.test(images.app))
        )
          throw Error("Build result does not match approved source/digests");
        s.images = images;
        s.buildOutcome = "SUCCEEDED";
        save(c, s);
        return s;
      }
      if (build.buildStatus !== "IN_PROGRESS") {
        s.buildOutcome = build.buildStatus;
        save(c, s);
        throw Error("Build failed/stopped; no automatic paid retry");
      }
      await wait(10000);
    }
    throw Error("Build wait expired; status can reconcile the recorded job");
  }
  if (
    plan.phase !== "deploy" ||
    !s.images ||
    canonical(s.images) !== canonical(plan.images)
  )
    throw Error("A matching built-image deployment plan is required");
  if (plan.templates[names.foundation])
    await createStack(
      c,
      s,
      aws,
      names.foundation,
      plan.templates[names.foundation],
      plan,
      {},
      wait,
    );
  const silos: Record<string, unknown> = {};
  for (let i = 0; i < c.principals.length; i++) {
    const subject = c.principals[i].subject;
    const o = await createStack(
      c,
      s,
      aws,
      names.silos[i],
      plan.templates[names.silos[i]],
      plan,
      {
        SiloId: principalKey(subject),
        RuntimeImageRepository: `docintel-${c.deploymentId}-runtime`,
        RuntimeImageDigest: s.images.runtime,
        ApplicationPrincipalArn:
          c.mode === "hosted"
            ? `arn:aws:iam::${c.account}:role/docintel-${c.deploymentId}-application`
            : c.developerCallerArn!,
        BmaModel: c.model,
      },
      wait,
    );
    // Seed only our own new input bucket, with bounded source files; no deployment Lambda.
    const files = [
      "document-analysis/SKILL.md",
      "generate-examine-correct/SKILL.md",
    ];
    for (const file of files)
      aws.call([
        "s3api",
        "put-object",
        "--bucket",
        o.InputsBucket,
        "--key",
        "skills/" + file,
        "--body",
        join(ROOT, "agent/skills", file),
        "--server-side-encryption",
        "AES256",
      ]);
    silos[subject] = {
      region: c.region,
      runtimeArn: o.RuntimeArn,
      roleArn: o.SessionRoleArn,
      applicationRoleArn: o.ApplicationSiloRoleArn,
      inputBucket: o.InputsBucket,
      outputBucket: o.OutputsBucket,
      model: c.model,
    };
  }
  writeJson(join(workspace(c.deploymentId), "silos.json"), silos);
  writeJson(
    join(workspace(c.deploymentId), "acl.json"),
    Object.fromEntries(c.principals.map((p) => [p.subject, p.documents])),
  );
  if (c.mode === "hosted")
    await createStack(
      c,
      s,
      aws,
      names.host,
      plan.templates[names.host],
      plan,
      {},
      wait,
    );
  save(c, s);
  return s;
}

export async function applyPlan(
  c: Config,
  plan: Plan,
  approval: string,
  aws: Aws,
  wait = delay,
) {
  // Bad approval must have no filesystem or AWS side effects.
  verifyPlan(plan, approval, c, sourceInventory().digest);
  return withDeploymentLock(c.deploymentId, () =>
    applyPlanLocked(c, plan, approval, aws, wait),
  );
}
