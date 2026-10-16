import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { z } from "zod";
import { validateSilos } from "../server/bedrock.js";

const id = (prefix: string) =>
  z.string().regex(new RegExp("^" + prefix + "-[a-f0-9]{8,32}$"));
export const RunPlan = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    syntheticOnly: z.literal(true),
    profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    account: z.string().regex(/^\d{12}$/),
    callerRoleName: z.string().regex(/^[A-Za-z0-9_+=,.@-]{1,128}$/),
    awsCli: z.string().startsWith("/"),
    awsCliSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
    receiptDirectory: z.string().startsWith("/"),
    ledgerFile: z.string().startsWith("/"),
    deploymentTag: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    vpc: id("vpc"),
    privateSubnet: id("subnet"),
    privateRouteTable: id("rtb"),
    bobSecurityGroup: id("sg"),
    azId: z.literal("use1-az1"),
    publicCidr: z.literal("10.88.0.64/26"),
    silo: z.unknown(),
    sessionPolicyName: z.literal("DocIntelOwnedScope"),
    originalSessionPolicy: z.record(z.unknown()),
    proposedSessionPolicy: z.record(z.unknown()),
    runtimeVersion: z.string().regex(/^[1-9][0-9]*$/),
    runtimeExecutionRoleArn: z
      .string()
      .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@\/-]+$/),
    inputAccessPointArn: z
      .string()
      .regex(
        /^arn:aws:s3files:us-east-1:\d{12}:file-system\/fs-[a-f0-9]+\/access-point\/fsap-[a-f0-9]+$/,
      ),
    outputAccessPointArn: z
      .string()
      .regex(
        /^arn:aws:s3files:us-east-1:\d{12}:file-system\/fs-[a-f0-9]+\/access-point\/fsap-[a-f0-9]+$/,
      ),
    imageRepository: z.string().regex(/^[a-z0-9][a-z0-9/_-]+$/),
    imageTag: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    cumulativeBudgetUsd: z.literal(15),
    limits: z
      .object({
        setupMinutes: z.literal(45),
        testMinutes: z.literal(20),
        computeStopMinutes: z.literal(30),
        cleanupStartMinutes: z.literal(90),
        cleanupDeadlineMinutes: z.literal(120),
      })
      .strict(),
  })
  .strict();
export function parsePlan(bytes: Buffer, approval: string) {
  const digest = sha(bytes);
  if (approval !== digest) throw Error("Exact plan SHA256 approval required");
  const plan = RunPlan.parse(JSON.parse(bytes.toString("utf8")));
  const silo = validateSilos({ bob: plan.silo }).bob;
  if (
    resolve(plan.receiptDirectory) !== plan.receiptDirectory ||
    resolve(plan.ledgerFile) !== plan.ledgerFile ||
    plan.ledgerFile === plan.receiptDirectory ||
    plan.ledgerFile.startsWith(plan.receiptDirectory + "/")
  )
    throw Error("Canonical receipts and independent ledger paths required");
  if (
    silo.region !== "us-east-1" ||
    silo.model !== "openai.gpt-5.6-luna" ||
    silo.runtimeArn.split(":")[4] !== plan.account ||
    !silo.runtimeArn.includes("_Bob-")
  )
    throw Error("Only the approved Bob baseline is allowed");
  for (const arn of [
    plan.runtimeExecutionRoleArn,
    plan.inputAccessPointArn,
    plan.outputAccessPointArn,
  ])
    if (arn.split(":")[4] !== plan.account)
      throw Error("Runtime role/AP account mismatch");
  if (plan.inputAccessPointArn === plan.outputAccessPointArn)
    throw Error("Exclusive input/output access points required");
  const old = structuredClone(plan.originalSessionPolicy) as any;
  const statements = old.Statement?.filter(
    (s: any) => s.Sid === "OnlySelectedModel",
  );
  if (
    !Array.isArray(old.Statement) ||
    old.Statement.length !== 2 ||
    statements?.length !== 1 ||
    statements[0].Condition?.StringEquals?.["bedrock-mantle:Model"] !==
      "openai.gpt-6-luna"
  )
    throw Error("Exact prior model condition required");
  statements[0].Condition.StringEquals["bedrock-mantle:Model"] = silo.model;
  if (canonical(old) !== canonical(plan.proposedSessionPolicy))
    throw Error("Only the selected model condition may change");
  const owned = (old.Statement as any[]).find(
    (s: any) => s.Sid === "OnlyOwnedRuntime",
  );
  if (
    canonical(owned?.Resource) !==
    canonical([silo.runtimeArn, silo.runtimeArn + "/runtime-endpoint/*"])
  )
    throw Error("Exact owned Runtime policy required");
  return { plan, silo, digest };
}
export type Plan = z.infer<typeof RunPlan>;
export const canonical = (v: any): string =>
  JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
