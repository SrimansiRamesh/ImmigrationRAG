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
  // Mobile only: tapping the account row reveals an explicit Sign out button
  // instead of signing out immediately (there's no hover affordance on touch).
  const [expanded, setExpanded] = useState(false);

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

  const isMobile = () =>
    typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches;

  // Desktop: sign out directly (hover already reveals the "Sign out" label).
  // Mobile: first tap toggles an explicit Sign out button below.
  const handleAccountClick = () => {
    if (isMobile()) setExpanded(v => !v);
    else signOut();
  };

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
    <div className="w-full min-w-0">
      <button
        onClick={handleAccountClick}
        title="Account"
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
        {/* Desktop: email, swapping to "Sign out" on hover */}
        <span className="hidden md:block truncate flex-1 min-w-0 text-xs text-left md:group-hover:hidden" style={{ color: "var(--iq-muted)" }}>
          {email}
        </span>
        <span className="hidden md:group-hover:flex items-center gap-1 flex-1 min-w-0 text-xs" style={{ color: "var(--iq-teal)" }}>
          <i className="ti ti-logout text-sm" />
          Sign out
        </span>
        {/* Mobile: email + a chevron hinting the tap reveals Sign out */}
        <span className="md:hidden truncate flex-1 min-w-0 text-xs text-left" style={{ color: "var(--iq-muted)" }}>
          {email}
        </span>
        <i
          className={`ti ti-chevron-${expanded ? "up" : "down"} text-sm md:hidden flex-shrink-0`}
          style={{ color: "var(--iq-hint)" }}
        />
      </button>

      {/* Mobile-only explicit Sign out button (revealed on tap) */}
      {expanded && (
        <button
          onClick={signOut}
          className="md:hidden w-full flex items-center justify-center gap-2 mt-1.5 py-2 rounded-md text-xs font-medium transition-opacity duration-150"
          style={{ background: "var(--iq-surface-2)", color: "var(--iq-teal)" }}
        >
          <i className="ti ti-logout text-sm" />
          Sign out
        </button>
      )}
    </div>
  );
}
