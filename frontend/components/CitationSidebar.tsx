"use client";

/**
 * CitationSidebar.tsx
 *
 * Expandable list of sources for a message.
 * Shows after the typewriter animation completes.
 */

import { useState } from "react";
import { Source } from "@/lib/api";

interface CitationSidebarProps {
  sources: Source[];
}

// Human-readable labels for jurisdictions
const JURISDICTION_LABELS: Record<string, string> = {
  uscis:      "USCIS",
  irs:        "IRS",
  dol:        "Dept. of Labor",
  state_dept: "State Dept.",
};

// Color coding by jurisdiction
const JURISDICTION_COLORS: Record<string, string> = {
  uscis:      "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  irs:        "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  dol:        "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  state_dept: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

export default function CitationSidebar({ sources }: CitationSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-2">
      {/* Toggle button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {sources.length} source{sources.length !== 1 ? "s" : ""}
      </button>

      {/* Source list */}
      {isOpen && (
        <div className="mt-2 space-y-2">
          {sources.map((source, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2 p-2 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
            >
              {/* Jurisdiction badge */}
              <span className={`
                flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-medium
                ${JURISDICTION_COLORS[source.jurisdiction] || "bg-gray-100 text-gray-600"}
              `}>
                {JURISDICTION_LABELS[source.jurisdiction] || source.jurisdiction.toUpperCase()}
              </span>

              {/* Source details */}
              <div className="min-w-0 flex-1">
                {source.section && (
                  <p className="text-xs text-gray-600 dark:text-gray-300 font-medium truncate">
                    {source.section}
                  </p>
                )}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 hover:underline truncate block"
                >
                  {source.url}
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}