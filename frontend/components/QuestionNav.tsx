"use client";

import { Message, Mode } from "@/lib/api";

interface QuestionNavProps {
  messages:        Message[];
  mode:            Mode;
  onModeChange:    (m: Mode) => void;
  onQuestionClick: (id: string) => void;
  onNewChat:       () => void;
  onExport:        () => void;
  isLoading:       boolean;
  onClose?:        () => void; // mobile only
}

export default function QuestionNav({
  messages, mode, onModeChange, onQuestionClick,
  onNewChat, onExport, isLoading, onClose,
}: QuestionNavProps) {
  const userMessages = messages.filter(m => m.role === "user");

  return (
    <aside
      className="flex flex-col h-full"
      style={{ background: "var(--bg-surface)", borderRight: "1px solid var(--border)" }}
    >
      {/* ── Logo ──────────────────────────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-5" style={{ borderBottom: "1px solid var(--border-dim)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #1A3A72 0%, #0D2050 100%)", border: "1px solid #1E3A6E" }}
            >
              <span className="text-xs font-bold tracking-wider" style={{ color: "var(--accent)" }}>IQ</span>
            </div>
            <div>
              <h1 className="font-display text-sm font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>
                ImmigrationIQ
              </h1>
              <p className="text-xs leading-none mt-0.5" style={{ color: "var(--text-muted)" }}>
                US Immigration
              </p>
            </div>
          </div>

          {/* Close button — mobile only */}
          {onClose && (
            <button
              onClick={onClose}
              className="md:hidden w-7 h-7 flex items-center justify-center rounded-md"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Mode toggle ───────────────────────────────────────────────────── */}
      <div className="px-3 py-4" style={{ borderBottom: "1px solid var(--border-dim)" }}>
        <p className="text-xs uppercase tracking-widest mb-2.5 px-2" style={{ color: "var(--text-muted)" }}>
          Mode
        </p>
        <div className="flex rounded-lg p-0.5" style={{ background: "var(--bg-elevated)" }}>
          {(["student", "professional"] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              disabled={isLoading}
              className="flex-1 py-1.5 rounded-md text-xs font-medium transition-all duration-200 capitalize disabled:opacity-50"
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

      {/* ── Question history ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {userMessages.length === 0 ? (
          <p className="text-xs px-2 mt-2" style={{ color: "var(--text-muted)" }}>
            Your questions will appear here.
          </p>
        ) : (
          <>
            <p className="text-xs uppercase tracking-widest mb-2 px-2" style={{ color: "var(--text-muted)" }}>
              This chat
            </p>
            <ul className="space-y-0.5">
              {userMessages.map((msg, idx) => (
                <li key={msg.id}>
                  <button
                    onClick={() => onQuestionClick(msg.id)}
                    className="w-full text-left px-2.5 py-2 rounded-md text-xs leading-snug transition-colors duration-150 flex items-start gap-1.5"
                    style={{ color: "var(--text-secondary)" }}
                    onMouseEnter={e => {
                      (e.currentTarget).style.background = "var(--bg-elevated)";
                      (e.currentTarget).style.color = "var(--text-primary)";
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget).style.background = "transparent";
                      (e.currentTarget).style.color = "var(--text-secondary)";
                    }}
                  >
                    <span className="flex-shrink-0 w-4 text-right" style={{ color: "var(--text-muted)" }}>
                      {idx + 1}.
                    </span>
                    <span className="line-clamp-2 flex-1">{msg.content}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ── Bottom actions ────────────────────────────────────────────────── */}
      <div className="px-3 pb-4 pt-3 space-y-1.5" style={{ borderTop: "1px solid var(--border-dim)" }}>
        <button
          onClick={onExport}
          disabled={messages.length === 0}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs transition-colors duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={e => {
            if (!messages.length) return;
            (e.currentTarget).style.background = "var(--bg-elevated)";
            (e.currentTarget).style.color = "var(--text-primary)";
          }}
          onMouseLeave={e => {
            (e.currentTarget).style.background = "transparent";
            (e.currentTarget).style.color = "var(--text-secondary)";
          }}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export chat (.md)
        </button>

        <button
          onClick={onNewChat}
          disabled={isLoading}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs transition-colors duration-150 disabled:opacity-50"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={e => {
            if (isLoading) return;
            (e.currentTarget).style.background = "var(--bg-elevated)";
            (e.currentTarget).style.color = "var(--text-primary)";
          }}
          onMouseLeave={e => {
            (e.currentTarget).style.background = "transparent";
            (e.currentTarget).style.color = "var(--text-secondary)";
          }}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 4v16m8-8H4" />
          </svg>
          New chat
        </button>
      </div>
    </aside>
  );
}