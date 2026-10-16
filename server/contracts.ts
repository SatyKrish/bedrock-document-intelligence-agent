import type { PublicSummary } from "./public-summaries.js";
import { z } from "zod";
export const StartInput = z
  .object({
    documentIds: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .min(1)
      .max(4),
    question: z.string().trim().min(3).max(4000),
    requestId: z.string().uuid(),
  })
  .strict();
export type Start = z.infer<typeof StartInput>;
export type Principal = { id: string; scopes: string[]; expiresAt?: number };
export type Doc = {
  id: string;
  title: string;
  filename: string;
  kind: "report" | "csv";
  owners: string[];
  text: string;
};
export const Citation = z
  .object({
    documentId: z.string(),
    location: z.string().min(1).max(120),
    quote: z.string().min(5).max(500),
  })
  .strict();
export const Result = z
  .object({
    analysisId: z.string().uuid(),
    answer: z.string().min(1).max(20000),
    citations: z.array(Citation).min(1).max(30),
    limitations: z.array(z.string().max(1000)).max(10),
  })
  .strict();
export type AnalysisResult = z.infer<typeof Result>;
export type State =
  | "queued"
  | "staging"
  | "creating"
  | "submitting"
  | "running"
  | "reconciling"
  | "syncing"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "uncertain";
export type Analysis = {
  id: string;
  owner: string;
  requestId: string;
  documentIds: string[];
  question: string;
  status: State;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  result?: AnalysisResult;
  error?: string;
  artifactReady?: boolean;
  publicSummaries?: PublicSummary[];
  cancelAcknowledged?: boolean;
};
export const artifactNames = ["comparison.md", "kpis.csv"] as const;
export type ArtifactName = (typeof artifactNames)[number];
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const terminal = (s: State) =>
  ["completed", "cancelled", "failed", "uncertain"].includes(s);
