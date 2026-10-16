import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = new URL(
  "../agentcore-reference/DocIntelReference/",
  import.meta.url,
);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
it("keeps both official lifecycle copies unchanged and ships both domain skills", () => {
  const provenance = JSON.parse(read("PROVENANCE.json"));
  for (const owner of ["Alice", "Bob"]) {
    expect(
      createHash("sha256")
        .update(read(`app/${owner}/lifecycle/server.py`))
        .digest("hex"),
    ).toBe(provenance.lifecycleSha256);
    const plugin = JSON.parse(
      read(
        `app/${owner}/plugins/document-intelligence/.codex-plugin/plugin.json`,
      ),
    );
    expect(plugin.skills).toBe("./skills/");
    for (const skill of ["document-analysis", "generate-examine-correct"]) {
      const source = readFileSync(
        new URL(`../agent/skills/${skill}/SKILL.md`, import.meta.url),
        "utf8",
      );
      expect(
        read(
          `app/${owner}/plugins/document-intelligence/skills/${skill}/SKILL.md`,
        ),
      ).toBe(source);
    }
  }
});
it("requires separate imported roles and access points with bounded persistent test sessions", () => {
  const spec = JSON.parse(read("agentcore/agentcore.json"));
  expect(spec.runtimes).toHaveLength(2);
  expect(new Set(spec.runtimes.map((a: any) => a.executionRoleArn)).size).toBe(
    2,
  );
  const points: string[] = [];
  for (const a of spec.runtimes) {
    expect(a.networkMode).toBe("VPC");
    expect(a.authorizerType ?? "AWS_IAM").toBe("AWS_IAM");
    expect(a.additionalPolicies).toEqual([]);
    expect(a.instrumentation.enableOtel).toBe(false);
    expect(a.lifecycleConfiguration).toEqual({
      idleRuntimeSessionTimeout: 600,
      maxLifetime: 1800,
    });
    expect(a.filesystemConfigurations[0]).toEqual({
      sessionStorage: { mountPath: "/mnt/home" },
    });
    points.push(
      ...a.filesystemConfigurations
        .slice(1)
        .map((s: any) => s.s3FilesAccessPoint.accessPointArn),
    );
  }
  expect(new Set(points).size).toBe(4);
});
it("uses a project-scoped Transaction Search opt-out and leaves public deployment targets empty", () => {
  expect(
    JSON.parse(read("cli-settings/config.json")).disableTransactionSearch,
  ).toBe(true);
  expect(JSON.parse(read("agentcore/aws-targets.json"))).toEqual([]);
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.devDependencies["@aws/agentcore"]).toBe("0.31.1");
  expect(pkg.scripts.agentcore).toContain("AGENTCORE_CONFIG_DIR");
  expect(pkg.scripts.deploy).toBe("npm run agentcore -- deploy");
});
