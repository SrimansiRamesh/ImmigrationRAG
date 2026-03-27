# Frontend — Reference Document

## What this frontend does

A Next.js (App Router) chat interface for the ImmigrationIQ RAG backend. Users type immigration questions, receive grounded answers with typewriter animation, navigate past questions via a sidebar, and view source citations in a right panel.

```
User types question
        ↓
POST /api/chat  { session_id, message, mode }
        ↓
Backend returns  { answer, sources, complexity, tokens_used }
        ↓
Typewriter animates answer character-by-character
Sources appear as "N sources" button → click → right panel opens
Question saved to left nav → click → smooth scroll back to answer
```

---

## Layout

Three-panel layout at all times:

```
┌──────────────┬───────────────────────────────┬─────────────┐
│  QuestionNav │         Chat + Input           │ SourcesPanel│
│   220px      │          flex-1                │   272px     │
│  (always)    │          (always)              │ (when open) │
└──────────────┴───────────────────────────────┴─────────────┘
```

The right panel is hidden (`width: 0, opacity: 0`) when no sources are active and slides in with a CSS transition when a message's sources are opened.

---

## File Overview

| File | Responsibility |
|------|----------------|
| `app/layout.tsx` | Font loading, metadata, root HTML shell |
| `app/globals.css` | Design tokens (CSS vars), custom scrollbar, keyframe animations |
| `app/page.tsx` | Root state, three-panel layout, send/new-chat/export logic |
| `components/QuestionNav.tsx` | Left sidebar — logo, mode toggle, question nav links, new chat, export |
| `components/ChatWindow.tsx` | Scrollable message list, empty state with suggestion chips |
| `components/MessageBubble.tsx` | Individual message — user bubble or assistant card + sources button |
| `components/TypewriterText.tsx` | Character-by-character animation with skip button |
| `components/LoadingIndicator.tsx` | Three bouncing dots while awaiting backend response |
| `components/SourcesPanel.tsx` | Right panel — source cards with jurisdiction badges and links |
| `lib/api.ts` | All fetch calls to FastAPI backend (`sendMessage`, `clearSession`, `checkHealth`) |
| `lib/session.ts` | UUID session ID in `sessionStorage` (per-tab, clears on tab close) |

---

## Design System

### Aesthetic direction: "Federal Intelligence"
Dark navy base with warm amber accent — conveys governmental authority and trustworthiness without being sterile. Playfair Display for brand display text; IBM Plex Sans for all body copy.

### Fonts
Loaded via `next/font/google` in `layout.tsx`:
- **Playfair Display** (`--font-playfair`) — serif display font, used for the ImmigrationIQ brand mark and empty-state heading
- **IBM Plex Sans** (`--font-ibm-plex`) — clean technical sans, used for all body text, UI labels, messages

### Color tokens (CSS variables in `globals.css`)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#070B16` | Page background |
| `--bg-surface` | `#0B1323` | Sidebars |
| `--bg-elevated` | `#101D30` | Message cards, source cards |
| `--bg-input` | `#0D1829` | Textarea background |
| `--border` | `#182338` | Panel borders |
| `--border-dim` | `#101B2E` | Subtle internal borders |
| `--accent` | `#C4893A` | Amber gold — send button, active states, IQ badge |
| `--text-primary` | `#D8E3F5` | Main readable text |
| `--text-secondary` | `#6B7F9E` | Labels, subdued text |
| `--text-muted` | `#3A4D68` | Placeholders, metadata |
| `--user-bg` | `#1A3460` | User message bubble background |
| `--user-text` | `#AAC3EF` | User message text |

### Animations (defined in `globals.css`)
- **`highlight-flash`** — amber fade on message div when navigating from question nav (2s ease-out)
- **`blink`** — typewriter cursor (1s step-end infinite), applied via `.cursor-blink` class
- **`bounce-dot`** — staggered dot bounce for loading indicator (1.2s, 3 dots with 0.2s offsets)

---

## Component Details

### `app/page.tsx`

Root component. Owns all state:

| State | Type | Purpose |
|-------|------|---------|
| `messages` | `Message[]` | Full chat history |
| `mode` | `"student" \| "professional"` | Which system prompt the backend uses |
| `input` | `string` | Current textarea value |
| `isLoading` | `boolean` | Disables input while awaiting response |
| `activeSources` | `Source[]` | Sources shown in right panel (empty = panel closed) |

Key functions:

**`handleSend(overrideText?)`**
Accepts an optional override so suggestion chips can send directly without going through the `input` state. Appends user message immediately, calls `sendMessage()`, appends assistant message on success (or error message on failure).

**`handleNewChat()`**
1. Calls `clearSession(oldId)` — sends `DELETE /api/session/{id}` to clear backend memory
2. Calls `resetSession()` — writes a new UUID into `sessionStorage`
3. Clears `messages`, `input`, `activeSources`, resets textarea height
4. Refocuses the input

**`exportChatAsMd(messages)`**
Builds a markdown string: header, then each message as `### You` / `### ImmigrationIQ` with content and a `Sources:` list of links. Creates a `Blob`, triggers a download as `immigrationiq-YYYY-MM-DD.md`.

**`scrollToMessage(messageId)`**
Calls `document.getElementById("msg-{id}").scrollIntoView({ behavior: "smooth", block: "start" })`, then adds/removes `.highlight-flash` class with a 2-second timeout.

