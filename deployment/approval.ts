import { createHash } from "node:crypto";
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export type Plan = {
  version: 1;
  phase: "build" | "deploy" | "cleanup";
  configuration: unknown;
  sourceDigest: string;
  templates: Record<string, unknown>;
  images?: Record<string, string>;
  createdAt: string;
  expiresAt: string;
  retainData: true;
  costAllowanceUsd: number;
  id: string;
};
export function sealPlan(data: Omit<Plan, "id">): Plan {
  return { ...data, id: digest(canonical(data)) };
}
export function verifyPlan(
  plan: Plan,
  approval: string,
  config: unknown,
  sourceDigest: string,
  now = Date.now(),
) {
  const { id, ...body } = plan;
  if (id !== digest(canonical(body)) || approval !== id)
    throw Error("Approval must match the exact intact plan ID");
  if (
    canonical(plan.configuration) !== canonical(config) ||
    plan.sourceDigest !== sourceDigest
  )
    throw Error(
      "Configuration or source changed; generate and review a new plan",
    );
  if (
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    Date.parse(plan.expiresAt) < now
  )
    throw Error("Plan expired; generate a new plan");
  if (plan.retainData !== true)
    throw Error("Only retain-data cleanup is supported");
}
