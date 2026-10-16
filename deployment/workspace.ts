import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "./source.js";
export function workspace(id: string) {
  if (!/^[a-z][a-z0-9-]{2,20}$/.test(id)) throw Error("Invalid deployment ID");
  const root = join(ROOT, ".deployment");
  const dir = join(root, id);
  for (const p of [root, dir])
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw Error("Deployment paths must not be symlinks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function readJson(path: string): any {
  if (lstatSync(path).isSymbolicLink())
    throw Error("JSON path must not be a symlink");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function writeJson(path: string, value: unknown) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw Error("State path must not be a symlink");
  const temporary = resolve(path + "." + randomUUID() + ".tmp");
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

// Exclusive across CLI processes; a crash leaves a lock for explicit, read-only reconciliation.
export async function withDeploymentLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(workspace(id), "operation.lock");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  } catch {
    throw Error(
      "Deployment operation is already locked; inspect status and any surviving process before manually removing a stale lock",
    );
  }
  try {
    return await operation();
  } finally {
    unlinkSync(path);
  }
}

export function writeBytes(path: string, bytes: Buffer) {
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw Error("Artifact destination must be a regular file");
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
