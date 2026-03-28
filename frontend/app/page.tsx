"use client";

/**
 * page.tsx — ImmigrationIQ main chat interface.
 *
 * Three-panel layout:
 *   [QuestionNav 220px] | [Chat + Input flex-1] | [SourcesPanel 272px]
 *
 * Features:
 *   - Mode toggle (student ↔ professional)
 *   - Typewriter animation on assistant responses
 *   - Question nav: click any past question to scroll to its answer
 *   - Sources panel: opens on the right when "N sources" is clicked
 *   - Export chat as .md file
 *   - New chat clears state and backend session
 */

import { useState, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { Message, Mode, Source, ParsedDocument, sendMessage, clearSession, parseDocument } from "@/lib/api";
import { getSessionId, resetSession } from "@/lib/session";
import ChatWindow from "@/components/ChatWindow";
import QuestionNav from "@/components/QuestionNav";
import SourcesPanel from "@/components/SourcesPanel";
import ColdStartOverlay from "@/components/ColdStartOverlay";

const ACCEPTED_FILE_TYPES = ".txt,.md,.markdown,.pdf";

// ── Helpers ───────────────────────────────────────────────────────────────────

function exportChatAsMd(messages: Message[]): void {
  if (messages.length === 0) return;

  const lines: string[] = [
    "# ImmigrationIQ Chat Export",
    `*Exported ${new Date().toLocaleString()}*`,
    "",
  ];

  for (const msg of messages) {
    const role = msg.role === "user" ? "**You**" : "**ImmigrationIQ**";
    lines.push(`### ${role}`);
    lines.push(msg.content.trim());

    if (msg.sources && msg.sources.length > 0) {
      lines.push("");
      lines.push("**Sources:**");
      for (const s of msg.sources) {
        const label = s.section || s.url;
        lines.push(`- [${label}](${s.url})`);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [mode,      setMode]      = useState<Mode>("student");
  const [input,     setInput]     = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Right panel state
  const [activeSources,  setActiveSources]  = useState<Source[]>([]);
  // Document attached to the next message to be sent
  const [pendingDoc,     setPendingDoc]     = useState<ParsedDocument | null>(null);
  const [docLoading,     setDocLoading]     = useState(false);

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
      console.error("Document parse failed:", err);
      // Surface the error in chat as a system message
      setMessages(prev => [...prev, {
        id:        crypto.randomUUID(),
        role:      "assistant" as const,
        content:   `Could not read the document: ${err instanceof Error ? err.message : "Unknown error"}`,
        timestamp: new Date(),
      }]);
    } finally {
      setDocLoading(false);
    }
  };

  // ── Send message ────────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || isLoading) return;

      const sessionId = getSessionId();

      // If a document is attached, prepend it to this message only
      const messageToSend = pendingDoc
        ? `[Attached document: "${pendingDoc.filename}"${pendingDoc.summarised ? " (summarised)" : ""}]\n\n${pendingDoc.text}\n\n---\n\n${text}`
        : text;

      const userMsg: Message = {
        id:         uuidv4(),
        role:       "user",
        content:    text,   // UI shows only the user's question
        timestamp:  new Date(),
        attachment: pendingDoc
          ? { filename: pendingDoc.filename, summarised: pendingDoc.summarised }
          : undefined,
      };

      setMessages((prev) => [...prev, userMsg]);
      if (!overrideText) setInput("");
      setPendingDoc(null);
      setIsLoading(true);

      // Auto-resize reset
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }

      try {
        const response = await sendMessage(messageToSend, sessionId, mode);

        const assistantMsg: Message = {
          id:         uuidv4(),
          role:       "assistant",
          content:    response.answer,
          sources:    response.sources,
          complexity: response.complexity,
          timestamp:  new Date(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id:        uuidv4(),
            role:      "assistant",
            content:
              "Sorry, something went wrong. Please check that the backend server is running and try again.",
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsLoading(false);
        inputRef.current?.focus();
      }
    },
    [input, isLoading, mode]
  );

  // ── New chat ────────────────────────────────────────────────────────────────
  const handleNewChat = useCallback(async () => {
    const oldId = getSessionId();
    await clearSession(oldId);
    resetSession();
    setMessages([]);
    setInput("");
    setActiveSources([]);
    setPendingDoc(null);
    if (inputRef.current) inputRef.current.style.height = "auto";
    inputRef.current?.focus();
  }, []);

  // ── Input handlers ──────────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const showSourcesPanel = activeSources.length > 0;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-base)" }}>
      <ColdStartOverlay />
      {/* ── Left sidebar: navigation ──────────────────────────────────────── */}
      <div className="w-[260px] flex-shrink-0">
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

      {/* ── Main chat column ──────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0" style={{ borderLeft: "1px solid var(--border)" }}>
        <ChatWindow
          messages={messages}
          isLoading={isLoading}
          onSuggestionClick={(text) => handleSend(text)}
          onViewSources={(sources) => setActiveSources(sources)}
        />

        {/* Input area */}
        <div
          className="flex-shrink-0 px-5 py-4"
          style={{ borderTop: "1px solid var(--border-dim)", background: "var(--bg-base)" }}
        >
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            onChange={handleFileImport}
            className="hidden"
          />

          <div className="max-w-2xl mx-auto">
            {/* Pending doc badge */}
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
                {docLoading
                  ? <span>Parsing document…</span>
                  : <>
                      <span>
                        {pendingDoc!.filename}
                        {pendingDoc!.summarised && <span style={{ color: "var(--text-muted)" }}> · summarised</span>}
                        <span style={{ color: "var(--text-muted)" }}> — will be sent with this message</span>
                      </span>
                      <button
                        onClick={() => setPendingDoc(null)}
                        style={{ color: "var(--text-muted)" }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)")}
                      >✕</button>
                    </>
                }
              </div>
            )}

            <div
              className="flex items-end gap-2 rounded-2xl px-4 py-2 transition-colors"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
              }}
              onFocusCapture={(e) =>
                ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--accent)")
              }
              onBlurCapture={(e) =>
                ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)")
              }
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
                style={{
                  color: "var(--text-primary)",
                  caretColor: "var(--accent)",
                  maxHeight: "160px",
                  lineHeight: "1.5",
                }}
              />
              {/* Attach document */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || docLoading}
                title="Attach a document to this message (PDF, txt, md)"
                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors mb-0.5 disabled:opacity-25"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) => {
                  if (!isLoading && !docLoading)
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </button>

              {/* Send */}
              <button
                onClick={() => handleSend()}
                disabled={isLoading || !input.trim()}
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 mb-0.5 disabled:opacity-30"
                style={{ background: "var(--accent)" }}
                onMouseEnter={(e) => {
                  if (!isLoading && input.trim())
                    (e.currentTarget as HTMLButtonElement).style.opacity = "0.85";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                }}
              >
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2}
                    d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <p className="text-center text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              General information only — not legal advice. Consult a licensed attorney for your situation.
            </p>
          </div>
        </div>
      </main>

      {/* ── Right panel: sources (slides in) ──────────────────────────────── */}
      <div
        className="flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
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
