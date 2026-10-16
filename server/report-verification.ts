import {
  AppError,
  type Analysis,
  type AnalysisResult,
  type Doc,
} from "./contracts.js";
// This vertical slice supports a deliberately narrow plain-cell CSV contract.
// Reject quoting rather than incorrectly decoding spreadsheet formula strings.
export function verifyReports(
  md: Buffer,
  csv: Buffer,
  a: Analysis,
  docs: Doc[],
  result: AnalysisResult,
) {
  const markdown = md.toString("utf8");
  if (
    !markdown.includes(result.answer) ||
    result.citations.some((c) => !markdown.includes(c.quote))
  )
    throw new AppError(502, "invalid_report");
  const rows = csv.toString("utf8").trim().split(/\r?\n/);
  if (
    rows[0] !==
    "company,fiscal_year,revenue_usd_billions,operating_income_usd_billions,source_document,source_section"
  )
    throw new AppError(502, "invalid_csv");
  const expected = docs
    .filter((d) => d.kind === "report")
    .map((d) => {
      const company = d.text.match(/^# ([A-Z]+) Corporation/)?.[1];
      const revenue = d.text.match(
        /revenue was USD ([\d.]+) billion in fiscal (\d{4})/,
      );
      const income = d.text.match(
        /Operating income was USD ([\d.]+) billion in fiscal (\d{4})/,
      );
      if (!company || !revenue || !income || revenue[2] !== income[2])
        throw new AppError(502, "invalid_csv");
      return [
        company,
        revenue[2],
        revenue[1],
        income[1],
        d.id,
        "Financial performance",
      ];
    });
  if (rows.length - 1 !== expected.length)
    throw new AppError(502, "invalid_csv");
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const fields = row.split(",");
    if (
      fields.length !== 6 ||
      fields.some((v) => /["\x00-\x1f]/.test(v) || /^[\s]*[=+@-]/.test(v)) ||
      !/^\d{4}$/.test(fields[1]) ||
      ![fields[2], fields[3]].every((v) => /^\d+(\.\d+)?$/.test(v)) ||
      !a.documentIds.includes(fields[4])
    )
      throw new AppError(502, "invalid_csv");
    const source = expected.find((e) => e[4] === fields[4]);
    if (
      !source ||
      seen.has(fields[4]) ||
      fields.some((v, i) =>
        i === 2 || i === 3 ? Number(v) !== Number(source[i]) : v !== source[i],
      )
    )
      throw new AppError(502, "invalid_csv");
    seen.add(fields[4]);
  }
}
