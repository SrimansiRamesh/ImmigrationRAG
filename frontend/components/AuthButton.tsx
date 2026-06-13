"use client";

/**
 * AuthButton.tsx
 *
 * Google OAuth sign-in/out via Supabase. Self-contained: tracks its own
 * session for display. Signed-out → "Sign in with Google"; signed-in →
 * avatar + email, revealing "Sign out" on hover.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function AuthButton() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });

  const signOut = () => supabase.auth.signOut();

  // ── Signed out ──────────────────────────────────────────────────────────
  if (!email) {
    return (
      <button
        onClick={signIn}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity duration-150 hover:opacity-90"
        style={{ background: "#0F6B6B", color: "#fff" }}
      >
        <i className="ti ti-brand-google text-base" />
        Sign in with Google
      </button>
    );
  }

  // ── Signed in ───────────────────────────────────────────────────────────
  return (
    <button
      onClick={signOut}
      title="Sign out"
      className="group w-full min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors duration-150"
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--iq-surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span
        className="flex items-center justify-center rounded-full flex-shrink-0"
        style={{ width: 26, height: 26, background: "var(--iq-teal)", color: "#fff", fontSize: 12, fontWeight: 600 }}
      >
        {email[0]?.toUpperCase()}
      </span>
      <span className="truncate flex-1 min-w-0 text-xs text-left group-hover:hidden" style={{ color: "var(--iq-muted)" }}>
        {email}
      </span>
      <span className="hidden group-hover:flex items-center gap-1 flex-1 min-w-0 text-xs" style={{ color: "var(--iq-teal)" }}>
        <i className="ti ti-logout text-sm" />
        Sign out
      </span>
    </button>
  );
}
