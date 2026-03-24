"use client";

/**
 * SourcesPanel.tsx
 *
 * Right panel that slides in when an assistant message has sources.
 * Shows the sources from the currently "active" message with links.
 */

import { Source } from "@/lib/api";

interface SourcesPanelProps {
  sources: Source[];
  onClose: () => void;
}

/** Convert YYYYMMDD integer → "Jan 2024" string. Returns null if missing/invalid. */
function formatEffectiveDate(d: number | null | undefined): string | null {
  if (!d) return null;
  const s = String(d);
  if (s.length !== 8) return null;
  const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const JURISDICTION_META: Record<string, { label: string; color: string; dot: string }> = {
  uscis:      { label: "USCIS",          color: "#1E3A8A", dot: "#3B82F6" },
  irs:        { label: "IRS",            color: "#14532D", dot: "#22C55E" },
  dol:        { label: "Dept. of Labor", color: "#78350F", dot: "#F59E0B" },
  state_dept: { label: "State Dept.",    color: "#581C87", dot: "#A855F7" },
};

const DOC_TYPE_LABELS: Record<string, string> = {
  policy_manual: "Policy Manual",
  form:          "Form",
  publication:   "Publication",
  bulletin:      "Bulletin",
  regulation:    "Regulation",
  faq:           "FAQ",
};

export default function SourcesPanel({ sources, onClose }: SourcesPanelProps) {
  return (
    <aside
      className="flex flex-col h-full"
      style={{ background: "var(--bg-surface)", borderLeft: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-4 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-dim)" }}
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
            style={{ color: "var(--accent)" }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-secondary)" }}>
            Sources
          </span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: "var(--bg-elevated)", color: "var(--accent)" }}
          >
            {sources.length}
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)")
          }
          aria-label="Close sources panel"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Sources list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {sources.map((source, idx) => {
          const meta = JURISDICTION_META[source.jurisdiction];
          const docLabel = DOC_TYPE_LABELS[source.doc_type] || source.doc_type;
          const dateLabel = formatEffectiveDate(source.effective_date);

          return (
            <div
              key={idx}
              className="rounded-lg p-3 transition-colors"
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-dim)",
              }}
            >
              {/* Jurisdiction + doc type row */}
              <div className="flex items-center gap-1.5 mb-2">
                {meta && (
                  <span
                    className="flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded"
                    style={{ background: meta.color + "33", color: meta.dot }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: meta.dot }}
                    />
                    {meta.label}
                  </span>
                )}
                {!meta && source.jurisdiction && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded font-medium uppercase"
                    style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
                  >
                    {source.jurisdiction}
                  </span>
                )}
                {docLabel && (
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {docLabel}
                  </span>
                )}
              </div>

              {/* Section name */}
              {source.section && (
                <p className="text-xs font-medium mb-1.5 leading-snug" style={{ color: "var(--text-primary)" }}>
                  {source.section}
                </p>
              )}

              {/* Effective date badge */}
              {dateLabel && (
                <p className="text-xs mb-1.5 flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Current as of {dateLabel}
                </p>
              )}

              {/* URL link */}
              {source.url && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs transition-colors group"
                  style={{ color: "var(--text-secondary)" }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = "var(--accent)")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = "var(--text-secondary)")
                  }
                >
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span className="truncate">{source.url.replace(/^https?:\/\//, "")}</span>
                </a>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer disclaimer */}
      <div
        className="px-4 py-3 flex-shrink-0"
        style={{ borderTop: "1px solid var(--border-dim)" }}
      >
        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          All sources are official government publications. Always verify current information at the source.
        </p>
      </div>
    </aside>
  );
}
