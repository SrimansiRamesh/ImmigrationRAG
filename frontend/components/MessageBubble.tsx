"use client";

import { Message, Source } from "@/lib/api";
import TypewriterText from "./TypewriterText";
import MarkdownWithCitations from "./MarkdownWithCitations";

interface MessageBubbleProps {
  message:        Message;
  onViewSources?: (sources: Source[], messageId: string) => void;
  onCiteClick?:   (index: number) => void;
}

export default function MessageBubble({ message, onViewSources, onCiteClick }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end px-5 py-2">
        <div className="max-w-[75%] self-end flex flex-col items-end gap-1.5">
          {message.attachment && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
              style={{ background: "var(--iq-white)", border: "1px solid var(--iq-border)", color: "var(--iq-muted)" }}
            >
              <i className="ti ti-paperclip text-sm" style={{ color: "var(--iq-teal)" }} />
              {message.attachment.filename}
              {message.attachment.summarised && <span> · summarised</span>}
            </div>
          )}
          <div
            className="px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "var(--iq-teal)",
              color: "#fff",
              borderRadius: "10px 10px 2px 10px",
              overflowWrap: "break-word",
              wordBreak: "break-word",
            }}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start px-5 py-3">
      <div className="min-w-0 max-w-[75%] self-start">
        <div
          className="px-4 py-3 text-sm leading-relaxed"
          style={{
            background: "var(--iq-white)",
            border: "1px solid var(--iq-border)",
            color: "var(--iq-ink)",
            borderRadius: "2px 10px 10px 10px",
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {message.animate === true ? (
            <TypewriterText text={message.content} speed={10} onCiteClick={onCiteClick} />
          ) : (
            <MarkdownWithCitations
              content={message.content}
              onCiteClick={onCiteClick}
              className="prose prose-sm max-w-none prose-p:my-1 prose-headings:text-[var(--iq-ink)] prose-strong:text-[var(--iq-ink)] prose-a:text-[var(--iq-teal)] prose-code:text-[var(--iq-teal-dark)] prose-li:my-0.5"
              style={{ color: "var(--iq-ink)", overflowWrap: "break-word", wordBreak: "break-word" }}
            />
          )}
        </div>

        {/* Sources button */}
        {message.sources && message.sources.length > 0 && (
          <div className="flex items-center gap-3 mt-1.5 px-1">
            <button
              onClick={() => onViewSources?.(message.sources!, message.id)}
              className="flex items-center gap-1.5 text-xs font-medium transition-opacity"
              style={{ color: "var(--iq-teal)" }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.7")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <i className="ti ti-files text-sm" />
              {message.sources.length} source{message.sources.length !== 1 ? "s" : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
