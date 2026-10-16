import { ZodError } from "zod";
import { verifyReports } from "./report-verification.js";
import { randomUUID, createHash } from "node:crypto";
import {
  StartInput,
  Result,
  AppError,
  artifactNames,
  terminal,
  type Analysis,
  type Principal,
  type ArtifactName,
} from "./contracts.js";
import { listDocs, selectDocs } from "./catalog.js";
import { requireScope } from "./auth.js";
import { Store } from "./store.js";
import type { Provider } from "./provider.js";
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Sealed = Analysis & { hashes?: Record<ArtifactName, string> };
export class Service {
  private closed = false;
  private busy = new Set<string>();
  private watches = new Map<string, AbortController>();
  constructor(
    public store: Store,
    public provider: Provider,
    private maxMs = 300000,
  ) {
    // Crash during a non-idempotent phase has an uncertain outcome. Never replay it.
    for (const a of store.all())
      if (["creating", "submitting"].includes(a.status)) {
        a.status = a.providerId ? "reconciling" : "uncertain";
        a.error = "submission_outcome_unknown";
        store.save(a);
      }
  }
  docs(p: Principal) {
    requireScope(p);
    return listDocs(p).map(({ text, owners, ...d }) => d);
  }
  readDoc(p: Principal, id: string) {
    requireScope(p);
    const d = selectDocs(p, [id])[0];
    return { id: d.id, title: d.title, text: d.text };
  }
  list(p: Principal) {
    requireScope(p);
    return this.store.list(p).map((a) => this.view(a));
  }
  get(p: Principal, id: string) {
    requireScope(p);
    return this.view(this.store.get(p, id));
  }
  private view(a: Analysis) {
    const { owner, providerId, hashes, publicSummaries, ...v } = a as Sealed;
    return {
      ...v,
      mode: this.provider.mode,
      analysisDetails: {
        reasoningSummaries: {
          status:
            this.provider.mode === "mock"
              ? "unavailable_mock"
              : !this.provider.publicSummariesEnabled
                ? "disabled"
                : a.publicSummaries?.length
                  ? "available"
                  : "unavailable",
          summaries:
            this.provider.mode === "bedrock" &&
            this.provider.publicSummariesEnabled
              ? (publicSummaries ?? [])
              : [],
          notice:
            "Public model summaries describe the model's work. Check source evidence to verify findings.",
        },
      },
    };
  }
  async start(p: Principal, input: unknown) {
    requireScope(p);
    requireScope(p, true);
    const data = StartInput.parse(input);
    selectDocs(p, data.documentIds);
    const previous = this.store.byRequest(p, data.requestId);
    if (previous) {
      if (
        previous.question !== data.question ||
        JSON.stringify(previous.documentIds) !==
          JSON.stringify(data.documentIds)
      )
        throw new AppError(409, "request_id_conflict");
      return this.view(previous);
    }
    const own = this.store.list(p);
    if (
      own.filter((a) => !terminal(a.status)).length >= 2 ||
      own.filter((a) => Date.now() - a.createdAt < 3600000).length >= 20
    )
      throw new AppError(429, "analysis_limit");
    const a: Analysis = {
      id: randomUUID(),
      owner: p.id,
      ...data,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.insert(a);
    void this.prepare(a);
    return this.view(a);
  }
  private async prepare(a: Analysis) {
    if (this.busy.has(a.id)) return;
    this.busy.add(a.id);
    try {
      const docs = selectDocs({ id: a.owner, scopes: [] }, a.documentIds);
      a.status = "staging";
      this.store.save(a);
      await this.bounded(this.provider.stage(a, docs));
      if (
        this.store.get({ id: a.owner, scopes: [] }, a.id).status === "cancelled"
      )
        return;
      a.status = "creating";
      this.store.save(a);
      a.providerId = await this.bounded(this.provider.create(a));
      a.status = "submitting";
      this.store.save(a);
      if (this.provider.watch) {
        const ctl = new AbortController();
        this.watches.set(a.id, ctl);
        void this.provider
          .watch(
            a,
            () => {
              void this.refresh(a.id);
            },
            ctl.signal,
          )
          .catch(() => {});
      }
      await this.bounded(this.provider.submit(a, docs));
      a.status = "running";
      this.store.save(a);
    } catch {
      if (this.closed) return;
      a.status =
        a.status === "submitting" && a.providerId
          ? "reconciling"
          : ["creating", "submitting"].includes(a.status)
            ? "uncertain"
            : "failed";
      a.error = ["uncertain", "reconciling"].includes(a.status)
        ? "submission_outcome_unknown"
        : "preparation_failed";
      this.store.save(a);
      if (a.status !== "reconciling") this.stopWatch(a.id);
    } finally {
      this.busy.delete(a.id);
    }
  }
  private async bounded<T>(work: Promise<T>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppError(504, "operation_timeout")),
            this.maxMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async tick() {
    for (const a of this.store.all()) {
      if (a.status === "queued" || a.status === "staging") void this.prepare(a);
      else if (
        ["running", "reconciling", "syncing", "cancel_requested"].includes(
          a.status,
        )
      )
        await this.refresh(a.id);
    }
  }
  private stopWatch(id: string) {
    this.watches.get(id)?.abort();
    this.watches.delete(id);
  }
  async refresh(id: string) {
    if (this.busy.has(id)) return;
    const a = this.store.all().find((a) => a.id === id) as Sealed | undefined;
    if (
      !a ||
      !["running", "reconciling", "syncing", "cancel_requested"].includes(
        a.status,
      )
    )
      return;
    this.busy.add(id);
    try {
      if (Date.now() - a.createdAt > this.maxMs) {
        a.status = "uncertain";
        a.error = "monitor_timeout_work_may_continue";
        this.stopWatch(id);
        this.store.save(a);
        return;
      }
      const v = await this.bounded(this.provider.poll(a));
      if (this.provider.publicSummariesEnabled)
        a.publicSummaries = v.publicSummaries ?? [];
      delete a.error;
      if (v.state === "failed") {
        a.status = "failed";
        a.error = "managed_turn_failed";
        this.stopWatch(id);
      } else if (v.result && v.state === "idle") {
        const result = Result.parse(v.result);
        if (result.analysisId !== a.id)
          throw new AppError(502, "result_session_mismatch");
        const docs = selectDocs({ id: a.owner, scopes: [] }, a.documentIds);
        for (const c of result.citations)
          if (
            !docs.some((d) => d.id === c.documentId && d.text.includes(c.quote))
          )
            throw new AppError(502, "invalid_source_citation");
        a.status = "syncing";
        a.result = result;
        const outputs = await this.bounded(
          Promise.all(artifactNames.map((n) => this.provider.artifact(a, n))),
        );
        if (outputs.every((b) => b && b.length > 0 && b.length <= 524288)) {
          verifyReports(outputs[0]!, outputs[1]!, a, docs, result);
          a.hashes = Object.fromEntries(
            artifactNames.map((n, i) => [n, digest(outputs[i]!)]),
          ) as Record<ArtifactName, string>;
          a.artifactReady = true;
          a.status = "completed";
          this.stopWatch(id);
        }
      } else if (
        a.status === "cancel_requested" &&
        a.cancelAcknowledged &&
        v.state === "idle"
      ) {
        a.status = "cancelled";
        this.stopWatch(id);
      }
      this.store.save(a);
    } catch (e) {
      if (this.closed) return;
      if (
        e instanceof ZodError ||
        (e instanceof AppError &&
          [
            "invalid_source_citation",
            "result_session_mismatch",
            "invalid_csv",
            "invalid_report",
          ].includes(e.code))
      ) {
        a.status = "failed";
        a.error = e instanceof AppError ? e.code : "invalid_result_schema";
        this.stopWatch(id);
      } else a.error = "progress_temporarily_unavailable";
      this.store.save(a);
    } finally {
      this.busy.delete(id);
    }
  }

  async cancel(p: Principal, id: string) {
    requireScope(p);
    requireScope(p, true);
    const a = this.store.get(p, id);
    if (a.status === "cancelled") return this.view(a);
    if (["completed", "failed"].includes(a.status))
      throw new AppError(409, "analysis_terminal");
    if (this.busy.has(id)) throw new AppError(409, "operation_in_progress");
    if (!a.providerId) {
      if (a.status === "uncertain")
        throw new AppError(409, "provider_identity_unknown");
      a.status = "cancelled";
      this.store.save(a);
      return this.view(a);
    }
    a.status = "cancel_requested";
    a.cancelAcknowledged = false;
    this.store.save(a);
    this.busy.add(id);
    try {
      await this.bounded(this.provider.cancel(a));
      a.cancelAcknowledged = true;
      this.store.save(a);
    } catch {
      a.error = "cancel_outcome_unknown";
      this.store.save(a);
    } finally {
      this.busy.delete(id);
    }
    return this.view(a);
  }
  artifacts(p: Principal, id: string) {
    requireScope(p);
    const a = this.store.get(p, id);
    return {
      analysisId: id,
      status: a.status,
      artifacts: a.artifactReady
        ? artifactNames.map((name) => ({
            name,
            mimeType: name.endsWith("csv") ? "text/csv" : "text/markdown",
            available: true,
          }))
        : [],
    };
  }
  async download(p: Principal, id: string, name: string) {
    requireScope(p);
    const a = this.store.get(p, id) as Sealed;
    if (!artifactNames.includes(name as ArtifactName))
      throw new AppError(404, "artifact_not_found");
    if (a.status !== "completed" || !a.artifactReady)
      throw new AppError(409, "artifact_not_available");
    const b = await this.bounded(
      this.provider.artifact(a, name as ArtifactName),
    );
    if (!b || !a.hashes || digest(b) !== a.hashes[name as ArtifactName])
      throw new AppError(409, "artifact_changed_or_unavailable");
    return b;
  }
  close() {
    this.closed = true;
    for (const id of this.watches.keys()) this.stopWatch(id);
    this.store.close();
  }
}
