"use client";

import {
  AlertCircle,
  ArrowDown,
  Bot,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Database,
  Key,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Terminal,
  Zap,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageMetadata = {
  resolution_source?: string;
  model_used?: string;
  latency_ms?: number;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  key_index_used?: number | null;
  fallback_attempts?: number;
};

type ChatMessage =
  | {
    id: string;
    role: "user";
    content: string;
  }
  | {
    id: string;
    role: "assistant";
    content: string;
    status: "loading" | "success" | "error";
    metadata?: MessageMetadata;
    error?: string;
    retryMessageId?: string;
  };

type ChatResponse = {
  reply?: string | null;
  error?: string;
  metadata?: MessageMetadata;
};

type DebugKeyInfo = {
  key_index: number;
  simulated_down: boolean;
  usage_count: number;
};

type DebugStatus = {
  simulated_down: number[];
  key_states: DebugKeyInfo[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ID_KEY = "chat-session-id";
const MESSAGES_KEY = "chat-messages";
const COLD_START_THRESHOLD_MS = 20000; // 20s: only triggers for genuine free-tier host sleep, never during failover

const EXAMPLE_PROMPTS = [
  "What is the capital of France?",
  "Explain quantum computing briefly.",
  "Write a haiku about the ocean.",
  "What is 17 × 24?",
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function createUuid(): string {
  if (typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function getResolutionSource(source?: string): "LLM_CACHE" | "LIVE_INFERENCE" {
  return source === "LLM_CACHE" ? "LLM_CACHE" : "LIVE_INFERENCE";
}

function saveMessages(messages: ChatMessage[]): void {
  try { localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages)); } catch { /* */ }
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return parsed.map((m) =>
      m.role === "assistant" && m.status === "loading"
        ? { ...m, status: "error" as const, error: "Session interrupted. Please retry." }
        : m
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugStatus, setDebugStatus] = useState<DebugStatus | null>(null);
  const [debugPending, setDebugPending] = useState<number | null>(null);
  const [debugError, setDebugError] = useState("");
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [coldStartNotice, setColdStartNotice] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const coldStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiBaseUrl = getApiBaseUrl();

  // Init session + restore history
  useEffect(() => {
    let id = "";
    try { id = localStorage.getItem(SESSION_ID_KEY) || ""; } catch { /* */ }
    if (!id) id = createUuid();
    setSessionId(id);
    try { localStorage.setItem(SESSION_ID_KEY, id); } catch { /* */ }
    const saved = loadMessages();
    if (saved.length > 0) setMessages(saved);
  }, []);

  // Persist messages
  useEffect(() => {
    if (messages.length > 0) saveMessages(messages);
  }, [messages]);

  // Auto-scroll
  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Fetch debug status when panel opens
  useEffect(() => {
    if (debugOpen && apiBaseUrl) void fetchDebugStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugOpen, apiBaseUrl]);

  const fetchDebugStatus = useCallback(async () => {
    if (!apiBaseUrl) return;
    try {
      const r = await fetch(`${apiBaseUrl}/debug/status`);
      if (r.ok) setDebugStatus(await r.json() as DebugStatus);
    } catch { /* non-critical */ }
  }, [apiBaseUrl]);

  // Core send function
  const sendRequest = useCallback(
    async (message: string, assistantMessageId: string) => {
      setIsSending(true);
      setNotice("");
      setColdStartNotice(false);
      setMessages((cur) =>
        cur.map((m) =>
          m.id === assistantMessageId && m.role === "assistant"
            ? { ...m, status: "loading", content: "", error: undefined }
            : m
        )
      );

      const isLocalhost = !apiBaseUrl || apiBaseUrl.includes("localhost") || apiBaseUrl.includes("127.0.0.1");
      if (!isLocalhost) {
        coldStartTimerRef.current = setTimeout(() => setColdStartNotice(true), COLD_START_THRESHOLD_MS);
      }

      try {
        if (!apiBaseUrl) throw new Error("Set NEXT_PUBLIC_API_BASE_URL in frontend/.env to connect to your API.");
        if (!sessionId) throw new Error("Session is still initialising. Please try again.");

        const response = await fetch(`${apiBaseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message, system_prompt: systemPrompt || undefined }),
        });

        const payload = (await response.json().catch(() => null)) as ChatResponse | null;

        if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
        if (payload?.error) throw new Error(payload.error);
        if (typeof payload?.reply !== "string") throw new Error("The API returned no reply. Please retry.");

        setMessages((cur) =>
          cur.map((m) =>
            m.id === assistantMessageId && m.role === "assistant"
              ? { ...m, status: "success", content: payload.reply as string, metadata: payload.metadata ?? {}, error: undefined }
              : m
          )
        );
      } catch (error) {
        const msg = errorMessage(error);
        setMessages((cur) =>
          cur.map((m) =>
            m.id === assistantMessageId && m.role === "assistant"
              ? { ...m, status: "error", error: msg }
              : m
          )
        );
      } finally {
        setIsSending(false);
        setColdStartNotice(false);
        if (coldStartTimerRef.current) clearTimeout(coldStartTimerRef.current);
      }
    },
    [apiBaseUrl, sessionId, systemPrompt]
  );

  const submitMessage = useCallback(
    (rawMessage: string) => {
      const message = rawMessage.trim();
      if (!message || isSending || isResetting) return;
      const userMessageId = createUuid();
      const assistantMessageId = createUuid();
      setMessages((cur) => [
        ...cur,
        { id: userMessageId, role: "user", content: message },
        { id: assistantMessageId, role: "assistant", content: "", status: "loading", retryMessageId: userMessageId },
      ]);
      setDraft("");
      if (composerRef.current) composerRef.current.style.height = "auto";
      void sendRequest(message, assistantMessageId);
    },
    [isSending, isResetting, sendRequest]
  );

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submitMessage(draft);
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage(draft);
    }
  }

  async function startNewChat() {
    if (!sessionId || isResetting || isSending) return;
    setNotice("");
    setIsResetting(true);
    try {
      if (apiBaseUrl) {
        await fetch(`${apiBaseUrl}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      }
      const nextId = createUuid();
      setSessionId(nextId);
      try { localStorage.setItem(SESSION_ID_KEY, nextId); } catch { /* */ }
      try { localStorage.removeItem(MESSAGES_KEY); } catch { /* */ }
      setMessages([]);
      setDraft("");
      setDebugError("");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setIsResetting(false);
    }
  }

  async function toggleFailKey(keyIndex: number, currentlyDown: boolean) {
    if (!apiBaseUrl) { setDebugError("Set NEXT_PUBLIC_API_BASE_URL before using debug controls."); return; }
    setDebugPending(keyIndex);
    setDebugError("");
    try {
      const state = currentlyDown ? "off" : "on";
      const r = await fetch(`${apiBaseUrl}/debug/fail-key/${keyIndex}/${state}`, { method: "POST" });
      if (!r.ok) throw new Error(`Failed to update key ${keyIndex} (${r.status}).`);
      await fetchDebugStatus();
    } catch (error) {
      setDebugError(errorMessage(error));
    } finally {
      setDebugPending(null);
    }
  }

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    setShowScrollButton(el.scrollHeight - el.scrollTop - el.clientHeight > 180);
  }

  function retryMessage(msg: Extract<ChatMessage, { role: "assistant" }>) {
    const userMsg = messages.find((m) => m.role === "user" && m.id === msg.retryMessageId);
    if (userMsg?.role === "user") void sendRequest(userMsg.content, msg.id);
  }

  const userMessageCount = messages.filter((m) => m.role === "user").length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="app-shell">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="header-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 className="header-title">Resilient AI Chat</h1>
              <span className="header-badge">LiteLLM</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontSize: 10, color: "var(--text-dim)" }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: apiBaseUrl ? "var(--emerald-bright)" : "var(--amber-bright)",
                display: "inline-block"
              }} />
              {apiBaseUrl ? "API connected" : "API base URL not configured"}
            </div>
          </div>
        </div>

        <div className="header-actions">
          {sessionId && (
            <div className="session-chip" style={{ display: "none" }}>
              <ShieldCheck size={11} />
              <span>Session</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{sessionId.slice(0, 8)}…</span>
            </div>
          )}
          {/* Show session on wider screens via inline media style */}
          <div className="session-chip" style={{ display: "flex" }}>
            <span className="session-dot" />
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {sessionId ? `${sessionId.slice(0, 8)}…` : "init…"}
            </span>
          </div>

          <button
            type="button"
            onClick={startNewChat}
            disabled={!sessionId || isResetting || isSending}
            id="new-chat-btn"
            className="btn-ghost"
          >
            {isResetting
              ? <LoaderCircle size={14} className="animate-spin" />
              : <SquarePen size={14} />}
            <span>{isResetting ? "Starting…" : "New chat"}</span>
          </button>

          <button
            type="button"
            onClick={() => setSidebarMobileOpen((o) => !o)}
            id="toggle-sidebar-btn"
            className="btn-ghost sidebar-toggle-btn"
            aria-label="Toggle settings and debug panels"
          >
            <Settings2 size={14} />
            <span>{sidebarMobileOpen ? "Close" : "Panels"}</span>
          </button>
        </div>
      </header>

      {/* ── Two-column content ── */}
      <div className="content-grid">
        {sidebarMobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setSidebarMobileOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* ── LEFT: Chat panel (fixed height, internal scroll) ── */}
        <section className="chat-panel" style={{ position: "relative" }}>

          {/* Chat top bar */}
          <div className="chat-topbar">
            <div className="chat-topbar-left">
              <MessageSquare size={15} color="var(--violet)" />
              <span>Conversation</span>
              {userMessageCount > 0 && (
                <span className="chat-count-pill">{userMessageCount}</span>
              )}
            </div>
            <div className="chat-topbar-right">
              <span className="method-pill">POST</span>
              <span>/chat</span>
            </div>
          </div>

          {/* Notice bars (shrink, not scroll) */}
          {notice && (
            <div className="notice-bar error">
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{notice}</span>
              <button className="dismiss-btn" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
            </div>
          )}
          {coldStartNotice && (
            <div className="notice-bar warn">
              <Zap size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Waking up the server — this can take up to a minute on free hosting…</span>
            </div>
          )}

          {/* ── Scrollable message area ── */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="chat-scroll"
          >
            {messages.length === 0 ? (
              /* Empty state — always shows the chat panel with input */
              <div className="empty-state">
                <div className="empty-icon-wrap">
                  <div className="empty-icon-glow" />
                  <div className="empty-icon">
                    <Sparkles size={26} strokeWidth={1.6} />
                  </div>
                </div>

                <p className="empty-label">Ready when you are</p>
                <h2 className="empty-title">Send your first message</h2>
                <p className="empty-sub">
                  Each reply shows source, model, latency, tokens, and which key answered.
                </p>

                {!apiBaseUrl && (
                  <div className="api-warn-box">
                    <CircleHelp size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      Add <code style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>NEXT_PUBLIC_API_BASE_URL</code>{" "}
                      to <code style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>frontend/.env</code> to connect your API.
                    </span>
                  </div>
                )}

                <div className="example-chips">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => submitMessage(prompt)}
                      disabled={isSending || !sessionId}
                      className="chip-btn"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages-list" aria-live="polite">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="msg-user">
                      <div className="user-bubble">{message.content}</div>
                      <div className="user-avatar">YOU</div>
                    </div>
                  ) : (
                    <div key={message.id} className="msg-ai">
                      <div className="ai-avatar">
                        <Bot size={16} strokeWidth={1.7} />
                      </div>
                      <div className="ai-body">
                        {message.status === "loading" ? (
                          <div className="loading-bubble">
                            <LoaderCircle size={14} className="animate-spin" color="var(--violet)" />
                            <span>Generating response</span>
                            <div className="loading-dots" aria-hidden="true">
                              <span /><span /><span />
                            </div>
                          </div>
                        ) : message.status === "error" ? (
                          <div className="error-bubble">
                            <div className="error-text">
                              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                              <p>{message.error}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => retryMessage(message)}
                              disabled={isSending}
                              id={`retry-${message.id}`}
                              className="retry-btn"
                            >
                              <RotateCcw size={12} />
                              Retry
                            </button>
                          </div>
                        ) : (
                          <>
                            <p className="ai-text">{message.content}</p>
                            <MetadataBar metadata={message.metadata} />
                          </>
                        )}
                      </div>
                    </div>
                  )
                )}
                <div ref={endOfMessagesRef} />
              </div>
            )}
          </div>

          {/* Scroll-to-bottom button */}
          {showScrollButton && (
            <button
              type="button"
              className="scroll-btn"
              onClick={() => endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" })}
              aria-label="Scroll to latest message"
            >
              <ArrowDown size={15} />
            </button>
          )}

          {/* ── Composer — always anchored to bottom ── */}
          <div className="composer-wrap">
            <form onSubmit={handleSubmit} className="composer-box">
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleComposerKeyDown}
                placeholder="Write a message…"
                aria-label="Write a message"
                id="message-composer"
                rows={1}
                maxLength={4000}
                className="composer-input"
              />
              <button
                type="submit"
                id="send-btn"
                disabled={!draft.trim() || isSending || isResetting}
                className="btn-send"
                aria-label="Send message"
              >
                {isSending
                  ? <LoaderCircle size={16} className="animate-spin" />
                  : <Send size={15} style={{ transform: "translateX(-1px)" }} />}
              </button>
            </form>
            <div className="composer-footer">
              <span>Enter to send · Shift+Enter for new line</span>
              <span>{draft.length.toLocaleString()} / 4,000</span>
            </div>
          </div>
        </section>

        {/* ── RIGHT: Sidebar ── */}
        <aside className={`sidebar ${sidebarMobileOpen ? "mobile-open" : ""}`}>

          {/* Settings panel */}
          <div className={`panel-card ${settingsOpen ? "open" : ""}`}>
            <button
              type="button"
              className="panel-header"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-expanded={settingsOpen}
              id="settings-accordion-btn"
            >
              <span className="panel-icon violet"><Settings2 size={16} /></span>
              <span className="panel-label">
                <span className="panel-title">Settings</span>
                <span className="panel-sub">System behavior & prompt</span>
              </span>
              <ChevronDown size={16} className={`panel-chevron ${settingsOpen ? "open" : ""}`} />
            </button>

            {settingsOpen && (
              <div className="panel-body">
                <label htmlFor="system-prompt" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 2 }}>
                  <span>System prompt</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 500 }}>Optional context</span>
                </label>
                <textarea
                  id="system-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Set role or instructions for the assistant (e.g., 'You are a concise expert engineer.')…"
                  rows={4}
                  className="panel-textarea"
                />
                <p className="panel-hint">Injected as system instructions with every message in this session.</p>
                <div className="panel-code-tag">
                  <Code2 size={12} />
                  <span>Backend parameter:</span>
                  <code style={{ background: "var(--bg-panel)", padding: "1px 6px", borderRadius: 4, color: "var(--indigo)", fontWeight: 600 }}>system_prompt</code>
                </div>
              </div>
            )}
          </div>

          {/* Debug panel */}
          <div className={`panel-card ${debugOpen ? "open" : ""}`}>
            <button
              type="button"
              className="panel-header"
              onClick={() => { setDebugOpen((o) => !o); setDebugError(""); }}
              aria-expanded={debugOpen}
              id="debug-accordion-btn"
            >
              <span className="panel-icon amber"><Terminal size={16} /></span>
              <span className="panel-label">
                <span className="panel-title">Debug controls</span>
                <span className="panel-sub">Simulate key failures (429)</span>
              </span>
              <ChevronDown size={16} className={`panel-chevron ${debugOpen ? "open" : ""}`} />
            </button>

            {debugOpen && (
              <div className="panel-body">
                <div className="debug-tip">
                  <Zap size={14} style={{ flexShrink: 0, marginTop: 1, color: "var(--amber-bright)" }} />
                  <div>
                    Toggle a key <strong>OFF</strong> to simulate a 429 quota exhaustion. Send a message to see LiteLLM automatically fail over to Key 2!
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(debugStatus?.key_states && debugStatus.key_states.length > 0
                    ? debugStatus.key_states
                    : [
                      { key_index: 1, simulated_down: false, usage_count: 0 },
                      { key_index: 2, simulated_down: false, usage_count: 0 },
                    ]
                  ).map((info) => {
                    const keyNum = info.key_index;
                    const isDown = info.simulated_down;
                    const usageCount = info.usage_count;
                    const busy = debugPending === keyNum;
                    return (
                      <button
                        key={keyNum}
                        type="button"
                        role="switch"
                        aria-checked={!isDown}
                        aria-label={`Toggle Key ${keyNum} state`}
                        id={`fail-key-${keyNum}`}
                        disabled={debugPending !== null}
                        onClick={() => void toggleFailKey(keyNum, isDown)}
                        className={`toggle-btn ${isDown ? "is-failed" : ""}`}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{
                            width: 26, height: 26, display: "grid", placeItems: "center",
                            borderRadius: 6,
                            border: isDown ? "1.5px solid rgba(225,29,72,0.3)" : "1.5px solid rgba(5,150,105,0.3)",
                            background: isDown ? "var(--rose-soft)" : "var(--emerald-soft)",
                            fontFamily: "var(--font-mono)", fontSize: 11,
                            color: isDown ? "var(--rose)" : "var(--emerald)", fontWeight: 700,
                          }}>
                            {keyNum}
                          </span>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontWeight: 700, fontSize: 12 }}>Key #{keyNum}</span>
                              {isDown ? (
                                <span className="key-status-pill down">DOWN (429)</span>
                              ) : (
                                <span className="key-status-pill healthy">ACTIVE</span>
                              )}
                            </div>
                            {usageCount > 0 && (
                              <span style={{
                                fontSize: 9, fontFamily: "var(--font-mono)", fontWeight: 700,
                                padding: "1px 6px", borderRadius: 999,
                                background: "var(--violet-soft)", color: "var(--violet)",
                                border: "1px solid rgba(109,40,217,0.15)",
                              }}>
                                {usageCount} live call{usageCount > 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className={`toggle-track ${isDown ? "is-down" : ""}`} title={isDown ? "Key is simulated down. Click to restore." : "Key is active. Click to simulate 429."}>
                          <div className="toggle-thumb">
                            {busy && <LoaderCircle size={9} className="animate-spin" color="#fff" />}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {debugError && (
                  <div className="debug-error" role="alert">
                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{debugError}</span>
                  </div>
                )}

                <div className="panel-code-tag">
                  <Code2 size={12} />
                  <span>Endpoint:</span>
                  <code style={{ background: "var(--bg-panel)", padding: "1px 6px", borderRadius: 4, color: "var(--indigo)", fontSize: 10 }}>
                    POST /debug/fail-key/:n/:state
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Metadata legend */}
          <div className="legend-card">
            <div className="card-title">
              <Database size={12} />
              Per-response metadata
            </div>
            <div className="legend-badges">
              <span className="meta-badge cache">
                <span className="meta-dot cache" />
                LLM_CACHE
              </span>
              <span className="meta-badge live">
                <span className="meta-dot live" />
                LIVE_INFERENCE
              </span>
            </div>
            <p className="legend-hint">
              Source, model, latency, tokens, and key info shown below each reply.
            </p>
          </div>

          {/* Quick test guide */}
          <div className="quick-guide">
            <div className="card-title">
              <Key size={12} />
              Quick test guide
            </div>
            <ol className="guide-list">
              {[
                <>Send <em>&quot;What is the capital of France?&quot;</em> → <span style={{ color: "var(--cyan)", fontWeight: 600 }}>LIVE_INFERENCE</span></>,
                <>Click <strong>New chat</strong>, same message → <span style={{ color: "var(--emerald)", fontWeight: 600 }}>LLM_CACHE</span> (lower latency)</>,
                <>Open Debug, toggle Key 1 off, new message → see <code style={{ fontFamily: "var(--font-mono)", fontSize: 9 }}>key_index_used = 2</code></>,
                <>Toggle all keys off → friendly error bubble, no crash</>,
              ].map((step, i) => (
                <li key={i} className="guide-step">
                  <span className="guide-num">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetadataBar component
// ---------------------------------------------------------------------------

function MetadataBar({ metadata }: { metadata?: MessageMetadata }) {
  const source = getResolutionSource(metadata?.resolution_source);
  const cached = source === "LLM_CACHE";
  const model = metadata?.model_used || "Unknown model";
  const latency = Number.isFinite(metadata?.latency_ms) ? metadata?.latency_ms : "—";
  const inputTokens = Number.isFinite(metadata?.token_usage?.input_tokens)
    ? metadata?.token_usage?.input_tokens
    : "—";
  const outputTokens = Number.isFinite(metadata?.token_usage?.output_tokens)
    ? metadata?.token_usage?.output_tokens
    : "—";
  const keyUsed = metadata?.key_index_used ?? null;
  const fallbacks = metadata?.fallback_attempts ?? 0;

  return (
    <div className="meta-bar">
      {/* Resolution source */}
      <span className={`meta-badge ${cached ? "cache" : "live"}`}>
        <span className={`meta-dot ${cached ? "cache" : "live"}`} />
        {source}
      </span>

      {/* Model */}
      <span className="meta-item" title={model} style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {model}
      </span>

      {/* Latency */}
      <span className="meta-item">
        <Clock3 size={10} />
        {latency} ms
      </span>

      {/* Token usage */}
      <span className="meta-item">
        In: {inputTokens} | Out: {outputTokens}
      </span>

      {/* Key used */}
      {keyUsed !== null && (
        <span className="meta-key-badge">
          <Key size={9} />
          Key #{keyUsed}
        </span>
      )}

      {/* Fallbacks */}
      {fallbacks > 0 && (
        <span className="meta-fallback-badge">
          {fallbacks} fallback{fallbacks > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
