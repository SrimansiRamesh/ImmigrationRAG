"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { Message, Mode, Source, ParsedDocument, sendMessage, clearSession, parseDocument, pollEvalScore } from "@/lib/api";
import { getSessionId, resetSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import {
  Conversation,
  createConversation,
  saveMessage,
  getConversations,
  getMessages,
  touchConversation,
  renameConversation,
  deleteConversation,
} from "@/lib/conversations";
import ChatWindow from "@/components/ChatWindow";
import QuestionNav from "@/components/QuestionNav";
import SourcesPanel from "@/components/SourcesPanel";
import ColdStartOverlay from "@/components/ColdStartOverlay";
import LandingPage from "@/components/LandingPage";

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

export default function Home() {
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [mode,      setMode]      = useState<Mode>("student");
  const [input,     setInput]     = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [activeSources,    setActiveSources]    = useState<Source[]>([]);
  const [activeMessageId,  setActiveMessageId]  = useState<string | null>(null);
  const [activeCiteIndex,  setActiveCiteIndex]  = useState<number | null>(null);
  const [pendingDoc,     setPendingDoc]     = useState<ParsedDocument | null>(null);
  const [docLoading,     setDocLoading]     = useState(false);

  // Mobile drawer/sheet state
  const [navOpen,     setNavOpen]     = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // Desktop sidebar collapse (persisted)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Supabase auth + persisted conversations (signed-in users only)
  const [userId,         setUserId]         = useState<string | null>(null);
  const [authReady,      setAuthReady]      = useState(false);
  const [anonMode,       setAnonMode]       = useState(false);
  const [conversations,  setConversations]  = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const inputRef     = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Auth: track session + load this user's conversations ──────────────────
  useEffect(() => {
    let mounted = true;

    const refreshFor = async (uid: string | null) => {
      if (!mounted) return;
      setUserId(uid);
      if (uid) {
        try {
          const convos = await getConversations(uid);
          if (mounted) setConversations(convos);
        } catch {
          if (mounted) setConversations([]);
        }
      } else {
        setConversations([]);
      }
    };

    supabase.auth.getSession().then(({ data }) => {
      refreshFor(data.session?.user?.id ?? null);
      if (mounted) setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      refreshFor(session?.user?.id ?? null);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  // ── Restore persisted sidebar collapse state ──────────────────────────────
  useEffect(() => {
    if (localStorage.getItem("sidebar-collapsed") === "true") setSidebarCollapsed(true);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);

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

  // Poll the eval service for a message's quality scores (fire-and-forget).
  const pollForScores = useCallback(async (evalId: string, messageId: string) => {
    for (let i = 0; i < 10; i++) {              // max 10 attempts
      await new Promise(r => setTimeout(r, 2000)); // 2s between polls
      const scores = await pollEvalScore(evalId);
      if (scores) {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, scores } : m));
        break;
      }
    }
  }, []);

  const handleSend = useCallback(async (overrideText?: string) => {
    console.log("handleSend entered", { overrideText, input, isLoading }); // TEMP debug
    const text = (overrideText ?? input).trim();
    if (!text || isLoading) return;
    setActiveCiteIndex(null);
    const sessionId = getSessionId();
    console.log("handleSend got sessionId", { sessionId, mode }); // TEMP debug
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

    // Signed-in: create a conversation on the first message of this chat
    let convId = conversationId;
    if (userId && !convId) {
      try {
        convId = await createConversation(userId, text.slice(0, 60), mode);
        setConversationId(convId);
      } catch {
        convId = null; // persistence is best-effort; never block the chat
      }
    }

    try {
      const response = await sendMessage(messageToSend, sessionId, mode);
      const assistantId = uuidv4();
      setMessages(prev => [...prev, {
        id: assistantId, role: "assistant", content: response.answer,
        sources: response.sources, complexity: response.complexity,
        animate: true, timestamp: new Date(),
      }]);
      // Auto-reveal the sources panel when a response returns sources
      if (response.sources && response.sources.length > 0) {
        setActiveSources(response.sources);
        setActiveMessageId(assistantId);
      }
      // Eval runs async on the backend — poll for scores and attach them later
      if (response.eval_id) {
        pollForScores(response.eval_id, assistantId); // fire-and-forget
      }
      // Persist this turn for signed-in users (best-effort)
      if (convId && userId) {
        try {
          await saveMessage(convId, "user", text);
          await saveMessage(convId, "assistant", response.answer, response.sources, response.complexity);
          await touchConversation(convId);
          getConversations(userId).then(setConversations).catch(() => {});
        } catch {
          // ignore — storage failures must not affect the chat experience
        }
      }
    } catch (err) {
      console.error("chat failed:", err); // TEMP debug
      const errText = err instanceof Error ? err.message : String(err);
      const isBusy = errText.includes("503") || errText.includes("UNAVAILABLE");
      setMessages(prev => [...prev, {
        id: uuidv4(), role: "assistant", timestamp: new Date(),
        content: isBusy
          ? "Google's AI service is temporarily busy. Please try again in a few seconds."
          : "Sorry, something went wrong. Please check that the backend server is running and try again.",
      }]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [input, isLoading, mode, pendingDoc, userId, conversationId, pollForScores]);

  const handleNewChat = useCallback(async () => {
    const oldId = getSessionId();
    await clearSession(oldId);
    resetSession();
    setMessages([]);
    setInput("");
    setActiveSources([]);
    setActiveMessageId(null);
    setActiveCiteIndex(null);
    setPendingDoc(null);
    setConversationId(null);
    setNavOpen(false);
    if (inputRef.current) inputRef.current.style.height = "auto";
    inputRef.current?.focus();
  }, []);

  const handleSelectConversation = useCallback(async (id: string) => {
    setNavOpen(false);
    setActiveSources([]);
    setActiveMessageId(null);
    setActiveCiteIndex(null);
    setPendingDoc(null);
    setConversationId(id);
    // The loaded conversation gets fresh FastAPI memory — Supabase storage
    // and the session.ts UUID memory are intentionally separate.
    resetSession();
    try {
      setMessages(await getMessages(id));
    } catch {
      /* ignore load failure */
    }
  }, []);

  const handleRenameConversation = useCallback(async (id: string, newTitle: string) => {
    try {
      await renameConversation(id, newTitle);
      if (userId) setConversations(await getConversations(userId));
    } catch {
      /* ignore — title just won't update */
    }
  }, [userId]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    // Optimistic removal from the list
    setConversations(prev => prev.filter(c => c.id !== id));
    // If the deleted conversation was active, reset to an empty chat
    if (id === conversationId) {
      setMessages([]);
      setConversationId(null);
      setActiveSources([]);
      setActiveMessageId(null);
      setActiveCiteIndex(null);
      setPendingDoc(null);
      resetSession();
    }
    try {
      await deleteConversation(id);
    } catch {
      /* ignore — row was already removed locally */
    }
  }, [conversationId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  const handleViewSources = (sources: Source[], messageId: string) => {
    // Always update the panel contents so the desktop right panel shows
    // (and reopens if it was closed). Only the mobile bottom sheet is gated
    // to small screens — on desktop it stays closed, avoiding a double render.
    setActiveSources(sources);
    setActiveMessageId(messageId);
    const isMobile = typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches;
    if (isMobile) setSourcesOpen(true);
  };

  const showSourcesPanel = activeSources.length > 0;
  // Derived from the active message so late-arriving polled scores update the panel reactively.
  const activeScores = messages.find(m => m.id === activeMessageId)?.scores ?? null;

  // Wait for the initial session check before deciding what to show (avoids
  // a landing-page flash for already-signed-in users).
  if (!authReady) {
    return <div className="h-screen" style={{ background: "var(--iq-bg)" }} />;
  }

  // Unauthenticated → sign-in landing page, unless the user chose to
  // continue anonymously (full chat, but no saved history).
  if (!userId && !anonMode) {
    return (
      <div className="iq-fade-in">
        <LandingPage onContinueAnon={() => setAnonMode(true)} />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden iq-fade-in" style={{ background: "var(--iq-bg)" }}>
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
      <div
        className="hidden md:flex md:flex-shrink-0 overflow-hidden"
        style={{ width: sidebarCollapsed ? "40px" : "196px", transition: "width 0.2s ease" }}
      >
        <QuestionNav
          messages={messages}
          mode={mode}
          onModeChange={setMode}
          onNewChat={handleNewChat}
          onExport={() => exportChatAsMd(messages)}
          isLoading={isLoading}
          userId={userId}
          conversations={conversations}
          activeConversationId={conversationId}
          onSelectConversation={handleSelectConversation}
          onRename={handleRenameConversation}
          onDelete={handleDeleteConversation}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
        />
      </div>

      {/* Mobile drawer */}
      <div
        className="md:hidden fixed z-40 h-full overflow-hidden transition-transform duration-300 ease-in-out"
        style={{
          width: "260px",
          transform: navOpen ? "translateX(0)" : "translateX(-100%)",
        }}
      >
        <QuestionNav
          messages={messages}
          mode={mode}
          onModeChange={setMode}
          onNewChat={handleNewChat}
          onExport={() => exportChatAsMd(messages)}
          isLoading={isLoading}
          onClose={() => setNavOpen(false)}
          userId={userId}
          conversations={conversations}
          activeConversationId={conversationId}
          onSelectConversation={handleSelectConversation}
          onRename={handleRenameConversation}
          onDelete={handleDeleteConversation}
        />
      </div>

      {/* ── Main chat column ──────────────────────────────────────────────── */}
      <main
        className="flex-1 flex flex-col min-w-0"
        style={{ borderLeft: "1px solid var(--iq-border)" }}
      >
        {/* Mobile top header bar */}
        <div
          className="flex md:hidden items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--iq-border)", background: "var(--iq-surface)" }}
        >
          {/* Hamburger */}
          <button
            onClick={() => setNavOpen(v => !v)}
            className="w-8 h-8 flex items-center justify-center rounded-md"
            style={{ color: "var(--iq-muted)" }}
          >
            <i className="ti ti-menu-2 text-xl" />
          </button>

          {/* Logo */}
          <div className="flex items-center gap-2">
            <div
              className="rounded-md flex items-center justify-center"
              style={{ width: 24, height: 24, background: "var(--iq-teal)" }}
            >
              <span className="font-display text-xs leading-none" style={{ color: "#fff" }}>IQ</span>
            </div>
            <span className="font-display text-sm" style={{ color: "var(--iq-ink)" }}>ImmigrationIQ</span>
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-lg p-0.5" style={{ background: "var(--iq-surface-2)" }}>
            {([["student", "Student", "ti-school"], ["professional", "Pro", "ti-briefcase"]] as [Mode, string, string][]).map(([m, label, icon]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isLoading}
                className="flex items-center gap-1 py-1 px-2 rounded-md text-xs font-medium transition-all duration-200 disabled:opacity-50"
                style={mode === m
                  ? { background: "var(--iq-white)", color: "var(--iq-teal)", boxShadow: "0 1px 2px rgba(26,26,46,0.08)" }
                  : { color: "var(--iq-muted)" }
                }
              >
                <i className={`ti ${icon} text-sm`} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <ChatWindow
          messages={messages}
          isLoading={isLoading}
          onSuggestionClick={(text) => handleSend(text)}
          onViewSources={handleViewSources}
          onCiteClick={(i) => setActiveCiteIndex(i)}
        />

        {/* Input area */}
        <div
          className="flex-shrink-0 px-4 md:px-5 py-4"
          style={{ borderTop: "1px solid var(--iq-border)", background: "var(--iq-bg)" }}
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
                style={{ background: "var(--iq-white)", border: "1px solid var(--iq-border)", color: "var(--iq-muted)" }}
              >
                <i className="ti ti-paperclip text-sm flex-shrink-0" style={{ color: "var(--iq-teal)" }} />
                {docLoading ? <span>Parsing document…</span> : (
                  <>
                    <span>
                      {pendingDoc!.filename}
                      {pendingDoc!.summarised && <span style={{ color: "var(--iq-hint)" }}> · summarised</span>}
                      <span style={{ color: "var(--iq-hint)" }}> — will be sent with this message</span>
                    </span>
                    <button onClick={() => setPendingDoc(null)} style={{ color: "var(--iq-hint)" }}>
                      <i className="ti ti-x text-sm" />
                    </button>
                  </>
                )}
              </div>
            )}

            <div
              className="flex items-end gap-2 px-3 py-2 transition-colors"
              style={{ background: "var(--iq-white)", border: "1px solid var(--iq-border)", borderRadius: "9px" }}
              onFocusCapture={e => (e.currentTarget.style.borderColor = "var(--iq-teal)")}
              onBlurCapture={e => (e.currentTarget.style.borderColor = "var(--iq-border)")}
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
                style={{ fontSize: "16px", color: "var(--iq-ink)", caretColor: "var(--iq-teal)", maxHeight: "160px", lineHeight: "1.5" }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || docLoading}
                title="Attach a document"
                className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-colors mb-0.5 disabled:opacity-25"
                style={{ color: "var(--iq-hint)" }}
                onMouseEnter={e => { if (!isLoading && !docLoading) e.currentTarget.style.color = "var(--iq-teal)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--iq-hint)"; }}
              >
                <i className="ti ti-paperclip text-lg" />
              </button>
              <button
                onClick={() => handleSend()}
                disabled={isLoading || !input.trim()}
                className="flex-shrink-0 flex items-center justify-center transition-all duration-200 mb-0.5 disabled:opacity-30"
                style={{ width: 28, height: 28, background: "var(--iq-teal)", borderRadius: "7px" }}
              >
                <i className="ti ti-arrow-up text-base" style={{ color: "#fff" }} />
              </button>
            </div>

            <p className="text-center mt-2" style={{ fontSize: "10.5px", color: "var(--iq-hint)" }}>
              General information only — not legal advice. Consult a licensed attorney.
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
          background: "var(--iq-surface)",
          border: "1px solid var(--iq-border)",
          maxHeight: "70vh",
          height: "70vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {showSourcesPanel && sourcesOpen && (
          <SourcesPanel
            sources={activeSources}
            activeIndex={activeCiteIndex}
            scores={activeScores}
            onClose={() => { setSourcesOpen(false); setActiveSources([]); }}
          />
        )}
      </div>

      {/* Desktop right panel */}
      <div
        className="hidden md:block flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
        style={{ width: showSourcesPanel ? "220px" : "0px", opacity: showSourcesPanel ? 1 : 0 }}
      >
        {showSourcesPanel && (
          <SourcesPanel
            sources={activeSources}
            activeIndex={activeCiteIndex}
            scores={activeScores}
            onClose={() => setActiveSources([])}
          />
        )}
      </div>
    </div>
  );
}