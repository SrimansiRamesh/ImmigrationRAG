# CLAUDE.md — ImmigrationIQ

## Project Overview

**ImmigrationIQ** — a Retrieval-Augmented Generation (RAG) chatbot that helps users with US immigration questions: H1B, OPT, visa processes, work authorization, green cards, tax filing, and general newcomer guidance.

The application has **two distinct modes** with different system prompts and output styles:

1. **Student / Common User Mode** — warm, plain-English, step-by-step guidance with analogies and "What to do next" sections
2. **Professional Mode** — formal, regulation-heavy, compliance-focused (for HR, recruiters, immigration officials); structured with Regulatory Basis / Eligibility / Employer Obligations / Compliance Risks headings

The application maintains **conversational awareness within a chat session** (not per-user persistence). Each new browser tab / "New Chat" starts fresh.

---

## Architecture Decisions (Current / As-Built)

| Layer         | Choice                                     | Notes                                                                               |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Orchestration | **LangChain** (memory only)                | `ConversationBufferWindowMemory`; retrieval and generation done directly            |
| LLM           | **Google Gemini 2.5 Flash**                | `gemini-2.5-flash` for generation; `gemini-2.5-flash-lite` for classifier/decomposer/summarizer |
| Embeddings    | **Azure OpenAI `text-embedding-3-large`**  | 1536 dims; used for both ingestion and query-time embedding                         |
| Vector DB     | **Qdrant Cloud (free tier)**               | 1553 points (1280 child + 273 parent); hybrid dense + sparse search                |
| Reranker      | **Cohere `rerank-english-v3.0`**           | Free tier: 1k calls/month                                                           |
| Ingestion     | Custom pipeline (scraper → parser → chunker → embedder → loader) | No LlamaIndex/Unstructured.io in final build |
| Backend       | **FastAPI**                                | Non-streaming; full response + background eval firing                               |
| Frontend      | **Next.js (App Router)**                   | Three-panel layout; typewriter animation (CSS/JS, no streaming API)                 |
| Eval          | **Live eval service** (eval/service.py)    | Standalone FastAPI on port 8001; RAGAS-style metrics scored on every chat response  |

> **LLM change from original design:** Azure OpenAI GPT-OSS-120B was replaced by Google Gemini. Azure OpenAI is still used exclusively for embeddings. All generation, classification, decomposition, and summarization goes through the Gemini SDK (`google-genai`).

---

## RAG Strategy

### DO NOT use HyDE

Immigration queries are specific and terminology-heavy. HyDE risks embedding hallucinated answers and retrieving wrong context.

### USE: RAG-Fusion + Query Decomposition (routed by complexity)

```
User Query
│
▼
Complexity Classifier (gemini-2.5-flash-lite, max_tokens=5)
│
├── Simple factual query ("What is the H1B filing fee?")
│   └── Direct hybrid retrieval from Qdrant (dense + sparse)
│
└── Complex multi-part query ("I'm on F1-OPT, can I file H1B
    and what happens during cap-gap?")
    └── Query Decomposer (gemini-2.5-flash-lite)
        ├── Sub-query 1: "H1B lottery and filing process"
        ├── Sub-query 2: "F1-OPT to H1B transition rules"
        └── Sub-query 3: "Cap-gap eligibility and duration"
        │
        └── Retrieve per sub-query → RRF fusion (k=60) → rerank → deduplicate
```

**Why this approach:**
- Immigration docs use inconsistent terminology (H-1B vs H1B vs specialty occupation)
- Multi-query covers phrasing variations naturally
- Decomposition handles complex multi-part questions (very common in immigration)
- LLM classifier outperforms heuristics — "Can I work?" looks simple but implies complex status

---

## Data Sources (Knowledge Base)

### Ingested (1553 Qdrant points as of March 2026)

- **uscis.gov** — Policy Manual (HTML), forms, processing times (8 sources)
- **irs.gov** — Publication 519, 1040-NR instructions (planned, partially ingested)
- **dol.gov** — H-1B LCA data, PERM labor conditions (6 sources)

### Source Priority Hierarchy

Official gov > Law firm content > Community/forum data

---

