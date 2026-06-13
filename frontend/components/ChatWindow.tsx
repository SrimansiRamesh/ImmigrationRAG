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
  onCiteClick:     (index: number) => void;
}

const SUGGESTIONS: { text: string; icon: string }[] = [
  { text: "What is the H1B filing fee?",                       icon: "ti-file-dollar" },
  { text: "How does F1 OPT cap-gap work?",                     icon: "ti-calendar-time" },
  { text: "Do I need to file taxes on an F1 visa?",            icon: "ti-receipt-tax" },
  { text: "How do I get a green card through employment?",     icon: "ti-id-badge" },
];

export default function ChatWindow({
  messages,
  isLoading,
  onSuggestionClick,
  onViewSources,
  onCiteClick,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {/* Logo mark */}
        <div
          className="rounded-2xl flex items-center justify-center mb-5"
          style={{ width: 56, height: 56, background: "var(--iq-teal)" }}
        >
          <span className="font-display text-xl leading-none" style={{ color: "#fff" }}>
            IQ
          </span>
        </div>

        <h2 className="font-display text-2xl mb-2" style={{ color: "var(--iq-ink)" }}>
          ImmigrationIQ
        </h2>
        <p className="text-sm max-w-sm mb-7" style={{ color: "var(--iq-muted)" }}>
          Ask me anything about US immigration — H1B, F1 OPT, green cards,
          tax filing for nonresidents, and more.
        </p>

        {/* 2×2 suggestion grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
          {SUGGESTIONS.map(({ text, icon }) => (
            <button
              key={text}
              onClick={() => onSuggestionClick(text)}
              className="flex items-center gap-2.5 text-left px-3.5 py-3 rounded-xl text-sm transition-all duration-150"
              style={{
                background: "var(--iq-white)",
                border: "1px solid var(--iq-border)",
                color: "var(--iq-ink)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--iq-teal)";
                e.currentTarget.style.background = "#F0FAF7";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--iq-border)";
                e.currentTarget.style.background = "var(--iq-white)";
              }}
            >
              <span
                className="flex items-center justify-center rounded-lg flex-shrink-0"
                style={{ width: 28, height: 28, background: "var(--iq-teal-light)", color: "var(--iq-teal-dark)" }}
              >
                <i className={`ti ${icon} text-base`} />
              </span>
              <span className="leading-snug">{text}</span>
            </button>
          ))}
        </div>

        {/* Sources badge */}
        <div
          className="flex items-center gap-2 mt-7 px-3 py-1.5 rounded-full text-xs"
          style={{ background: "var(--iq-surface)", color: "var(--iq-muted)" }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--iq-teal-mid)" }} />
          Sources: USCIS · DOL · IRS
        </div>
      </div>
    );
  }

  // ── Message list ─────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto py-4">
      {messages.map((msg) => (
        <div key={msg.id} id={`msg-${msg.id}`}>
          <MessageBubble
            message={msg}
            onViewSources={onViewSources}
            onCiteClick={onCiteClick}
          />
        </div>
      ))}
      {isLoading && <LoadingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
