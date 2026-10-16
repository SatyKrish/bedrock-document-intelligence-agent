import type { PublicSummary } from "./public-summaries.js";
import type {
  Analysis,
  AnalysisResult,
  ArtifactName,
  Doc,
} from "./contracts.js";
export type Snapshot = {
  state: "idle" | "in_progress" | "failed";
  items: Array<{
    id: string;
    role?: string;
    turn_id?: string;
    type?: string;
    exit_code?: number;
  }>;
  publicSummaries?: PublicSummary[];
  result?: AnalysisResult;
};
export interface Provider {
  readonly publicSummariesEnabled?: boolean;
  readonly mode: "mock" | "bedrock";
  stage(a: Analysis, docs: Doc[]): Promise<void>;
  create(a: Analysis): Promise<string>;
  submit(a: Analysis, docs: Doc[]): Promise<void>;
  poll(a: Analysis): Promise<Snapshot>;
  cancel(a: Analysis): Promise<void>;
  artifact(a: Analysis, name: ArtifactName): Promise<Buffer | undefined>;
  watch?(a: Analysis, notify: () => void, signal: AbortSignal): Promise<void>;
}
