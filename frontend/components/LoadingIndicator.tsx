"use client";

export default function LoadingIndicator() {
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

      {/* Bouncing dots */}
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3"
        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-dim)" }}
      >
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="block w-1.5 h-1.5 rounded-full"
              style={{
                background: "var(--text-muted)",
                animation: `bounce-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
