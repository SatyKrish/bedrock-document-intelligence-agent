import { App } from "aws-cdk-lib";
import { readFileSync } from "node:fs";
import { DocumentSiloStack } from "./stack.js";
import { ExistingNetwork } from "./network.js";
const app = new App({ outdir: "cdk.out" });
const region = process.env.CDK_DEFAULT_REGION || "us-east-1";
if (!["us-east-1", "us-east-2", "us-west-2"].includes(region))
  throw Error("BMA preview requires a supported US region");
const name = process.env.SILO_STACK_NAME || "DocumentIntelligenceSilo";
if (!/^DocumentIntelligence[A-Za-z0-9-]{1,80}$/.test(name))
  throw Error(
    "Use a distinct DocumentIntelligence-prefixed stack name per principal",
  );
const existingNetwork = process.env.NETWORK_FILE
  ? ExistingNetwork.parse(
      JSON.parse(readFileSync(process.env.NETWORK_FILE, "utf8")),
    )
  : undefined;
if (existingNetwork && existingNetwork.region !== region)
  throw Error("Network and stack regions must match");
new DocumentSiloStack(app, name, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  existingNetwork,
});
app.synth();
