import { readFileSync, mkdirSync, readdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve("plugin/document-intelligence");
const manifest = JSON.parse(readFileSync(root + "/plugin.json", "utf8"));
if (
  manifest.name !== "document-intelligence" ||
  manifest.extensions["com.openai"].interface.shortDescription.length > 30
)
  throw Error("Invalid plugin identity or listing");
const check = (dir) => {
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".env"].includes(f))
      throw Error("Exclude dependency trees and secrets before packing");
    const p = dir + "/" + f;
    if (lstatSync(p).isSymbolicLink()) throw Error("Symlinks prohibited");
    if (lstatSync(p).isDirectory()) check(p);
  }
};
check(root);
mkdirSync("dist", { recursive: true });
execFileSync(
  "zip",
  [
    "-qr",
    resolve("dist/document-intelligence-plugin.zip"),
    "document-intelligence",
  ],
  { cwd: resolve("plugin") },
);
console.log(
  "Source plugin: dist/document-intelligence-plugin.zip (not installed or uploaded)",
);