export const sha = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
const key = (name: string) => {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(name)) throw Error("Invalid journal key");
  return name;
};
export class Journal {
  readonly directory: string;
  constructor(directory: string) {
    // Canonicalize existing parent, then reject all links/hard links below it.
    const input = resolve(directory);
    this.directory = join(
      realpathSync(dirname(input)),
      input.split("/").at(-1)!,
    );
    if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
    const s = lstatSync(this.directory);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077
    )
      throw Error("Private operator-owned journal directory required");
  }
  syncDirectory() {
    const fd = openSync(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  path(name: string) {
    return join(this.directory, key(name) + ".json");
  }
  read(name: string): any {
    const path = this.path(name);
    if (!existsSync(path)) return undefined;
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      s.size > 2 * 1024 * 1024
    )
      throw Error("Unsafe journal entry");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  put(name: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    if (bytes.length > 2 * 1024 * 1024)
      throw Error("Evidence entry exceeds bound");
    const current = this.read(name);
    if (current !== undefined) {
      if (canonical(current) !== canonical(value))
        throw Error("Immutable evidence differs; reconcile without replay");
      return;
    }
    if (
      !name.startsWith("cleanup") &&
      readdirSync(this.directory).length > 3000
    )
      throw Error("Evidence count limit");
    let fd: number;
    try {
      fd = openSync(
        this.path(name),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error: any) {
      if (
        error.code === "EEXIST" &&
        canonical(this.read(name)) === canonical(value)
      )
        return;
      throw error;
    }
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncDirectory();
  }
  claim(name: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    if (bytes.length > 2 * 1024 * 1024) throw Error("Intent exceeds bound");
    const fd = openSync(
      this.path(name),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncDirectory();
  }
  evidence(kind: string, value: unknown) {
    this.put(key(kind) + "-" + sha(canonical(value)).slice(0, 40), value);
  }
  async once<T>(
    name: string,
    request: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.read(name + "-intent");
    if (previous && canonical(previous.request) !== canonical(request))
      throw Error("Write request differs from immutable intent");
    const result = this.read(name + "-result");
    if (result !== undefined) return result.value as T;
    if (this.read(name + "-intent"))
      throw Error("Ambiguous prior write; no automatic replay: " + name);
    this.claim(name + "-intent", { request, startedAt: Date.now() });
    try {
      const value = await action();
      this.put(name + "-result", { value });
      return value;
    } catch {
      this.put(name + "-uncertain", {
        operation: name,
        observedAt: Date.now(),
      });
      throw Error(
        "Write outcome uncertain; reconcile before further work: " + name,
      );
    }
  }
  lock(name: string) {
    const path = this.path(name + "-lock");
    const fd = openSync(path, "wx", 0o600);
    const original = fstatSync(fd);
    return () => {
      closeSync(fd);
      const now = lstatSync(path);
      if (now.ino === original.ino && now.dev === original.dev)
        unlinkSync(path);
    };
  }
}
export function bindLedger(
  p: Plan,
  digest: string,
  j: Journal,
  initialize: boolean,
) {
  if (j.directory !== p.receiptDirectory)
    throw Error("Receipt location differs from approved plan");
  const ledger = p.ledgerFile;
  const parent = realpathSync(dirname(ledger));
  if (parent !== dirname(ledger))
    throw Error("Canonical ledger parent required");
  const info = lstatSync(parent);
  if (info.uid !== process.getuid?.() || info.mode & 0o077)
    throw Error("Private operator-owned ledger parent required");
  const folder = lstatSync(j.directory);
  if (existsSync(ledger)) {
    const stat = lstatSync(ledger);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 8192
    )
      throw Error("Unsafe ledger");
    const value = JSON.parse(readFileSync(ledger, "utf8"));
    const marker = j.read("run-identity");
    if (
      value.digest !== digest ||
      value.runId !== p.runId ||
      value.directory !== j.directory ||
      value.dev !== folder.dev ||
      value.ino !== folder.ino ||
      !marker ||
      marker.nonce !== value.nonce ||
      marker.digest !== digest
    )
      throw Error("Initialized run state missing/replaced; no replay");
    return;
  }
  if (!initialize || readdirSync(j.directory).length)
    throw Error("Ledger missing for initialized evidence; no replay");
  const nonce = randomUUID();
  const value = {
    digest,
    runId: p.runId,
    directory: j.directory,
    dev: folder.dev,
    ino: folder.ino,
    nonce,
  };
  const fd = openSync(
    ledger,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
  j.claim("run-identity", { nonce, digest });
}
export function watchdogLease(j: Journal, now: () => number = Date.now) {
  const path = join(j.directory, "watchdog-lease.sqlite");
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    j.syncDirectory();
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error("Unsafe watchdog lease file");
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires REAL NOT NULL)",
  );
  const token = randomUUID();
  try {
    db.exec("BEGIN IMMEDIATE");
    const old = db
      .prepare("SELECT token,expires FROM lease WHERE id=1")
      .get() as any;
    if (old && (typeof old.expires !== "number" || old.expires > now()))
      throw Error("Watchdog lease already held");
    db.prepare(
      "INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires",
    ).run(token, now() + 60000);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    db.close();
    throw error;
  }
  return {
    renew() {
      const changed = db
        .prepare(
          "UPDATE lease SET expires=? WHERE id=1 AND token=? AND expires>?",
        )
        .run(now() + 60000, token, now());
      if (changed.changes !== 1)
        throw Error("Watchdog lease lost; stop this process");
    },
    release() {
      db.prepare("DELETE FROM lease WHERE id=1 AND token=?").run(token);
      db.close();
    },
  };
}
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const epochAtLoad = Date.now(),
  monotonicAtLoad = performance.now();
export const clock: Clock = {
  now: () => Math.floor(epochAtLoad + performance.now() - monotonicAtLoad),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10000))),
};
export function deadlines(startedAt: number, plan: Plan, activatedAt?: number) {
  return {
    setup: startedAt + plan.limits.setupMinutes * 60000,
    cleanupStart: startedAt + plan.limits.cleanupStartMinutes * 60000,
    cleanupEnd: startedAt + plan.limits.cleanupDeadlineMinutes * 60000,
    computeStop:
      activatedAt === undefined
        ? Infinity
        : activatedAt + plan.limits.computeStopMinutes * 60000,
  };
}
export function admission(
  j: Journal,
  p: Plan,
  c: Clock,
  phase: "setup" | "test",
) {
  const arm = j.read("armed");
  const heartbeat = j.read("watchdog-heartbeat");
  if (
    !arm ||
    !Number.isFinite(arm.startedAt) ||
    !Number.isFinite(heartbeat?.at) ||
    !Number.isFinite(c.now()) ||
    (j.read("activation") && !Number.isFinite(j.read("activation").at)) ||
    arm.planSha256 !== j.read("identity")?.digest ||
    !heartbeat ||
    c.now() - heartbeat.at > 30000 ||
    heartbeat.at > c.now() + 5000 ||
    j.read("cleanup-requested") ||
    j.read("cleanup-started")
  )
    throw Error("Watchdog unavailable or cleanup has started; new work denied");
  const d = deadlines(arm.startedAt, p, j.read("activation")?.at);
  if (
    c.now() >=
    Math.min(phase === "setup" ? d.setup : d.cleanupStart, d.computeStop)
  )
    throw Error("Run deadline reached; new work denied");
}
// Heartbeats are replaceable control state, not immutable evidence. No symlink traversal.
export function heartbeat(j: Journal, at: number) {
  if (!Number.isFinite(at)) throw Error("Invalid heartbeat clock");
  const name = "heartbeat-tmp-" + randomUUID();
  j.claim(name, { at });
  renameSync(j.path(name), j.path("watchdog-heartbeat"));
  j.syncDirectory();
}
export interface AwsApi {
  call(
    service: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<any>;
}
export class OfficialAwsCli implements AwsApi {
  constructor(readonly plan: Plan) {}
  call(service: string, operation: string, input: Record<string, unknown>) {
    return new Promise<any>((resolveCall, reject) =>
      execFile(
        this.plan.awsCli,
        [
          service,
          operation,
          "--cli-input-json",
          JSON.stringify(input),
          "--profile",
          this.plan.profile,
          "--region",
          "us-east-1",
          "--output",
          "json",
          "--no-cli-pager",
          "--cli-connect-timeout",
          "5",
          "--cli-read-timeout",
          "15",
        ],
        {
          timeout: 20000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            AWS_MAX_ATTEMPTS: "1",
            AWS_RETRY_MODE: "standard",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              Object.assign(
                Error("AWS CLI call failed: " + service + " " + operation),
                {
                  code: /An error occurred \(([A-Za-z0-9._-]+)\) when calling/.exec(
                    String(stderr),
                  )?.[1],
                },
              ),
            );
          } else {
            try {
              resolveCall(stdout.trim() ? JSON.parse(stdout) : {});
            } catch {
              reject(Error("Invalid bounded CLI response"));
            }
          }
        },
      ),
    );
  }
}
export function hasTags(resource: any, p: Plan, fresh = false) {
  const tags = Object.fromEntries(
    (resource?.Tags ?? []).map((t: any) => [t.Key, t.Value]),
  );
  return (
    tags.DocIntelDeployment === p.deploymentTag &&
    (!fresh || tags.DocIntelRunId === p.runId)
  );
}
export const tags = (p: Plan, resourceType: string) => [
  {
    ResourceType: resourceType,
    Tags: [
      { Key: "DocIntelDeployment", Value: p.deploymentTag },
      { Key: "DocIntelRunId", Value: p.runId },
      { Key: "Owner", Value: "bob" },
    ],
  },
];
export const freshFilter = (p: Plan) => [
  { Name: "tag:DocIntelRunId", Values: [p.runId] },
  { Name: "tag:DocIntelDeployment", Values: [p.deploymentTag] },
];
export function inventory(value: any, field: string, identifier: string) {
  if (
    !value ||
    !Array.isArray(value[field]) ||
    !value[field].every(
      (v: any) =>
        v &&
        typeof v === "object" &&
        typeof v[identifier] === "string" &&
        v[identifier].length > 0,
    )
  )
    throw Error("Unknown inventory envelope: " + field);
  return value[field] as any[];
}
export async function readIdentity(api: AwsApi, p: Plan) {
  const identity = await api.call("sts", "get-caller-identity", {});
  if (
    identity.Account !== p.account ||
    !String(identity.Arn).startsWith(
      `arn:aws:sts::${p.account}:assumed-role/${p.callerRoleName}/`,
    )
  )
    throw Error("AWS caller differs from approved role/account");
  return identity;
}
export async function provisionNetwork(
  p: Plan,
  j: Journal,
  api: AwsApi,
  c: Clock = clock,
) {
  const write = async (
    name: string,
    op: string,
    input: Record<string, unknown>,
  ) => {
    admission(j, p, c, "setup");
    return j.once(name, { service: "ec2", op, input }, () => {
      admission(j, p, c, "setup");
      return api.call("ec2", op, input);
    });
  };
  const subnet = await write("subnet", "create-subnet", {
    VpcId: p.vpc,
    CidrBlock: p.publicCidr,
    AvailabilityZoneId: p.azId,
    TagSpecifications: tags(p, "subnet"),
  });
  const subnetId = subnet.Subnet.SubnetId;
  const igw = await write("igw", "create-internet-gateway", {
    TagSpecifications: tags(p, "internet-gateway"),
  });
  await write("attach-igw", "attach-internet-gateway", {
    InternetGatewayId: igw.InternetGateway.InternetGatewayId,
    VpcId: p.vpc,
  });
  const rt = await write("public-rt", "create-route-table", {
    VpcId: p.vpc,
    TagSpecifications: tags(p, "route-table"),
  });
  await write("public-route", "create-route", {
    RouteTableId: rt.RouteTable.RouteTableId,
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: igw.InternetGateway.InternetGatewayId,
  });
  await write("public-association", "associate-route-table", {
    RouteTableId: rt.RouteTable.RouteTableId,
    SubnetId: subnetId,
  });
  const eip = await write("eip", "allocate-address", {
    Domain: "vpc",
    TagSpecifications: tags(p, "elastic-ip"),
  });
  const nat = await write("nat", "create-nat-gateway", {
    SubnetId: subnetId,
    AllocationId: eip.AllocationId,
    ConnectivityType: "public",
    AvailabilityMode: "zonal",
    ClientToken: p.runId,
    TagSpecifications: tags(p, "natgateway"),
  });
  while (true) {
    admission(j, p, c, "setup");
    const read = await api.call("ec2", "describe-nat-gateways", {
      NatGatewayIds: [nat.NatGateway.NatGatewayId],
    });
    j.evidence("nat-state", read);
    if (read.NatGateways?.[0]?.State === "available") break;
    if (
      ["failed", "deleted", "deleting"].includes(read.NatGateways?.[0]?.State)
    )
      throw Error("NAT not available");
    await c.sleep(5000);
  }
  // Recheck the shared reference table immediately before create; never replace.
  const current = await api.call("ec2", "describe-route-tables", {
    RouteTableIds: [p.privateRouteTable],
  });
  if (
    current.RouteTables?.length !== 1 ||
    current.RouteTables[0].VpcId !== p.vpc ||
    current.RouteTables[0].Routes.some(
      (r: any) => r.DestinationCidrBlock === "0.0.0.0/0",
    )
  )
    throw Error("Existing private default route; abort without replacement");
  await write("private-route", "create-route", {
    RouteTableId: p.privateRouteTable,
    DestinationCidrBlock: "0.0.0.0/0",
    NatGatewayId: nat.NatGateway.NatGatewayId,
  });
  await write("bob-egress", "authorize-security-group-egress", {
    GroupId: p.bobSecurityGroup,
    IpPermissions: [
      {
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: "0.0.0.0/0" }],
      },
    ],
    TagSpecifications: tags(p, "security-group-rule"),
  });
  return { nat: nat.NatGateway.NatGatewayId };
}

