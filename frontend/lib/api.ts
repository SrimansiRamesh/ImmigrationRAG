/**
 * api.ts
 *
 * All communication with the FastAPI backend lives here.
 * Components import these functions — never fetch() directly.
 *
 * Why centralize API calls?
 * - One place to change the base URL
 * - One place to add auth headers later
 * - Consistent error handling across all calls
 * - Easy to mock for testing
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const EVAL_BASE = process.env.NEXT_PUBLIC_EVAL_URL || "http://localhost:8001";

// ── Types ──────────────────────────────────────────────────────────────────

export type Mode = "student" | "professional";

export interface Source {
  url:            string;
  section:        string;
  doc_type:       string;
  jurisdiction:   string;
  effective_date: number | null;
}

export interface EvalScores {
  faithfulness:      number;
  answer_relevance:  number;
  context_precision: number;
  overall:           number;
}

export interface ChatResponse {
  answer:      string;
  sources:     Source[];
  complexity:  string;
  tokens_used: number;
  eval_id:     string | null;
}

export interface Message {
  id:          string;
  role:        "user" | "assistant";
  content:     string;
  sources?:    Source[];
  complexity?: string;
  scores?:     EvalScores;
  animate?:    boolean;   // true → typewriter animate; false/undefined → static
  timestamp:   Date;
  attachment?: { filename: string; summarised: boolean };
}

export interface ParsedDocument {
  filename:   string;
  text:       string;
  summarised: boolean;
  char_count: number;
}

// ── API calls ──────────────────────────────────────────────────────────────

/**
 * Send a chat message to the backend and get a response.
 */
export async function sendMessage(
  message:   string,
  sessionId: string,
  mode:      Mode
): Promise<ChatResponse> {
  console.log("calling sendMessage", { message, sessionId, mode }); // TEMP debug
  const res = await fetch(`${API_BASE}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      mode,
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Clear the backend session memory.
 * Called when user starts a new chat.
 */
export async function clearSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/session/${sessionId}`, {
    method: "DELETE",
  }).catch(() => {
    // Non-critical — if this fails, old memory just expires naturally
    console.warn("Failed to clear session on backend");
  });
}

/**
 * Upload a document to the backend for parsing/summarisation.
 * Returns extracted text (summarised if large).
 */
export async function parseDocument(file: File): Promise<ParsedDocument> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/api/parse-document`, {
    method: "POST",
    body:   formData,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail || `Upload failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Check if the backend is healthy.
 * Used on app load to verify the API is reachable.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(3000), // 3 second timeout
    });
    console.log("Health check response:", res);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll the eval service for a single response's quality scores.
 * Returns null while scores aren't ready yet (404) or on any error —
 * the caller decides how many times to retry.
 */
export async function pollEvalScore(evalId: string): Promise<EvalScores | null> {
  try {
    const res = await fetch(`${EVAL_BASE}/result/${evalId}`);
    if (res.status === 404) return null; // not ready yet
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}