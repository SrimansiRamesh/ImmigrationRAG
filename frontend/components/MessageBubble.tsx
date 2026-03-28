"use client";

import { Message, Source } from "@/lib/api";
import TypewriterText from "./TypewriterText";
import ReactMarkdown from "react-markdown";

interface MessageBubbleProps {
  message:        Message;
  isLatest?:      boolean;
  onViewSources?: (sources: Source[], messageId: string) => void;
}

export default function MessageBubble({ message, isLatest, onViewSources }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end px-5 py-2">
        <div className="max-w-[72%] flex flex-col items-end gap-1.5">
          {message.attachment && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
              style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-dim)", color: "var(--text-muted)" }}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ color: "var(--accent)" }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              {message.attachment.filename}
              {message.attachment.summarised && <span>· summarised</span>}
            </div>
          )}
          <div
            className="rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed"
            style={{ background: "var(--user-bg)", color: "var(--user-text)", overflowWrap: "break-word", wordBreak: "break-word" }}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 px-5 py-3">
      {/* Avatar */}
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{
          background: "linear-gradient(135deg, #1A3A72 0%, #0D2050 100%)",
          border: "1px solid #1E3A6E",
        }}
      >
        <span className="text-xs font-bold tracking-wider" style={{ color: "var(--accent)" }}>
          IQ
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed"
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-dim)",
            color: "var(--text-primary)",
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {isLatest ? (
            <TypewriterText text={message.content} speed={10} />
          ) : (
            <div
              className="prose prose-sm max-w-none prose-p:my-1 prose-headings:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-a:text-[var(--accent)] prose-code:text-[var(--accent)] prose-li:my-0.5"
              style={{ color: "var(--text-primary)", overflowWrap: "break-word", wordBreak: "break-word" }}
            >
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Sources + complexity */}
        {(message.sources?.length || message.complexity) && (
          <div className="flex items-center gap-3 mt-1.5 px-1">
            {message.sources && message.sources.length > 0 && (
              <button
                onClick={() => onViewSources?.(message.sources!, message.id)}
                className="flex items-center gap-1.5 text-xs transition-colors"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--accent)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)")}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {message.sources.length} source{message.sources.length !== 1 ? "s" : ""}
              </button>
            )}
            {message.complexity && (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {message.complexity === "complex" ? "↩ multi-query" : "→ direct"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}