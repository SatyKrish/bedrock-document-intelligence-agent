import { it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Journal,
  parsePlan,
  sha,
  canonical,
  heartbeat,
  admission,
  deadlines,
  bindLedger,
  watchdogLease,
  provisionNetwork,
  cleanupNetwork,
  type Plan,
  type AwsApi,
  type Clock,
} from "../deployment/baseline-control.js";
import {
  collectBaseline,
  correlateTurn,
  runtimeBindings,
  stopOwned,
  restoreModel,
  watchdogCycle,
  worker,
  listItems,
  preflight,
  localSourceHashes,
  type EvidenceIo,
  type ObjectInfo,
} from "../deployment/baseline-live.js";
import {
  baselinePrompts,
  baselineVerificationCommand,
  baselineSkillBytes,
  baselineSkillSha256,
  baselineSkillKey,
} from "../deployment/aws-baseline.js";
function plan() {
  const runtimeArn =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/Reference_Bob-abcd";
  const originalSessionPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OnlySelectedModel",
        Effect: "Allow",
        Action: "bedrock-mantle:CreateInference",
        Resource: "*",
        Condition: {
          StringEquals: { "bedrock-mantle:Model": "openai.gpt-6-luna" },
        },
      },
      {
        Sid: "OnlyOwnedRuntime",
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:StopRuntimeSession",
        ],
        Resource: [runtimeArn, runtimeArn + "/runtime-endpoint/*"],
      },
    ],
  };
  const proposedSessionPolicy = structuredClone(originalSessionPolicy);
  proposedSessionPolicy.Statement[0].Condition!.StringEquals[
    "bedrock-mantle:Model"
  ] = "openai.gpt-5.6-luna";
  const p = {
    version: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    syntheticOnly: true,
    profile: "synthetic",
    account: "123456789012",
    callerRoleName: "approved-role",
    awsCli: "/bin/false",
    awsCliSha256: "a".repeat(64),
    sourceSha256: {},
    receiptDirectory: "/private/tmp/synthetic-receipts",
    ledgerFile: "/private/tmp/synthetic-ledger.json",
    deploymentTag: "Reference",
    vpc: "vpc-11111111",
    privateSubnet: "subnet-11111111",
    privateRouteTable: "rtb-11111111",
    bobSecurityGroup: "sg-11111111",
    azId: "use1-az1",
    publicCidr: "10.88.0.64/26",
    silo: {
      region: "us-east-1",
      runtimeArn,
      roleArn: "arn:aws:iam::123456789012:role/bob-session",
      applicationRoleArn: "arn:aws:iam::123456789012:role/bob-app",
      inputBucket: "bob-input",
      outputBucket: "bob-output",
      model: "openai.gpt-5.6-luna",
    },
    sessionPolicyName: "DocIntelOwnedScope",
    originalSessionPolicy,
    proposedSessionPolicy,
    runtimeVersion: "2",
    runtimeExecutionRoleArn: "arn:aws:iam::123456789012:role/bob-runtime",
    inputAccessPointArn:
      "arn:aws:s3files:us-east-1:123456789012:file-system/fs-11111111/access-point/fsap-11111111",
    outputAccessPointArn:
      "arn:aws:s3files:us-east-1:123456789012:file-system/fs-22222222/access-point/fsap-22222222",
    imageRepository: "reference/bob",
    imageTag: "qualified",
    imageDigest: "sha256:" + "a".repeat(64),
    cumulativeBudgetUsd: 15,
    limits: {
      setupMinutes: 45,
      testMinutes: 20,
      computeStopMinutes: 30,
      cleanupStartMinutes: 90,
      cleanupDeadlineMinutes: 120,
    },
  };
  const bytes = Buffer.from(JSON.stringify(p));
  return parsePlan(bytes, sha(bytes)).plan;
}
class FakeClock implements Clock {
  at = Date.now();
  now = () => this.at;
  sleep = async (ms: number) => {
    this.at += ms;
  };
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "docintel-baseline-test-"));
  const j = new Journal(join(folder, "receipts"));
  const p = plan();
  p.receiptDirectory = j.directory;
  p.ledgerFile = join(dirname(j.directory), "ledger.json");
  const c = new FakeClock();
  j.put("identity", { digest: "fixture" });
  j.put("armed", { planSha256: "fixture", startedAt: c.now() });
  heartbeat(j, c.now());
  return {
    folder,
    j,
    p,
    c,
    close: () => rmSync(folder, { recursive: true, force: true }),
  };
}
const sid = "bma-agentcore-" + "1".repeat(32);
class FakeAws implements AwsApi {
  calls: Array<{ service: string; op: string; input: any }> = [];
  p: Plan;
  c: FakeClock;
  policy: any;
  subnets: any[] = [];
  nats: any[] = [];
  eips: any[] = [];
  igws: any[] = [];
  tables: any[] = [];
  rules: any[] = [];
  logs: any[] = [];
  logError = false;
  privateRoutes: any[] = [
    { DestinationCidrBlock: "10.88.0.0/24", GatewayId: "local" },
  ];
  constructor(p: Plan, c: FakeClock) {
    this.p = p;
    this.c = c;
    this.policy = structuredClone(p.originalSessionPolicy);
  }
  fresh() {
    return [
      { Key: "DocIntelDeployment", Value: this.p.deploymentTag },
      { Key: "DocIntelRunId", Value: this.p.runId },
      { Key: "Owner", Value: "bob" },
    ];
  }
  async call(service: string, op: string, input: any): Promise<any> {
    this.calls.push({ service, op, input: structuredClone(input) });
    const p = this.p,
      Tags = this.fresh();
    switch (op) {
      case "get-caller-identity":
        return {
          Account: p.account,
          Arn: `arn:aws:sts::${p.account}:assumed-role/${p.callerRoleName}/synthetic`,
        };
      case "describe-vpcs":
        return {
          Vpcs: [
            {
              VpcId: p.vpc,
              OwnerId: p.account,
              CidrBlock: "10.88.0.0/24",
              IsDefault: false,
              Tags,
            },
          ],
        };
      case "describe-security-groups":
        return {
          SecurityGroups: [
            {
              GroupId: p.bobSecurityGroup,
              VpcId: p.vpc,
              Tags,
              IpPermissionsEgress: [],
            },
          ],
        };
      case "describe-tags":
        return { Tags: [] };
      case "describe-subnets":
        return {
          Subnets:
            input.SubnetIds && input.SubnetIds[0] !== p.privateSubnet
              ? this.subnets.filter((v) => input.SubnetIds.includes(v.SubnetId))
              : input.SubnetIds
                ? [
                    {
                      SubnetId: p.privateSubnet,
                      VpcId: p.vpc,
                      CidrBlock: "10.88.0.0/26",
                      AvailabilityZoneId: p.azId,
                      MapPublicIpOnLaunch: false,
                      Tags,
                    },
                  ]
                : this.subnets,
        };
      case "get-agent-runtime":
        return {
          agentRuntimeArn: (p.silo as any).runtimeArn,
          status: "READY",
          agentRuntimeVersion: "2",
          roleArn: p.runtimeExecutionRoleArn,
          lifecycleConfiguration: {
            idleRuntimeSessionTimeout: 28800,
            maxLifetime: 28800,
          },
          filesystemConfigurations: [
            { sessionStorage: { mountPath: "/mnt/workspace" } },
            {
              s3FilesAccessPoint: {
                accessPointArn: p.inputAccessPointArn,
                mountPath: "/mnt/bma",
              },
            },
            {
              s3FilesAccessPoint: {
                accessPointArn: p.outputAccessPointArn,
                mountPath: "/mnt/output",
              },
            },
          ],
          environmentVariables: {
            BMA_HOME_DIR: "/mnt/workspace",
            BMA_STATE_DIR: "/mnt/workspace/.bma",
            BMA_CODEX_HOME: "/mnt/workspace/.codex",
            DISABLE_ADOT_OBSERVABILITY: "true",
            AGENT_OBSERVABILITY_ENABLED: "false",
          },
          networkConfiguration: {
            networkModeConfig: {
              subnets: [p.privateSubnet],
              securityGroups: [p.bobSecurityGroup],
            },
          },
          agentRuntimeArtifact: {
            containerConfiguration: {
              containerUri: `${p.account}.dkr.ecr.us-east-1.amazonaws.com/${p.imageRepository}@${p.imageDigest}`,
            },
          },
        };
      case "describe-images":
        return { imageDetails: [{ imageDigest: p.imageDigest }] };
      case "get-file-system":
        return {
          fileSystemId: input.fileSystemId,
          bucket:
            "arn:aws:s3:::bob-" +
            (input.fileSystemId === "fs-11111111" ? "input" : "output"),
          prefix: "",
          status: "available",
          ownerId: p.account,
          tags: [
            { key: "Owner", value: "bob" },
            { key: "DocIntelDeployment", value: p.deploymentTag },
          ],
        };
      case "get-access-point":
        return {
          fileSystemId: input.fileSystemId,
          accessPointArn:
            input.fileSystemId === "fs-11111111"
              ? p.inputAccessPointArn
              : p.outputAccessPointArn,
          status: "available",
          ownerId: p.account,
          rootDirectory: { path: "/" },
          tags: [
            { key: "Owner", value: "bob" },
            { key: "DocIntelDeployment", value: p.deploymentTag },
          ],
        };
      case "get-role-policy":
        return { PolicyDocument: this.policy };
      case "put-role-policy":
        this.policy = JSON.parse(input.PolicyDocument);
        return {};
      case "create-subnet": {
        const Subnet = {
          SubnetId: "subnet-22222222",
          VpcId: p.vpc,
          CidrBlock: p.publicCidr,
          MapPublicIpOnLaunch: false,
          Tags,
        };
        this.subnets = [Subnet];
        return { Subnet };
      }
      case "create-internet-gateway": {
        const InternetGateway = {
          InternetGatewayId: "igw-22222222",
          Tags,
          Attachments: [],
        };
        this.igws = [InternetGateway];
        return { InternetGateway };
      }
      case "attach-internet-gateway":
        this.igws[0].Attachments = [{ VpcId: p.vpc }];
        return {};
      case "create-route-table": {
        const RouteTable = {
          RouteTableId: "rtb-22222222",
          VpcId: p.vpc,
          Tags,
          Associations: [],
          Routes: [],
        };
        this.tables = [RouteTable];
        return { RouteTable };
      }
      case "associate-route-table":
        this.tables[0].Associations = [
          {
            RouteTableAssociationId: "rtbassoc-22222222",
            SubnetId: input.SubnetId,
            Main: false,
          },
        ];
        return { AssociationId: "rtbassoc-22222222" };
      case "create-route":
        if (input.RouteTableId === p.privateRouteTable)
          this.privateRoutes.push(input);
        else this.tables[0].Routes.push(input);
        return {};
      case "describe-route-tables":
        return {
          RouteTables:
            input.RouteTableIds &&
            input.RouteTableIds[0] !== p.privateRouteTable
              ? this.tables.filter((v) =>
                  input.RouteTableIds.includes(v.RouteTableId),
                )
              : input.RouteTableIds
                ? [
                    {
                      RouteTableId: p.privateRouteTable,
                      VpcId: p.vpc,
                      Routes: this.privateRoutes,
                      Associations: [{ Main: true }],
                    },
                  ]
                : this.tables,
        };
      case "allocate-address":
        this.eips = [{ AllocationId: "eipalloc-22222222", Tags }];
        return this.eips[0];
      case "create-nat-gateway": {
        const NatGateway = {
          NatGatewayId: "nat-22222222",
          VpcId: p.vpc,
          State: "available",
          Tags,
          NatGatewayAddresses: [{ AllocationId: this.eips[0].AllocationId }],
        };
        this.nats = [NatGateway];
        return { NatGateway };
      }
      case "describe-nat-gateways":
        return { NatGateways: this.nats };
      case "authorize-security-group-egress":
        this.rules = [
          {
            SecurityGroupRuleId: "sgr-22222222",
            GroupId: p.bobSecurityGroup,
            IsEgress: true,
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "0.0.0.0/0",
            Tags,
          },
        ];
        return { SecurityGroupRules: this.rules };
      case "describe-security-group-rules":
        return { SecurityGroupRules: this.rules };
      case "revoke-security-group-egress":
        this.rules = [];
        return {};
      case "delete-route":
        this.privateRoutes = this.privateRoutes.filter(
          (r) => r.DestinationCidrBlock !== input.DestinationCidrBlock,
        );
        return {};
      case "delete-nat-gateway":
        this.nats[0].State = "deleted";
        return {};
      case "describe-addresses":
        return { Addresses: this.eips };
      case "release-address":
        this.eips = [];
        return {};
      case "disassociate-route-table":
        this.tables[0].Associations = [];
        return {};
      case "delete-route-table":
        this.tables = [];
        return {};
      case "delete-subnet":
        this.subnets = [];
        return {};
      case "describe-internet-gateways":
        return {
          InternetGateways: input.Filters?.some(
            (f: any) => f.Name === "attachment.vpc-id",
          )
            ? this.igws.filter((g) => g.Attachments?.length)
            : this.igws,
        };
      case "detach-internet-gateway":
        this.igws[0].Attachments = [];
        return {};
      case "delete-internet-gateway":
        this.igws = [];
        return {};
      case "filter-log-events":
        if (this.logError) throw Error("offline log failure");
        return { events: this.logs };
      case "stop-runtime-session":
        this.logs.push({
          timestamp: this.c.now(),
          eventId: "signal",
          message: JSON.stringify({
            message: "signal",
            signal: 15,
            runtimeSessionId: input.runtimeSessionId,
          }),
        });
        return {};
      default:
        throw Error("Unexpected fake operation " + op);
    }
  }
}
class FakeIo implements EvidenceIo {
  p: Plan;
  c: FakeClock;
  objects = new Map<
    string,
    { bytes: Buffer; etag: string; versionId: string }
  >();
  creates = 0;
  turns = 0;
  stages = 0;
  lostSubmit = false;
  outage = false;
  streamDisconnected = false;
  wrongVersion = false;
  constructor(p: Plan, c: FakeClock) {
    this.p = p;
    this.c = c;
  }
  session() {
    return {
      id: "sess/a?&",
      role_arn: (this.p.silo as any).roleArn,
      environment: {
        id: "env/mock",
        runtime_arn: (this.p.silo as any).runtimeArn,
      },
      status: "idle",
    };
  }
  async bma(method: "GET" | "POST", path: string, body?: any): Promise<any> {
    if (this.outage) throw Error("synthetic BMA outage");
    if (path.startsWith("/openai/v1/agents/sessions?"))
      return { status: 200, body: { data: [], has_more: false } };
    if (method === "POST" && path === "/openai/v1/agents/sessions") {
      this.creates++;
      return { status: 201, requestId: "create-request", body: this.session() };
    }
    if (method === "POST" && path.includes("/events")) {
      if (body.events[0].type === "agent.session.input.cancel")
        return { status: 200, body: {} };
      this.turns++;
      if (this.lostSubmit) throw Error("lost accepted turn response");
      if (this.turns === 2)
        this.objects.set("bob-output/verification.txt", {
          bytes: Buffer.from("BMA_OUTPUT_VERIFIED\n"),
          etag: "output-etag",
          versionId: "output-v1",
        });
      return { status: 202, body: {} };
    }
    if (path.includes("/items?"))
      return { status: 200, body: { data: this.items(), has_more: false } };
    return { status: 200, body: this.session() };
  }
  items() {
    const out: any[] = [];
    for (let step = 0; step < this.turns; step++) {
      const turn_id = "turn-" + step;
      out.push({
        id: "user-" + step,
        role: "user",
        turn_id,
        content: [{ type: "input_text", text: baselinePrompts[step] }],
      });
      const cmd = (id: string, command: string, output: string) => ({
        id,
        type: "command_execution",
        turn_id,
        command,
        output,
        exit_code: 0,
      });
      if (step === 0) {
        for (const path of [
          "/mnt/bma/skills/hello-bma/SKILL.md",
          "/mnt/workspace/skills/hello-bma/SKILL.md",
        ])
          out.push(
            cmd(
              "hash-" + path,
              "sha256sum " + path,
              baselineSkillSha256 + "  " + path,
            ),
          );
        out.push(
          cmd(
            "head",
            "cat /mnt/workspace/skills/hello-bma/SKILL.md | head -1",
            "---\n",
          ),
          cmd("list", "ls /mnt/workspace/skills", "hello-bma\n"),
        );
      } else
        out.push(
          cmd("write", baselineVerificationCommand, "BMA_OUTPUT_VERIFIED\n"),
        );
      out.push({
        id: "assistant-" + step,
        turn_id,
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      });
    }
    return out;
  }
  async stream(_path: string, _event: (x: any) => void, signal: AbortSignal) {
    if (!this.streamDisconnected) {
      this.streamDisconnected = true;
      throw Error("synthetic disconnect");
    }
    await new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener("abort", () => r(), { once: true });
    });
  }
  async head(bucket: string, key: string) {
    const v = this.objects.get(bucket + "/" + key);
    return v
      ? { contentLength: v.bytes.length, etag: v.etag, versionId: v.versionId }
      : undefined;
  }
  async get(bucket: string, key: string, _head: ObjectInfo) {
    const v = this.objects.get(bucket + "/" + key)!;
    return { ...v, versionId: this.wrongVersion ? "wrong" : v.versionId };
  }
  async stage(bucket: string) {
    this.stages++;
    this.objects.set(bucket + "/" + baselineSkillKey, {
      bytes: baselineSkillBytes,
      etag: "skill-etag",
      versionId: "skill-v1",
    });
    return { etag: "skill-etag", versionId: "skill-v1" };
  }
}
it("requires exact reviewed budget, model-only policy diff and same-account silo", () => {
  const p = plan();
  const bytes = Buffer.from(JSON.stringify(p));
  expect(() => parsePlan(bytes, "wrong")).toThrow();
  for (const mutation of [
    (v: any) => (v.cumulativeBudgetUsd = 5),
    (v: any) =>
      v.proposedSessionPolicy.Statement.push({
        Effect: "Allow",
        Action: "*",
        Resource: "*",
      }),
    (v: any) =>
      (v.silo.roleArn = v.silo.roleArn.replace("123456789012", "999999999999")),
  ]) {
    const v = structuredClone(p);
    mutation(v);
    const b = Buffer.from(JSON.stringify(v));
    expect(() => parsePlan(b, sha(b))).toThrow();
  }
});
it("journals ambiguous writes before action and refuses replay or changed requests", async () => {
  const x = setup();
  try {
    let calls = 0;
    await expect(
      x.j.once("create", { a: 1 }, async () => {
        calls++;
        throw Error("lost");
      }),
    ).rejects.toThrow("uncertain");
    await expect(
      x.j.once("create", { a: 1 }, async () => ++calls),
    ).rejects.toThrow("no automatic replay");
    expect(calls).toBe(1);
    await x.j.once("complete", { a: 1 }, async () => ({ id: "known" }));
    await expect(
      x.j.once("complete", { a: 2 }, async () => ({ id: "other" })),
    ).rejects.toThrow("differs");
  } finally {
    x.close();
  }
});
it("rejects symlink evidence and makes intent ownership exclusive across processes", async () => {
  const x = setup();
  try {
    const target = join(x.folder, "unrelated");
    writeFileSync(target, "preserve");
    symlinkSync(target, x.j.path("linked"));
    expect(() => x.j.put("linked", {})).toThrow();
    expect(readFileSync(target, "utf8")).toBe("preserve");
    const module = fileURLToPath(
      new URL("../deployment/baseline-control.ts", import.meta.url),
    );
    const source =
      "const {Journal}=await import(process.argv[2]);const j=new Journal(process.argv[1]);try{j.claim('race',{at:123});console.log('winner')}catch{console.log('blocked')}";
    const child = () =>
      new Promise<string>((res, rej) =>
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            source,
            x.j.directory,
            module,
          ],
          { timeout: 10000 },
          (e, stdout) => (e ? rej(e) : res(stdout.trim())),
        ),
      );
    const results = await Promise.all([child(), child()]);
    expect(results.sort()).toEqual(["blocked", "winner"]);
  } finally {
    x.close();
  }
});
it("refuses new work with a stale watchdog, at compute deadline or once cleanup begins", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c);
    x.c.at += 31000;
    await expect(provisionNetwork(x.p, x.j, api, x.c)).rejects.toThrow(
      "Watchdog",
    );
    expect(api.calls).toEqual([]);
    heartbeat(x.j, x.c.now());
    x.j.put("activation", { at: x.c.now() - 30 * 60000 });
    expect(() => admission(x.j, x.p, x.c, "test")).toThrow("deadline");
    expect(deadlines(x.j.read("armed").startedAt, x.p).cleanupEnd).toBe(
      x.j.read("armed").startedAt + 120 * 60000,
    );
    x.j.put("cleanup-requested", { reason: "test" });
    expect(() => admission(x.j, x.p, x.c, "setup")).toThrow("cleanup");
  } finally {
    x.close();
  }
});
it("runs only two serial stock turns, reconciles disconnected SSE and seals same-version S3 evidence", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    api.logs = [
      {
        timestamp: x.c.now(),
        eventId: "owned-start",
        message: JSON.stringify({
          message: "exec_server_start",
          runtimeSessionId: sid,
          environment_id: "env/mock",
        }),
      },
    ];
    const result = await collectBaseline(x.p, x.j, io, api, x.c);
    expect(result.versionId).toBe("output-v1");
    expect(io.creates).toBe(1);
    expect(io.turns).toBe(2);
    expect(io.stages).toBe(1);
    expect(x.j.read("baseline-passed")).toBeDefined();
  } finally {
    x.close();
  }
});
it("does not submit another turn after an ambiguous accepted input and never overwrites old output", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    io.lostSubmit = true;
    await expect(collectBaseline(x.p, x.j, io, api, x.c)).rejects.toThrow(
      "uncertain",
    );
    expect(io.turns).toBe(1);
    expect(x.j.read("turn-0-intent")).toBeDefined();
    expect(x.j.read("turn-1-intent")).toBeUndefined();
  } finally {
    x.close();
  }
  const y = setup();
  try {
    const io = new FakeIo(y.p, y.c);
    io.objects.set("bob-output/verification.txt", {
      bytes: Buffer.from("preserve"),
      etag: "old",
      versionId: "old",
    });
    await expect(
      collectBaseline(y.p, y.j, io, new FakeAws(y.p, y.c), y.c),
    ).rejects.toThrow("exists");
    expect(io.stages).toBe(0);
    expect(io.creates).toBe(0);
  } finally {
    y.close();
  }
});
it("correlates actual fresh user turn IDs, rejects extra inputs and bounds cursor loops", async () => {
  const rows = [
    { id: "old", role: "user", turn_id: "old", content: baselinePrompts[0] },
    {
      id: "new",
      role: "user",
      turn_id: "turn/new?",
      content: baselinePrompts[0],
    },
    { id: "cmd", turn_id: "turn/new?", type: "command_execution" },
  ];
  expect(
    correlateTurn(rows, new Set(["old"]), baselinePrompts[0])?.items,
  ).toHaveLength(2);
  expect(() =>
    correlateTurn(
      [...rows, { id: "extra", role: "user", content: "other" }],
      new Set(["old"]),
      baselinePrompts[0],
    ),
  ).toThrow("additional");
  const io = {
    bma: async () => ({
      body: { data: [], has_more: true, last_id: "same/cursor" },
      status: 200,
    }),
  };
  await expect(listItems(io, "/session")).rejects.toThrow("looping");
});
it("binds authoritative Runtime IDs to environment logs and stops saved IDs during BMA/log outages", async () => {
  const x = setup();
  try {
    const event = {
      timestamp: x.c.now(),
      eventId: "owned",
      message: JSON.stringify({
        message: "exec_server_start",
        environment_id: "env/mock",
        runtimeSessionId: sid,
      }),
    };
    expect(runtimeBindings([event], "foreign", x.c.now())).toEqual([]);
    const binding = runtimeBindings([event], "env/mock", x.c.now())[0];
    x.j.put("activation", { at: x.c.now() });
    x.j.put("create-session-intent", { request: {}, startedAt: x.c.now() });
    x.j.put("session", { id: "owned", environmentId: "env/mock" });
    x.j.put("runtime-" + sha(sid).slice(0, 32), {
      ...binding,
      environmentId: "env/mock",
      runtimeArn: (x.p.silo as any).runtimeArn,
    });
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    api.logError = true;
    io.outage = true;
    expect(await stopOwned(x.p, x.j, io, api, x.c)).toBe(false);
    expect(
      api.calls.filter((c) => c.op === "stop-runtime-session"),
    ).toHaveLength(1);
    expect(
      api.calls.find((c) => c.op === "stop-runtime-session")!.input
        .runtimeSessionId,
    ).toBe(sid);
  } finally {
    x.close();
  }
});
it("requires delayed SIGTERM/no-restart evidence rather than accepting a Stop ACK", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    x.j.put("activation", { at: x.c.now() });
    x.j.put("create-session-intent", { request: {} });
    x.j.put("session", { id: "sess/a?&", environmentId: "env/mock" });
    api.logs = [
      {
        timestamp: x.c.now(),
        eventId: "start",
        message: JSON.stringify({
          message: "exec_server_start",
          environment_id: "env/mock",
          runtimeSessionId: sid,
        }),
      },
    ];
    expect(await stopOwned(x.p, x.j, io, api, x.c)).toBe(false);
    x.c.at += 31000;
    expect(await stopOwned(x.p, x.j, io, api, x.c)).toBe(true);
  } finally {
    x.close();
  }
});
it("cleans only fresh owned network and restores only the exact selected-model policy", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c);
    await provisionNetwork(x.p, x.j, api, x.c);
    expect(
      api.calls.find((c) => c.op === "create-nat-gateway")?.input
        .AvailabilityMode,
    ).toBe("zonal");
    await cleanupNetwork(x.p, x.j, api, x.c);
    await cleanupNetwork(x.p, x.j, api, x.c);
    expect(api.eips).toEqual([]);
    expect(api.subnets).toEqual([]);
    expect(api.igws).toEqual([]);
    expect(api.rules).toEqual([]);
    expect(api.privateRoutes).toHaveLength(1);
    expect(
      api.calls.some((c) =>
        [
          "delete-vpc",
          "delete-security-group",
          "delete-file-system",
          "delete-bucket",
        ].includes(c.op),
      ),
    ).toBe(false);
    x.j.put("session-policy-intent", { request: {} });
    api.policy = structuredClone(x.p.proposedSessionPolicy);
    await restoreModel(x.p, x.j, api);
    expect(canonical(api.policy)).toBe(canonical(x.p.originalSessionPolicy));
    api.policy = { unexpected: "foreign-policy" };
    await expect(restoreModel(x.p, x.j, api)).rejects.toThrow("drift");
  } finally {
    x.close();
  }
});
it("preserves a foreign default route and refuses released EIP before NAT deletion", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c);
    await provisionNetwork(x.p, x.j, api, x.c);
    api.privateRoutes = [
      { DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-ffffffff" },
    ];
    const failures = await cleanupNetwork(x.p, x.j, api, x.c);
    expect(failures.some((f) => f.startsWith("nat-"))).toBe(true);
    expect(
      api.calls.some(
        (c) => c.op === "delete-route" || c.op === "release-address",
      ),
    ).toBe(false);
  } finally {
    x.close();
  }
});
it("watchdog closes admission and records a deadline breach even when API cleanup fails", async () => {
  const x = setup();
  try {
    x.c.at += 121 * 60000;
    const api = new FakeAws(x.p, x.c);
    const original = api.call.bind(api);
    api.call = async (s, o, i) => {
      if (o === "get-caller-identity") return original(s, o, i);
      throw Error("simulated API outage");
    };
    const result = await watchdogCycle(
      x.p,
      x.j,
      new FakeIo(x.p, x.c),
      api,
      x.c,
    );
    expect(result).toBe(false);
    expect(x.j.read("cleanup-started")).toBeDefined();
    expect(x.j.read("cleanup-deadline-breach")).toBeDefined();
    expect(() => admission(x.j, x.p, x.c, "test")).toThrow();
  } finally {
    x.close();
  }
});
it("worker is single-use and failed preflight schedules cleanup before any paid step", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c);
    api.call = async () => {
      throw Error("preflight failure");
    };
    const io = new FakeIo(x.p, x.c);
    await expect(worker(x.p, x.j, io, api, x.c)).rejects.toThrow();
    expect(x.j.read("cleanup-requested")).toBeDefined();
    await expect(worker(x.p, x.j, io, api, x.c)).rejects.toThrow(
      "already initialized",
    );
    expect(io.creates).toBe(0);
    expect(io.stages).toBe(0);
  } finally {
    x.close();
  }
});

