import { bmaPayload } from "../deployment/preflight.js";
import { responseBytes } from "../deployment/http.js";
import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sourceInventory, packageSource, ROOT } from "../deployment/source.js";
import { writeBytes } from "../deployment/workspace.js";
it("exact inventory excludes unlisted secret-like files and rejects adding credential paths", () => {
  const root = mkdtempSync(join(tmpdir(), "docintel-inventory-"));
  try {
    mkdirSync(join(root, "deployment"));
    mkdirSync(join(root, "server"));
    writeFileSync(join(root, "server/public.ts"), "export const fixture=true;");
    writeFileSync(join(root, "deployment/.env.json"), "PRIVATE_NOT_TO_UPLOAD");
    writeFileSync(
      join(root, "server/credentials.json"),
      "PRIVATE_NOT_TO_UPLOAD",
    );
    writeFileSync(
      join(root, "deployment/source-files.json"),
      JSON.stringify(["server/public.ts"]),
    );
    expect(Object.keys(sourceInventory(root).files)).toEqual([
      "server/public.ts",
    ]);
    writeFileSync(
      join(root, "deployment/source-files.json"),
      JSON.stringify(["server/credentials.json"]),
    );
    expect(() => sourceInventory(root)).toThrow("Unapproved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("bundle contains all local test/build configuration, and upstream verifier detects extra or altered members", () => {
  const root = mkdtempSync(join(tmpdir(), "docintel-bundle-"));
  try {
    const inv = packageSource(join(root, "source.zip"));
    for (const name of [
      "deploy/config.example.json",
      "deployment/verify-source.py",
      "deployment/source-files.json",
      "vitest.config.ts",
      "tsconfig.server.json",
      "vite.config.ts",
    ])
      expect(inv.files[name]).toMatch(/^[a-f0-9]{64}$/);
    const unpack = join(root, "unpacked");
    mkdirSync(unpack);
    execFileSync("python3", [
      "-m",
      "zipfile",
      "-e",
      join(root, "source.zip"),
      unpack,
    ]);
    const verify = () =>
      execFileSync("python3", [join(ROOT, "deployment/verify-source.py")], {
        cwd: unpack,
        env: { ...process.env, SOURCE_DIGEST: inv.digest },
        stdio: "pipe",
      });
    expect(verify).not.toThrow();
    writeFileSync(join(unpack, "extra.json"), "{}");
    expect(verify).toThrow();
    rmSync(join(unpack, "extra.json"));
    writeFileSync(
      join(unpack, "deployment/verify-source.py"),
      "# replaced verifier",
    );
    expect(verify).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("artifact writes reject symlinks without overwriting unrelated work", () => {
  const root = mkdtempSync(join(tmpdir(), "docintel-artifact-"));
  try {
    const original = join(root, "unrelated.txt"),
      link = join(root, "comparison.md");
    writeFileSync(original, "preserve");
    symlinkSync(original, link);
    expect(() => writeBytes(link, Buffer.from("changed"))).toThrow("regular");
    expect(readFileSync(original, "utf8")).toBe("preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("remote metadata limit cancels an oversized stream before buffering the rest", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(128));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(responseBytes(new Response(stream), 64)).rejects.toThrow(
    "bounded",
  );
  expect(cancelled).toBe(true);
});

it("fresh source archives reject a dangling output link and preserve its target", () => {
  const root = mkdtempSync(join(tmpdir(), "docintel-zip-exclusive-"));
  try {
    const target = join(root, "unrelated.zip"),
      output = join(root, "source.zip");
    symlinkSync(target, output);
    expect(() => packageSource(output)).toThrow();
    expect(() => readFileSync(target)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("BMA successful null/zero-body acknowledgements remain accepted while metadata is bounded", async () => {
  expect(await bmaPayload(new Response(null, { status: 204 }))).toEqual({});
  expect(await bmaPayload(new Response(""))).toEqual({});
  expect(await bmaPayload(Response.json({ id: "owned-session" }))).toEqual({
    id: "owned-session",
  });
});
