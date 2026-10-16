import { it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRuntimeAcceptance,
  runRuntimeAcceptance,
} from "../deployment/runtime-acceptance.js";
import { MockProvider } from "../server/mock.js";
import { configureCatalog } from "../server/catalog.js";
import type { Analysis } from "../server/contracts.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  configureCatalog({
    alice: ["acme-2024", "beta-2024", "kpis-2024"],
    bob: ["acme-2024"],
  });
});
function fixture() {
  const silos = JSON.parse(readFileSync("infra/silos.example.json", "utf8"));
  for (const s of Object.values(silos) as Array<{ model: string }>)
    s.model = "openai.gpt-6-luna";
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "docintel-acceptance-")),
  );
  const folder = join(base, "receipts");
  dirs.push(base);
  const data = {
    version: 1,
    syntheticOnly: true,
    mode: "mock",
    receiptDirectory: folder,
    ledgerFile: join(base, "ledger.json"),
    cases: [
      { subject: "alice", requestId: "11111111-1111-4111-8111-111111111111" },
      { subject: "bob", requestId: "22222222-2222-4222-8222-222222222222" },
    ],
    silos,
  };
  const bytes = Buffer.from(JSON.stringify(data));
  const approval = createHash("sha256").update(bytes).digest("hex");
  return { bytes, approval, folder, data };
}
it("rejects approval and model drift before provider construction", async () => {
  const { bytes, folder, data } = fixture();
  const factory = vi.fn(() => new MockProvider());
  await expect(
    runRuntimeAcceptance(bytes, "wrong", folder, { providerFactory: factory }),
  ).rejects.toThrow("approval");
  expect(factory).not.toHaveBeenCalled();
  data.silos.alice.model = "openai.other";
  const changed = Buffer.from(JSON.stringify(data));
  expect(() =>
    authorizeRuntimeAcceptance(
      changed,
      createHash("sha256").update(changed).digest("hex"),
    ),
  ).toThrow("model");
});
it("default live runner requires an explicit live authorization gate", async () => {
  const { data, folder } = fixture();
  data.mode = "bedrock";
  const bytes = Buffer.from(JSON.stringify(data));
  const approval = createHash("sha256").update(bytes).digest("hex");
  await expect(runRuntimeAcceptance(bytes, approval, folder)).rejects.toThrow(
    "not approved",
  );
});
it("runs two serial mock analyses with sealed artifacts and reuses their durable request IDs", async () => {
  const { bytes, approval, folder } = fixture();
  class Counted extends MockProvider {
    created = 0;
    submitted = 0;
    override async create(a: Analysis) {
      this.created++;
      return super.create(a);
    }
    override async submit(
      a: Analysis,
      docs: Parameters<MockProvider["submit"]>[1],
    ) {
      this.submitted++;
      return super.submit(a, docs);
    }
  }
  const provider = new Counted();
  const options = { providerFactory: () => provider, maxMs: 10000, pollMs: 5 };
  const first = await runRuntimeAcceptance(bytes, approval, folder, options);
  const second = await runRuntimeAcceptance(bytes, approval, folder, options);
  expect(provider.created).toBe(2);
  expect(provider.submitted).toBe(2);
  expect(second).toEqual(first);
  expect(first.mode).toBe("mock");
  expect(first.crossOwnerServiceDenial && first.crossOwnerSourceDenial).toBe(
    true,
  );
  expect(readFileSync(join(folder, "case-1-kpis.csv"), "utf8")).toContain(
    "beta-2024",
  );
  expect(readFileSync(join(folder, "case-2-kpis.csv"), "utf8")).not.toContain(
    "beta-2024",
  );
});
it("an ambiguous first create blocks the second owner and is never replayed on restart", async () => {
  const { bytes, approval, folder } = fixture();
  class Ambiguous extends MockProvider {
    created = 0;
    override async create(): Promise<string> {
      this.created++;
      throw Error("lost create response");
    }
  }
  const provider = new Ambiguous();
  const options = { providerFactory: () => provider, maxMs: 1000, pollMs: 1 };
  await expect(
    runRuntimeAcceptance(bytes, approval, folder, options),
  ).rejects.toThrow("uncertain");
  await expect(
    runRuntimeAcceptance(bytes, approval, folder, options),
  ).rejects.toThrow("uncertain");
  expect(provider.created).toBe(1);
});

it("rejects concurrent execution and new receipt locations before any duplicate work", async () => {
  const { bytes, approval, folder } = fixture();
  const provider = new MockProvider();
  const options = { providerFactory: () => provider, maxMs: 10000, pollMs: 5 };
  const running = runRuntimeAcceptance(bytes, approval, folder, options);
  await expect(
    runRuntimeAcceptance(bytes, approval, folder, options),
  ).rejects.toThrow("locked");
  await expect(
    runRuntimeAcceptance(bytes, approval, folder + "-other", options),
  ).rejects.toThrow("exact approved");
  await running;
});
it("missing initialized SQLite state fails before provider construction", async () => {
  const { bytes, approval, folder } = fixture();
  await runRuntimeAcceptance(bytes, approval, folder, {
    providerFactory: () => new MockProvider(),
    maxMs: 10000,
    pollMs: 5,
  });
  unlinkSync(join(folder, "acceptance.sqlite"));
  const factory = vi.fn(() => new MockProvider());
  await expect(
    runRuntimeAcceptance(bytes, approval, folder, { providerFactory: factory }),
  ).rejects.toThrow("state is missing");
  expect(factory).not.toHaveBeenCalled();
});
