# ImmigrationIQ

A RAG-powered chatbot for US immigration questions: H1B, F1 OPT, green cards, tax filing for nonresidents, and more. Built with Azure OpenAI, Qdrant, and a custom retrieval pipeline over official government sources. Optional Google sign-in syncs your conversations across devices.

**Live:** [immigration-rag.vercel.app](https://immigration-rag.vercel.app)

---

## What it does

ImmigrationIQ answers immigration questions by retrieving relevant chunks from a knowledge base of official government documents (USCIS, DOL, IRS) and generating grounded, cited responses. It never speculates. If the context does not cover the question, it says so and points to the right source.

Two modes serve different audiences:

- **Student mode** - warm, plain-English answers with numbered steps, bolded deadlines, and a "What to do next" section
- **Professional mode** - formal, regulation-heavy responses structured around Regulatory Basis / Eligibility / Employer Obligations / Compliance Risks, with 8 CFR and INA citations

Every answer carries **inline citations** (`[1]`, `[2]`) that map to the source cards in the right panel, plus a **Response Quality** readout (faithfulness / relevance / precision) scored by a separate eval service. Signing in with Google is optional — anonymous users get the full experience, signed-in users also get their conversations saved and synced.

---

## Architecture

```
User Query
    │
    ▼
Complexity Classifier (Azure OpenAI, max_tokens=10)
    │
    ├── Simple → Direct hybrid search (Qdrant dense + sparse)
    │
    └── Complex → Query Decomposer (Azure OpenAI) → N sub-queries
                  → Retrieve per sub-query
                  → RRF fusion (k=60)
                  → Cohere rerank-english-v3.0 (top 5)
                  → Parent chunk fetcher
                  │
                  ▼
            Context assembly (~4-6k tokens)
                  │
                  ▼
            Azure OpenAI chat (gpt-4o-mini, temperature=0, max 2048 output tokens)
                  │
                  ▼
            Response + inline [n] citations + legal disclaimer
                  │
                  ├──► returned to user immediately (with an eval_id)
                  │
                  └──► fire-and-forget POST → Eval service (async RAGAS-style scoring)
                           ▲
                           └── frontend polls GET /result/{eval_id} → "Response Quality" panel
```

### Stack

| Layer        | Choice                                       | Notes                                                              |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| LLM          | Azure OpenAI (gpt-4o-mini deployment)        | Generation, classification, decomposition, document summarization  |
| Embeddings   | Azure OpenAI text-embedding-3-large          | 1536 dims; ingestion + query time + eval relevance similarity      |
| Vector DB    | Qdrant Cloud (free tier)                     | Hierarchical parent/child points; native hybrid dense + sparse     |
| Reranker     | Cohere rerank-english-v3.0                   | Cross-encoder reranking, top 5 from 20 candidates                  |
| Backend      | FastAPI                                      | Non-streaming; full JSON response; eval fired off the response path |
| Frontend     | Next.js 16 (App Router, React 19, Tailwind 4)| Three-panel layout, typewriter, inline citations, collapsible sidebar |
| Auth         | Supabase — Google OAuth                      | Optional sign-in; anonymous mode fully supported                   |
| Persistence  | Supabase Postgres (conversations + messages) | Row-level security scoped to the signed-in user; cross-device sync |
| Session memory | LangChain ConversationBufferWindowMemory   | Session-scoped, k=10, in-memory (separate from Supabase storage)   |
| Eval         | Standalone FastAPI microservice              | Async RAGAS-style scoring, surfaced in the UI via polling          |

### Engineering decisions

**Why RAG-Fusion + Query Decomposition instead of HyDE**

Immigration queries tend to be specific and terminology-heavy. HyDE generates a hypothetical answer and embeds that instead of the query, which sounds clever but falls apart when the domain has strict vocabulary (H-1B vs H1B vs specialty occupation). Embedding a hallucinated answer retrieves wrong context. Instead, a lightweight classifier routes simple queries to direct hybrid retrieval and complex ones through a decomposer that generates up to 3 sub-queries, retrieves independently, and fuses results with Reciprocal Rank Fusion.

**Why hierarchical parent-child chunking**

Child chunks (256 tokens) are indexed for precise retrieval. When a match is found, the full parent chunk (1024 tokens) is fetched for generation. This means the model gets enough surrounding context to generate a coherent answer without bloating the search index with large chunks that hurt retrieval precision. The reranker keeps the top 5 chunks before generation, which keeps the prompt lean (and latency down) without sacrificing coverage.

**Why Azure OpenAI for generation**

The pipeline originally generated with Google Gemini. It was migrated to a single Azure OpenAI chat deployment (`gpt-4o-mini`) for generation, classification, decomposition, and document summarization — embeddings were already on Azure, so consolidating on one provider simplified credentials, billing, and client code. Generation output is capped at 2048 tokens, which is plenty for a thorough immigration answer and keeps both cost and latency predictable (the input prompt — system prompt + retrieved context + history — is the larger share of total tokens).

**Why inline citations**

The system prompt instructs the model to cite retrieved context with bracketed numbers (`[1]`, `[2]`) corresponding to source order. The frontend parses those markers and renders them as small clickable badges inside the answer; clicking one highlights the matching source card in the right panel. No fabricated "references" section — citations are inline and tied to real retrieved sources.

**Why optional Google sign-in (and full anonymous support)**

Auth is a convenience, not a gate. Anonymous users get the entire chat experience with nothing saved. Signing in with Google (via Supabase) persists conversations to Postgres so they sync across devices, with row-level security ensuring each user only ever touches their own rows. The sign-in landing page includes a "Continue without signing in" path. Crucially, Supabase storage is kept **completely separate** from the backend's session memory — the FastAPI session UUID drives the LLM's short-term memory; the Supabase user id only drives storage.

**Why session-scoped in-memory history on the backend**

The LLM's conversational memory is a `ConversationBufferWindowMemory` (k=10) keyed by a per-tab UUID, held in a Python dict and intentionally discarded on server restart. This is deliberately decoupled from Supabase persistence: loading a saved conversation populates the UI, but the backend starts that thread with fresh memory. There is also an export-to-`.md` feature for taking a conversation elsewhere.

**Why no streaming API**

The backend returns the full response in one JSON payload and the frontend animates it character by character (newly generated messages only — loaded history renders instantly). This keeps the backend simple and avoids SSE/WebSocket complexity. The tradeoff is a wait before the animation starts, handled with rotating status messages showing which RAG stage is running, plus a cold-start overlay.

**Why a fire-and-forget eval service with frontend polling**

Every chat response is scored on three RAGAS-style metrics by a separate FastAPI service. The main backend fires the eval as a non-blocking background task and returns the answer immediately with an `eval_id` — users never wait for scoring. The frontend then polls `GET /result/{eval_id}` for a few seconds and fades in the "Response Quality" panel once the scores are ready. This keeps response latency flat while still surfacing quality metrics in the UI, and every real interaction becomes part of the eval corpus.

---

## Project structure

```
ImmigrationRAG/
├── backend/
│   ├── main.py               # Routes, CORS, session mgmt, eval dispatch, timing log
│   ├── config.py             # Env vars, model parameters
│   ├── prompts.py            # Student + professional prompts (incl. citation rules)
│   ├── memory.py             # Session-scoped ConversationBufferWindowMemory
│   ├── retriever.py          # Embed → hybrid search → rerank (top 5) → parent fetch
│   ├── chain.py              # Classify → route → retrieve → generate (Azure OpenAI, async)
│   └── requirements.txt
│
├── eval/
│   ├── service.py            # Async scoring (Azure OpenAI) + GET /result/{eval_id}
│   ├── requirements.txt
│   └── results/              # Daily JSONL files (gitignored)
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx            # Fonts (DM Serif Display + Inter), Tabler icons
│   │   └── page.tsx              # Three-panel layout, auth + conversation state, all wiring
│   ├── components/
│   │   ├── ChatWindow.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── MarkdownWithCitations.tsx # Renders markdown + inline [n] citation badges
│   │   ├── TypewriterText.tsx
│   │   ├── QuestionNav.tsx           # Left sidebar (collapsible) / mobile drawer + auth + rename/delete
│   │   ├── SourcesPanel.tsx          # Right panel: sources + Response Quality scores
│   │   ├── AuthButton.tsx            # Google sign-in / sign-out
│   │   ├── LandingPage.tsx           # Sign-in landing (with "continue without signing in")
│   │   ├── LoadingIndicator.tsx      # Rotating RAG-stage messages
│   │   └── ColdStartOverlay.tsx      # Cold start UX with health polling
│   └── lib/
│       ├── api.ts            # Backend fetch calls + eval-score polling
│       ├── session.ts        # UUID session management (backend memory key)
│       ├── supabase.ts       # Supabase browser client
│       └── conversations.ts  # CRUD for saved conversations/messages
│
├── supabase/
│   └── schema.sql            # conversations + messages tables, RLS policies
│
└── ingestion/                # Offline pipeline, run locally
    ├── scraper.py
    ├── parser.py
    ├── chunker.py
    ├── embedder.py
    ├── qdrant_loader.py
    ├── run_ingestion.py
    └── requirements.txt
```

---

## Knowledge base

~1,860 vectors in Qdrant (hierarchical parent + child chunks) from:

- **USCIS** -- Policy Manual, H1B specialty occupations, OPT / STEM OPT, fee schedule
- **DOL** -- H1B Labor Condition Application fact sheets, PERM
- **IRS** -- Publication 519 (tax for nonresident aliens), 1040-NR instructions

---

## Running locally

You'll run three processes: backend (`:8000`), eval service (`:8001`), and frontend (`:3000`).

### Prerequisites

- Python 3.11
- Node.js 18+
- Accounts: Qdrant Cloud, Azure OpenAI (chat + embeddings deployments), Cohere, Supabase (for auth/persistence)

### Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Eval service

```bash
cd eval
pip install -r requirements.txt
uvicorn service:app --reload --port 8001
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Supabase setup (for sign-in + saved conversations)

1. Run `supabase/schema.sql` in the Supabase SQL editor (creates the `conversations` and `messages` tables with row-level security).
2. Auth → Providers → enable **Google** (add a Google OAuth client ID/secret).
3. Auth → URL Configuration → add `http://localhost:3000` (and your production origin) to the redirect URLs.

Anonymous mode works without any of this; it's only needed for sign-in and persistence.

### Environment variables

**Backend `.env`:**

```env
# Embeddings (query + ingestion)
AZURE_OPENAI_ENDPOINT=https://your-embeddings-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-embeddings-key
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_API_VERSION=2024-08-01-preview

# Chat (generation, classifier, decomposer, doc summarizer)
AZURE_OPENAI_CHAT_ENDPOINT=https://your-chat-resource.openai.azure.com/
AZURE_OPENAI_CHAT_API_KEY=your-chat-key
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_CHAT_API_VERSION=2024-08-01-preview

QDRANT_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-key
QDRANT_COLLECTION_NAME=immigration_docs

COHERE_API_KEY=your-key

EVAL_SERVICE_URL=http://localhost:8001/evaluate
```

**Eval service `.env`** (same Azure keys — chat for faithfulness/precision, embeddings for relevance):

```env
AZURE_OPENAI_ENDPOINT=https://your-embeddings-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-embeddings-key
AZURE_OPENAI_API_VERSION=2024-08-01-preview
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large

AZURE_OPENAI_CHAT_ENDPOINT=https://your-chat-resource.openai.azure.com/
AZURE_OPENAI_CHAT_API_KEY=your-chat-key
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_CHAT_API_VERSION=2024-08-01-preview
```

**Frontend `.env.local`:**

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_EVAL_URL=http://localhost:8001
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### Running the ingestion pipeline

Only needed if you want to rebuild the knowledge base from scratch. This takes a while.

```bash
cd ingestion
pip install -r requirements.txt
python run_ingestion.py
```

---

## Deployment

| Service      | Platform       | URL                                                                              |
| ------------ | -------------- | -------------------------------------------------------------------------------- |
| Frontend     | Vercel (Hobby) | [immigration-rag.vercel.app](https://immigration-rag.vercel.app)                 |
| Backend      | Render (Free)  | [immigrationragservice.onrender.com](https://immigrationragservice.onrender.com) |
| Eval service | Render (Free)  | [immigrationiq-eval.onrender.com](https://immigrationiq-eval.onrender.com)       |
| Auth + DB    | Supabase       | Google OAuth + Postgres                                                          |

### Deploying your own copy

Deploy in this order. Each step depends on the URL from the previous one.

**1. Supabase**

Create a project, run `supabase/schema.sql`, enable the Google auth provider, and add your production frontend origin to the redirect URLs. Grab the project URL and anon key.

**2. Eval service**

New Web Service on Render, connect the repo, set Root Directory to `eval`. Add a `eval/.python-version` file containing `3.11.9`. Build command: `pip install -r requirements.txt`. Start command: `uvicorn service:app --host 0.0.0.0 --port $PORT`. Add the `AZURE_OPENAI_*` and `AZURE_OPENAI_CHAT_*` env vars. Copy the deployed URL once it is live.

**3. Backend**

New Web Service, Root Directory `backend`, add `backend/.python-version` with `3.11.9`. Same build command. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`. Add all env vars including `EVAL_SERVICE_URL` pointing to the eval service from step 2. Copy the deployed URL.

**4. Frontend**

New Project on Vercel, Root Directory `frontend`. Add `NEXT_PUBLIC_API_URL` (backend from step 3), `NEXT_PUBLIC_EVAL_URL` (eval service from step 2), and the `NEXT_PUBLIC_SUPABASE_*` vars (step 1). Update the CORS `allow_origins` in **both** `backend/main.py` and `eval/service.py` to include your Vercel domain (the frontend polls the eval service directly from the browser), then redeploy.

---

## Eval metrics

Every chat response is scored asynchronously, off the response path. The backend returns an `eval_id`; the frontend polls the eval service and fades in a **Response Quality** panel once the scores are ready.

| Metric            | Weight | What it measures                                         |
| ----------------- | ------ | -------------------------------------------------------- |
| Faithfulness      | 0.5    | Are claims in the answer supported by retrieved context? |
| Answer Relevance  | 0.3    | Does the answer actually address the question?           |
| Context Precision | 0.2    | Is the retrieved context useful for the question?        |

Endpoints: `POST /evaluate` (score + persist), `GET /result/{eval_id}` (polling), `GET /metrics` (aggregates), `GET /results` (recent). Aggregate scores: `GET https://immigrationiq-eval.onrender.com/metrics`

---

## Known limitations

- **Cold starts** - Render free tier spins down after 15 minutes of inactivity. The first request after that takes 30-60 seconds to respond. The app shows a cold start overlay while this happens so users are not staring at a blank screen.
- **In-memory session memory** - the backend's LLM conversation memory is lost when the server restarts. This is intentional. (Saved conversations in Supabase persist independently.)
- **Eval scoring window** - the frontend polls for ~20 seconds; if scoring takes longer (it does three LLM/embedding calls) the Response Quality panel just won't appear for that answer. The eval result store is in-memory per process, so it's cleared on restart and assumes a single worker.
- **Ephemeral eval JSONL** - the result files on Render's filesystem are wiped on every redeploy.
- **Cohere free tier** - 1k rerank calls per month. Fine for a demo, needs an upgrade for real traffic.
- **Static knowledge base** - the ingestion pipeline needs to be re-run manually to pick up new government documents.