it("binds the canonical receipt directory to an independent durable ledger and rejects missing initialized state", () => {
  const folder = mkdtempSync(join(tmpdir(), "docintel-ledger-test-"));
  try {
    const j = new Journal(join(folder, "receipts")),
      p = plan();
    p.receiptDirectory = j.directory;
    p.ledgerFile = join(dirname(j.directory), "ledger.json");
    const digest = sha(canonical(p));
    bindLedger(p, digest, j, true);
    expect(() => bindLedger(p, digest, j, false)).not.toThrow();
    const other = new Journal(join(folder, "other"));
    expect(() => bindLedger(p, digest, other, true)).toThrow("location");
    rmSync(j.path("run-identity"));
    expect(() => bindLedger(p, digest, j, true)).toThrow("missing/replaced");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it("recovers expired watchdog ownership without allowing an old process to renew or remove the new lease", () => {
  const x = setup();
  try {
    const a = watchdogLease(x.j, x.c.now);
    expect(() => watchdogLease(x.j, x.c.now)).toThrow("held");
    x.c.at += 61000;
    const b = watchdogLease(x.j, x.c.now);
    expect(() => a.renew()).toThrow("lost");
    a.release();
    expect(() => b.renew()).not.toThrow();
    b.release();
  } finally {
    x.close();
  }
});
it("preflight binds full ECR identity, Runtime version/role, exact mounts and real bucket/AP ownership", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    await expect(preflight(x.p, x.j, api, io, x.c)).resolves.toBeUndefined();
  } finally {
    x.close();
  }
  for (const mutation of [
    (v: any) =>
      (v.agentRuntimeArtifact.containerConfiguration.containerUri =
        v.agentRuntimeArtifact.containerConfiguration.containerUri.replace(
          "123456789012",
          "999999999999",
        )),
    (v: any) => (v.roleArn = "arn:aws:iam::123456789012:role/alice-runtime"),
    (v: any) =>
      (v.filesystemConfigurations[1].s3FilesAccessPoint.accessPointArn =
        v.filesystemConfigurations[2].s3FilesAccessPoint.accessPointArn),
  ]) {
    const y = setup();
    try {
      const api = new FakeAws(y.p, y.c),
        original = api.call.bind(api);
      api.call = async (s, o, i) => {
        const v = await original(s, o, i);
        if (o === "get-agent-runtime") mutation(v);
        return v;
      };
      await expect(
        preflight(y.p, y.j, api, new FakeIo(y.p, y.c), y.c),
      ).rejects.toThrow();
      expect(api.calls.some((c) => c.op === "create-subnet")).toBe(false);
    } finally {
      y.close();
    }
  }
  const y = setup();
  try {
    const api = new FakeAws(y.p, y.c),
      original = api.call.bind(api);
    api.call = async (s, o, i) => {
      const v = await original(s, o, i);
      if (o === "get-file-system") v.bucket = "arn:aws:s3:::alice-input";
      return v;
    };
    await expect(
      preflight(y.p, y.j, api, new FakeIo(y.p, y.c), y.c),
    ).rejects.toThrow("binding");
  } finally {
    y.close();
  }
});
it("fails closed on malformed cleanup envelopes and invalid persisted clock entries", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c);
    api.call = async () => ({});
    await expect(cleanupNetwork(x.p, x.j, api, x.c)).rejects.toThrow(
      "inventory envelope",
    );
    writeFileSync(x.j.path("armed"), JSON.stringify({ planSha256: "fixture" }));
    expect(() => admission(x.j, x.p, x.c, "test")).toThrow();
  } finally {
    x.close();
  }
});
it("completes the full synthetic worker then independently removes only owned network and restores model policy", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    api.logs = [
      {
        timestamp: x.c.now(),
        eventId: "start",
        message: JSON.stringify({
          message: "exec_server_start",
          environment_id: "env/mock",
          runtimeSessionId: sid,
        }),
      },
    ];
    await worker(x.p, x.j, io, api, x.c);
    expect(io.turns).toBe(2);
    expect(x.j.read("cleanup-requested")).toBeDefined();
    expect(await watchdogCycle(x.p, x.j, io, api, x.c)).toBe(false);
    x.c.at += 31000;
    expect(await watchdogCycle(x.p, x.j, io, api, x.c)).toBe(true);
    expect(x.j.read("cleanup-completed")).toBeDefined();
    expect(canonical(api.policy)).toBe(canonical(x.p.originalSessionPolicy));
  } finally {
    x.close();
  }
});
it("the twenty-minute test deadline prevents a second input while a first turn remains in progress", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    io.items = () => [];
    x.c.sleep = async () => {
      x.c.at += 60000;
      heartbeat(x.j, x.c.now());
    };
    await expect(collectBaseline(x.p, x.j, io, api, x.c)).rejects.toThrow(
      "deadline",
    );
    expect(io.turns).toBe(1);
    expect(x.j.read("turn-1-intent")).toBeUndefined();
  } finally {
    x.close();
  }
});
it("CLI check mode validates the sealed local inputs without arming or executing AWS, and live mode requires approval", async () => {
  const x = setup();
  try {
    const p = plan();
    p.sourceSha256 = localSourceHashes();
    p.awsCli = join(x.folder, "mock-aws-cli");
    writeFileSync(p.awsCli, "LOCAL CHECK ONLY - NOT EXECUTABLE");
    p.awsCliSha256 = sha(readFileSync(p.awsCli));
    const file = join(x.folder, "plan.json"),
      bytes = Buffer.from(JSON.stringify(p));
    writeFileSync(file, bytes);
    const script = fileURLToPath(
      new URL("../deployment/baseline-live.ts", import.meta.url),
    );
    const child = (mode: string) =>
      new Promise<{ code: number | null; out: string }>((res) =>
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            script,
            mode,
            "--plan",
            file,
            "--approval",
            sha(bytes),
          ],
          { timeout: 10000, env: { ...process.env, LIVE_AWS_CALLS: "" } },
          (e, out) => res({ code: e ? (e as any).code : 0, out }),
        ),
      );
    const checked = await child("check");
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.out)).toMatchObject({
      awsCalls: 0,
      modelCalls: 0,
      cumulativeBudgetUsd: 15,
    });
    expect((await child("execute")).code).not.toBe(0);
  } finally {
    x.close();
  }
});

