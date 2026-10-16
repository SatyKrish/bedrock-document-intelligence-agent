import { z } from "zod";
import { createHash } from "node:crypto";
const text = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (s) => !/[\x00-\x1f\x7f]/.test(s),
    "Control characters are not allowed",
  );
const https = text.refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}, "An approved HTTPS URL is required");
const subnet = z
  .object({
    subnetId: z.string().regex(/^subnet-[a-f0-9]{8,17}$/),
    routeTableId: z.string().regex(/^rtb-[a-f0-9]{8,17}$/),
    availabilityZone: z.string().regex(/^us-(east-[12]|west-2)[a-z]$/),
  })
  .strict();
export const Configuration = z
  .object({
    version: z.literal(1),
    deploymentId: z.string().regex(/^[a-z][a-z0-9-]{2,20}$/),
    profile: text,
    account: z.string().regex(/^\d{12}$/),
    region: z.enum(["us-east-1", "us-east-2", "us-west-2"]),
    availabilityZones: z
      .array(z.string().regex(/^us-(east-[12]|west-2)[a-z]$/))
      .length(2),
    hostedZone: z
      .object({
        id: z.string().regex(/^Z[A-Z0-9]+$/),
        name: z.string().regex(/^[a-z0-9.-]+$/),
      })
      .strict()
      .optional(),
    mode: z.enum(["hosted", "developer"]),
    model: z.literal("openai.gpt-5.6-luna"),
    network: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new") }).strict(),
      z
        .object({
          kind: z.literal("existing"),
          vpcId: z.string().regex(/^vpc-[a-f0-9]{8,17}$/),
          vpcCidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/),
          privateSubnets: z.array(subnet).length(2),
          publicSubnets: z.array(subnet).length(2),
        })
        .strict(),
    ]),
    principals: z
      .array(
        z
          .object({
            subject: text,
            documents: z
              .array(z.enum(["acme-2024", "beta-2024", "kpis-2024"]))
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    identity: z
      .object({
        issuer: https,
        jwksUrl: https,
        audience: https,
        spaClientId: text,
        connectOrigins: z.array(https).min(1).max(4),
        chatgptClient: z.enum(["predefined", "cimd", "dcr"]),
      })
      .strict(),
    publicOrigin: https,
    certificateArn: z
      .string()
      .regex(
        /^arn:aws:acm:(us-east-1|us-east-2|us-west-2):\d{12}:certificate\/[a-f0-9-]+$/,
      )
      .optional(),
    developerCallerArn: z
      .string()
      .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/)
      .optional(),
    amiId: z.string().regex(/^ami-[a-f0-9]{8,17}$/),
    costAllowanceUsd: z.number().positive().max(100),
    termsReviewed: z.literal(true),
  })
  .strict()
  .superRefine((c, ctx) => {
    const problem = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const u = new URL(c.publicOrigin);
    if (u.origin !== c.publicOrigin)
      problem("publicOrigin must be a canonical origin");
    if (c.mode === "hosted" && !c.hostedZone)
      problem(
        "Hosted mode requires an approved Route53 zone for its DNS record",
      );
    if (
      c.hostedZone &&
      !u.hostname.endsWith("." + c.hostedZone.name) &&
      u.hostname !== c.hostedZone.name
    )
      problem("Application hostname must belong to the approved zone");
    if (
      new Set(c.availabilityZones).size !== 2 ||
      c.availabilityZones.some((a) => !a.startsWith(c.region))
    )
      problem("Choose two distinct enabled AZs in the region");
    if (
      c.mode === "hosted" &&
      (!c.certificateArn ||
        c.certificateArn.split(":")[3] !== c.region ||
        c.certificateArn.split(":")[4] !== c.account)
    )
      problem(
        "Hosted mode requires an existing certificate in the configured account/region",
      );
    if (
      c.mode === "developer" &&
      (!c.developerCallerArn ||
        c.developerCallerArn.split(":")[4] !== c.account)
    )
      problem(
        "Developer mode requires an exact approved caller role in the same account",
      );
    if (
      new Set(c.principals.map((p) => p.subject)).size !== c.principals.length
    )
      problem("Subjects must be unique");
    for (const p of c.principals)
      if (new Set(p.documents).size !== p.documents.length)
        problem("Document grants must be unique");
    for (const origin of c.identity.connectOrigins)
      if (new URL(origin).origin !== origin)
        problem("Identity connect origins must be canonical origins");
    if (
      c.network.kind === "existing" &&
      [...c.network.privateSubnets, ...c.network.publicSubnets].some(
        (s) => !c.availabilityZones.includes(s.availabilityZone),
      )
    )
      problem("Imported subnet AZs must match the two configured AZs");
    if (c.network.kind === "existing")
      for (const group of [c.network.privateSubnets, c.network.publicSubnets])
        if (
          new Set(group.map((s) => s.subnetId)).size !== group.length ||
          new Set(group.map((s) => s.availabilityZone)).size !== group.length ||
          group.some((s) => !s.availabilityZone.startsWith(c.region))
        )
          problem(
            "Network subnets must be distinct AZs in the configured region",
          );
  });
export type Config = z.infer<typeof Configuration>;
export const principalKey = (subject: string) =>
  "u_" + createHash("sha256").update(subject).digest("hex").slice(0, 12);
export const roleName = (c: Config, key: string, kind: string) =>
  `docintel-${c.deploymentId}-${key}-${kind}`;
export const stackNames = (c: Config) => ({
  build: `DocumentIntelligence-${c.deploymentId}-Build`,
  foundation: `DocumentIntelligence-${c.deploymentId}-Foundation`,
  host: `DocumentIntelligence-${c.deploymentId}-Host`,
  silos: c.principals.map(
    (p) =>
      `DocumentIntelligence-${c.deploymentId}-${principalKey(p.subject).replaceAll("_", "-")}`,
  ),
});
