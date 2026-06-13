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
  const [visible,   setVisible]   = useState(false);
  const [fadeOut,   setFadeOut]   = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [msgIdx,    setMsgIdx]    = useState(0);

  useEffect(() => {
  let elapsed = 0;
  let done    = false;
  let interval: ReturnType<typeof setInterval>;

  const dismiss = () => {
    if (done) return;
    done = true;
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    setProgress(100);
    setFadeOut(true);
    setTimeout(() => setVisible(false), 600);
  };

  // Re-check immediately when the tab becomes visible/focused. Browsers like
  // Arc prerender tabs and throttle background timers, so the polling interval
  // can stall while hidden — by the time the user opens the tab the backend may
  // already be awake. This catches that case without waiting for the next tick.
  const onVisible = async () => {
    if (done || document.visibilityState !== "visible") return;
    if (await checkHealth()) dismiss();
  };

  checkHealth().then(healthy => {
    if (healthy || done) {
      return;
    }

    setVisible(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // Backend is cold — start polling
    interval = setInterval(async () => {
      elapsed += POLL_INTERVAL;
      setProgress(p => Math.min(p + PROGRESS_STEP, 95));
      setMsgIdx(prev => Math.min(prev + 1, MESSAGES.length - 1));

      const healthy = await checkHealth();
      if (healthy) {
        dismiss();
        return;
      }

      if (elapsed >= MAX_WAIT) {
        dismiss();
      }
    }, POLL_INTERVAL);
  });

  return () => {
    done = true;
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
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
        style={{ background: "var(--iq-teal)" }}
      >
        <span className="font-display text-lg leading-none" style={{ color: "#fff" }}>
          IQ
        </span>
      </div>

      <h1
        className="font-display text-xl mb-1"
        style={{ color: "var(--text-primary)" }}
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
    </div>
  );
}