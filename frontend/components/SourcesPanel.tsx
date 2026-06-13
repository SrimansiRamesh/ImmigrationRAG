"use client";

/**
 * SourcesPanel.tsx
 *
 * Right panel that slides in when an assistant message has sources.
 * Shows the sources from the currently "active" message with links.
 */

import { Source, EvalScores } from "@/lib/api";

interface SourcesPanelProps {
  sources: Source[];
  onClose: () => void;
  activeIndex?: number | null;
  scores?: EvalScores | null;
}

const QUALITY_ROWS: { label: string; key: keyof EvalScores }[] = [
  { label: "Faithfulness", key: "faithfulness" },
  { label: "Relevance",    key: "answer_relevance" },
  { label: "Precision",    key: "context_precision" },
];

/** Convert YYYYMMDD integer → "Jan 2024" string. Returns null if missing/invalid. */
function formatEffectiveDate(d: number | null | undefined): string | null {
  if (!d) return null;
  const s = String(d);
  if (s.length !== 8) return null;
  const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const JURISDICTION_META: Record<string, { label: string; bg: string; fg: string }> = {
  uscis:      { label: "USCIS",       bg: "var(--iq-teal-light)", fg: "var(--iq-teal-dark)" },
  dol:        { label: "DOL",         bg: "var(--iq-blue-light)", fg: "var(--iq-blue-dark)" },
  irs:        { label: "IRS",         bg: "var(--iq-amber-light)", fg: "var(--iq-amber-dark)" },
  state_dept: { label: "State Dept.", bg: "var(--iq-surface)",    fg: "var(--iq-muted)" },
};

const DOC_TYPE_LABELS: Record<string, string> = {
  policy_manual: "Policy Manual",
  form:          "Form",
  publication:   "Publication",
  bulletin:      "Bulletin",
  regulation:    "Regulation",
  faq:           "FAQ",
};

export default function SourcesPanel({ sources, onClose, activeIndex = null, scores = null }: SourcesPanelProps) {
  return (
    <aside
      className="flex flex-col h-full"
      style={{ background: "var(--iq-surface)", borderLeft: "1px solid var(--iq-border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--iq-hint)" }}>
            Sources
          </span>
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{ background: "var(--iq-white)", color: "var(--iq-muted)" }}
          >
            {sources.length} retrieved
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center transition-colors"
          style={{ color: "var(--iq-hint)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--iq-ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--iq-hint)")}
          aria-label="Close sources panel"
        >
          <i className="ti ti-x text-base" />
        </button>
      </div>

      {/* Sources list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
        {sources.map((source, idx) => {
          const meta = JURISDICTION_META[source.jurisdiction];
          const docLabel = DOC_TYPE_LABELS[source.doc_type] || source.doc_type;
          const dateLabel = formatEffectiveDate(source.effective_date);

          const isActive = activeIndex === idx;

          return (
            <div
              key={idx}
              className="relative rounded-lg p-3 transition-colors duration-200"
              style={{
                background: isActive ? "#F0FAF7" : "var(--iq-white)",
                border: `1px solid ${isActive ? "#0F6B6B" : "var(--iq-border)"}`,
              }}
            >
              {/* Numbered badge */}
              <span
                className="absolute top-2.5 right-2.5 flex items-center justify-center"
                style={{ width: 16, height: 16, background: "#E1F5EE", color: "#0F6E56", borderRadius: 4, fontSize: 9, fontWeight: 600 }}
              >
                {idx + 1}
              </span>

              {/* Agency tag */}
              <div className="flex items-center gap-1.5 mb-2 pr-6">
                {meta ? (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                    style={{ background: meta.bg, color: meta.fg }}
                  >
                    {meta.label}
                  </span>
                ) : source.jurisdiction ? (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase"
                    style={{ background: "var(--iq-surface)", color: "var(--iq-muted)" }}
                  >
                    {source.jurisdiction}
                  </span>
                ) : null}
                {docLabel && (
                  <span className="text-[10px]" style={{ color: "var(--iq-hint)" }}>
                    {docLabel}
                  </span>
                )}
              </div>

              {/* Title */}
              {source.section && (
                <p
                  className="mb-1.5 leading-snug line-clamp-2"
                  style={{ fontSize: 12, fontWeight: 500, color: "var(--iq-ink)" }}
                >
                  {source.section}
                </p>
              )}

              {/* Effective date */}
              {dateLabel && (
                <p className="flex items-center gap-1 mb-1.5" style={{ fontSize: 11, color: "var(--iq-hint)" }}>
                  <i className="ti ti-calendar-time text-xs" />
                  Current as of {dateLabel}
                </p>
              )}

              {/* URL link */}
              {source.url && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 transition-colors"
                  style={{ fontSize: 11, color: "var(--iq-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--iq-teal)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--iq-muted)")}
                >
                  <i className="ti ti-external-link text-xs flex-shrink-0" />
                  <span className="truncate">{source.url.replace(/^https?:\/\//, "")}</span>
                </a>
              )}
            </div>
          );
        })}
      </div>

      {/* Response quality (RAGAS-style eval scores) — fades in once scores arrive */}
      {scores && (
        <div className="px-3 pb-3 flex-shrink-0 iq-fade-in">
          <p
            className="mb-2"
            style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "#9E9B93" }}
          >
            Response Quality
          </p>
          <div style={{ background: "#EDEAE0", borderRadius: 8, padding: "10px 12px" }}>
            {QUALITY_ROWS.map(({ label, key }) => {
              const value = scores[key];
              const pct = value != null ? Math.max(0, Math.min(1, value)) * 100 : 0;
              return (
                <div key={key} className="flex items-center gap-2 py-1">
                  <span style={{ fontSize: 11, color: "#4A4840", width: 80, flexShrink: 0 }}>{label}</span>
                  <div style={{ flex: 1, height: 4, background: "#D9D6CC", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: 4, background: "#1D9E75", width: `${pct}%` }} />
                  </div>
                  <span
                    style={{ fontSize: 11, fontWeight: 500, color: "#1A1A2E", width: 26, flexShrink: 0, textAlign: "right" }}
                  >
                    {value != null ? value.toFixed(2) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer disclaimer */}
      <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: "1px solid var(--iq-border)" }}>
        <p className="leading-relaxed" style={{ fontSize: 11, color: "var(--iq-hint)" }}>
          All sources are official government publications. Always verify current information at the source.
        </p>
      </div>
    </aside>
  );
}
