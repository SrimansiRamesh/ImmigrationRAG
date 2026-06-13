"use client";

/**
 * LandingPage.tsx
 *
 * Shown to unauthenticated users before the chat interface. Purely a
 * sign-in gate — the only action is "Continue with Google". Signed-in
 * users never see this (page.tsx renders the chat instead).
 */

import { supabase } from "@/lib/supabase";

const FEATURES = [
  { icon: "ti-file-text",    title: "Official sources", desc: "USCIS, DOL, and IRS documents only" },
  { icon: "ti-shield-check", title: "Cited answers",    desc: "Every claim linked to its source" },
  { icon: "ti-history",      title: "Saved history",    desc: "Conversations sync across devices" },
];

export default function LandingPage({ onContinueAnon }: { onContinueAnon: () => void }) {
  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });

  return (
    <div
      className="h-screen w-full flex flex-col items-center justify-center px-6"
      style={{ background: "#F7F6F2" }}
    >
      {/* Logo mark */}
      <div
        className="flex items-center justify-center"
        style={{ width: 56, height: 56, borderRadius: 14, background: "#0F6B6B" }}
      >
        <span className="font-display" style={{ color: "#fff", fontSize: 22, lineHeight: 1 }}>IQ</span>
      </div>

      {/* Title */}
      <h1 className="font-display mt-5" style={{ fontSize: 32, color: "#1A1A2E", lineHeight: 1.1 }}>
        ImmigrationIQ
      </h1>

      {/* Subtitle */}
      <p className="mt-2 text-center" style={{ fontSize: 16, color: "#6B6860", maxWidth: 360 }}>
        Grounded answers to your US immigration questions
      </p>

      {/* Sources badge */}
      <div
        className="flex items-center gap-2 mt-4"
        style={{ background: "#E1F5EE", color: "#0F6E56", borderRadius: 20, padding: "4px 12px", fontSize: 12 }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 9999, background: "#1D9E75", display: "inline-block" }} />
        Sources: USCIS · DOL · IRS
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-8 w-full" style={{ maxWidth: 560 }}>
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="flex flex-col items-center text-center"
            style={{ background: "#EDEAE0", borderRadius: 10, padding: 16 }}
          >
            <i className={`ti ${f.icon}`} style={{ color: "#0F6B6B", fontSize: 20 }} />
            <p className="mt-2" style={{ fontSize: 13, fontWeight: 600, color: "#1A1A2E" }}>{f.title}</p>
            <p className="mt-1" style={{ fontSize: 11, color: "#6B6860" }}>{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Continue with Google */}
      <button
        onClick={signIn}
        className="flex items-center justify-center gap-2 mt-8 w-full transition-opacity duration-150 hover:opacity-90"
        style={{ maxWidth: 280, background: "#0F6B6B", color: "#fff", fontSize: 14, fontWeight: 500, borderRadius: 9, padding: 12 }}
      >
        <i className="ti ti-brand-google text-base" />
        Continue with Google
      </button>

      {/* Continue without signing in */}
      <button
        onClick={onContinueAnon}
        className="mt-3 bg-transparent no-underline hover:underline"
        style={{ fontSize: 12, color: "#9E9B93" }}
      >
        Continue without signing in
      </button>

      {/* Fine print */}
      <p className="mt-3 text-center" style={{ fontSize: 11, color: "#B4B2A9", maxWidth: 280 }}>
        By signing in you agree this is for informational use only — not legal advice.
      </p>
    </div>
  );
}
