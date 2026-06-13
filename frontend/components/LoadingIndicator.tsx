"use client";

import { useEffect, useState } from "react";

const SIMPLE_STAGES = [
  "Searching federal databases…",
  "Retrieving relevant documents…",
  "Analyzing context…",
  "Drafting response…",
];

const COMPLEX_STAGES = [
  "Decomposing your question…",
  "Searching federal databases…",
  "Retrieving relevant documents…",
  "Cross-referencing sources…",
  "Analyzing context…",
  "Synthesizing findings…",
  "Drafting response…",
];

interface Props {
  complexity?: "simple" | "complex";
}

export default function LoadingIndicator({ complexity = "simple" }: Props) {
  const stages = complexity === "complex" ? COMPLEX_STAGES : SIMPLE_STAGES;
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setIdx(0);
    setVisible(true);
  }, [complexity]);

  useEffect(() => {
    // Fade out, advance index, fade in
    const fadeOut = setTimeout(() => setVisible(false), 1800);
    const advance = setTimeout(() => {
      setIdx(prev => (prev + 1) % stages.length);
      setVisible(true);
    }, 2000);

    return () => {
      clearTimeout(fadeOut);
      clearTimeout(advance);
    };
  }, [idx, stages.length]);

  return (
    <div className="flex items-start gap-3 px-5 py-3">
      {/* Avatar */}
      <div
        className="flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ width: 30, height: 30, background: "#0F6B6B", borderRadius: 7 }}
      >
        <span className="font-display leading-none" style={{ color: "#E1F5EE", fontSize: 12 }}>
          IQ
        </span>
      </div>

      {/* Status message */}
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3"
        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-dim)" }}
      >
        <div className="flex items-center gap-2.5">
          {/* Spinner */}
          <svg
            className="w-3.5 h-3.5 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }}
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>

          {/* Rotating message */}
          <span
            className="text-sm"
            style={{
              color: "var(--text-secondary)",
              transition: "opacity 0.2s ease",
              opacity: visible ? 1 : 0,
              minWidth: "220px",
            }}
          >
            {stages[idx]}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}