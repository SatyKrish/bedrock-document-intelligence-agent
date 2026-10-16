import { z } from "zod";
export const ExistingNetwork = z
  .object({
    region: z.enum(["us-east-1", "us-east-2", "us-west-2"]),
    vpcId: z.string().regex(/^vpc-[a-f0-9]{8,17}$/),
    privateSubnets: z
      .array(
        z
          .object({
            subnetId: z.string().regex(/^subnet-[a-f0-9]{8,17}$/),
            routeTableId: z.string().regex(/^rtb-[a-f0-9]{8,17}$/),
            availabilityZone: z.string().regex(/^us-(east-[12]|west-2)[a-z]$/),
          })
          .strict(),
      )
      .min(2)
      .max(3),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (
      new Set(n.privateSubnets.map((s) => s.subnetId)).size !==
        n.privateSubnets.length ||
      new Set(n.privateSubnets.map((s) => s.availabilityZone)).size !==
        n.privateSubnets.length ||
      n.privateSubnets.some((s) => !s.availabilityZone.startsWith(n.region))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Private subnets must be distinct AZs in the configured region",
      });
  });
export type ExistingNetwork = z.infer<typeof ExistingNetwork>;
