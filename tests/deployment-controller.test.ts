import { it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Configuration,
  stackNames,
  type Config,
} from "../deployment/config.js";
import { sourceInventory, ROOT } from "../deployment/source.js";
import { canonical, digest, sealPlan } from "../deployment/approval.js";
import {
  workspace,
  writeJson,
  readJson,
  withDeploymentLock,
} from "../deployment/workspace.js";
import { loadState, applyPlan } from "../deployment/apply.js";
import { createPlan } from "../deployment/planner.js";
import { cleanupPlan, cleanup } from "../deployment/cleanup.js";
import { smoke } from "../deployment/smoke.js";
import type { Aws } from "../deployment/aws.js";
const example = JSON.parse(
  readFileSync(join(ROOT, "deploy/config.example.json"), "utf8"),
);
const config = () =>
  Configuration.parse({
    ...example,
    deploymentId: "test-" + Math.random().toString(16).slice(2, 10),
    termsReviewed: true,
  });
function state(c: Config, stacks: Record<string, any>) {
  const s = {
    account: c.account,
    region: c.region,
    deploymentId: c.deploymentId,
    configurationDigest: digest(canonical(c)),
    sourceDigest: sourceInventory().digest,
    stacks,
  };
  writeJson(join(workspace(c.deploymentId), "state.json"), s);
  return s;
}
function cloud(c: Config, name: string, out: Record<string, string> = {}) {
  return {
    StackId: `arn:aws:cloudformation:${c.region}:${c.account}:stack/${name}/owned`,
    StackName: name,
    StackStatus: "CREATE_COMPLETE",
    Parameters: [],
    Tags: [{ Key: "DocIntelDeploymentId", Value: c.deploymentId }],
    Outputs: Object.entries(out).map(([OutputKey, OutputValue]) => ({
      OutputKey,
      OutputValue,
    })),
  };
}
function fixture(c: Config, incomplete = false) {
  const n = stackNames(c),
    rows = new Map<string, any>();
  const runtime = `arn:aws:bedrock-agentcore:${c.region}:${c.account}:runtime/owned_runtime`,
    role = `arn:aws:iam::${c.account}:role/owned-session`;
  for (const name of [n.host, n.silos[0]])
    rows.set(
      name,
      cloud(
        c,
        name,
        name === n.host || incomplete
          ? {}
          : { RuntimeArn: runtime, SessionRoleArn: role },
      ),
    );
  const calls: string[][] = [];
  const deleted: string[] = [];
  const template = {
    Resources: { Owned: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain" } },
  };
  const aws: Aws = {
    call(args) {
      calls.push(args);
      if (args[0] === "sts") return { Account: c.account };
      const key = args[args.indexOf("--stack-name") + 1];
      const row = [...rows.values()].find(
        (r) => r.StackId === key || r.StackName === key,
      );
      if (args[1] === "describe-stacks") return { Stacks: [row] };
      if (args[1] === "list-stack-resources")
        return {
          StackResourceSummaries: [
            {
              LogicalResourceId: "Owned",
              ResourceType: "AWS::S3::Bucket",
              PhysicalResourceId: "owned-bucket",
            },
          ],
        };
      if (args[1] === "get-template")
        return { TemplateBody: structuredClone(template) };
      if (args[1] === "delete-stack") {
        deleted.push(row.StackName);
        return {};
      }
      if (args[1] === "list-stacks")
        return {
          StackSummaries: deleted.map((name) => ({
            StackId: rows.get(name).StackId,
            StackStatus: "DELETE_COMPLETE",
          })),
        };
      throw Error("Unexpected mocked call: " + args[1]);
    },
  };
  state(
    c,
    Object.fromEntries(
      [...rows].map(([name, r]) => [name, { id: r.StackId, phase: "deploy" }]),
    ),
  );
  return { n, rows, calls, deleted, template, aws, runtime, role };
}
const clean = (c: Config) =>
  rmSync(workspace(c.deploymentId), { recursive: true, force: true });
it("configuration changes cannot reuse a deployment identity and preserve revoked grants", () => {
  const c = config();
  try {
    state(c, {});
    expect(() =>
      loadState({
        ...c,
        principals: [{ subject: "replacement", documents: ["acme-2024"] }],
      }),
    ).toThrow("configuration");
  } finally {
    clean(c);
  }
});
it("operation lock serializes cloud and paid smoke mutations", async () => {
  const c = config();
  try {
    await withDeploymentLock(c.deploymentId, async () => {
      await expect(
        withDeploymentLock(c.deploymentId, async () => true),
      ).rejects.toThrow("locked");
    });
    expect(await withDeploymentLock(c.deploymentId, async () => true)).toBe(
      true,
    );
  } finally {
    clean(c);
  }
});
it("a lost CodeBuild start response records uncertainty and never launches a second paid job", async () => {
  const c = config(),
    p = createPlan(c, "build"),
    n = stackNames(c);
  let starts = 0;
  const row = cloud(c, n.build, {
    SourceBucket: "owned-source",
    ProjectName: "owned-builder",
  });
  const aws: Aws = {
    call(a) {
      if (a[0] === "sts") return { Account: c.account };
      if (a[1] === "list-stacks") return { StackSummaries: [] };
      if (a[1] === "create-stack") return { StackId: row.StackId };
      if (a[1] === "describe-stacks") return { Stacks: [row] };
      if (a[1] === "put-object")
        return { VersionId: "immutable-source-version" };
      if (a[1] === "start-build") {
        starts++;
        throw Error("lost reply");
      }
      throw Error("Unexpected mocked call");
    },
  };
  try {
    await expect(applyPlan(c, p, p.id, aws, async () => {})).rejects.toThrow(
      "lost reply",
    );
    expect(loadState(c).pending).toBe("start-build");
    await expect(applyPlan(c, p, p.id, aws, async () => {})).rejects.toThrow(
      "ambiguous",
    );
    expect(starts).toBe(1);
  } finally {
    clean(c);
  }
});
it("cleanup rejects material stack drift before any destructive operation", async () => {
  const c = config(),
    f = fixture(c);
  try {
    const p = cleanupPlan(c, f.aws);
    f.template.Resources.Owned.DeletionPolicy = "Delete";
    await expect(
      cleanup(
        c,
        p,
        p.id,
        f.aws,
        async () => {
          throw Error("No BMA call expected");
        },
        async () => {},
      ),
    ).rejects.toThrow("changed");
    expect(f.deleted).toEqual([]);
  } finally {
    clean(c);
  }
});
it("missing runtime outputs cannot select an unrelated unknown session", async () => {
  const c = config(),
    f = fixture(c, true);
  let calls = 0;
  try {
    const p = cleanupPlan(c, f.aws);
    await expect(
      cleanup(
        c,
        p,
        p.id,
        f.aws,
        async () => {
          calls++;
          return { data: [{ id: "foreign" }], has_more: false };
        },
        async () => {},
      ),
    ).rejects.toThrow("Incomplete owned");
    expect(calls).toBe(0);
    expect(f.deleted).toEqual([]);
  } finally {
    clean(c);
  }
});
it("cleanup quiesces host first and cancels/deletes only a confirmed runtime-role pair", async () => {
  const c = config(),
    f = fixture(c);
  const mutations: string[] = [];
  try {
    const p = cleanupPlan(c, f.aws);
    const bma = async (_c: Config, path: string, method = "GET") => {
      expect(f.deleted[0]).toBe(f.n.host);
      const owned = {
        id: "owned-session",
        role_arn: f.role,
        environment: { runtime_arn: f.runtime },
        status: "idle",
      };
      if (path.includes("?limit"))
        return {
          data: [
            owned,
            {
              id: "foreign",
              role_arn: `arn:aws:iam::${c.account}:role/foreign`,
              environment: {
                runtime_arn: `arn:aws:bedrock-agentcore:${c.region}:${c.account}:runtime/foreign`,
              },
            },
          ],
          has_more: false,
        };
      if (method !== "GET") mutations.push(method + ":" + path);
      return method === "GET" ? owned : {};
    };
    const result = await cleanup(c, p, p.id, f.aws, bma, async () => {});
    expect(result.status).toBe("retained-data-cleanup-complete");
    expect(mutations).toEqual([
      "POST:/openai/v1/agents/sessions/owned-session/events",
      "DELETE:/openai/v1/agents/sessions/owned-session",
    ]);
    expect(f.deleted).toEqual([f.n.host, f.n.silos[0]]);
    expect(readJson(result.manifest).manifests).toEqual(p.templates);
  } finally {
    clean(c);
  }
});
it("a lost cleanup delete response leaves a pending journal and is never replayed", async () => {
  const c = config(),
    f = fixture(c);
  const original = f.aws.call.bind(f.aws);
  let writes = 0;
  try {
    const p = cleanupPlan(c, f.aws);
    f.aws.call = (a) => {
      if (a[1] === "delete-stack") {
        writes++;
        throw Error("lost delete");
      }
      return original(a);
    };
    await expect(
      cleanup(
        c,
        p,
        p.id,
        f.aws,
        async () => ({}),
        async () => {},
      ),
    ).rejects.toThrow("lost delete");
    expect(loadState(c).pending).toBe("delete:" + f.n.host);
    await expect(
      cleanup(
        c,
        p,
        p.id,
        f.aws,
        async () => ({}),
        async () => {},
      ),
    ).rejects.toThrow("ambiguous");
    expect(writes).toBe(1);
  } finally {
    clean(c);
  }
});
it("live-smoke controller reconciles a lost submit by owned request ID without another inference", async () => {
  const c = config(),
    source = sourceInventory().digest,
    p = createPlan(c, "deploy", {
      sourceDigest: source,
      runtime: "sha256:" + "a".repeat(64),
      app: "sha256:" + "b".repeat(64),
    });
  const token =
    "header." +
    Buffer.from(JSON.stringify({ sub: c.principals[0].subject })).toString(
      "base64url",
    ) +
    ".signature";
  let posts = 0,
    requestId = "",
    lost = true;
  const fetcher = (async (input: any, options: any) => {
    const path = new URL(input).pathname;
    if (path === "/api/config")
      return Response.json({
        mode: "bedrock",
        identity: { issuer: c.identity.issuer, audience: c.identity.audience },
      });
    if (path === "/api/documents")
      return Response.json({
        documents: c.principals[0].documents.map((id) => ({ id })),
      });
    if (path === "/api/analyses" && options.method === "POST") {
      posts++;
      requestId = JSON.parse(options.body).requestId;
      if (lost) {
        lost = false;
        throw Error("lost submit");
      }
    }
    if (path === "/api/analyses")
      return Response.json({ analyses: [{ id: "owned-analysis", requestId }] });
    if (path.endsWith("/owned-analysis"))
      return Response.json({ id: "owned-analysis", status: "completed" });
    if (path.includes("/artifacts/"))
      return new Response("synthetic verified contract artifact");
    throw Error("Unexpected mocked API call");
  }) as typeof fetch;
  try {
    await expect(
      smoke(c, p, p.id, token, fetcher, async () => {}),
    ).rejects.toThrow("lost submit");
    const first = readJson(join(workspace(c.deploymentId), "smoke.json"));
    expect(first.requestId).toBe(requestId);
    expect(
      (await smoke(c, p, p.id, token, fetcher, async () => {})).status,
    ).toBe("completed");
    expect(posts).toBe(1);
  } finally {
    clean(c);
  }
});
