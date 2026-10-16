import { spawn } from "node:child_process";
const p = spawn("node", ["dist/server/index.js"], {
  env: { ...process.env, MODE: "mock", HOST: "127.0.0.1", PORT: "3000" },
  stdio: "ignore",
});
try {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try {
      const c = await fetch("http://127.0.0.1:3000/api/config");
      if ((await c.json()).mode === "mock") {
        ok = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ok) throw Error("Compiled application did not become ready");
  const r = await fetch("http://127.0.0.1:3000/api/documents", {
    headers: { Authorization: "Bearer demo-alice" },
  });
  if (!r.ok || (await r.json()).documents.length !== 3)
    throw Error("Compiled fixture contract failed");
  const denied = await fetch("http://127.0.0.1:3000/api/documents");
  if (denied.status !== 401) throw Error("Anonymous documents exposed");
} finally {
  if (p.exitCode === null && p.signalCode === null) {
    const exited = new Promise((resolve) => p.once("exit", resolve));
    p.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) =>
        setTimeout(() => {
          p.kill("SIGKILL");
          resolve();
        }, 5000).unref(),
      ),
    ]);
  }
}
