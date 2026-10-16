import { App, BootstraplessSynthesizer, Tags } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { Config } from "./config.js";
import { stackNames, principalKey, roleName } from "./config.js";
import { sealPlan, type Plan } from "./approval.js";
import { sourceInventory } from "./source.js";
import { ImageBuildStack } from "../infra/build-stack.js";
import { FoundationStack } from "../infra/foundation-stack.js";
import { DocumentSiloStack } from "../infra/stack.js";
import { ApplicationHostStack } from "../infra/host-stack.js";
export type Images = { sourceDigest: string; runtime: string; app: string };
export function createPlan(
  c: Config,
  phase: Plan["phase"],
  images?: Images,
): Plan {
  const source = sourceInventory();
  const app = new App({
    context: {
      [`availability-zones:account=${c.account}:region=${c.region}`]:
        c.availabilityZones,
    },
  });
  const props = () => ({
    env: { account: c.account, region: c.region },
    synthesizer: new BootstraplessSynthesizer(),
  });
  const names = stackNames(c),
    templates: Record<string, unknown> = {};
  const stacks: import("aws-cdk-lib").Stack[] = [];
  const record = (s: import("aws-cdk-lib").Stack) => {
    Tags.of(s).add("DocIntelDeploymentId", c.deploymentId);
    stacks.push(s);
  };
  if (phase === "build")
    record(new ImageBuildStack(app, names.build, c, source.digest, props()));
  else if (phase === "deploy") {
    if (
      !images ||
      images.sourceDigest !== source.digest ||
      !/^sha256:[a-f0-9]{64}$/.test(images.runtime) ||
      (c.mode === "hosted" && !/^sha256:[a-f0-9]{64}$/.test(images.app))
    )
      throw Error("Matching immutable build-result digests are required");
    const foundation = new FoundationStack(app, names.foundation, c, props());
    record(foundation);
    const silos: Record<string, unknown> = {};
    c.principals.forEach((p, i) => {
      const key = principalKey(p.subject),
        prefix = `docintel-${c.deploymentId}-${key}`;
      const s = new DocumentSiloStack(app, names.silos[i], {
        ...props(),
        providedVpc: foundation.vpc,
        deploymentPrefix: prefix,
        seedSkills: false,
      });
      record(s);
      silos[p.subject] = {
        region: c.region,
        ...s.configOutputs,
        model: c.model,
      };
    });
    if (c.mode === "hosted")
      record(
        new ApplicationHostStack(
          app,
          names.host,
          c,
          foundation.vpc,
          `arn:aws:iam::${c.account}:role/docintel-${c.deploymentId}-application`,
          `${c.account}.dkr.ecr.${c.region}.amazonaws.com/docintel-${c.deploymentId}-app@${images.app}`,
          silos,
          props(),
        ),
      );
  }
  for (const s of stacks) {
    const template = Template.fromStack(s).toJSON();
    if (Object.keys(template.Resources ?? {}).length)
      templates[s.stackName] = template;
  }
  const createdAt = new Date().toISOString();
  return sealPlan({
    version: 1,
    phase,
    configuration: c,
    sourceDigest: source.digest,
    templates,
    ...(images ? { images } : {}),
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    retainData: true,
    costAllowanceUsd: c.costAllowanceUsd,
  });
}
