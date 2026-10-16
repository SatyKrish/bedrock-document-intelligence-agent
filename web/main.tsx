import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import "./style.css";
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Doc = { id: string; title: string; kind: string };
type Citation = { documentId: string; location: string; quote: string };
import type { IdentityConfig } from "./oidc.js";
type Pending = { documentIds: string[]; question: string; requestId: string };
type Analysis = {
  id: string;
  requestId: string;
  question: string;
  status: string;
  mode: string;
  error?: string;
  artifactReady?: boolean;
  analysisDetails?: {
    reasoningSummaries: {
      status: string;
      summaries: Array<{ id: string; turnId: string; text: string }>;
      notice: string;
    };
  };
  result?: { answer: string; citations: Citation[]; limitations: string[] };
};
const finished = (a: Analysis) =>
  ["completed", "failed", "cancelled", "uncertain"].includes(a.status);
function Message() {
  return (
    <MessagePrimitive.Root className="message">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
function App() {
  const [identity, setIdentity] = useState<IdentityConfig>();
  const [token, setToken] = useState(
    () => sessionStorage.getItem("docintel-demo") ?? "",
  );
  const [mode, setMode] = useState("mock");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [analysis, setAnalysis] = useState<Analysis>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{ title: string; text: string }>();
  const [connected, setConnected] = useState(true);
  const current = useRef<string | undefined>(undefined);
  const epoch = useRef(0);
  const [pending, setPending] = useState<Pending | undefined>(() => {
    try {
      return (
        JSON.parse(sessionStorage.getItem("docintel-pending") ?? "null") ??
        undefined
      );
    } catch {
      return undefined;
    }
  });
  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const version = epoch.current;
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (version !== epoch.current) throw Error("identity_changed");
      if (!res.ok) {
        const e = await res.json();
        throw new ApiError(res.status, e.error ?? "request_failed");
      }
      return res;
    },
    [token],
  );
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(async (c) => {
        setMode(c.mode);
        setIdentity(c.identity);
        if (c.mode === "bedrock") {
          sessionStorage.removeItem("docintel-demo");
          setToken("");
          if (c.identity && new URLSearchParams(location.search).has("code")) {
            const version = epoch.current;
            try {
              const { finishSignIn } = await import("./oidc.js");
              const accessToken = await finishSignIn(c.identity);
              if (version === epoch.current) {
                epoch.current++;
                setToken(accessToken);
              }
            } catch {
              setError(
                "Sign-in failed; verify approved identity configuration.",
              );
            }
          }
        }
      })
      .catch(() => setError("Service unavailable"));
  }, []);
  useEffect(() => {
    if (!token) return;
    let live = true;
    Promise.all([
      api("/api/documents").then((r) => r.json()),
      api("/api/analyses").then((r) => r.json()),
    ])
      .then(([d, h]) => {
        if (!live) return;
        setDocs(d.documents);
        setSelected(d.documents.map((x: Doc) => x.id));
        setHistory(h.analyses);
        const pendingText = sessionStorage.getItem("docintel-pending");
        const key = pendingText ? JSON.parse(pendingText).requestId : undefined;
        const recovered = h.analyses.find((x: Analysis) => x.requestId === key);
        if (recovered) {
          sessionStorage.removeItem("docintel-pending");
          setPending(undefined);
        }
        const id = sessionStorage.getItem("docintel-analysis");
        const a = recovered ?? h.analyses.find((x: Analysis) => x.id === id);
        setAnalysis(a);
        current.current = a?.id;
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [token, api]);
  useEffect(() => {
    if (!analysis?.id) return;
    const id = analysis.id;
    const abort = new AbortController();
    let stopped = false;
    const reconcile = async () => {
      const a = await (
        await api(`/api/analyses/${id}`, { signal: abort.signal })
      ).json();
      if (!stopped && current.current === id) {
        setAnalysis(a);
        setHistory((h) => [a, ...h.filter((x) => x.id !== id)]);
      }
      return a;
    };
    const monitor = async () => {
      while (!stopped) {
        try {
          const a = await reconcile();
          if (!stopped) setConnected(true);
          if (stopped || finished(a)) break;
          const response = await api(`/api/analyses/${id}/events`, {
            signal: abort.signal,
          });
          if (!response.body) throw Error();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          try {
            while (!stopped) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buf += decoder.decode(chunk.value, { stream: true });
              let boundary;
              while ((boundary = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, boundary);
                buf = buf.slice(boundary + 2);
                const line = frame
                  .split("\n")
                  .find((l) => l.startsWith("data: "));
                if (line) {
                  const next = JSON.parse(line.slice(6)) as Analysis;
                  if (!stopped && current.current === id) {
                    setAnalysis(next);
                    setHistory((h) => [next, ...h.filter((x) => x.id !== id)]);
                  }
                  if (finished(next)) {
                    await reader.cancel();
                    return;
                  }
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        } catch {
          if (stopped) break;
          setConnected(false);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void monitor();
    return () => {
      stopped = true;
      abort.abort();
    };
  }, [analysis?.id, api]);
  const submit = useCallback(
    async (data: Pending) => {
      const version = epoch.current;
      setBusy(true);
      setError("");
      sessionStorage.setItem("docintel-pending", JSON.stringify(data));
      setPending(data);
      try {
        const res = await api("/api/analyses", {
          method: "POST",
          body: JSON.stringify(data),
        });
        const a = await res.json();
        if (version !== epoch.current) return;
        sessionStorage.removeItem("docintel-pending");
        setPending(undefined);
        current.current = a.id;
        sessionStorage.setItem("docintel-analysis", a.id);
        setAnalysis(a);
        setHistory((h) => [a, ...h.filter((x) => x.id !== a.id)]);
      } catch (e) {
        if (version === epoch.current) {
          const definitive =
            e instanceof ApiError &&
            [400, 401, 403, 404, 409, 429].includes(e.status);
          if (definitive) {
            sessionStorage.removeItem("docintel-pending");
            setPending(undefined);
          }
          setError(
            (e as Error).message +
              (definitive
                ? ""
                : " · Request saved; retry safely with the same ID."),
          );
        }
      } finally {
        if (version === epoch.current) setBusy(false);
      }
    },
    [api],
  );
  const start = useCallback(
    async (message: Pick<AppendMessage, "content">) => {
      if (pending) {
        setError(
          "A prior request has an unknown outcome. Retry that saved request first.",
        );
        return;
      }
      const question = message.content
        .filter((c) => c.type === "text")
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      await submit({
        documentIds: selected,
        question,
        requestId: crypto.randomUUID(),
      });
    },
    [submit, selected, pending],
  );
  const readSource = async (id: string) => {
    const version = epoch.current;
    try {
      const d = await (await api(`/api/documents/${id}`)).json();
      if (version === epoch.current) setSource(d);
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    }
  };

  const cancel = useCallback(async () => {
    if (!analysis) return;
    const version = epoch.current;
    try {
      const a = await (
        await api(`/api/analyses/${analysis.id}/cancel`, { method: "POST" })
      ).json();
      if (version === epoch.current) setAnalysis(a);
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    }
  }, [api, analysis]);
  const messages = useMemo<ThreadMessageLike[]>(
    () =>
      analysis
        ? [
            { id: analysis.id + "u", role: "user", content: analysis.question },
            ...(analysis.result
              ? [
                  {
                    id: analysis.id + "a",
                    role: "assistant" as const,
                    content: analysis.result.answer,
                  },
                ]
              : []),
          ]
        : [],
    [analysis],
  );
  const running = busy || !!(analysis && !finished(analysis));
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (m: ThreadMessageLike) => m,
    isRunning: running,
    onNew: start,
    onCancel: cancel,
  });
  const login = (user: string) => {
    epoch.current++;
    sessionStorage.setItem("docintel-demo", "demo-" + user);
    setToken("demo-" + user);
    setError("");
  };
  const logout = () => {
    if (identity)
      void import("./oidc.js").then(({ oidc }) => oidc(identity).removeUser());
    epoch.current++;
    setBusy(false);
    setPending(undefined);
    sessionStorage.removeItem("docintel-pending");
    sessionStorage.removeItem("docintel-demo");
    sessionStorage.removeItem("docintel-analysis");
    current.current = undefined;
    setToken("");
    setAnalysis(undefined);
    setHistory([]);
    setSource(undefined);
    setDocs([]);
    setError("");
  };
  const download = async (name: string) => {
    if (!analysis) return;
    const version = epoch.current;
    try {
      const b = await (
        await api(`/api/analyses/${analysis.id}/artifacts/${name}`)
      ).blob();
      if (version !== epoch.current) return;
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    }
  };
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="mark">
            D<span>i</span>
          </span>
          <div>
            <strong>Document Intelligence</strong>
            <small>Amazon Bedrock Managed Agents · powered by OpenAI</small>
          </div>
        </div>
        <div className="header-actions">
          <span className="badge">
            {mode === "mock" ? "LOCAL MOCK" : "AWS PUBLIC PREVIEW"}
          </span>
          {token ? (
            <button className="quiet" onClick={logout}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      {!token ? (
        <main className="welcome">
          <div className="eyebrow">A SOURCE-FIRST WORKSPACE</div>
          <h1>
            From documents
            <br />
            to defensible answers.
          </h1>
          <p>
            Compare annual reports, inspect the evidence, and create reports you
            can take with you.
          </p>
          <div className="login-card">
            <h2>
              {mode === "mock"
                ? "Explore with synthetic data"
                : "Connect your approved identity"}
            </h2>
            <p>
              {mode === "mock"
                ? "Local deterministic demo. No AWS resources or model calls."
                : "Live access requires your organization's reviewed sign-in integration. See deployment gates."}
            </p>
            {mode === "mock" ? (
              <>
                <button onClick={() => login("alice")}>
                  Continue as Alice <span>→</span>
                </button>
                <button className="secondary" onClick={() => login("bob")}>
                  Continue as Bob · limited access
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={!identity}
                  onClick={() => {
                    if (identity)
                      void import("./oidc.js")
                        .then(({ oidc }) => oidc(identity).signinRedirect())
                        .catch(() => setError("Sign-in unavailable"));
                  }}
                >
                  Sign in with your organization
                </button>
                {!identity ? (
                  <p>
                    Configure the approved OIDC client before enabling this
                    surface.
                  </p>
                ) : null}
              </>
            )}
          </div>
          <small className="footnote">
            Public preview reference · text input · no subagents or built-in
            long-term memory
          </small>
        </main>
      ) : (
        <main className="workspace">
          <aside>
            <div className="eyebrow">YOUR DOCUMENTS</div>
            <h2>
              Source collection <span>{docs.length}</span>
            </h2>
            <p className="hint">Select the evidence for this analysis.</p>
            <div className="doc-list">
              {docs.map((d) => (
                <div key={d.id} className="doc">
                  <input
                    type="checkbox"
                    id={d.id}
                    checked={selected.includes(d.id)}
                    disabled={running}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, d.id]
                          : s.filter((x) => x !== d.id),
                      )
                    }
                  />
                  <label htmlFor={d.id}>
                    <span className="file-type">
                      {d.kind === "csv" ? "CSV" : "REPORT"}
                    </span>
                    <strong>{d.title}</strong>
                    <small>Synthetic · FY 2024</small>
                  </label>
                  <button
                    className="source-button"
                    aria-label={`Read ${d.title}`}
                    onClick={() => void readSource(d.id)}
                  >
                    ↗
                  </button>
                </div>
              ))}
            </div>
            <div className="history">
              <div className="eyebrow">RECENT ANALYSES</div>
              {history.slice(0, 6).map((a) => (
                <button
                  key={a.id}
                  className={a.id === analysis?.id ? "active" : ""}
                  onClick={() => {
                    current.current = a.id;
                    sessionStorage.setItem("docintel-analysis", a.id);
                    setAnalysis(a);
                  }}
                >
                  <strong>{a.question}</strong>
                  <small>{a.status.replaceAll("_", " ")}</small>
                </button>
              ))}
            </div>
            <div className="aside-note">
              {mode === "mock"
                ? "Fixture comparison only. Questions are saved, but not interpreted by a model."
                : "Managed execution in an isolated AgentCore runtime."}
            </div>
          </aside>
          <section className="analysis-pane">
            <div className="pane-heading">
              <div>
                <div className="eyebrow">ANALYST WORKSPACE</div>
                <h1>Ask. Examine. Export.</h1>
              </div>
              <span className="session-indicator">
                <i />
                {connected ? "Connected" : "Reconnecting"}
              </span>
            </div>
            {error ? (
              <div role="alert" className="error">
                {error.replaceAll("_", " ")}
              </div>
            ) : null}
            {pending ? (
              <div className="pending">
                <p>Saved request: {pending.question}</p>
                <button
                  className="secondary"
                  onClick={() => void submit(pending)}
                  disabled={busy}
                >
                  Retry saved analysis safely
                </button>
              </div>
            ) : null}
            <AssistantRuntimeProvider runtime={runtime}>
              <ThreadPrimitive.Root className="thread">
                <ThreadPrimitive.Viewport className="viewport">
                  <ThreadPrimitive.Empty>
                    <div className="empty">
                      <div className="empty-icon">⌕</div>
                      <h2>Every answer starts with evidence.</h2>
                      <p>
                        Select your sources, then compare revenue, margins, and
                        disclosed risks.
                      </p>
                      <button
                        className="suggestion"
                        disabled={!selected.length}
                        onClick={() =>
                          void start({
                            content: [
                              {
                                type: "text",
                                text: "Compare ACME and BETA's 2024 revenue and operating margins. Generate Markdown and CSV reports.",
                              },
                            ],
                          })
                        }
                      >
                        Compare the 2024 annual reports <span>↗</span>
                      </button>
                    </div>
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages
                    components={{
                      UserMessage: Message,
                      AssistantMessage: Message,
                    }}
                  />
                  {analysis ? (
                    <div
                      role="status"
                      className={`progress ${analysis.status}`}
                    >
                      <span>{analysis.status === "completed" ? "✓" : "◉"}</span>
                      <div>
                        <strong>{analysis.status.replaceAll("_", " ")}</strong>
                        <small>
                          {analysis.status === "syncing"
                            ? "Checking output availability before enabling downloads."
                            : analysis.status === "completed"
                              ? "Source quotes matched · files available"
                              : (analysis.error?.replaceAll("_", " ") ??
                                "Progress is saved. You can reconnect to this analysis.")}
                        </small>
                      </div>
                    </div>
                  ) : null}
                  {analysis?.result ? (
                    <div className="evidence">
                      <details className="analysis-details">
                        <summary>
                          Analysis details · public reasoning summaries
                        </summary>
                        <p>
                          {analysis.analysisDetails?.reasoningSummaries.notice}
                        </p>
                        {analysis.analysisDetails?.reasoningSummaries.status ===
                        "available" ? (
                          analysis.analysisDetails.reasoningSummaries.summaries.map(
                            (s) => (
                              <p key={JSON.stringify([s.turnId, s.id])}>
                                {s.text}
                              </p>
                            ),
                          )
                        ) : (
                          <p>
                            {mode === "mock"
                              ? "Unavailable in local mock mode. No model summary is manufactured."
                              : analysis.analysisDetails?.reasoningSummaries
                                    .status === "disabled"
                                ? "Optional public summary capture is disabled."
                                : "No supported public summary was returned for this run."}
                          </p>
                        )}
                      </details>
                      <h3>Source evidence</h3>
                      {analysis.result.citations.map((c, i) => (
                        <details key={i}>
                          <summary>
                            {c.documentId} <span>· {c.location}</span>
                          </summary>
                          <blockquote>{c.quote}</blockquote>
                        </details>
                      ))}
                      <h3>Limitations</h3>
                      <ul>
                        {analysis.result.limitations.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                      {analysis.artifactReady ? (
                        <div className="downloads">
                          <button
                            className="secondary"
                            onClick={() => void download("comparison.md")}
                          >
                            ↓ Markdown report
                          </button>
                          <button
                            className="secondary"
                            onClick={() => void download("kpis.csv")}
                          >
                            ↓ KPI CSV
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </ThreadPrimitive.Viewport>
                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input
                    aria-label="Analysis question"
                    placeholder="Ask a question about your selected documents…"
                    disabled={!selected.length}
                    rows={2}
                  />
                  <div className="composer-footer">
                    <small>
                      {selected.length} sources selected · text input
                    </small>
                    {running ? (
                      <ComposerPrimitive.Cancel
                        disabled={busy || !analysis}
                        className="secondary"
                      >
                        Request cancellation
                      </ComposerPrimitive.Cancel>
                    ) : (
                      <ComposerPrimitive.Send disabled={!selected.length}>
                        Analyze <span>↑</span>
                      </ComposerPrimitive.Send>
                    )}
                  </div>
                </ComposerPrimitive.Root>
              </ThreadPrimitive.Root>
            </AssistantRuntimeProvider>
            <p className="workspace-footnote">
              Synthetic demonstration data. Verify source evidence before using
              a result.
            </p>
          </section>
        </main>
      )}
      {source ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label={source.title}
        >
          <div>
            <button
              className="quiet"
              onClick={() => setSource(undefined)}
              autoFocus
            >
              Close source ×
            </button>
            <h2>{source.title}</h2>
            <pre>{source.text}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
