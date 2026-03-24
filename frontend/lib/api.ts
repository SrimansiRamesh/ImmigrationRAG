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

// ── Types ──────────────────────────────────────────────────────────────────

export type Mode = "student" | "professional";

export interface Source {
  url:            string;
  section:        string;
  doc_type:       string;
  jurisdiction:   string;
  effective_date: number | null;
}

export interface ChatResponse {
  answer:      string;
  sources:     Source[];
  complexity:  string;
  tokens_used: number;
}

export interface Message {
  id:          string;
  role:        "user" | "assistant";
  content:     string;
  sources?:    Source[];
  complexity?: string;
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
    return res.ok;
  } catch {
    return false;
  }
}