## Full Pipeline Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  INGESTION PIPELINE (Offline)                                    │
│                                                                  │
│  Sources (uscis.gov, irs.gov, dol.gov, travel.state.gov)        │
│         │                                                        │
│  scraper.py → parser.py → chunker.py → embedder.py              │
│         │                                                        │
│  Hierarchical Chunker                                            │
│  ├── Parent chunks: 1024 tokens (used in generation context)     │
│  └── Child chunks: 256 tokens (indexed for precise retrieval)    │
│         │                                                        │
│  Metadata: {source_url, doc_type, section, jurisdiction,         │
│             effective_date, parent_id}                           │
│         │                                                        │
│  Azure OpenAI text-embedding-3-large (1536 dims)                 │
│         │                                                        │
│  qdrant_loader.py → Qdrant Cloud                                 │
│  - Dense vectors (Azure embeddings)                              │
│  - Sparse vectors (BM25-style, hash-based TF)                    │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  RETRIEVAL LAYER (Online, per query)                             │
│                                                                  │
│  User Query + User Mode (student | professional)                 │
│  + Chat History (session-scoped) + optional document_context     │
│         │                                                        │
│  Complexity Classifier (gemini-2.5-flash-lite, max_tokens=5)    │
│  ├── Simple → Direct hybrid retrieval (RETRIEVAL_TOP_K=20)       │
│  └── Complex → Query Decomposer → N sub-queries                  │
│         │                                                        │
│  Qdrant Dense Search (embedding query via Azure OpenAI)          │
│         │                                                        │
│  [Complex: RRF fusion across sub-query result lists, k=60]       │
│         │                                                        │
│  Cohere rerank-english-v3.0 (top RERANK_TOP_N=7)                 │
│         │                                                        │
│  Parent Chunk Fetcher                                            │
│  (matched child chunk → retrieve full parent section by ID)      │
│         │                                                        │
│  Context Assembly (deduplicated, source-labeled blocks)          │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  GENERATION LAYER (Online)                                       │
│                                                                  │
│  Mode-specific System Prompt (student OR professional)           │
│  + [Optional: User-Uploaded Document prepended as primary ctx]   │
│  + Assembled RAG Context                                         │
│  + Session Chat History (ConversationBufferWindowMemory, k=10)   │
│         │                                                        │
│  Google Gemini 2.5 Flash                                         │
│  temperature=0.0, max_output_tokens=16384                        │
│         │                                                        │
│  Response with inline citations + legal disclaimer               │
│         │                                                        │
│  Background task: fire eval payload to eval service (port 8001)  │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  NEXT.JS FRONTEND                                                │
│                                                                  │
│  Three-panel layout:                                             │
│  [QuestionNav 260px] | [ChatWindow flex-1] | [SourcesPanel 272px]│
│                                                                  │
│  Theme: "Federal Intelligence" dark theme                        │
│  Fonts: Playfair Display (headings) + IBM Plex Sans (body)       │
│                                                                  │
│  Features:                                                       │
│  - Mode toggle (Student ↔ Professional) in left nav              │
│  - Typewriter animation on assistant responses                   │
│  - QuestionNav: click past question to scroll to its answer      │
│  - SourcesPanel: slides in when "N sources" clicked              │
│  - Document upload: attach PDF/txt/md to a message               │
│  - Export chat as .md file                                       │
│  - New Chat: clears messages + backend session                   │
│  Session-scoped: new browser tab = new chat = fresh history      │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  EVAL SERVICE (eval/service.py, port 8001)                       │
│                                                                  │
│  Receives every chat response as background POST /evaluate       │
│  Scores three RAGAS-style metrics using Gemini + Azure embeds:   │
│  - Faithfulness (0–1): claims in answer supported by context     │
│  - Answer Relevance (0–1): does answer address the question      │
│  - Context Precision (0–1): is retrieved context useful          │
│  - Overall: 0.5×faith + 0.3×rel + 0.2×prec                      │
│                                                                  │
│  Results persisted to: eval/results/live_YYYYMMDD.jsonl          │
│  Endpoints: POST /evaluate, GET /metrics, GET /results           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Conversational Awareness (Session-Scoped)

- LangChain `ConversationBufferWindowMemory` with `k=10` (last 10 turns)
- Memory keyed by **session_id** (UUID generated on frontend page load)
- Backend stores chat history **in-memory** (Python dict keyed by session_id)
- No database persistence — server restart or session end = history gone
- Intentional: no user accounts, no login, no data retention

```python
# backend/memory.py
from langchain.memory import ConversationBufferWindowMemory

_session_store: dict[str, ConversationBufferWindowMemory] = {}

def get_memory(session_id: str) -> ConversationBufferWindowMemory:
    if session_id not in _session_store:
        _session_store[session_id] = ConversationBufferWindowMemory(
            k=10,
            memory_key="chat_history",
            return_messages=True,
            output_key="answer"
        )
    return _session_store[session_id]
```

---

## System Prompts

### Mode A: Student / Common User

Key behaviors:
- Warm, patient, empathetic — "like a knowledgeable friend"
- No jargon without explanation (e.g., "I-94 — this is basically your digital arrival record")
- Numbered steps + **bold** deadlines + "📋 What to do next" section
- Cite: `(Source: USCIS Policy Manual, Vol. 2, Part F)`
- Hard boundary: only from retrieved context; never speculate on case outcomes
- Mandatory disclaimer: "⚠️ This is general information only, not legal or tax advice."