// Cleanup discovers lost create responses by this fresh run's tags. It never adopts
// a pre-existing default route, public network, rule, policy or untagged resource.
export async function cleanupNetwork(
  p: Plan,
  j: Journal,
  api: AwsApi,
  c: Clock = clock,
) {
  const failures: string[] = [];
  const safe = async (name: string, task: () => Promise<void>) => {
    try {
      await task();
    } catch {
      failures.push(name);
    }
  };
  const call = async (
    name: string,
    op: string,
    input: Record<string, unknown>,
  ) => {
    j.evidence("cleanup-intent", { name, op, input });
    const result = await api.call("ec2", op, input);
    j.evidence("cleanup-response", { name, op, input, result });
    j.put("cleanup-ack-" + sha(canonical({ op, input })).slice(0, 40), {
      op,
      input,
    });
  };
  const read = async (op: string, input: Record<string, unknown>) => {
    const x = await api.call("ec2", op, input);
    j.evidence("cleanup-read", { op, input, result: x });
    const fields: Record<string, [string, string]> = {
      "describe-nat-gateways": ["NatGateways", "NatGatewayId"],
      "describe-security-group-rules": [
        "SecurityGroupRules",
        "SecurityGroupRuleId",
      ],
      "describe-addresses": ["Addresses", "AllocationId"],
      "describe-route-tables": ["RouteTables", "RouteTableId"],
      "describe-subnets": ["Subnets", "SubnetId"],
      "describe-internet-gateways": ["InternetGateways", "InternetGatewayId"],
    };
    if (!fields[op]) throw Error("Unknown cleanup inventory");
    inventory(x, ...fields[op]);
    return x;
  };
  await safe("bob-egress", async () => {
    const rules =
      (
        await read("describe-security-group-rules", {
          Filters: [
            { Name: "group-id", Values: [p.bobSecurityGroup] },
            ...freshFilter(p),
          ],
        })
      ).SecurityGroupRules ?? [];
    for (const r of rules) {
      if (
        !j.read("bob-egress-intent") ||
        !hasTags(r, p, true) ||
        r.GroupId !== p.bobSecurityGroup ||
        r.IsEgress !== true ||
        r.IpProtocol !== "tcp" ||
        r.FromPort !== 443 ||
        r.ToPort !== 443 ||
        r.CidrIpv4 !== "0.0.0.0/0"
      )
        throw Error("Unexpected rule");
      await call("revoke-owned-egress", "revoke-security-group-egress", {
        GroupId: p.bobSecurityGroup,
        SecurityGroupRuleIds: [r.SecurityGroupRuleId],
      });
    }
  });
  await safe("private-default-route", async () => {
    const intent = j.read("private-route-intent");
    if (!intent) return;
    const expected = intent.request?.input;
    if (
      expected?.RouteTableId !== p.privateRouteTable ||
      expected?.DestinationCidrBlock !== "0.0.0.0/0" ||
      !/^nat-[a-f0-9]+$/.test(expected?.NatGatewayId ?? "")
    )
      throw Error("Invalid owned route intent");
    const table = inventory(
      await read("describe-route-tables", {
        RouteTableIds: [p.privateRouteTable],
      }),
      "RouteTables",
      "RouteTableId",
    )[0];
    if (!table || table.VpcId !== p.vpc || !Array.isArray(table.Routes))
      throw Error("Unknown private route table");
    const route = table.Routes.find(
      (v: any) => v.DestinationCidrBlock === "0.0.0.0/0",
    );
    if (route) {
      if (route.NatGatewayId !== expected.NatGatewayId)
        throw Error("Foreign default route preserved");
      await call("remove-owned-private-default", "delete-route", {
        RouteTableId: p.privateRouteTable,
        DestinationCidrBlock: "0.0.0.0/0",
      });
    }
  });
  const nats =
    (await read("describe-nat-gateways", { Filter: freshFilter(p) }))
      .NatGateways ?? [];
  for (const nat of nats) {
    await safe("nat-" + nat.NatGatewayId, async () => {
      if (
        !j.read("nat-intent") ||
        !hasTags(nat, p, true) ||
        nat.VpcId !== p.vpc
      )
        throw Error("Unexpected NAT");
      const table = (
        await read("describe-route-tables", {
          RouteTableIds: [p.privateRouteTable],
        })
      ).RouteTables?.[0];
      if (!table || table.VpcId !== p.vpc) throw Error("Private table changed");
      const route = table.Routes.find(
        (r: any) => r.DestinationCidrBlock === "0.0.0.0/0",
      );
      if (route) {
        if (
          route.NatGatewayId !== nat.NatGatewayId ||
          !j.read("private-route-intent")
        )
          throw Error("Foreign default route; preserve");
        await call("remove-private-default", "delete-route", {
          RouteTableId: p.privateRouteTable,
          DestinationCidrBlock: "0.0.0.0/0",
        });
      }
      if (!["deleted", "deleting"].includes(nat.State))
        await call("delete-owned-nat", "delete-nat-gateway", {
          NatGatewayId: nat.NatGatewayId,
        });
      if (nat.State !== "deleted")
        throw Error("NAT deletion pending; retain EIP until confirmed");
    });
  }
  await safe("eip", async () => {
    const addresses =
      (await read("describe-addresses", { Filters: freshFilter(p) }))
        .Addresses ?? [];
    for (const a of addresses) {
      if (
        !j.read("eip-intent") ||
        !hasTags(a, p, true) ||
        a.AssociationId ||
        a.NetworkInterfaceId ||
        nats.some(
          (n: any) =>
            n.State !== "deleted" &&
            n.NatGatewayAddresses?.some(
              (v: any) => v.AllocationId === a.AllocationId,
            ),
        )
      )
        throw Error("EIP still associated");
      await call("release-owned-eip", "release-address", {
        AllocationId: a.AllocationId,
      });
    }
  });
  await safe("public-tables", async () => {
    const tables =
      (await read("describe-route-tables", { Filters: freshFilter(p) }))
        .RouteTables ?? [];
    const subnets =
      (await read("describe-subnets", { Filters: freshFilter(p) })).Subnets ??
      [];
    for (const t of tables) {
      if (
        !j.read("public-rt-intent") ||
        !hasTags(t, p, true) ||
        t.VpcId !== p.vpc ||
        t.RouteTableId === p.privateRouteTable
      )
        throw Error("Unexpected public table");
      const expectedGateway = j.read("public-route-intent")?.request?.input
        ?.GatewayId;
      if (
        !Array.isArray(t.Routes) ||
        t.Routes.some(
          (route: any) =>
            !(
              route.GatewayId === "local" &&
              route.DestinationCidrBlock === "10.88.0.0/24"
            ) &&
            !(
              route.DestinationCidrBlock === "0.0.0.0/0" &&
              route.GatewayId === expectedGateway
            ),
        )
      )
        throw Error("Foreign public route preserved");
      for (const a of t.Associations ?? []) {
        if (
          a.Main ||
          !subnets.some(
            (s: any) =>
              s.SubnetId === a.SubnetId &&
              hasTags(s, p, true) &&
              s.VpcId === p.vpc &&
              s.CidrBlock === p.publicCidr,
          )
        )
          throw Error("Foreign association");
        await call(
          "disassociate-owned-public-subnet",
          "disassociate-route-table",
          { AssociationId: a.RouteTableAssociationId },
        );
      }
      await call("delete-owned-public-table", "delete-route-table", {
        RouteTableId: t.RouteTableId,
      });
    }
    for (const s of subnets) {
      if (
        !j.read("subnet-intent") ||
        !hasTags(s, p, true) ||
        s.VpcId !== p.vpc ||
        s.SubnetId === p.privateSubnet ||
        s.CidrBlock !== p.publicCidr
      )
        throw Error("Foreign subnet");
      await call("delete-owned-public-subnet", "delete-subnet", {
        SubnetId: s.SubnetId,
      });
    }
  });
  await safe("igw", async () => {
    const gateways =
      (await read("describe-internet-gateways", { Filters: freshFilter(p) }))
        .InternetGateways ?? [];
    for (const g of gateways) {
      if (
        !j.read("igw-intent") ||
        !hasTags(g, p, true) ||
        (g.Attachments ?? []).some((a: any) => a.VpcId !== p.vpc)
      )
        throw Error("Foreign gateway attachment");
      if (g.Attachments?.length)
        await call("detach-owned-igw", "detach-internet-gateway", {
          InternetGatewayId: g.InternetGatewayId,
          VpcId: p.vpc,
        });
      await call("delete-owned-igw", "delete-internet-gateway", {
        InternetGatewayId: g.InternetGatewayId,
      });
    }
  });
  j.evidence("cleanup-cycle", { at: c.now(), failures });
  return failures;
}
