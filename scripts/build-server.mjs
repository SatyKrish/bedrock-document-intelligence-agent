import { cpSync } from "node:fs";
cpSync("fixtures", "dist/fixtures", { recursive: true });