### Mode B: Professional

Key behaviors:
- Formal, precise, compliance-oriented; assumes full terminology familiarity
- Structured headings: Regulatory Basis / Eligibility Requirements / Employer Obligations / Required Documentation / Timelines / ⚠️ Compliance Risks
- Cite: `(8 CFR §214.2(h)(4)(i)(A))` or `(USCIS Policy Manual, Vol. 2, Part B, Ch. 3)`
- Hard boundary: if context insufficient, recommend immigration counsel
- Mandatory disclaimer: "⚠️ This analysis does not constitute legal advice."

Both prompts include `{context}` and `{chat_history}` placeholders filled at query time.

---

## Document Upload Feature

The backend exposes `POST /api/parse-document` to let users attach context documents (e.g., their I-20, approval notice, DS-160) to a message.

```
POST /api/parse-document
  Input:  multipart file upload (.pdf, .txt, .md, .markdown)
  Output: { filename, text, summarised, char_count }
```

- Supported types: `.pdf` (via pdfplumber), `.txt`, `.md`
- If extracted text > 8,000 chars: summarized via `gemini-2.5-flash-lite` (preserving all dates, fees, form numbers, IDs verbatim)
- Summarized text prepended to RAG context in system prompt as "User-Uploaded Document" section
- Frontend shows a pending doc badge in input area; document is attached to the next message only

---

## API Endpoints

```
GET  /health                      — instant health check (active sessions count)
POST /api/chat                    — main RAG pipeline
  Request:  { session_id, message, mode, document_context? }
  Response: { answer, sources, complexity, tokens_used }

POST /api/parse-document          — parse + optionally summarize uploaded file
  Response: { filename, text, summarised, char_count }

DELETE /api/session/{session_id}  — clear conversation memory (called on New Chat)

GET  /api/health/detailed         — checks Qdrant connectivity + eval service status
```

---

## Typewriter Effect (Frontend, No Streaming API)

The backend returns the **full response** in a single JSON payload. The frontend animates it:

- Receives full `answer` string
- Renders character-by-character using `requestAnimationFrame`
- User can click "Skip" to show full response immediately
- Loading state: pulsing indicator while waiting for backend response
- Tradeoff: user waits for full LLM generation (3–8s for long responses) before typewriter begins

---

## Project Structure

```
RAGProject/
├── CLAUDE.md                          # This file
├── backend.md                         # Detailed backend reference (interview prep)
├── .env                               # Secrets (Azure, Qdrant, Cohere, Gemini)
├── .env.example                       # Template without secrets
│
├── ingestion/                         # Offline data pipeline
│   ├── scraper.py                     # Fetch HTML/PDF from gov sites
│   ├── parser.py                      # Parse HTML/PDF to text
│   ├── chunker.py                     # Hierarchical parent-child chunking
│   ├── embedder.py                    # Azure OpenAI embedding calls
│   ├── qdrant_loader.py               # Upload vectors + metadata to Qdrant
│   └── run_ingestion.py               # End-to-end ingestion script
│
├── backend/                           # FastAPI server
│   ├── main.py                        # FastAPI app, CORS, all routes
│   ├── config.py                      # All env vars + model parameters
│   ├── prompts.py                     # Student + professional system prompts,
│   │                                  # classifier prompt, decomposition prompt
│   ├── memory.py                      # Session-scoped ConversationBufferWindowMemory
│   ├── retriever.py                   # embed → hybrid search → rerank → fetch parents → assemble
│   ├── chain.py                       # classify → route → retrieve → generate → save memory
│   └── requirements.txt
│
├── frontend/                          # Next.js App Router
│   ├── app/
│   │   ├── layout.tsx                 # Root layout (fonts, theme CSS vars)
│   │   └── page.tsx                   # Main page — three-panel layout, all state
│   ├── components/
│   │   ├── ChatWindow.tsx             # Message list + suggestion chips + loading
│   │   ├── MessageBubble.tsx          # Individual message + sources button
│   │   ├── TypewriterText.tsx         # Character-by-character animation
│   │   ├── ModeToggle.tsx             # Student ↔ Professional switch
│   │   ├── QuestionNav.tsx            # Left sidebar: past questions + new chat + export
│   │   ├── SourcesPanel.tsx           # Right panel: source references (slides in)
│   │   └── LoadingIndicator.tsx       # Pulsing dots while waiting for backend
│   ├── lib/
│   │   ├── api.ts                     # sendMessage, clearSession, parseDocument
│   │   └── session.ts                 # Generate + store session UUID in sessionStorage
│   └── package.json
│
├── eval/                              # Live eval service
│   ├── service.py                     # FastAPI eval service (port 8001)
│   └── results/                       # Daily JSONL files: live_YYYYMMDD.jsonl
│
├── data/                              # Ingestion artifacts (not committed to git)
│   ├── chunks/                        # Per-source chunk JSON files
│   └── embedded/                      # Per-source embedded JSON files
│
└── scripts/
    └── setup_qdrant_collection.py     # One-time: create collection + indexes
```

