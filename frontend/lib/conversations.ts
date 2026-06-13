/**
 * conversations.ts
 *
 * Persistence layer for signed-in users, backed by Supabase.
 * Completely separate from the FastAPI session memory (session.ts) —
 * the Supabase user id is only used for storing/loading chat history.
 *
 * Requires two tables (see supabase/schema.sql): `conversations` and
 * `messages`, with row-level security scoping rows to auth.uid().
 */

import { supabase } from "@/lib/supabase";
import { Message, Source } from "@/lib/api";

export interface Conversation {
  id:         string;
  user_id:    string;
  title:      string;
  mode:       string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id:         string;
  role:       "user" | "assistant";
  content:    string;
  sources:    Source[] | null;
  complexity: string | null;
  created_at: string;
}

/** Create a new conversation and return its id. */
export async function createConversation(
  userId: string,
  title: string,
  mode: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title, mode })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Persist a single message belonging to a conversation. */
export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  sources?: Source[],
  complexity?: string,
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
    sources: sources ?? null,
    complexity: complexity ?? null,
  });
  if (error) throw error;
}

/** List a user's conversations, most-recently-updated first. */
export async function getConversations(userId: string): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as Conversation[]) ?? [];
}

/** Load all messages for a conversation in chronological order. */
export async function getMessages(conversationId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data as MessageRow[]) ?? []).map((m) => ({
    id:         m.id,
    role:       m.role,
    content:    m.content,
    sources:    m.sources ?? undefined,
    complexity: m.complexity ?? undefined,
    animate:    false, // loaded history renders instantly, no typewriter
    timestamp:  new Date(m.created_at),
  }));
}

/** Bump a conversation's updated_at so it sorts to the top of the list. */
export async function touchConversation(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) throw error;
}

/** Rename a conversation. Does NOT touch updated_at, so renaming never
 *  reorders the list (which is sorted by updated_at desc). */
export async function renameConversation(conversationId: string, newTitle: string): Promise<void> {
  await supabase
    .from("conversations")
    .update({ title: newTitle })
    .eq("id", conversationId);
}

/** Delete a conversation and all its messages (cascade handles messages). */
export async function deleteConversation(conversationId: string): Promise<void> {
  await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);
}
