import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Doc, Principal } from "./contracts.js";
import { z } from "zod";
import { AppError } from "./contracts.js";
const root = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const documents: Doc[] = [
  {
    id: "acme-2024",
    title: "ACME · Annual report 2024",
    filename: "acme-2024.md",
    kind: "report",
    owners: ["alice", "bob"],
  },
  {
    id: "beta-2024",
    title: "BETA · Annual report 2024",
    filename: "beta-2024.md",
    kind: "report",
    owners: ["alice"],
  },
  {
    id: "kpis-2024",
    title: "2024 KPI dataset",
    filename: "kpis-2024.csv",
    kind: "csv",
    owners: ["alice"],
  },
].map((d) => ({
  ...d,
  kind: d.kind as Doc["kind"],
  text: readFileSync(root + d.filename, "utf8"),
}));
export function configureCatalog(data: unknown) {
  const acl = z
    .record(z.array(z.enum(["acme-2024", "beta-2024", "kpis-2024"])))
    .parse(data);
  for (const d of documents)
    d.owners = Object.entries(acl)
      .filter(([, ids]) => (ids as string[]).includes(d.id))
      .map(([subject]) => subject);
}
// The synthetic catalog intentionally uses exact OIDC subjects alice/bob. Replace this
// with reviewed ACL data before onboarding real identities; never map by display name.
export const listDocs = (p: Principal) =>
  documents.filter((d) => d.owners.includes(p.id));
export const selectDocs = (p: Principal, ids: string[]) => {
  if (new Set(ids).size !== ids.length)
    throw new AppError(400, "duplicate_documents");
  return ids.map((id) => {
    const d = listDocs(p).find((d) => d.id === id);
    if (!d) throw new AppError(404, "document_not_found");
    return d;
  });
};
