"use client";

/**
 * ColdStartOverlay.tsx
 *
 * Shown on first app load while the Render backend wakes from sleep.
 * Polls /health every 4 seconds. Fades out when backend responds.
 * Never shown again for the rest of the session.
 */

import { useEffect, useState } from "react";
import { checkHealth } from "@/lib/api";

const MESSAGES = [
  "Initializing secure connection…",
  "Loading immigration database…",
  "Warming up AI systems…",
  "Connecting to federal sources…",
  "Almost ready…",
];

const POLL_INTERVAL   = 4000;   // ms between health checks
const MAX_WAIT        = 120000; // 2 min max before we give up and hide anyway
const PROGRESS_STEP   = 100 / (MAX_WAIT / POLL_INTERVAL); // % per poll tick

export default function ColdStartOverlay() {
  const [visible,   setVisible]   = useState(true);
  const [fadeOut,   setFadeOut]   = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [msgIdx,    setMsgIdx]    = useState(0);

  useEffect(() => {
    let elapsed  = 0;
    let interval: ReturnType<typeof setInterval>;

    const dismiss = () => {
      clearInterval(interval);
      setProgress(100);
      setFadeOut(true);
      setTimeout(() => setVisible(false), 600); // matches fade-out duration
    };

    interval = setInterval(async () => {
      elapsed += POLL_INTERVAL;

      // Advance progress bar and rotate message
      setProgress(p => Math.min(p + PROGRESS_STEP, 95)); // cap at 95 until confirmed ready
      setMsgIdx(prev => Math.min(prev + 1, MESSAGES.length - 1));

      // Check if backend is awake
      const healthy = await checkHealth();
      if (healthy) {
        dismiss();
        return;
      }

      // Give up after MAX_WAIT
      if (elapsed >= MAX_WAIT) {
        dismiss();
      }
    }, POLL_INTERVAL);

    // Also check immediately on mount (might already be warm)
    checkHealth().then(healthy => { if (healthy) dismiss(); });

    return () => clearInterval(interval);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background:  "var(--bg-base)",
        transition:  "opacity 0.6s ease",
        opacity:     fadeOut ? 0 : 1,
        pointerEvents: fadeOut ? "none" : "all",
      }}
    >
      {/* Logo */}
      <div
        className="w-14 h-14 rounded-xl flex items-center justify-center mb-6"
        style={{
          background: "linear-gradient(135deg, #1A3A72 0%, #0D2050 100%)",
          border:     "1px solid #1E3A6E",
        }}
      >
        <span className="text-lg font-bold tracking-wider" style={{ color: "var(--accent)" }}>
          IQ
        </span>
      </div>

      <h1
        className="text-xl font-semibold mb-1"
        style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading, serif)" }}
      >
        ImmigrationIQ
      </h1>

      <p className="text-sm mb-8" style={{ color: "var(--text-muted)" }}>
        Your AI-powered immigration assistant
      </p>

      {/* Status message */}
      <p
        className="text-sm mb-4 h-5 text-center"
        style={{ color: "var(--text-secondary)", transition: "opacity 0.3s ease" }}
      >
        {MESSAGES[msgIdx]}
      </p>

      {/* Progress bar */}
      <div
        className="rounded-full overflow-hidden"
        style={{
          width:      "260px",
          height:     "3px",
          background: "var(--border)",
        }}
      >
        <div
          style={{
            height:     "100%",
            width:      `${progress}%`,
            background: "var(--accent)",
            transition: `width ${POLL_INTERVAL - 200}ms ease`,
            borderRadius: "9999px",
          }}
        />
      </div>

      <p className="text-xs mt-4" style={{ color: "var(--text-muted)" }}>
        Free server waking from sleep — usually under 2 minutes
      </p>
    </div>
  );
}