"use client";

import { useState, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { Message, Mode, Source, ParsedDocument, sendMessage, clearSession, parseDocument } from "@/lib/api";
import { getSessionId, resetSession } from "@/lib/session";
import ChatWindow from "@/components/ChatWindow";
import QuestionNav from "@/components/QuestionNav";
import SourcesPanel from "@/components/SourcesPanel";
import ColdStartOverlay from "@/components/ColdStartOverlay";

const ACCEPTED_FILE_TYPES = ".txt,.md,.markdown,.pdf";

function exportChatAsMd(messages: Message[]): void {
  if (messages.length === 0) return;
  const lines: string[] = ["# ImmigrationIQ Chat Export", `*Exported ${new Date().toLocaleString()}*`, ""];
  for (const msg of messages) {
    const role = msg.role === "user" ? "**You**" : "**ImmigrationIQ**";
    lines.push(`### ${role}`);
    lines.push(msg.content.trim());
    if (msg.sources && msg.sources.length > 0) {
      lines.push("", "**Sources:**");
      for (const s of msg.sources) lines.push(`- [${s.section || s.url}](${s.url})`);
    }
    lines.push("", "---", "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `immigrationiq-${new Date().toISOString().split("T")[0]}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function scrollToMessage(messageId: string): void {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("highlight-flash");
  setTimeout(() => el.classList.remove("highlight-flash"), 2000);
}

export default function Home() {
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [mode,      setMode]      = useState<Mode>("student");
  const [input,     setInput]     = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [activeSources,  setActiveSources]  = useState<Source[]>([]);
  const [pendingDoc,     setPendingDoc]     = useState<ParsedDocument | null>(null);
  const [docLoading,     setDocLoading]     = useState(false);

  // Mobile drawer/sheet state
  const [navOpen,     setNavOpen]     = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const inputRef     = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setDocLoading(true);
    try {
      const parsed = await parseDocument(file);
      setPendingDoc(parsed);
    } catch (err) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: "assistant" as const,
        content: `Could not read the document: ${err instanceof Error ? err.message : "Unknown error"}`,
        timestamp: new Date(),
      }]);
    } finally {
      setDocLoading(false);
    }
  };

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || isLoading) return;
    const sessionId = getSessionId();
    const messageToSend = pendingDoc
      ? `[Attached document: "${pendingDoc.filename}"${pendingDoc.summarised ? " (summarised)" : ""}]\n\n${pendingDoc.text}\n\n---\n\n${text}`
      : text;
    const userMsg: Message = {
      id: uuidv4(), role: "user", content: text, timestamp: new Date(),
      attachment: pendingDoc ? { filename: pendingDoc.filename, summarised: pendingDoc.summarised } : undefined,
    };
    setMessages(prev => [...prev, userMsg]);
    if (!overrideText) setInput("");
    setPendingDoc(null);
    setIsLoading(true);
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      const response = await sendMessage(messageToSend, sessionId, mode);
      setMessages(prev => [...prev, {
        id: uuidv4(), role: "assistant", content: response.answer,
        sources: response.sources, complexity: response.complexity, timestamp: new Date(),
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: uuidv4(), role: "assistant", timestamp: new Date(),
        content: "Sorry, something went wrong. Please check that the backend server is running and try again.",
      }]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [input, isLoading, mode, pendingDoc]);

  const handleNewChat = useCallback(async () => {
    const oldId = getSessionId();
    await clearSession(oldId);
    resetSession();
    setMessages([]);
    setInput("");
    setActiveSources([]);
    setPendingDoc(null);
    setNavOpen(false);
    if (inputRef.current) inputRef.current.style.height = "auto";
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  const handleViewSources = (sources: Source[]) => {
    setActiveSources(sources);
    setSourcesOpen(true);
  };

  const showSourcesPanel = activeSources.length > 0;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-base)" }}>
      <ColdStartOverlay />

      {/* ── Mobile nav drawer backdrop ───────────────────────────────────── */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      {/* Desktop: always visible as normal flow element                   */}
      {/* Mobile: fixed overlay, slides in from left when navOpen          */}
      <div className="hidden md:flex md:flex-shrink-0" style={{ width: "260px" }}>
        <QuestionNav
          messages={messages}
          mode={mode}
          onModeChange={setMode}
          onQuestionClick={scrollToMessage}
          onNewChat={handleNewChat}
          onExport={() => exportChatAsMd(messages)}
          isLoading={isLoading}
        />
      </div>

      {/* Mobile drawer */}
      <div
        className="md:hidden fixed z-40 h-full transition-transform duration-300 ease-in-out"
        style={{
          width: "260px",
          transform: navOpen ? "translateX(0)" : "translateX(-100%)",
        }}
      >
        <QuestionNav
          messages={messages}
          mode={mode}
          onModeChange={setMode}
          onQuestionClick={(id) => { scrollToMessage(id); setNavOpen(false); }}
          onNewChat={handleNewChat}
          onExport={() => exportChatAsMd(messages)}
          isLoading={isLoading}
          onClose={() => setNavOpen(false)}
        />
      </div>

      {/* ── Main chat column ──────────────────────────────────────────────── */}
      <main
        className="flex-1 flex flex-col min-w-0"
        style={{ borderLeft: "1px solid var(--border)" }}
      >
        {/* Mobile top header bar */}
        <div
          className="flex md:hidden items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border-dim)", background: "var(--bg-surface)" }}
        >
          {/* Hamburger */}
          <button
            onClick={() => setNavOpen(v => !v)}
            className="w-8 h-8 flex items-center justify-center rounded-md"
            style={{ color: "var(--text-secondary)" }}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Logo */}
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #1A3A72 0%, #0D2050 100%)", border: "1px solid #1E3A6E" }}
            >
              <span className="text-xs font-bold" style={{ color: "var(--accent)" }}>IQ</span>
            </div>
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>ImmigrationIQ</span>
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-lg p-0.5" style={{ background: "var(--bg-elevated)" }}>
            {(["student", "professional"] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isLoading}
                className="py-1 px-2.5 rounded-md text-xs font-medium transition-all duration-200 capitalize disabled:opacity-50"
                style={mode === m
                  ? { background: "var(--bg-surface)", color: "var(--accent)", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }
                  : { color: "var(--text-secondary)" }
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <ChatWindow
          messages={messages}
          isLoading={isLoading}
          onSuggestionClick={(text) => handleSend(text)}
          onViewSources={handleViewSources}
        />

        {/* Input area */}
        <div
          className="flex-shrink-0 px-4 md:px-5 py-4"
          style={{ borderTop: "1px solid var(--border-dim)", background: "var(--bg-base)" }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            onChange={handleFileImport}
            className="hidden"
          />

          <div className="max-w-2xl mx-auto">
            {(pendingDoc || docLoading) && (
              <div
                className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg text-xs w-fit"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-dim)", color: "var(--text-secondary)" }}
              >
                <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  style={{ color: "var(--accent)" }}>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                {docLoading ? <span>Parsing document…</span> : (
                  <>
                    <span>
                      {pendingDoc!.filename}
                      {pendingDoc!.summarised && <span style={{ color: "var(--text-muted)" }}> · summarised</span>}
                      <span style={{ color: "var(--text-muted)" }}> — will be sent with this message</span>
                    </span>
                    <button onClick={() => setPendingDoc(null)} style={{ color: "var(--text-muted)" }}>✕</button>
                  </>
                )}
              </div>
            )}

            <div
              className="flex items-end gap-2 rounded-2xl px-4 py-2 transition-colors"
              style={{ background: "var(--bg-input)", border: "1px solid var(--border)" }}
              onFocusCapture={e => (e.currentTarget.style.borderColor = "var(--accent)")}
              onBlurCapture={e => (e.currentTarget.style.borderColor = "var(--border)")}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask about H1B, OPT, green cards, taxes…"
                disabled={isLoading}
                rows={1}
                className="flex-1 bg-transparent text-sm resize-none outline-none py-1.5 disabled:opacity-50"
                style={{ color: "var(--text-primary)", caretColor: "var(--accent)", maxHeight: "160px", lineHeight: "1.5" }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || docLoading}
                title="Attach a document"
                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors mb-0.5 disabled:opacity-25"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={e => { if (!isLoading && !docLoading) (e.currentTarget).style.color = "var(--accent)"; }}
                onMouseLeave={e => { (e.currentTarget).style.color = "var(--text-muted)"; }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </button>
              <button
                onClick={() => handleSend()}
                disabled={isLoading || !input.trim()}
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 mb-0.5 disabled:opacity-30"
                style={{ background: "var(--accent)" }}
              >
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <p className="text-center text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              General information only — not legal advice. Consult a licensed attorney for your situation.
            </p>
          </div>
        </div>
      </main>

      {/* ── Sources panel ─────────────────────────────────────────────────── */}
      {/* Desktop: slide in from right. Mobile: bottom sheet */}

      {/* Mobile bottom sheet backdrop */}
      {sourcesOpen && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => { setSourcesOpen(false); setActiveSources([]); }}
        />
      )}

      {/* Mobile bottom sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-40 md:hidden rounded-t-2xl overflow-hidden transition-transform duration-300"
        style={{
          transform: sourcesOpen ? "translateY(0)" : "translateY(100%)",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          maxHeight: "70vh",
        }}
      >
        {showSourcesPanel && sourcesOpen && (
          <SourcesPanel
            sources={activeSources}
            onClose={() => { setSourcesOpen(false); setActiveSources([]); }}
          />
        )}
      </div>

      {/* Desktop right panel */}
      <div
        className="hidden md:block flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
        style={{ width: showSourcesPanel ? "272px" : "0px", opacity: showSourcesPanel ? 1 : 0 }}
      >
        {showSourcesPanel && (
          <SourcesPanel
            sources={activeSources}
            onClose={() => setActiveSources([])}
          />
        )}
      </div>
    </div>
  );
}