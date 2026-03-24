"use client";

import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

interface TypewriterTextProps {
  text:        string;
  speed?:      number;
  onComplete?: () => void;
}

/** Strip markdown syntax so plain text looks clean during animation */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")           // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")     // bold
    .replace(/\*(.+?)\*/g, "$1")         // italic
    .replace(/`(.+?)`/g, "$1")           // inline code
    .replace(/^\s*[-*+]\s/gm, "• ")      // unordered bullets
    .replace(/^\s*\d+\.\s/gm, "")        // ordered list numbers
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")  // links → label only
    .replace(/\n{3,}/g, "\n\n");         // excess blank lines
}

export default function TypewriterText({
  text,
  speed = 10,
  onComplete,
}: TypewriterTextProps) {
  const [displayed,   setDisplayed]   = useState("");
  const [isComplete,  setIsComplete]  = useState(false);
  const indexRef   = useRef(0);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  const skipToEnd = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setDisplayed(text);
    setIsComplete(true);
    onCompleteRef.current?.();
  };

  useEffect(() => {
    indexRef.current = 0;
    setDisplayed("");
    setIsComplete(false);

    const tick = () => {
      if (indexRef.current < text.length) {
        indexRef.current += 1;
        setDisplayed(text.slice(0, indexRef.current));
        timerRef.current = setTimeout(tick, speed);
      } else {
        setIsComplete(true);
        onCompleteRef.current?.();
      }
    };

    timerRef.current = setTimeout(tick, speed);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [text, speed]);

  // While animating: stripped plain text (fast, no markdown symbols)
  // Once complete:  full ReactMarkdown rendering
  return (
    <div>
      {isComplete ? (
        <div
          className="prose prose-sm max-w-none prose-p:my-1 prose-headings:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-a:text-[var(--accent)] prose-code:text-[var(--accent)] prose-li:my-0.5"
          style={{ color: "var(--text-primary)" }}
        >
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      ) : (
        <div className="whitespace-pre-wrap">
          {stripMarkdown(displayed)}
          <span className="cursor-blink" />
        </div>
      )}

      {!isComplete && (
        <button
          onClick={skipToEnd}
          className="mt-2 text-xs transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)")}
        >
          Skip ↓
        </button>
      )}
    </div>
  );
}