---

### `components/QuestionNav.tsx`

Left sidebar. Always visible. Contains:

1. **Logo** — blue gradient square with amber "IQ" text + Playfair Display "ImmigrationIQ" wordmark
2. **Mode toggle** — pill switcher (Student / Professional). Calls `onModeChange` prop. Disabled during loading. The active mode shows with amber text and a background lift.
3. **Question history** — filtered to `role === "user"` messages. Each renders as a numbered button showing up to 2 lines of question text. Clicking fires `onQuestionClick(msg.id)` which calls `scrollToMessage` in the parent.
4. **Export button** — disabled if no messages. Calls `onExport` → `exportChatAsMd`.
5. **New Chat button** — disabled during loading. Calls `onNewChat`.

---

### `components/ChatWindow.tsx`

Scrollable container with auto-scroll to bottom via `useEffect` on `messages` / `isLoading`.

**Empty state** (shown when `messages.length === 0 && !isLoading`):
- Decorative IQ avatar
- ImmigrationIQ heading in Playfair Display
- Three suggestion chips that call `onSuggestionClick(text)` → `handleSend(text)` in the parent

**Message list**:
Each `Message` is wrapped in `<div id="msg-{msg.id}">` — this is the anchor target for question nav scrolling. `MessageBubble` is rendered inside, with `isLatest` only true for the final assistant message (to animate only the newest response).

---

### `components/MessageBubble.tsx`

Renders one of two layouts:

**User message** — right-aligned bubble with `--user-bg` / `--user-text` colors. Rounded except top-right corner.

**Assistant message** — left-aligned with IQ avatar, card background (`--bg-elevated`), and a meta row below:
- **"N sources" button** — calls `onViewSources(message.sources, message.id)` which sets `activeSources` in the parent, opening the right panel
- **Complexity badge** — `→ direct` for simple queries, `↩ multi-query` for decomposed ones

Only the latest assistant message gets `TypewriterText`; previous messages render plain text to avoid re-animating on state changes.

---

### `components/TypewriterText.tsx`

Increments a character index via `setTimeout` at `speed` ms/char (default 10ms). Uses a ref for the index to avoid stale closure issues in the recursive timer.

- **Blinking cursor** — `<span class="cursor-blink" />` shown while typing
- **Skip button** — clears the timer, sets `displayed = text` immediately, fires `onComplete`
- Resets cleanly when `text` prop changes (new message)

---

### `components/SourcesPanel.tsx`

Right panel, 272px wide. Rendered only when `activeSources.length > 0` (parent shows/hides with CSS `width` + `opacity` transition for the slide animation).

Each source card shows:
- **Jurisdiction badge** — color-coded pill (USCIS = blue, IRS = green, DOL = amber, State Dept = purple)
- **Doc type label** — human-readable (e.g. "Policy Manual", "Publication")
- **Section name** — from `source.section` metadata
- **URL link** — opens in new tab, styled with hover amber color; URL shown without `https://` prefix for readability

Footer disclaimer reminds users to verify information at the source.

---

### `components/LoadingIndicator.tsx`

Three dots with the same IQ avatar as assistant messages, using the `bounce-dot` CSS animation with staggered delays (0s, 0.2s, 0.4s) for a wave effect.

---

## API Contract

The frontend expects this shape from `POST /api/chat`:

```typescript
interface ChatResponse {
  answer:      string;    // Full response text
  sources:     Source[];  // For citation display
  complexity:  string;    // "simple" | "complex"
  tokens_used: number;    // For monitoring
}

interface Source {
  url:          string;
  section:      string;
  doc_type:     string;
  jurisdiction: string;   // "uscis" | "irs" | "dol" | "state_dept"
}
```

Base URL: `process.env.NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8000`).

---

## Session Management

Session ID is a UUID stored in `sessionStorage` (not `localStorage`):
- **Persists** across page refreshes in the same tab
- **Isolated** per tab — two tabs = two independent chat sessions
- **Cleared** when tab closes (privacy by design, no server-side persistence)

`resetSession()` writes a new UUID. `getSessionId()` creates one lazily if none exists. Both guard against SSR with `typeof window === "undefined"`.

---

## Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| No streaming API | Full response + typewriter animation | Simpler FastAPI backend; typewriter gives perception of live response |
| Sources lifted to page state | `activeSources` in `page.tsx` | One panel for all sources; avoids multiple open sidebars |
| Question nav uses DOM scroll | `scrollIntoView` + `id` anchors | No additional state; works with any number of messages |
| Session in `sessionStorage` | Not `localStorage` | Per-tab isolation; auto-clears on close; no login needed |
| Font: Playfair + IBM Plex | Not Inter/Geist | Distinctive character fitting the governmental/legal domain |
| No animation library | CSS keyframes + `setTimeout` | Zero dependencies; full control; no bundle size cost |
| Three-panel layout | Always-visible nav + slide-in sources | Efficient navigation in long chats without losing context |

---

## Running the Frontend

```bash
cd frontend
npm install
npm run dev        # starts on localhost:3000
```

Requires the FastAPI backend running on `localhost:8000` (or set `NEXT_PUBLIC_API_URL` in `.env.local`).

```bash
# .env.local
NEXT_PUBLIC_API_URL=http://localhost:8000
```
