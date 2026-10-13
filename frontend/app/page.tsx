"use client";

import {
  AlertCircle,
  ArrowDown,
  Bot,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Command,
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
const COLD_START_THRESHOLD_MS = 5000;

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

function getResolutionSource(source?: string): string {
  return source === "LLM_CACHE" ? "LLM_CACHE" : "LIVE_INFERENCE";
}

function saveMessages(messages: ChatMessage[]): void {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    // Storage might be blocked
  }
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Filter out any messages stuck in "loading" state (from a previous crash)
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

  // ---- Init session + restore history ----
  useEffect(() => {
    let id = "";
    try { id = localStorage.getItem(SESSION_ID_KEY) || ""; } catch { /* */ }
    if (!id) id = createUuid();
    setSessionId(id);
    try { localStorage.setItem(SESSION_ID_KEY, id); } catch { /* */ }

    // Restore messages from localStorage (includes per-message metadata)
    const saved = loadMessages();
    if (saved.length > 0) {
      setMessages(saved);
    }
  }, []);

  // ---- Persist messages whenever they change ----
  useEffect(() => {
    if (messages.length > 0) saveMessages(messages);
  }, [messages]);

  // ---- Auto-scroll on new messages ----
  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // ---- Fetch debug status when panel opens ----
  useEffect(() => {
    if (debugOpen && apiBaseUrl) {
      void fetchDebugStatus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugOpen, apiBaseUrl]);

  const fetchDebugStatus = useCallback(async () => {
    if (!apiBaseUrl) return;
    try {
      const r = await fetch(`${apiBaseUrl}/debug/status`);
      if (r.ok) setDebugStatus(await r.json() as DebugStatus);
    } catch { /* non-critical */ }
  }, [apiBaseUrl]);

  // ---- Core send function ----
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

      // Cold-start notice after 5 seconds
      coldStartTimerRef.current = setTimeout(() => {
        setColdStartNotice(true);
      }, COLD_START_THRESHOLD_MS);

      try {
        if (!apiBaseUrl) {
          throw new Error("Set NEXT_PUBLIC_API_BASE_URL in frontend/.env to connect to your API.");
        }
        if (!sessionId) {
          throw new Error("Session is still initialising. Please try again.");
        }

        const response = await fetch(`${apiBaseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message, system_prompt: systemPrompt || undefined }),
        });

        const payload = (await response.json().catch(() => null)) as ChatResponse | null;

        if (!response.ok) {
          throw new Error(payload?.error || `Request failed (${response.status}).`);
        }
        if (payload?.error) {
          throw new Error(payload.error);
        }
        if (typeof payload?.reply !== "string") {
          throw new Error("The API returned no reply. Please retry.");
        }

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
    if (!apiBaseUrl) {
      setDebugError("Set NEXT_PUBLIC_API_BASE_URL before using debug controls.");
      return;
    }
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="console-shell flex min-h-[100dvh] flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[#0d1117]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] w-full max-w-[1440px] items-center justify-between px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-sky-300/20 bg-sky-300/[0.09] text-sky-200">
              <Command size={18} strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-slate-100">
                  Resilient AI Chat
                </h1>
                <span className="hidden rounded-md border border-white/[0.08] bg-white/[0.035] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500 sm:inline">
                  LiteLLM
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                <span
                  className={`size-1.5 rounded-full ${apiBaseUrl ? "bg-emerald-400" : "bg-amber-400"}`}
                  aria-hidden="true"
                />
                {apiBaseUrl ? "API connected" : "API base URL not configured"}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-[11px] text-slate-500 md:flex">
              <ShieldCheck size={14} className="text-slate-400" />
              <span>Session</span>
              <span className="font-mono text-slate-400">
                {sessionId ? `${sessionId.slice(0, 8)}…` : "init…"}
              </span>
            </div>
            <button
              type="button"
              onClick={startNewChat}
              disabled={!sessionId || isResetting || isSending}
              id="new-chat-btn"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.045] px-3 text-xs font-medium text-slate-200 transition hover:border-white/[0.16] hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isResetting ? <LoaderCircle size={14} className="animate-spin" /> : <SquarePen size={14} />}
              <span className="hidden sm:inline">{isResetting ? "Starting…" : "New chat"}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-4 py-5 sm:px-7 sm:py-7 lg:grid-cols-[minmax(0,1fr)_282px] lg:gap-6">
        {/* Main chat panel */}
        <section className="flex min-h-[calc(100svh-126px)] flex-col overflow-hidden rounded-2xl border border-white/[0.075] bg-[#101720]/90 shadow-[0_20px_80px_rgba(0,0,0,0.16)] lg:min-h-[calc(100svh-128px)]">
          <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-white/[0.065] px-5 sm:px-7">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <MessageSquare size={15} className="text-sky-300/80" />
              <span>Conversation</span>
              {messages.length > 0 && (
                <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {messages.filter((m) => m.role === "user").length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
              <span className="font-mono">POST</span>
              <span className="rounded border border-white/[0.07] px-1.5 py-0.5 font-mono text-slate-500">/chat</span>
            </div>
          </div>

          {/* Notice bar */}
          {notice && (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-rose-300/15 bg-rose-400/[0.07] px-3.5 py-3 text-xs text-rose-200 sm:mx-7">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} className="ml-auto text-rose-200/65 hover:text-rose-100" aria-label="Dismiss">×</button>
            </div>
          )}

          {/* Cold-start notice */}
          {coldStartNotice && (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-300/15 bg-amber-400/[0.06] px-3.5 py-3 text-xs text-amber-200 sm:mx-7">
              <Zap size={15} className="mt-0.5 shrink-0" />
              <span>Waking up the server — this can take up to a minute on free hosting…</span>
            </div>
          )}

          {/* Messages area */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="subtle-scrollbar relative flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7"
          >
            {messages.length === 0 ? (
              <div className="flex min-h-full flex-col items-center justify-center px-4 py-12 text-center">
                <div className="relative mb-6">
                  <div className="absolute -inset-4 rounded-full bg-sky-400/[0.07] blur-2xl" />
                  <div className="relative grid size-[58px] place-items-center rounded-[18px] border border-sky-200/15 bg-gradient-to-br from-sky-300/[0.12] to-indigo-300/[0.08] text-sky-200 shadow-[0_8px_40px_rgba(56,137,212,0.1)]">
                    <Sparkles size={24} strokeWidth={1.5} />
                  </div>
                </div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-200/70">Ready when you are</p>
                <h2 className="max-w-lg text-balance text-2xl font-medium tracking-[-0.04em] text-slate-100 sm:text-[30px]">
                  Send your first message.
                </h2>
                <p className="mt-3 max-w-[360px] text-sm leading-6 text-slate-500">
                  Each reply shows resolution source, model, latency, token counts, and key info.
                </p>

                {!apiBaseUrl && (
                  <div className="mt-6 flex max-w-md items-start gap-2.5 rounded-xl border border-amber-200/10 bg-amber-300/[0.045] px-4 py-3 text-left text-xs leading-5 text-amber-100/75">
                    <CircleHelp size={15} className="mt-0.5 shrink-0 text-amber-200/70" />
                    <span>
                      Add <code className="font-mono text-amber-100">NEXT_PUBLIC_API_BASE_URL</code> to{" "}
                      <code className="font-mono text-amber-100">frontend/.env</code> to connect your API.
                    </span>
                  </div>
                )}

                {/* Example prompt chips */}
                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => submitMessage(prompt)}
                      disabled={isSending || !sessionId}
                      className="rounded-full border border-white/[0.09] bg-white/[0.035] px-3.5 py-2 text-xs text-slate-400 transition hover:border-sky-300/20 hover:bg-sky-300/[0.06] hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-[780px] flex-col gap-7" aria-live="polite">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="flex justify-end gap-3">
                      <div className="max-w-[min(84%,640px)] rounded-2xl rounded-br-md border border-sky-200/10 bg-[#1b344b] px-4 py-3.5 text-[14px] leading-6 text-slate-100 shadow-[0_8px_30px_rgba(0,0,0,0.1)]">
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      </div>
                      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.055] text-[10px] font-semibold text-slate-300">
                        YOU
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="flex items-start gap-3">
                      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-sky-200/15 bg-sky-300/[0.09] text-sky-200">
                        <Bot size={16} strokeWidth={1.7} />
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        {message.status === "loading" ? (
                          <div className="inline-flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3.5 py-3 text-xs text-slate-400">
                            <LoaderCircle size={14} className="animate-spin text-sky-300" />
                            Generating response
                            <span className="loading-dots ml-0.5" aria-hidden="true">
                              <span /><span /><span />
                            </span>
                          </div>
                        ) : message.status === "error" ? (
                          <div className="max-w-[640px] rounded-xl border border-rose-300/15 bg-rose-400/[0.055] px-4 py-3.5">
                            <div className="flex items-start gap-2.5 text-[13px] leading-6 text-rose-100/90">
                              <AlertCircle size={16} className="mt-1 shrink-0 text-rose-300" />
                              <p className="whitespace-pre-wrap break-words">{message.error}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => retryMessage(message)}
                              disabled={isSending}
                              id={`retry-${message.id}`}
                              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-rose-200/15 bg-rose-200/[0.05] px-2.5 py-1.5 text-[11px] font-medium text-rose-100 transition hover:bg-rose-200/[0.1] disabled:opacity-40"
                            >
                              <RotateCcw size={12} />
                              Retry
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.8] text-slate-200">
                              {message.content}
                            </div>
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

          {showScrollButton && (
            <button
              type="button"
              onClick={() => endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" })}
              className="absolute bottom-[132px] left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-white/10 bg-[#202a35] text-slate-300 shadow-lg transition hover:bg-[#2b3948]"
              aria-label="Scroll to latest message"
            >
              <ArrowDown size={15} />
            </button>
          )}

          {/* Composer */}
          <div className="shrink-0 border-t border-white/[0.065] bg-[#101720]/95 px-4 pb-4 pt-3 sm:px-7 sm:pb-5">
            <form
              onSubmit={handleSubmit}
              className="mx-auto flex max-w-[780px] items-end gap-2 rounded-xl border border-white/[0.1] bg-[#151e28] p-2 transition focus-within:border-sky-200/25 focus-within:ring-2 focus-within:ring-sky-300/[0.055]"
            >
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                }}
                onKeyDown={handleComposerKeyDown}
                placeholder="Write a message…"
                aria-label="Write a message"
                id="message-composer"
                rows={1}
                maxLength={4000}
                className="max-h-[180px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-[10px] text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-600"
              />
              <button
                type="submit"
                id="send-btn"
                disabled={!draft.trim() || isSending || isResetting}
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-sky-300 text-[#0a1723] transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-white/[0.07] disabled:text-slate-600"
                aria-label="Send message"
              >
                {isSending ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={15} className="-translate-x-px" />}
              </button>
            </form>
            <div className="mx-auto mt-2 flex max-w-[780px] items-center justify-between px-1 text-[10px] text-slate-600">
              <span>Enter to send · Shift+Enter for new line</span>
              <span>{draft.length.toLocaleString()} / 4,000</span>
            </div>
          </div>
        </section>

        {/* Sidebar */}
        <aside className="flex flex-col gap-3">
          {/* Settings panel */}
          <CollapsiblePanel
            title="Settings"
            subtitle="System behavior"
            icon={<Settings2 size={15} />}
            open={settingsOpen}
            onToggle={() => setSettingsOpen((o) => !o)}
          >
            <label htmlFor="system-prompt" className="mb-2 block text-[11px] font-medium text-slate-400">
              System prompt
            </label>
            <textarea
              id="system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Set context or instructions for the assistant…"
              rows={5}
              className="subtle-scrollbar w-full resize-y rounded-lg border border-white/[0.08] bg-[#0c1219] px-3 py-2.5 text-xs leading-5 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-sky-200/25 focus:ring-2 focus:ring-sky-300/[0.05]"
            />
            <p className="mt-2 text-[10px] leading-4 text-slate-600">Included with every message in this chat.</p>
            <div className="mt-4 flex items-center gap-2 border-t border-white/[0.06] pt-3 text-[10px] text-slate-600">
              <Code2 size={13} />
              <span>Sent as</span>
              <code className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-slate-400">system_prompt</code>
            </div>
          </CollapsiblePanel>

          {/* Debug panel */}
          <CollapsiblePanel
            title="Debug controls"
            subtitle="Simulate key failures"
            icon={<Terminal size={15} />}
            open={debugOpen}
            onToggle={() => {
              setDebugOpen((o) => !o);
              setDebugError("");
            }}
            accent="amber"
          >
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200/[0.08] bg-amber-300/[0.035] px-3 py-2.5">
              <Zap size={13} className="mt-0.5 shrink-0 text-amber-200/75" />
              <p className="text-[10px] leading-4 text-slate-500">
                Toggle a key OFF to simulate a 429/failure for that key and prove automatic failover. Send a{" "}
                <strong className="text-slate-400">new message</strong> and watch <code className="font-mono text-xs">key_index_used</code> change.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              {(debugStatus?.key_states && debugStatus.key_states.length > 0
                ? debugStatus.key_states
                : [{ key_index: 1, simulated_down: false, usage_count: 0 }, { key_index: 2, simulated_down: false, usage_count: 0 }]
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
                    aria-checked={isDown}
                    aria-label={`Fail key ${keyNum}`}
                    id={`fail-key-${keyNum}`}
                    disabled={debugPending !== null}
                    onClick={() => void toggleFailKey(keyNum, isDown)}
                    className="flex w-full items-center justify-between rounded-lg border border-white/[0.055] bg-white/[0.018] px-3 py-2.5 text-left transition hover:border-white/[0.1] hover:bg-white/[0.035] disabled:cursor-wait disabled:opacity-65"
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="grid size-6 place-items-center rounded-md border border-white/[0.07] bg-white/[0.035] font-mono text-[10px] text-slate-400">
                        {keyNum}
                      </span>
                      <span className="text-xs text-slate-300">Key {keyNum}</span>
                      {usageCount > 0 && (
                        <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-slate-600">
                          {usageCount}×
                        </span>
                      )}
                    </span>
                    <span
                      className={`relative inline-flex h-[19px] w-[34px] items-center rounded-full border transition ${
                        isDown ? "border-rose-300/30 bg-rose-300/20" : "border-white/[0.1] bg-[#0b1016]"
                      }`}
                    >
                      <span
                        className={`absolute left-[2px] grid size-[13px] place-items-center rounded-full transition ${
                          isDown ? "translate-x-[15px] bg-rose-200" : "bg-slate-500"
                        }`}
                      >
                        {busy && <LoaderCircle size={8} className="animate-spin text-slate-900" />}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {debugError && (
              <div role="alert" className="mt-3 rounded-lg border border-rose-300/15 bg-rose-300/[0.055] px-3 py-2.5 text-[11px] leading-5 text-rose-200/90">
                {debugError}
              </div>
            )}
            <div className="mt-4 flex items-center gap-2 border-t border-white/[0.06] pt-3 text-[10px] text-slate-600">
              <Code2 size={13} />
              <span>POST</span>
              <code className="truncate rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-slate-400">
                /debug/fail-key/:n/:state
              </code>
            </div>
          </CollapsiblePanel>

          {/* Metadata legend */}
          <div className="mt-1 rounded-xl border border-white/[0.065] bg-[#101720]/80 px-4 py-3.5">
            <div className="mb-2.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              <Database size={12} />
              Per-response metadata
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300/15 bg-emerald-300/[0.06] px-2 py-1 text-[9px] text-emerald-200/90">
                <span className="size-1 rounded-full bg-emerald-300" />
                LLM_CACHE
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-300/15 bg-sky-300/[0.06] px-2 py-1 text-[9px] text-sky-200/90">
                <span className="size-1 rounded-full bg-sky-300" />
                LIVE_INFERENCE
              </span>
            </div>
            <p className="mt-2.5 text-[10px] leading-4 text-slate-600">
              Source, model, latency, tokens, and key info shown beneath each reply.
            </p>
          </div>

          {/* Quick test guide */}
          <div className="rounded-xl border border-white/[0.065] bg-[#101720]/80 px-4 py-3.5">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              <Key size={12} />
              Quick test guide
            </div>
            <ol className="list-decimal space-y-1.5 pl-4 text-[10px] leading-4 text-slate-600">
              <li>Send &quot;What is the capital of France?&quot; → <span className="text-sky-300/70">LIVE_INFERENCE</span></li>
              <li>Click <strong className="text-slate-400">New chat</strong>, same message → <span className="text-emerald-300/70">LLM_CACHE</span> (lower latency)</li>
              <li>Open Debug, toggle Key 1 off, new message → see key_index_used = 2</li>
              <li>Toggle all keys off → friendly error bubble appears</li>
            </ol>
          </div>
        </aside>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// CollapsiblePanel component
// ---------------------------------------------------------------------------

function CollapsiblePanel({
  title,
  subtitle,
  icon,
  open,
  onToggle,
  accent = "sky",
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  accent?: "sky" | "amber";
  children: React.ReactNode;
}) {
  const tone =
    accent === "amber"
      ? "border-amber-200/10 bg-amber-200/[0.055] text-amber-100/80"
      : "border-sky-200/10 bg-sky-200/[0.055] text-sky-100/80";

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.075] bg-[#101720]/85">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-white/[0.025]"
      >
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg border ${tone}`}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-slate-200">{title}</span>
          <span className="mt-0.5 block text-[10px] text-slate-500">{subtitle}</span>
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="border-t border-white/[0.06] px-4 pb-4 pt-3.5">{children}</div>}
    </section>
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
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/[0.055] pt-2.5 text-[10px] text-slate-500">
      {/* Resolution source badge */}
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium tracking-[0.035em] ${
          cached
            ? "border-emerald-300/15 bg-emerald-300/[0.055] text-emerald-200/90"
            : "border-sky-300/15 bg-sky-300/[0.055] text-sky-200/90"
        }`}
      >
        <span className={`size-1 rounded-full ${cached ? "bg-emerald-300" : "bg-sky-300"}`} aria-hidden="true" />
        {source}
      </span>

      {/* Model */}
      <span className="max-w-[220px] truncate font-mono text-slate-400" title={model}>
        {model}
      </span>

      {/* Latency */}
      <span className="inline-flex items-center gap-1">
        <Clock3 size={11} />
        {latency} ms
      </span>

      {/* Token usage — per request */}
      <span className="font-mono text-slate-500">
        In: {inputTokens} | Out: {outputTokens}
      </span>

      {/* Key info */}
      {keyUsed !== null && (
        <span className="inline-flex items-center gap-1 font-mono text-slate-600">
          <Key size={10} />
          Key #{keyUsed}
        </span>
      )}

      {/* Fallback count */}
      {fallbacks > 0 && (
        <span className="rounded-md border border-amber-300/15 bg-amber-300/[0.05] px-1.5 py-0.5 text-amber-200/80">
          {fallbacks} fallback{fallbacks > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
