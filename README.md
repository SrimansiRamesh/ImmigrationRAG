# ImmigrationIQ

A RAG-powered chatbot for US immigration questions: H1B, F1 OPT, green cards, tax filing for nonresidents, and more. Built with Google Gemini, Qdrant, and a custom retrieval pipeline over official government sources.

**Live:** [immigration-rag.vercel.app](https://immigration-rag.vercel.app)

---

## What it does

ImmigrationIQ answers immigration questions by retrieving relevant chunks from a knowledge base of official government documents (USCIS, DOL, IRS) and generating grounded, cited responses. It never speculates. If the context does not cover the question, it says so and points to the right source.

Two modes serve different audiences:

- **Student mode** - warm, plain-English answers with numbered steps, bolded deadlines, and a "What to do next" section
- **Professional mode** - formal, regulation-heavy responses structured around Regulatory Basis / Eligibility / Employer Obligations / Compliance Risks, with 8 CFR and INA citations

---

## Architecture

```
User Query
    │
    ▼
Complexity Classifier (Gemini Flash Lite)
    │
    ├── Simple → Direct hybrid search (Qdrant dense + sparse)
    │
    └── Complex → Query Decomposer → N sub-queries
                  → Retrieve per sub-query
                  → RRF fusion (k=60)
                  → Cohere rerank-english-v3.0 (top 7)
                  → Parent chunk fetcher
                  │
                  ▼
            Context assembly (~6-8k tokens)
                  │
                  ▼
            Gemini 2.5 Flash (temperature=0, max 16384 tokens)
                  │
                  ▼
            Response + inline citations + legal disclaimer
                  │
                  ▼
            Background POST → Eval service (RAGAS-style scoring)
```

### Stack

| Layer      | Choice                                   | Notes                                                    |
| ---------- | ---------------------------------------- | -------------------------------------------------------- |
| LLM        | Google Gemini 2.5 Flash                  | Generation, classification, decomposition, summarization |
| Embeddings | Azure OpenAI text-embedding-3-large      | 1536 dims; ingestion + query time                        |
| Vector DB  | Qdrant Cloud (free tier)                 | 1553 points; native hybrid dense + sparse search         |
| Reranker   | Cohere rerank-english-v3.0               | Cross-encoder reranking, top 7 from 20 candidates        |
| Backend    | FastAPI                                  | Non-streaming; full response + background eval           |
| Frontend   | Next.js 14 (App Router)                  | Typewriter animation, three-panel layout                 |
| Memory     | LangChain ConversationBufferWindowMemory | Session-scoped, k=10, in-memory                          |
| Eval       | Standalone FastAPI microservice          | Live RAGAS-style scoring on every response               |

### Engineering decisions

**Why RAG-Fusion + Query Decomposition instead of HyDE**

Immigration queries tend to be specific and terminology-heavy. HyDE generates a hypothetical answer and embeds that instead of the query, which sounds clever but falls apart when the domain has strict vocabulary (H-1B vs H1B vs specialty occupation). Embedding a hallucinated answer retrieves wrong context. Instead, a lightweight classifier routes simple queries to direct hybrid retrieval and complex ones through a decomposer that generates up to 3 sub-queries, retrieves independently, and fuses results with Reciprocal Rank Fusion.

**Why hierarchical parent-child chunking**

Child chunks (256 tokens) are indexed for precise retrieval. When a match is found, the full parent chunk (1024 tokens) is fetched for generation. This means the model gets enough surrounding context to generate a coherent answer without bloating the search index with large chunks that hurt retrieval precision.

**Why no streaming API**

The backend returns the full response in one JSON payload and the frontend animates it character by character. This keeps the backend simple and avoids SSE/WebSocket complexity. The tradeoff is a 3-8 second wait before the animation starts, which is handled with rotating status messages showing which RAG stage is running.

**Why session-scoped in-memory history**

No user accounts, no login, no data retention. Each browser tab gets a UUID session ID and history lives in a Python dict on the backend. It is intentionally discarded on server restart. The privacy benefit outweighs the loss of cross-session continuity for a use case like this. There is also a functionality to export your chats as a .md file to give context to the LLM in case of future needs.

**Why a live eval microservice instead of an offline golden set**

Every chat response is scored in real time by a separate FastAPI service on three RAGAS-style metrics. The main backend fires a background POST and forgets about it - users never wait for scoring. This means every real user interaction becomes part of the eval corpus, which is more representative than a curated golden set.

---

## Project structure

```
ImmigrationRAG/
├── backend/
│   ├── main.py               # Routes, CORS, session management
│   ├── config.py             # Env vars, model parameters
│   ├── prompts.py            # Student + professional system prompts
│   ├── memory.py             # Session-scoped ConversationBufferWindowMemory
│   ├── retriever.py          # Embed → hybrid search → rerank → parent fetch
│   ├── chain.py              # Classify → route → retrieve → generate
│   └── requirements.txt
│
├── eval/
│   ├── service.py            # Scores faithfulness, relevance, precision
│   ├── requirements.txt
│   └── results/              # Daily JSONL files (gitignored)
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx
│   │   └── page.tsx          # Main page, three-panel layout, all state
│   ├── components/
│   │   ├── ChatWindow.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── TypewriterText.tsx
│   │   ├── QuestionNav.tsx       # Left sidebar / mobile drawer
│   │   ├── SourcesPanel.tsx      # Right panel / mobile bottom sheet
│   │   ├── LoadingIndicator.tsx  # Rotating RAG-stage messages
│   │   └── ColdStartOverlay.tsx  # Cold start UX with health polling
│   └── lib/
│       ├── api.ts            # All fetch calls to backend
│       └── session.ts        # UUID session management
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

1553 vectors in Qdrant (1280 child + 273 parent chunks) from:

- **USCIS** -- Policy Manual, H1B specialty occupations, OPT, fee schedule
- **DOL** -- H1B Labor Condition Application fact sheets, PERM
- **IRS** -- Publication 519 (tax for nonresident aliens), 1040-NR instructions

---

## Running locally

### Prerequisites

- Python 3.11
- Node.js 18+
- Accounts: Qdrant Cloud, Google AI Studio (Gemini), Azure OpenAI, Cohere

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
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
npm run dev
```

### Environment variables

**Backend `.env`:**

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_API_VERSION=2024-08-01-preview

GEMINI_API_KEY=your-key
GEMINI_CHAT_MODEL=gemini-2.5-flash
GEMINI_CLASSIFIER_MODEL=gemini-2.5-flash-lite

QDRANT_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-key
QDRANT_COLLECTION_NAME=immigration_docs

COHERE_API_KEY=your-key

EVAL_SERVICE_URL=http://localhost:8001/evaluate
```

**Frontend `.env.local`:**

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
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

### Deploying your own copy

Deploy in this order. Each step depends on the URL from the previous one.

**1. Eval service**

New Web Service on Render, connect the repo, set Root Directory to `eval`. Add a `eval/.python-version` file containing `3.11.9`. Build command: `pip install -r requirements.txt`. Start command: `uvicorn service:app --host 0.0.0.0 --port $PORT`. Add `GEMINI_API_KEY` and `AZURE_OPENAI_*` env vars. Copy the deployed URL once it is live.

**2. Backend**

New Web Service, Root Directory `backend`, add `backend/.python-version` with `3.11.9`. Same build command. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`. Add all env vars including `EVAL_SERVICE_URL` pointing to the eval service from step 1. Copy the deployed URL.

**3. Frontend**

New Project on Vercel, Root Directory `frontend`. Add `NEXT_PUBLIC_API_URL` pointing to the backend from step 2. Update CORS in `backend/main.py` to allow your Vercel domain and redeploy the backend.

---

## Eval metrics

Every chat response is scored automatically in the background.

| Metric            | Weight | What it measures                                         |
| ----------------- | ------ | -------------------------------------------------------- |
| Faithfulness      | 0.5    | Are claims in the answer supported by retrieved context? |
| Answer Relevance  | 0.3    | Does the answer actually address the question?           |
| Context Precision | 0.2    | Is the retrieved context useful for the question?        |

Check live scores at `GET https://immigrationiq-eval.onrender.com/metrics`

---

## Known limitations

- **Cold starts** - Render free tier spins down after 15 minutes of inactivity. The first request after that takes 30-60 seconds to respond. The app shows a cold start overlay while this happens so users are not staring at a blank screen.
- **In-memory sessions** - chat history is lost when the server restarts. This is intentional.
- **Ephemeral eval results** - the JSONL files on Render's filesystem are wiped on every redeploy.
- **Cohere free tier** - 1k rerank calls per month. Fine for a demo, needs an upgrade for real traffic.
- **Static knowledge base** - the ingestion pipeline needs to be re-run manually to pick up new government documents.

---