it("rechecks the twenty-minute deadline after awaited reads and immediately before a second POST", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    api.logs = [
      {
        timestamp: x.c.now(),
        eventId: "start",
        message: JSON.stringify({
          message: "exec_server_start",
          runtimeSessionId: sid,
          environment_id: "env/mock",
        }),
      },
    ];
    const original = io.bma.bind(io);
    let afterFirst = 0;
    io.bma = async (m, path, b) => {
      const result = await original(m, path, b);
      if (
        m === "GET" &&
        path.includes("/items?") &&
        io.turns === 1 &&
        ++afterFirst === 2
      ) {
        x.c.at = x.j.read("activation").at + 20 * 60000 + 1000;
        heartbeat(x.j, x.c.now());
      }
      return result;
    };
    await expect(collectBaseline(x.p, x.j, io, api, x.c)).rejects.toThrow(
      "deadline",
    );
    expect(io.turns).toBe(1);
    expect(x.j.read("turn-1-result")).toBeUndefined();
  } finally {
    x.close();
  }
});

it("keeps cleanup pending for in-flight writes and for known IDs hidden from tag-filter inventory", async () => {
  const x = setup();
  try {
    const api = new FakeAws(x.p, x.c),
      io = new FakeIo(x.p, x.c);
    x.j.put("cleanup-requested", { reason: "test" });
    x.j.claim("eip-intent", { request: {}, startedAt: x.c.now() });
    expect(await watchdogCycle(x.p, x.j, io, api, x.c)).toBe(false);
    expect(x.j.read("cleanup-completed")).toBeUndefined();
  } finally {
    x.close();
  }
  const y = setup();
  try {
    const api = new FakeAws(y.p, y.c),
      io = new FakeIo(y.p, y.c);
    y.j.put("cleanup-requested", { reason: "test" });
    y.j.put("eip-result", { value: { AllocationId: "eipalloc-hidden" } });
    const original = api.call.bind(api);
    api.call = async (s, o, i) =>
      o === "describe-addresses" && i.AllocationIds
        ? { Addresses: [{ AllocationId: "eipalloc-hidden" }] }
        : original(s, o, i);
    expect(await watchdogCycle(y.p, y.j, io, api, y.c)).toBe(false);
    expect(y.j.read("cleanup-completed")).toBeUndefined();
  } finally {
    y.close();
  }
});

it("does not mistake pre-delete eventual NotFound/empty reads for completed cleanup", async () => {
  for (const missing of ["notfound", "empty"]) {
    const x = setup();
    try {
      const api = new FakeAws(x.p, x.c),
        io = new FakeIo(x.p, x.c);
      x.j.put("cleanup-requested", { reason: "test" });
      x.j.put("eip-intent", { request: {} });
      x.j.put("eip-result", { value: { AllocationId: "eipalloc-delayed" } });
      const original = api.call.bind(api);
      api.call = async (s, o, i) => {
        if (o === "describe-addresses" && i.AllocationIds) {
          if (missing === "notfound")
            throw Object.assign(Error("synthetic eventual absence"), {
              code: "InvalidAllocationID.NotFound",
            });
          return { Addresses: [] };
        }
        return original(s, o, i);
      };
      expect(await watchdogCycle(x.p, x.j, io, api, x.c)).toBe(false);
      expect(api.calls.some((v) => v.op === "release-address")).toBe(false);
      expect(x.j.read("cleanup-completed")).toBeUndefined();
    } finally {
      x.close();
    }
  }
});
