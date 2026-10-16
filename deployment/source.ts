import { readFileSync, lstatSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { canonical, digest } from "./approval.js";
export const ROOT = resolve(import.meta.dirname, "..");
// Review and update this exact list for source additions. Never glob an adopter's files.
export function sourceInventory(root = ROOT) {
  const manifest = resolve(root, "deployment/source-files.json");
  if (lstatSync(manifest).isSymbolicLink())
    throw Error("Source list must not be a symlink");
  const names: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (
    !Array.isArray(names) ||
    names.length > 300 ||
    new Set(names).size !== names.length
  )
    throw Error("Invalid source file list");
  const files: Record<string, string> = {};
  let total = 0;
  for (const name of names) {
    if (
      typeof name !== "string" ||
      name.includes("\\") ||
      name
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.startsWith(".")) ||
      /(^|\/)(node_modules|vendor|bin|__pycache__|credentials?|secrets?|customer-data)(\/|\.|$)/i.test(
        name,
      )
    )
      throw Error("Unapproved source path");
    const path = resolve(root, name);
    if (!path.startsWith(resolve(root) + sep))
      throw Error("Source outside root");
    for (let p = path; p !== resolve(root); p = dirname(p))
      if (lstatSync(p).isSymbolicLink())
        throw Error("Source bundle rejects symlinks");
    const stat = lstatSync(path);
    total += stat.size;
    if (
      !stat.isFile() ||
      stat.size > 4 * 1024 * 1024 ||
      total > 20 * 1024 * 1024
    )
      throw Error("Source file/bundle too large or nonregular");
    files[name] = digest(readFileSync(path));
  }
  return { files, digest: digest(canonical(files)) };
}
export function packageSource(output: string) {
  const inventory = sourceInventory();
  execFileSync(
    "python3",
    [
      resolve(ROOT, "scripts/package-deployment.py"),
      ROOT,
      output,
      JSON.stringify(inventory.files),
    ],
    { stdio: "pipe", timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  return inventory;
}
