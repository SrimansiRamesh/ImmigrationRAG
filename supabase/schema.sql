-- ImmigrationIQ — Supabase schema for signed-in conversation persistence.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Storage is scoped per authenticated user via row-level security; the anon
-- key used by the frontend can only ever read/write the signed-in user's own
-- rows. Anonymous (signed-out) users never touch these tables.

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'New chat',
  mode       text not null default 'student',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  sources         jsonb,
  complexity      text,
  created_at      timestamptz not null default now()
);

create index if not exists conversations_user_idx
  on public.conversations (user_id, updated_at desc);
create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- ── Row-level security ──────────────────────────────────────────────────────

alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- Conversations: a user may only see/modify their own.
create policy "own conversations - select"
  on public.conversations for select using (auth.uid() = user_id);
create policy "own conversations - insert"
  on public.conversations for insert with check (auth.uid() = user_id);
create policy "own conversations - update"
  on public.conversations for update using (auth.uid() = user_id);
create policy "own conversations - delete"
  on public.conversations for delete using (auth.uid() = user_id);

-- Messages: access allowed only if the parent conversation belongs to the user.
create policy "own messages - select"
  on public.messages for select
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
create policy "own messages - insert"
  on public.messages for insert
  with check (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
