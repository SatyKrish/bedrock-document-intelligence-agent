import { responseJson, responseBytes } from "./http.js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { Config } from "./config.js";
import { digest, canonical } from "./approval.js";
import { sourceInventory } from "./source.js";
import { asObject, type Aws } from "./aws.js";
export async function signedRead(
  c: Config,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const url = new URL(path, `https://bedrock-mantle.${c.region}.api.aws`),
    query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  const signer = new SignatureV4({
    credentials: defaultProvider({ profile: c.profile }),
    region: c.region,
    service: "bedrock-mantle",
    sha256: Sha256,
  });
  const request = await signer.sign(
    new HttpRequest({
      hostname: url.hostname,
      protocol: url.protocol,
      method,
      path: url.pathname,
      query,
      headers: {
        host: url.hostname,
        "x-amzn-account-id": c.account,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const response = await fetch(url, {
    method,
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`BMA ${method} failed (${response.status}); no write replay`);
  }
  return bmaPayload(response);
}
export async function preflight(
  c: Config,
  aws: Aws,
  fetcher: typeof fetch = fetch,
  bma = signedRead,
) {
  const identity = asObject(aws.call(["sts", "get-caller-identity"]));
  if (identity.Account !== c.account)
    throw Error("Selected profile belongs to a different account");
  const zones = asObject(aws.call(["ec2", "describe-availability-zones"]));
  const enabled = (zones.AvailabilityZones ?? [])
    .filter((a: any) => a.State === "available")
    .map((a: any) => a.ZoneName);
  if (c.availabilityZones.some((a) => !enabled.includes(a)))
    throw Error("Configured availability zones are not enabled");
  if (c.mode === "hosted") {
    const ami = asObject(
      aws.call([
        "ec2",
        "describe-images",
        "--image-ids",
        c.amiId,
        "--owners",
        "amazon",
      ]),
    );
    if (
      !ami.Images?.some(
        (i: any) =>
          i.ImageId === c.amiId &&
          i.Architecture === "arm64" &&
          i.State === "available" &&
          /^al2023-ami-/.test(i.Name ?? "") &&
          i.RootDeviceType === "ebs" &&
          i.VirtualizationType === "hvm",
      )
    )
      throw Error(
        "Use an available official Amazon Linux 2023 ARM64 EBS/HVM AMI",
      );
  }
  if (c.network.kind === "existing") {
    const subnets = [...c.network.privateSubnets, ...c.network.publicSubnets];
    const data = asObject(
      aws.call([
        "ec2",
        "describe-subnets",
        "--subnet-ids",
        ...subnets.map((s) => s.subnetId),
      ]),
    );
    for (const s of subnets)
      if (
        !data.Subnets?.some(
          (x: any) =>
            x.SubnetId === s.subnetId &&
            x.VpcId === (c.network as any).vpcId &&
            x.AvailabilityZone === s.availabilityZone,
        )
      )
        throw Error("Imported subnet identity/AZ mismatch");
    const routes = asObject(
      aws.call([
        "ec2",
        "describe-route-tables",
        "--route-table-ids",
        ...new Set(subnets.map((s) => s.routeTableId)),
      ]),
    );
    for (const s of subnets) {
      const rt = routes.RouteTables?.find(
        (r: any) => r.RouteTableId === s.routeTableId,
      );
      if (
        !rt ||
        rt.VpcId !== (c.network as any).vpcId ||
        !rt.Associations?.some((a: any) => a.SubnetId === s.subnetId)
      )
        throw Error("Imported route-table association mismatch");
    }
  }
  if (c.mode === "hosted") {
    const cert = asObject(
      aws.call([
        "acm",
        "describe-certificate",
        "--certificate-arn",
        c.certificateArn!,
      ]),
    );
    if (cert.Certificate?.Status !== "ISSUED")
      throw Error("Certificate is not issued");
    const host = new URL(c.publicOrigin).hostname;
    const names = cert.Certificate.SubjectAlternativeNames ?? [];
    if (
      !names.some(
        (n: string) =>
          n === host ||
          (n.startsWith("*.") &&
            host.split(".").slice(1).join(".") === n.slice(2)),
      )
    )
      throw Error("Certificate does not cover application hostname");
    const zone = asObject(
      aws.call(["route53", "get-hosted-zone", "--id", c.hostedZone!.id]),
    );
    if (
      zone.HostedZone?.Name !== c.hostedZone!.name + "." ||
      zone.HostedZone?.Config?.PrivateZone
    )
      throw Error("Use the approved public DNS zone");
    const records = asObject(
      aws.call([
        "route53",
        "list-resource-record-sets",
        "--hosted-zone-id",
        c.hostedZone!.id,
        "--start-record-name",
        host,
        "--max-items",
        "1",
      ]),
    );
    if (records.ResourceRecordSets?.some((r: any) => r.Name === host + "."))
      throw Error(
        "DNS name already exists; choose an unused name, do not overwrite unrelated records",
      );
  }
  const discovery = await fetcher(
    c.identity.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
    { redirect: "error", signal: AbortSignal.timeout(10000) },
  );
  if (!discovery.ok) throw Error("OIDC discovery unavailable");
  const d = await responseJson(discovery, 65536);
  if (
    d.issuer !== c.identity.issuer ||
    d.jwks_uri !== c.identity.jwksUrl ||
    !d.code_challenge_methods_supported?.includes("S256")
  )
    throw Error("OIDC issuer/JWKS/S256 metadata mismatch");
  const models = await bma(c, "/v1/models");
  if (!models.data?.some((m: any) => m.id === c.model))
    throw Error("Selected preview model not in this account/region catalog");
  return {
    configurationDigest: digest(canonical(c)),
    sourceDigest: sourceInventory().digest,
    account: identity.Account,
    callerArn: identity.Arn,
    region: c.region,
    model: c.model,
    availabilityZones: c.availabilityZones,
    verifiedAt: new Date().toISOString(),
    liveInference: false,
    remaining: [
      "Runtime/BMA write permissions, S3 mounts and sync",
      "Real access-token audience/scopes, SPA and ChatGPT client registration",
      "Application boot, durability and real model quality",
      "Imported endpoint SG/NACL/DNS reachability",
    ],
  };
}

export function verifyPreflight(report: any, c: Config, now = Date.now()) {
  if (
    report.account !== c.account ||
    report.region !== c.region ||
    report.configurationDigest !== digest(canonical(c)) ||
    report.sourceDigest !== sourceInventory().digest ||
    !Number.isFinite(Date.parse(report.verifiedAt)) ||
    now - Date.parse(report.verifiedAt) > 24 * 3600000 ||
    Date.parse(report.verifiedAt) > now + 60000
  )
    throw Error(
      "Preflight is missing, stale or belongs to changed configuration/source; rerun read-only preflight before cloud apply",
    );
}
export async function readiness(c: Config, fetcher: typeof fetch = fetch) {
  try {
    const get = (path: string) =>
      fetcher(c.publicOrigin + path, {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    const health = await get("/healthz");
    if (!health.ok || (await responseJson(health, 32768)).status !== "ok")
      throw Error();
    const cfg = await get("/api/config");
    const identity = await responseJson(cfg, 32768);
    if (
      !cfg.ok ||
      identity.mode !== "bedrock" ||
      identity.identity?.issuer !== c.identity.issuer ||
      identity.identity?.audience !== c.identity.audience
    )
      throw Error();
    const anonymous = await get("/api/documents");
    await anonymous.body?.cancel();
    if (anonymous.status !== 401 || !anonymous.headers.get("www-authenticate"))
      throw Error();
    return {
      status: "https-live-mode-auth-challenge-verified",
      webUrl: c.publicOrigin,
      mcpUrl: c.publicOrigin + "/mcp",
      remaining:
        "Real PKCE/token/scopes/ChatGPT and live managed execution acceptance remain required",
    };
  } catch {
    return {
      status: "application-readiness-unverified",
      webUrl: c.publicOrigin,
      remaining:
        "Inspect boot, DNS, TLS and health; CloudFormation completion alone does not prove application readiness",
    };
  }
}

// The documented event/delete acknowledgement may have no body (including 204).
export async function bmaPayload(response: Response) {
  if (!response.body) return {};
  const bytes = await responseBytes(response, 2 * 1024 * 1024);
  return bytes.byteLength ? JSON.parse(bytes.toString("utf8")) : {};
}
