import type {
  Analysis,
  AnalysisResult,
  ArtifactName,
  Doc,
} from "./contracts.js";
import type { Provider, Snapshot } from "./provider.js";
import { selectDocs } from "./catalog.js";
export class MockProvider implements Provider {
  readonly mode = "mock" as const;
  constructor(
    private duration = 1600,
    private syncDelay = 700,
  ) {}
  async stage(_a: Analysis, _docs: Doc[]) {}
  async create(a: Analysis) {
    return "mock_" + a.id;
  }
  async submit(_a: Analysis, _docs: Doc[]) {}
  async cancel(_a: Analysis) {}
  private result(a: Analysis): AnalysisResult {
    const docs = selectDocs({ id: a.owner, scopes: [] }, a.documentIds);
    const rows = docs
      .filter((d) => d.kind === "report")
      .map((d) => ({
        d,
        revenue: Number(d.text.match(/revenue was USD ([\d.]+) billion/)?.[1]),
        income: Number(
          d.text.match(/Operating income was USD ([\d.]+) billion/)?.[1],
        ),
      }));
    const citations = rows.map(({ d }) => ({
      documentId: d.id,
      location: "Financial performance",
      quote: d.text.split("\n").find((l) => l.includes("revenue was USD"))!,
    }));
    if (!citations.length) {
      const d = docs[0];
      citations.push({
        documentId: d.id,
        location: "CSV header",
        quote: d.text.split("\n")[0],
      });
    }
    const facts = rows
      .map(
        ({ d, revenue, income }) =>
          `${d.id.startsWith("acme") ? "ACME" : "BETA"}: revenue $${revenue.toFixed(1)}B; operating income $${income.toFixed(1)}B; operating margin ${((100 * income) / revenue).toFixed(1)}%. [${d.id} · Financial performance]`,
      )
      .join("\n\n");
    const diff =
      rows.length === 2
        ? `\n\nBETA revenue exceeds ACME by $117.8B. EBITDA is not disclosed in either report.`
        : "";
    return {
      analysisId: a.id,
      answer:
        "MOCK · Deterministic fixture comparison\n\n" +
        (facts ||
          "The selected CSV contains synthetic 2024 KPI rows. Select the annual reports for a cited comparison.") +
        diff,
      citations,
      limitations: [
        "Mock mode does not interpret arbitrary questions or call a model.",
        "Synthetic rounded figures; operating margin is derived as operating income / revenue.",
        "No EBITDA estimate or investment recommendation is produced.",
      ],
    };
  }
  async poll(a: Analysis): Promise<Snapshot> {
    if (a.status === "cancel_requested") return { state: "idle", items: [] };
    if (Date.now() - a.createdAt < this.duration)
      return { state: "in_progress", items: [] };
    return {
      state: "idle",
      items: [
        { id: "answer_" + a.id, role: "assistant", turn_id: "turn_" + a.id },
      ],
      result: this.result(a),
    };
  }
  async artifact(a: Analysis, name: ArtifactName) {
    if (Date.now() - a.createdAt < this.duration + this.syncDelay)
      return undefined;
    const res = this.result(a);
    if (name === "comparison.md")
      return Buffer.from(
        `# Synthetic comparison\n\n${res.answer}\n\n## Sources\n${res.citations.map((c) => `- ${c.documentId} / ${c.location}: ${c.quote}`).join("\n")}\n\n## Limitations\n${res.limitations.join("\n")}`,
      );
    const docs = selectDocs({ id: a.owner, scopes: [] }, a.documentIds);
    return Buffer.from(
      "company,fiscal_year,revenue_usd_billions,operating_income_usd_billions,source_document,source_section\n" +
        docs
          .filter((d) => d.kind === "report")
          .map(
            (d) =>
              `${d.id.startsWith("acme") ? "ACME" : "BETA"},2024,${d.text.match(/revenue was USD ([\d.]+)/)?.[1]},${d.text.match(/Operating income was USD ([\d.]+)/)?.[1]},${d.id},Financial performance`,
          )
          .join("\n") +
        "\n",
    );
  }
}
