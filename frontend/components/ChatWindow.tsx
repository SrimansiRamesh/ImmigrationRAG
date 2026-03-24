"use client";

/**
 * ChatWindow.tsx
 *
 * Scrollable message list. Each message wrapper gets id="msg-{id}"
 * so the QuestionNav sidebar can scroll directly to any message.
 */

import { useEffect, useRef } from "react";
import { Message, Source } from "@/lib/api";
import MessageBubble from "./MessageBubble";
import LoadingIndicator from "./LoadingIndicator";

interface ChatWindowProps {
  messages:        Message[];
  isLoading:       boolean;
  onSuggestionClick: (text: string) => void;
  onViewSources:   (sources: Source[], messageId: string) => void;
}

const SUGGESTIONS = [
  "What is the H1B filing fee?",
  "How does F1 OPT cap-gap work?",
  "Do I need to file taxes on an F1 visa?",
];

export default function ChatWindow({
  messages,
  isLoading,
  onSuggestionClick,
  onViewSources,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        {/* Decorative mark */}
        <div className="relative mb-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, #1A3A72 0%, #0D2050 100%)",
              border: "1px solid #1E3A6E",
              boxShadow: "0 0 40px rgba(196, 137, 58, 0.08)",
            }}
          >
            <span className="font-display text-xl font-bold" style={{ color: "var(--accent)" }}>
              IQ
            </span>
          </div>
        </div>

        <h2
          className="font-display text-2xl font-semibold mb-2"
          style={{ color: "var(--text-primary)" }}
        >
          ImmigrationIQ
        </h2>
        <p className="text-sm max-w-xs mb-8" style={{ color: "var(--text-secondary)" }}>
          Ask me anything about US immigration — H1B, F1 OPT, green cards,
          tax filing for nonresidents, and more.
        </p>

        {/* Suggestion chips */}
        <div className="grid gap-2 w-full max-w-sm">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onSuggestionClick(s)}
              className="text-left px-4 py-3 rounded-xl text-sm transition-all duration-150"
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-dim)",
                color: "var(--text-secondary)",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.borderColor = "var(--accent)";
                el.style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.borderColor = "var(--border-dim)";
                el.style.color = "var(--text-secondary)";
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Message list ─────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto py-4">
      {messages.map((msg, idx) => (
        <div key={msg.id} id={`msg-${msg.id}`}>
          <MessageBubble
            message={msg}
            isLatest={msg.role === "assistant" && idx === messages.length - 1}
            onViewSources={onViewSources}
          />
        </div>
      ))}
      {isLoading && <LoadingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
