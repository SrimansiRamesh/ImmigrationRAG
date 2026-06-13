"use client";

import { useState, useRef } from "react";
import { Message, Mode } from "@/lib/api";
import { Conversation } from "@/lib/conversations";
import AuthButton from "./AuthButton";

interface QuestionNavProps {
  messages:             Message[];
  mode:                 Mode;
  onModeChange:         (m: Mode) => void;
  onNewChat:            () => void;
  onExport:             () => void;
  isLoading:            boolean;
  onClose?:             () => void; // mobile only
  userId:               string | null;
  conversations:        Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onRename:             (id: string, newTitle: string) => void;
  onDelete:             (id: string) => void;
  collapsed?:           boolean;       // desktop-only collapse state
  onToggleCollapse?:    () => void;    // present only on the desktop instance
}

const MODES: { key: Mode; label: string; icon: string }[] = [
  { key: "student",      label: "Student", icon: "ti-school" },
  { key: "professional", label: "Pro",     icon: "ti-briefcase" },
];

export default function QuestionNav({
  messages, mode, onModeChange, onNewChat, onExport, isLoading, onClose,
  userId, conversations, activeConversationId, onSelectConversation,
  onRename, onDelete, collapsed = false, onToggleCollapse,
}: QuestionNavProps) {
  // Inline rename / delete-confirm UI state (local to the sidebar)
  const [editingId,         setEditingId]         = useState<string | null>(null);
  const [editValue,         setEditValue]         = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const editDoneRef = useRef(false); // dedupes Enter + blur both committing

  const startRename = (c: Conversation) => {
    editDoneRef.current = false;
    setConfirmingDeleteId(null);
    setEditingId(c.id);
    setEditValue(c.title);
  };

  const finishRename = (c: Conversation) => {
    if (editDoneRef.current) return;
    editDoneRef.current = true;
    const v = editValue.trim();
    setEditingId(null);
    setEditValue("");
    if (v && v !== c.title) onRename(c.id, v); // empty/unchanged → revert silently
  };

  const cancelRename = () => {
    editDoneRef.current = true;
    setEditingId(null);
    setEditValue("");
  };

  // ── Collapsed icon rail (desktop only) ──────────────────────────────────────
  if (collapsed && onToggleCollapse) {
    return (
      <aside
        className="flex flex-col items-center h-full w-full overflow-hidden py-4"
        style={{ background: "var(--iq-surface)", borderRight: "1px solid var(--iq-border)" }}
      >
        {/* Logo */}
        <div
          className="rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ width: 30, height: 30, background: "var(--iq-teal)" }}
        >
          <span className="font-display text-sm leading-none" style={{ color: "#fff" }}>IQ</span>
        </div>

        {/* New chat */}
        <button
          onClick={onNewChat}
          disabled={isLoading}
          title="New chat"
          className="mt-4 rounded-lg flex items-center justify-center flex-shrink-0 disabled:opacity-50"
          style={{ width: 30, height: 30, background: "var(--iq-teal)", color: "#fff" }}
        >
          <i className="ti ti-plus text-base" />
        </button>

        {/* Conversations indicator */}
        <div
          className="mt-3 flex items-center justify-center flex-shrink-0"
          style={{ width: 30, height: 30, color: "var(--iq-hint)" }}
          title="Conversations"
        >
          <i className="ti ti-message text-base" />
        </div>

        <div className="flex-1" />

        {/* Expand toggle */}
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          className="flex items-center justify-center"
          style={{ width: 24, height: 24, color: "#9E9B93" }}
          onMouseEnter={e => (e.currentTarget.style.color = "#1A1A2E")}
          onMouseLeave={e => (e.currentTarget.style.color = "#9E9B93")}
        >
          <i className="ti ti-chevron-right text-base" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col h-full w-full min-w-0 overflow-hidden"
      style={{ background: "var(--iq-surface)", borderRight: "1px solid var(--iq-border)" }}
    >
      {/* ── Logo ──────────────────────────────────────────────────────────── */}
      <div className="px-4 pt-5 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ width: 30, height: 30, background: "var(--iq-teal)" }}
          >
            <span className="font-display text-sm leading-none" style={{ color: "#fff" }}>
              IQ
            </span>
          </div>
          <h1 className="font-display leading-none" style={{ fontSize: 14, color: "var(--iq-ink)" }}>
            ImmigrationIQ
          </h1>
        </div>

        {/* Close button — mobile only */}
        {onClose && (
          <button
            onClick={onClose}
            className="md:hidden w-7 h-7 flex items-center justify-center rounded-md"
            style={{ color: "var(--iq-muted)" }}
          >
            <i className="ti ti-x text-base" />
          </button>
        )}
      </div>

      {/* ── Mode toggle ───────────────────────────────────────────────────── */}
      <div className="px-3 pb-3">
        <div
          className="flex rounded-lg p-0.5"
          style={{ background: "var(--iq-surface-2)" }}
        >
          {MODES.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => onModeChange(key)}
              disabled={isLoading}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all duration-200 disabled:opacity-50"
              style={mode === key
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

      {/* ── New chat ──────────────────────────────────────────────────────── */}
      <div className="px-3 pb-3">
        <button
          onClick={onNewChat}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity duration-150 disabled:opacity-50"
          style={{ background: "var(--iq-teal)", color: "#fff" }}
        >
          <i className="ti ti-plus text-base" />
          New chat
        </button>
      </div>

      {/* ── Conversation list (signed in) / sign-in prompt (signed out) ───── */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {!userId ? (
          <p className="px-2 mt-2" style={{ fontSize: 11, color: "var(--iq-hint)" }}>
            Sign in to save conversations
          </p>
        ) : conversations.length === 0 ? (
          <p className="px-2 mt-2" style={{ fontSize: 11, color: "var(--iq-hint)" }}>
            No saved chats yet.
          </p>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-widest mb-1.5 px-2" style={{ color: "var(--iq-hint)" }}>
              Conversations
            </p>
            <ul className="space-y-0.5">
              {conversations.map((c) => {
                const active     = c.id === activeConversationId;
                const editing    = editingId === c.id;
                const confirming = confirmingDeleteId === c.id;
                return (
                  <li key={c.id}>
                    <div
                      className="group flex items-center rounded-md transition-colors duration-150"
                      style={{ background: active ? "#D9D6CC" : "transparent" }}
                      onMouseEnter={e => { if (!active && !editing) e.currentTarget.style.background = "var(--iq-surface-2)"; }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                    >
                      {editing ? (
                        <div className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-2">
                          <i className="ti ti-message text-sm flex-shrink-0" style={{ color: "var(--iq-hint)" }} />
                          <input
                            autoFocus
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") finishRename(c);
                              else if (e.key === "Escape") cancelRename();
                            }}
                            onBlur={() => finishRename(c)}
                            className="flex-1 min-w-0 text-xs outline-none border-0"
                            style={{ background: "#D9D6CC", borderRadius: 4, padding: "2px 6px", color: "var(--iq-ink)" }}
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => onSelectConversation(c.id)}
                          className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-2 text-left text-xs leading-snug"
                          style={{ color: active ? "var(--iq-ink)" : "var(--iq-muted)" }}
                        >
                          <i className="ti ti-message text-sm flex-shrink-0" style={{ color: "var(--iq-hint)" }} />
                          <span className="truncate flex-1 min-w-0">{c.title}</span>
                        </button>
                      )}

                      {/* Hover actions / delete confirmation (hidden while renaming) */}
                      {!editing && (confirming ? (
                        <div className="flex items-center gap-1 pr-2 flex-shrink-0">
                          <span className="text-[11px]" style={{ color: "var(--iq-muted)" }}>Delete?</span>
                          <button
                            onClick={() => { setConfirmingDeleteId(null); onDelete(c.id); }}
                            title="Confirm delete"
                            className="flex items-center justify-center"
                            style={{ width: 20, height: 20, color: "#DC2626" }}
                          >
                            <i className="ti ti-check text-sm" />
                          </button>
                          <button
                            onClick={() => setConfirmingDeleteId(null)}
                            title="Cancel"
                            className="flex items-center justify-center"
                            style={{ width: 20, height: 20, color: "var(--iq-hint)" }}
                          >
                            <i className="ti ti-x text-sm" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 pr-2 flex-shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150">
                          <button
                            onClick={() => startRename(c)}
                            title="Rename"
                            className="flex items-center justify-center"
                            style={{ width: 20, height: 20, color: "#9E9B93" }}
                            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A2E")}
                            onMouseLeave={e => (e.currentTarget.style.color = "#9E9B93")}
                          >
                            <i className="ti ti-pencil text-sm" />
                          </button>
                          <button
                            onClick={() => setConfirmingDeleteId(c.id)}
                            title="Delete"
                            className="flex items-center justify-center"
                            style={{ width: 20, height: 20, color: "#9E9B93" }}
                            onMouseEnter={e => (e.currentTarget.style.color = "#DC2626")}
                            onMouseLeave={e => (e.currentTarget.style.color = "#9E9B93")}
                          >
                            <i className="ti ti-trash text-sm" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* ── Collapse toggle (desktop only) ────────────────────────────────── */}
      {onToggleCollapse && (
        <div className="px-3 pb-2 flex justify-end">
          <button
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            className="flex items-center justify-center"
            style={{ width: 24, height: 24, color: "#9E9B93" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A2E")}
            onMouseLeave={e => (e.currentTarget.style.color = "#9E9B93")}
          >
            <i className="ti ti-chevron-left text-base" />
          </button>
        </div>
      )}

      {/* ── Footer: export + auth ─────────────────────────────────────────── */}
      <div className="px-3 pb-4 pt-2 space-y-2" style={{ borderTop: "1px solid var(--iq-border)" }}>
        <button
          onClick={onExport}
          disabled={messages.length === 0}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-colors duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ color: "var(--iq-muted)" }}
          onMouseEnter={e => { if (messages.length) e.currentTarget.style.color = "var(--iq-ink)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--iq-muted)"; }}
        >
          <i className="ti ti-download text-sm" />
          Export chat (.md)
        </button>

        <AuthButton />
      </div>
    </aside>
  );
}
