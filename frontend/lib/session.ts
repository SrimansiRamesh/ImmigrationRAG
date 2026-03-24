/**
 * session.ts
 *
 * Generates and persists a session UUID for the current chat.
 * The session ID ties all messages in a conversation together
 * so the backend can maintain memory across turns.
 *
 * Stored in sessionStorage (not localStorage) so it:
 * - Persists across page refreshes within the same tab
 * - Clears when the tab is closed (fresh session = fresh chat)
 * - Is isolated per tab (two tabs = two independent sessions)
 */

import { v4 as uuidv4 } from "uuid";

const SESSION_KEY = "immigration_iq_session_id";

/**
 * Get the current session ID.
 * Creates a new one if none exists yet.
 */
export function getSessionId(): string {
  // sessionStorage is only available in the browser
  // This guard prevents errors during Next.js server-side rendering
  if (typeof window === "undefined") {
    return uuidv4();
  }

  let sessionId = sessionStorage.getItem(SESSION_KEY);

  if (!sessionId) {
    sessionId = uuidv4();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  return sessionId;
}

/**
 * Clear the current session and generate a new one.
 * Called when user clicks "New Chat".
 */
export function resetSession(): string {
  if (typeof window === "undefined") {
    return uuidv4();
  }
  const newId = uuidv4();
  sessionStorage.setItem(SESSION_KEY, newId);
  return newId;
}