---

## Environment Variables

```env
# Azure OpenAI (embeddings only)
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_API_VERSION=2024-08-01-preview

# Google Gemini (generation, classification, decomposition, summarization)
GEMINI_API_KEY=your-gemini-key
GEMINI_CHAT_MODEL=gemini-2.5-flash
GEMINI_CLASSIFIER_MODEL=gemini-2.5-flash-lite

# Qdrant Cloud
QDRANT_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-key
QDRANT_COLLECTION_NAME=immigration_docs

# Cohere (Reranker)
COHERE_API_KEY=your-cohere-key

# Eval service (optional, defaults to localhost:8001)
EVAL_SERVICE_URL=http://localhost:8001/evaluate
```

---

## Key Configuration Parameters

| Parameter        | Value  | Why                                                                    |
| ---------------- | ------ | ---------------------------------------------------------------------- |
| `TEMPERATURE`    | 0.0    | Deterministic — legal/tax content needs consistency, not creativity    |
| `MAX_TOKENS`     | 16384  | Long enough for detailed explanations                                  |
| `RETRIEVAL_TOP_K`| 20     | Wide net before reranking                                              |
| `RERANK_TOP_N`   | 7      | Narrows 20 → 7 via cross-encoder; balances context size vs coverage    |
| `MAX_SUB_QUERIES`| 3      | Diminishing returns beyond 3 sub-queries                               |
| `MEMORY_K`       | 10     | Last 10 turns ≈ 2k tokens of history; covers realistic follow-up depth |
| `EMBEDDING_DIMS` | 1536   | Must match ingestion (text-embedding-3-large default)                  |

---

## Build Status (as of March 2026)

| Phase                   | Status    | Notes                                                              |
| ----------------------- | --------- | ------------------------------------------------------------------ |
| Phase 1: Ingestion      | ✅ Complete | 1553 points in Qdrant (1280 child + 273 parent); USCIS + DOL data |
| Phase 2: Backend        | ✅ Complete | FastAPI + Gemini + Qdrant + Cohere; all endpoints working          |
| Phase 3: Frontend       | ✅ Complete | Three-panel Next.js UI; document upload; export; typewriter        |
| Phase 4: Eval           | ✅ Complete | Standalone eval service (port 8001); live RAGAS-style scoring on every response |

**What Phase 4 actually is:**
The eval approach diverged from the original golden-set plan. Instead of an offline batch evaluation against a curated Q&A set, Phase 4 is a **completely separate microservice** (`eval/service.py`) that:
- Runs independently on port 8001 (`uvicorn eval.service:app --port 8001`)
- Receives every chat response from the main backend as a fire-and-forget background POST
- Scores three metrics in real-time using Gemini + Azure embeddings
- Persists results to `eval/results/live_YYYYMMDD.jsonl` (one file per day)
- Exposes `GET /metrics` and `GET /results` for aggregate inspection

There is no golden set and no offline RAGAS pipeline. The live eval service is the complete Phase 4 implementation.

---

## Key Design Decisions Log

| Decision             | Choice                                    | Reason                                                                               |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| LLM                  | Gemini 2.5 Flash                          | Azure GPT-OSS-120B unavailable; Gemini free tier adequate for this project           |
| Embeddings           | Azure OpenAI text-embedding-3-large       | Already integrated; 1536 dims; high quality for domain                               |
| RAG strategy         | RAG-Fusion + Query Decomposition          | Immigration queries are specific + multi-part; HyDE risks hallucination at retrieval |
| Vector DB            | Qdrant Cloud free tier                    | No expiry, native hybrid search, 4GB disk                                            |
| Streaming            | No streaming API                          | Typewriter effect on frontend instead; simpler backend                               |
| Chat memory          | Session-scoped, in-memory, k=10           | No user accounts needed; fresh start per session; privacy by design                  |
| Two modes            | System prompt switching                   | Same retrieval pipeline, different generation persona                                |
| Chunking             | Hierarchical parent-child                 | Small chunks for retrieval precision, parent chunks for generation context           |
| Eval                 | Separate microservice, live scoring       | Scores every real response; no golden set — live data is the eval corpus             |
| Document upload      | Parse + summarize if > 8k chars           | Lets users get answers about their own documents (I-20, approval notices, etc.)      |
| Frontend layout      | Three-panel (nav / chat / sources)        | Keeps question history and citations accessible without cluttering the chat          |
| Deployment           | Gunicorn on Azure App Service + Render    | Free/cheap tiers; gunicorn needed for Azure's process model                         |
