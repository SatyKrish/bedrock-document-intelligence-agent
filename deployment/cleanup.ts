import { join } from "node:path";
import type { Config } from "./config.js";
import { stackNames } from "./config.js";
import { canonical, sealPlan, verifyPlan, type Plan } from "./approval.js";
import { sourceInventory } from "./source.js";
import { workspace, writeJson, withDeploymentLock } from "./workspace.js";
import { asObject, type Aws } from "./aws.js";
import {
  loadState,
  ownedStack,
  outputs,
  save,
  type DeploymentState,
} from "./apply.js";
import { signedRead } from "./preflight.js";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Ignore transient timestamps/statuses but pin every material resource, parameter and template.
export function stackManifest(
  c: Config,
  s: DeploymentState,
  aws: Aws,
  name: string,
) {
  const stack = ownedStack(c, s, aws, name);
  if (
    !/^(CREATE_COMPLETE|ROLLBACK_COMPLETE|CREATE_FAILED|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|UPDATE_ROLLBACK_FAILED|DELETE_FAILED)$/.test(
      stack.StackStatus,
    )
  )
    throw Error(
      "Stack is changing; wait for a stable owned stack before cleanup",
    );
  const summaries = asObject(
    aws.call([
      "cloudformation",
      "list-stack-resources",
      "--stack-name",
      stack.StackId,
    ]),
  ).StackResourceSummaries;
  if (!Array.isArray(summaries))
    throw Error("Unknown CloudFormation resource shape");
  const resources = summaries
    .map((r: any) => ({
      logicalId: r.LogicalResourceId,
      physicalId: r.PhysicalResourceId ?? null,
      type: r.ResourceType,
    }))
    .sort((a: any, b: any) => a.logicalId.localeCompare(b.logicalId));
  if (resources.some((r: any) => !r.logicalId || !r.type))
    throw Error("Incomplete CloudFormation resource identity");
  const original = asObject(
    aws.call([
      "cloudformation",
      "get-template",
      "--stack-name",
      stack.StackId,
      "--template-stage",
      "Original",
    ]),
  ).TemplateBody;
  const template =
    typeof original === "string" ? JSON.parse(original) : original;
  if (!template || typeof template !== "object")
    throw Error("Missing original CloudFormation template");
  return {
    stackId: stack.StackId,
    outputs: outputs(stack),
    parameters: (stack.Parameters ?? [])
      .slice()
      .sort((a: any, b: any) => a.ParameterKey.localeCompare(b.ParameterKey)),
    resources,
    template,
  };
}
export function cleanupPlan(c: Config, aws: Aws): Plan {
  const s = loadState(c);
  if (s.pending) throw Error("Reconcile ambiguous operation before cleanup");
  const manifests: Record<string, unknown> = {};
  for (const name of Object.keys(s.stacks)) {
    if (s.deletedStacks?.includes(name)) continue;
    manifests[name] = stackManifest(c, s, aws, name);
  }
  const createdAt = new Date().toISOString();
  return sealPlan({
    version: 1,
    phase: "cleanup",
    configuration: c,
    sourceDigest: sourceInventory().digest,
    templates: manifests,
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    retainData: true,
    costAllowanceUsd: c.costAllowanceUsd,
  });
}
async function cleanupLocked(
  c: Config,
  plan: Plan,
  approval: string,
  aws: Aws,
  bma: typeof signedRead,
  wait: typeof delay,
  developerQuiesced: boolean,
) {
  verifyPlan(plan, approval, c, sourceInventory().digest);
  if (plan.phase !== "cleanup")
    throw Error("Exact retain-cleanup plan is required");
  if (asObject(aws.call(["sts", "get-caller-identity"])).Account !== c.account)
    throw Error("Cleanup account mismatch");
  const s = loadState(c),
    names = stackNames(c);
  if (s.pending) throw Error("Reconcile ambiguous operation before cleanup");
  if (c.mode === "developer" && !developerQuiesced)
    throw Error(
      "Stop all local UI/API/MCP processes and pass --quiesced; cleanup cannot stop developer processes remotely",
    );
  const alive = Object.keys(s.stacks).filter(
    (name) => !s.deletedStacks?.includes(name),
  );
  if (
    canonical(alive.slice().sort()) !==
    canonical(
      Object.keys(plan.templates)
        .filter((name) => !s.deletedStacks?.includes(name))
        .sort(),
    )
  )
    throw Error("Cleanup stack inventory changed");
  const assertSnapshot = (name: string) => {
    if (
      canonical(stackManifest(c, s, aws, name)) !==
      canonical(plan.templates[name])
    )
      throw Error(
        "Cleanup template, parameters, outputs or resource identities changed; review a new plan",
      );
  };
  for (const name of alive) assertSnapshot(name);
  // Validate before ANY destruction/listing. Missing outputs can never make undefined match undefined.
  const runtimeRoles = new Map<string, string>();
  for (const name of names.silos) {
    if (!alive.includes(name)) continue;
    const o = (plan.templates[name] as any).outputs;
    if (
      !o ||
      !new RegExp(
        `^arn:aws:bedrock-agentcore:${c.region}:${c.account}:runtime/[A-Za-z0-9_-]+$`,
      ).test(o.RuntimeArn ?? "") ||
      !new RegExp(`^arn:aws:iam::${c.account}:role/[A-Za-z0-9+=,.@_/-]+$`).test(
        o.SessionRoleArn ?? "",
      )
    )
      throw Error(
        "Incomplete owned runtime/session-role outputs; cleanup halted before mutations",
      );
    if (
      runtimeRoles.has(o.RuntimeArn) ||
      [...runtimeRoles.values()].includes(o.SessionRoleArn)
    )
      throw Error("Nonexclusive runtime ownership metadata");
    runtimeRoles.set(o.RuntimeArn, o.SessionRoleArn);
  }
  const manifestPath = join(
    workspace(c.deploymentId),
    "retained-resource-manifest.json",
  );
  writeJson(manifestPath, {
    planId: plan.id,
    account: c.account,
    region: c.region,
    manifests: plan.templates,
    notice:
      "Data buckets/filesystems/APs/backing roles, state EBS, source bucket/images/logs retain by default and continue charging. No data purge.",
  });
  s.cleanupPlanId = plan.id;
  save(c, s);
  const deleteStack = async (name: string) => {
    if (!s.stacks[name] || s.deletedStacks?.includes(name)) return;
    assertSnapshot(name); // Recheck immediately before destructive write.
    const id = s.stacks[name].id;
    s.pending = "delete:" + name;
    save(c, s);
    aws.call([
      "cloudformation",
      "delete-stack",
      "--stack-name",
      id,
      "--client-request-token",
      plan.id + "-" + name.slice(-20),
    ]);
    // Pending remains until read-only deletion confirmation. A lost response never repeats the write.
    for (let n = 0; n < 180; n++) {
      const row = asObject(
        aws.call([
          "cloudformation",
          "list-stacks",
          "--stack-status-filter",
          "DELETE_COMPLETE",
          "DELETE_IN_PROGRESS",
          "DELETE_FAILED",
        ]),
      ).StackSummaries?.find((x: any) => x.StackId === id);
      if (row?.StackStatus === "DELETE_COMPLETE") {
        s.deletedStacks = [...(s.deletedStacks ?? []), name];
        delete s.pending;
        save(c, s);
        return;
      }
      if (row?.StackStatus === "DELETE_FAILED")
        throw Error(
          "Owned stack deletion failed; reconcile exact recorded deletion before continuing",
        );
      await wait(10000);
    }
    throw Error(
      "Deletion wait timed out; reconcile the recorded delete without replay",
    );
  };
  // Quiesce admission first, then enumerate/cancel sessions. Developer mode requires the operator's stop assertion.
  await deleteStack(names.host);
  const sessions: any[] = [];
  let after: string | undefined;
  for (let page = 0; runtimeRoles.size && page < 100; page++) {
    const response = await bma(
      c,
      "/openai/v1/agents/sessions?limit=20&order=asc" +
        (after ? "&after=" + encodeURIComponent(after) : ""),
    );
    if (!Array.isArray(response.data) || typeof response.has_more !== "boolean")
      throw Error("Unknown session-list shape; cleanup halted");
    for (const a of response.data) {
      const runtime = a?.environment?.runtime_arn,
        role = a?.role_arn;
      if (
        typeof a?.id !== "string" ||
        !a.id ||
        a.id.length > 512 ||
        /[\x00-\x1f\x7f]/.test(a.id) ||
        typeof role !== "string" ||
        !/^arn:aws:iam::\d{12}:role\//.test(role)
      )
        throw Error("Unknown session ownership shape; cleanup halted");
      if (
        a.environment?.type === "self_hosted" &&
        ![...runtimeRoles.values()].includes(role) &&
        !runtimeRoles.has(runtime)
      )
        continue;
      if (
        typeof runtime !== "string" ||
        !runtime.startsWith("arn:aws:bedrock-agentcore:")
      )
        throw Error("Unknown session environment; cleanup halted");
      if (
        runtimeRoles.has(runtime) ||
        [...runtimeRoles.values()].includes(role)
      ) {
        if (runtimeRoles.get(runtime) !== role)
          throw Error(
            "Session runtime/role ownership mismatch; cleanup halted",
          );
        if (!sessions.some((s) => s.id === a.id)) sessions.push(a);
      }
    }
    if (!response.has_more) break;
    if (
      typeof response.last_id !== "string" ||
      !response.last_id ||
      response.last_id === after ||
      page === 99
    )
      throw Error("Unbounded/invalid session pagination; cleanup halted");
    after = response.last_id;
  }
  for (const a of sessions) {
    const path = "/openai/v1/agents/sessions/" + encodeURIComponent(a.id);
    s.pending = "cancel-session:" + a.id;
    save(c, s);
    await bma(c, path + "/events", "POST", {
      events: [{ type: "agent.session.input.cancel" }],
    });
    let terminal = false;
    for (let n = 0; n < 30; n++) {
      const current = await bma(c, path);
      if (
        current.id !== a.id ||
        current.role_arn !== a.role_arn ||
        current.environment?.runtime_arn !== a.environment.runtime_arn
      )
        throw Error("Session identity changed during cancellation");
      if (["idle", "failed"].includes(current.status)) {
        terminal = true;
        break;
      }
      if (current.status !== "in_progress")
        throw Error("Unknown session status; cancellation unconfirmed");
      await wait(2000);
    }
    if (!terminal)
      throw Error(
        "Managed cancellation unconfirmed; no session/runtime deletion attempted",
      );
    s.pending = "delete-session:" + a.id;
    save(c, s);
    await bma(c, path, "DELETE");
    delete s.pending;
    save(c, s);
  }
  if (s.buildId) {
    const build = asObject(
      aws.call(["codebuild", "batch-get-builds", "--ids", s.buildId]),
    ).builds?.[0];
    if (
      !build ||
      build.projectName !==
        (plan.templates[names.build] as any)?.outputs?.ProjectName
    )
      throw Error("Recorded build ownership cannot be confirmed");
    if (build.buildStatus === "IN_PROGRESS") {
      s.pending = "stop-build:" + s.buildId;
      save(c, s);
      aws.call(["codebuild", "stop-build", "--id", s.buildId]);
      let stopped = false;
      for (let n = 0; n < 60; n++) {
        const b: any = asObject(
          aws.call(["codebuild", "batch-get-builds", "--ids", s.buildId]),
        ).builds?.[0];
        if (b?.id !== s.buildId || b?.projectName !== build.projectName)
          throw Error("Build identity changed during stop");
        if (
          ["STOPPED", "FAILED", "FAULT", "TIMED_OUT", "SUCCEEDED"].includes(
            b.buildStatus,
          )
        ) {
          stopped = true;
          break;
        }
        await wait(2000);
      }
      if (!stopped)
        throw Error("Build stop unconfirmed; builder resources retained");
      delete s.pending;
      save(c, s);
    }
  }
  for (const name of [...names.silos, names.foundation, names.build])
    await deleteStack(name);
  return {
    status: "retained-data-cleanup-complete",
    manifest: manifestPath,
    notice:
      "Retained storage/images/logs remain billable; imported network/certificate/zone/IdP were preserved",
  };
}
export async function cleanup(
  c: Config,
  plan: Plan,
  approval: string,
  aws: Aws,
  bma = signedRead,
  wait = delay,
  developerQuiesced = false,
) {
  verifyPlan(plan, approval, c, sourceInventory().digest);
  return withDeploymentLock(c.deploymentId, () =>
    cleanupLocked(c, plan, approval, aws, bma, wait, developerQuiesced),
  );
}
