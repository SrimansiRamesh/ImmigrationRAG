# CLAUDE.md — US Immigration RAG Application

## Project Overview

A Retrieval-Augmented Generation (RAG) chatbot that helps users with US immigration questions — tax returns, H1B, visa processes, work authorization, and general newcomer guidance. The application has **two distinct modes** with different system prompts and output styles:

1. **Student / Common User Mode** — friendly, plain-English, step-by-step guidance
2. **Professional Mode** — formal, regulation-heavy, compliance-focused (for recruiters, HR, immigration officials)

The application maintains **conversational awareness within a chat session** (not per-user persistence). Each new chat session starts fresh.

---

## Architecture Decisions (Finalized)

| Layer         | Choice                                    | Notes                                                                              |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Orchestration | **LangChain**                             |                                                                                    |
| LLM           | **GPT-OSS-120B via Azure OpenAI**         | Free credits. Model deployed on Azure.                                             |
| Embeddings    | **Azure OpenAI `text-embedding-3-large`** | Or whichever embedding model is available in the Azure subscription                |
| Vector DB     | **Qdrant Cloud (free tier)**              | 0.5 CPU, 1GB RAM, 4GB disk, no expiry. Native hybrid search (dense + sparse/BM25). |
| Reranker      | **Cohere Rerank v3**                      | Free tier: 1k calls/month                                                          |
| Ingestion     | **LlamaIndex + Unstructured.io**          | For parsing PDFs, HTML, tables from government sources                             |
| Backend       | **FastAPI**                               | Non-streaming endpoint. Returns full response.                                     |
| Frontend      | **Next.js (App Router)**                  | Typewriter effect animated on frontend (no streaming API)                          |
| Eval          | **RAGAS**                                 | Faithfulness, answer relevance, citation accuracy                                  |

---

## RAG Strategy

### DO NOT use HyDE (Hypothetical Document Embeddings)

Immigration queries are specific and terminology-heavy. HyDE risks embedding hallucinated answers and retrieving wrong context.

### USE: RAG-Fusion + Query Decomposition (routed by complexity)

```

User Query
│
▼
Complexity Classifier (GPT-OSS-120B or cheaper model, single LLM call)
│
├── Simple factual query ("What is the H1B filing fee?")
│ └── Direct hybrid retrieval from Qdrant (dense + sparse)
│
└── Complex multi-part query ("I'm on F1-OPT, can I file H1B
and what happens during cap-gap?")
└── Query Decomposer (LLM prompt)
├── Sub-query 1: "H1B lottery and filing process"
├── Sub-query 2: "F1-OPT to H1B transition rules"
└── Sub-query 3: "Cap-gap eligibility and duration"
│
└── Retrieve per sub-query → RRF fusion → deduplicate

```

**Why this approach:**

- Immigration docs use inconsistent terminology (H-1B vs H1B vs specialty occupation)
- Multi-query covers phrasing variations naturally
- Decomposition handles complex multi-part questions (very common in immigration)
- LangChain has `MultiQueryRetriever` built-in

---

## Data Sources (Knowledge Base)

### Primary (scrape/download for ingestion)

- **uscis.gov** — Policy Manual (HTML), forms, processing times
- **irs.gov** — Publication 519 (tax for nonresident aliens), 1040-NR instructions, tax treaty PDFs
- **dol.gov** — H-1B LCA data, PERM labor conditions
- **travel.state.gov** — Visa bulletin, consular processing
- **congress.gov** — INA, IMMACT (immigration law text)

### Secondary (optional, adds Q&A coverage)

- VisaJourney, Trackitt, Reddit r/immigration, r/h1b
- Murthy Law, Immihelp FAQs

### Source Priority Hierarchy

Official gov > Law firm content > Community/forum data

---

## Full Pipeline Architecture

```

┌──────────────────────────────────────────────────────────────────┐
│ INGESTION PIPELINE (Offline) │
│ │
│ Sources (uscis.gov, irs.gov, dol.gov, travel.state.gov) │
│ │ │
│ Parsers: Unstructured.io │
│ ├── PDF: pymupdf / pdfplumber (tables via pdfplumber) │
│ ├── HTML: BeautifulSoup / Playwright (JS-heavy pages) │
│ └── Markdown/Text: passthrough │
│ │ │
│ Document Cleaner │
│ - Remove headers/footers/boilerplate │
│ - Normalize whitespace, fix encoding │
│ │ │
│ Hierarchical Chunker │
│ ├── Parent chunks: 1024 tokens (used in generation context) │
│ └── Child chunks: 256 tokens (indexed for precise retrieval) │
│ - Preserve section headers as metadata │
│ │ │
│ Metadata Enrichment │
│ {source_url, doc_type, topic_tag, effective_date, jurisdiction}│
│ │ │
│ Azure OpenAI Embeddings (text-embedding-3-large) │
│ │ │
│ Qdrant Cloud │
│ - Dense vectors (embeddings) │
│ - Sparse vectors (BM25, built-in) │
│ - Payload: all metadata fields │
└──────────────────────────────────────────────────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────┐
│ RETRIEVAL LAYER (Online, per query) │
│ │
│ User Query + User Mode (student | professional) │
│ + Chat History (session-scoped) │
│ │ │
│ Complexity Classifier (cheap LLM call) │
│ ├── Simple → Direct hybrid retrieval │
│ └── Complex → Query Decomposer → N sub-queries │
│ │ │
│ Qdrant Hybrid Search (dense + sparse per query) │
│ │ │
│ Cohere Rerank v3 (reorder by relevance) │
│ │ │
│ Parent Chunk Fetcher │
│ (matched child chunk → retrieve full parent section) │
│ │ │
│ Context Assembly (~6k-8k tokens, deduplicated) │
└──────────────────────────────────────────────────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────┐
│ GENERATION LAYER (Online) │
│ │
│ Mode-specific System Prompt (student OR professional) │
│ + Assembled Context │
│ + Session Chat History (ConversationBufferWindowMemory, k=10) │
│ │ │
│ Azure OpenAI GPT-OSS-120B (non-streaming, full response) │
│ │ │
│ Response with inline citations + legal disclaimer │
└──────────────────────────────────────────────────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────┐
│ NEXT.JS FRONTEND │
│ │
│ Mode Toggle Switch (Student ↔ Professional) │
│ Chat UI with typewriter animation (CSS/JS, NOT streaming API) │
│ Citation sidebar (expandable source references) │
│ "Information current as of [doc_date]" badge │
│ Session-scoped: new browser tab = new chat = fresh history │
└──────────────────────────────────────────────────────────────────┘

```

---

## Conversational Awareness (Session-Scoped)

- Use LangChain's `ConversationBufferWindowMemory` with `k=10` (last 10 turns)
- Memory is tied to a **session ID** (generated on frontend when chat opens)
- Backend stores chat history **in-memory** (Python dict keyed by session_id)
- No database persistence — when the server restarts or session ends, history is gone
- This is intentional: no user accounts, no login, no data retention

```python
# Backend: session store (in-memory)
from langchain.memory import ConversationBufferWindowMemory

session_store: dict[str, ConversationBufferWindowMemory] = {}

def get_memory(session_id: str) -> ConversationBufferWindowMemory:
    if session_id not in session_store:
        session_store[session_id] = ConversationBufferWindowMemory(
            k=10,
            memory_key="chat_history",
            return_messages=True,
            output_key="answer"
        )
    return session_store[session_id]
```

Frontend sends `session_id` (UUID generated on page load) with every request. Follow-up questions like "What about for my spouse?" resolve correctly using chat history context.

---

## System Prompts

### Mode A: Student / Common User

```python
STUDENT_SYSTEM_PROMPT = """
You are an immigration assistant helping immigrants, international students,
and newcomers navigate life in the United States.

## Your Persona
- Warm, patient, and clear — like a knowledgeable friend
- Avoid legal jargon; when you must use it, explain it in plain English
  (e.g., "I-94 — this is basically your digital arrival record")
- Acknowledge that immigration is stressful and be empathetic

## How to Answer
1. Start with a direct, plain-English answer to the question
2. Break down any process into numbered steps
3. Use analogies where helpful
4. Call out deadlines and fees prominently (use **bold**)
5. If the question involves forms, mention the form number AND what it's for
6. End every response with a "📋 What to do next" section with 2-3 actionable steps

## Handling Follow-ups
- Use the conversation history to resolve references like "what about my spouse?",
  "and for F1?", "how long does that take?" without asking the user to repeat context
- If a follow-up is ambiguous, ask one clarifying question before answering

## Boundaries
- ONLY answer based on the provided context below
- If the context doesn't cover the question, say:
  "I don't have reliable information on this. Please check uscis.gov
  or consult an immigration attorney."
- NEVER speculate on case outcomes ("you will get approved", "this will take X months")
- NEVER provide specific legal strategy advice
- Always end with:
  "⚠️ This is general information, not legal advice. For your specific situation,
  please consult a licensed immigration attorney."

## Citation Format
Cite sources inline: (Source: USCIS Policy Manual, Vol. 2, Part B)
Include source URLs when available.

---
Context:
{context}

Conversation History:
{chat_history}
"""
```

### Mode B: Professional (Recruiter / HR / Immigration Official)

```python
PROFESSIONAL_SYSTEM_PROMPT = """
You are an immigration compliance assistant for HR professionals, recruiters,
corporate immigration teams, and immigration officials navigating US employment-based
immigration and work authorization requirements.

## Your Persona
- Formal, precise, compliance-oriented
- Assume familiarity with immigration terminology
  (LCA, PERM, I-140, priority dates, cap-exempt, prevailing wage, etc.)
- Reference-heavy and structured

## How to Answer
1. Lead with the regulatory basis — cite 8 CFR sections, INA provisions,
   or USCIS Policy Manual chapters where applicable
2. Structure responses with clear headings:
   - **Regulatory Basis**
   - **Eligibility Requirements**
   - **Employer Obligations**
   - **Required Documentation**
   - **Timelines & Filing Windows**
   - **⚠️ Compliance Risks** (always flag employer liability risks)
3. Where processing times apply, note they are subject to change and
   reference the USCIS processing times page
4. For fee-related queries, cite the exact USCIS fee schedule with
   effective dates

## Handling Follow-ups
- Use conversation history to maintain context across turns
- If a follow-up changes the visa category or scenario, acknowledge the shift
  explicitly ("Switching from H-1B to L-1A analysis...")
- Track entities mentioned earlier (visa type, country of birth, employer type)

## Boundaries
- ONLY answer based on the provided context below
- If context is insufficient, state:
  "The provided documentation does not cover this scenario.
  Recommend consulting immigration counsel for a formal opinion."
- Do NOT interpret ambiguous regulatory language — flag it as requiring legal review
- Do NOT provide case-specific adjudication predictions
- Always end with:
  "⚠️ This does not constitute legal advice. Employers should work with qualified
  immigration counsel for case-specific guidance."

## Citation Format
Cite precisely: (8 CFR §214.2(h)(4)(i)(A)) or (USCIS Policy Manual, Vol. 2, Part B, Ch. 3)
Include specific section/chapter references, not just "USCIS website."

---
Context:
{context}

Conversation History:
{chat_history}
"""
```

---

## Typewriter Effect (Frontend, No Streaming API)

The backend returns the **full response** in a single JSON payload. The frontend animates it:

```
Backend Response (FastAPI):
POST /api/chat
Request:  { session_id, message, mode: "student" | "professional" }
Response: { answer: "full text...", sources: [...], tokens_used: N }

Frontend Animation (Next.js):
- Receives full `answer` string
- Renders character-by-character (or word-by-word) using requestAnimationFrame
- Speed: ~30ms per character (adjustable)
- User can click "Skip" to show full response immediately
- While "typing", show a blinking cursor (CSS animation)
- Loading state: show a pulsing indicator while waiting for backend response
```

**Tradeoff acknowledged:** User waits for full LLM generation before seeing any text. For long responses (~500 tokens), expect 3-8 seconds of loading before typewriter begins. The loading indicator is important UX.

---

## Project Structure

```
RAGProject/
├── CLAUDE.md                          # This file
├── .env                               # Azure OpenAI keys, Qdrant URL, Cohere key
├── .env.example                       # Template without secrets
│
├── ingestion/                         # Offline data pipeline
│   ├── sources.yaml                   # URLs and scraping config per source
│   ├── scraper.py                     # Fetch HTML/PDF from gov sites
│   ├── parser.py                      # Unstructured.io parsing
│   ├── chunker.py                     # Hierarchical parent-child chunking
│   ├── embedder.py                    # Azure OpenAI embedding calls
│   ├── qdrant_loader.py              # Upload vectors + metadata to Qdrant
│   └── run_ingestion.py              # End-to-end ingestion script
│
├── backend/                           # FastAPI server
│   ├── main.py                        # FastAPI app, CORS, routes
│   ├── config.py                      # Settings, env vars, model config
│   ├── prompts.py                     # Both system prompts
│   ├── memory.py                      # Session-scoped ConversationBufferWindowMemory
│   ├── retriever.py                   # Qdrant hybrid search + reranker
│   ├── chain.py                       # LangChain RAG chain with query decomposition
│   └── requirements.txt
│
├── frontend/                          # Next.js app
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                   # Main chat page
│   │   └── api/                       # (optional: proxy route)
│   ├── components/
│   │   ├── ChatWindow.tsx             # Message list + typewriter renderer
│   │   ├── MessageBubble.tsx          # Individual message with citations
│   │   ├── TypewriterText.tsx         # Character-by-character animation
│   │   ├── ModeToggle.tsx             # Student ↔ Professional switch
│   │   ├── CitationSidebar.tsx        # Expandable source references
│   │   └── LoadingIndicator.tsx       # Pulsing dots while waiting for backend
│   ├── lib/
│   │   ├── api.ts                     # Fetch calls to FastAPI backend
│   │   └── session.ts                 # Generate + store session UUID
│   ├── package.json
│   └── tailwind.config.ts
│
├── eval/                              # Evaluation pipeline
│   ├── golden_set.json                # 100 expert-verified Q&A pairs
│   ├── run_ragas.py                   # RAGAS evaluation script
│   └── results/                       # Evaluation output
│
└── scripts/
    ├── refresh_sources.py             # Cron job to re-scrape gov sites weekly
    └── setup_qdrant_collection.py     # One-time: create collection + indexes
```

---

## Environment Variables Needed

```env
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-oss-120b
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_API_VERSION=2024-06-01

# Qdrant Cloud
QDRANT_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-key
QDRANT_COLLECTION_NAME=immigration_docs

# Cohere (Reranker)
COHERE_API_KEY=your-cohere-key
```

---

## Build Order

### Phase 1: Ingestion Pipeline

1. Set up Qdrant Cloud collection with dense + sparse vector config
2. Scrape USCIS Policy Manual + IRS Publication 519
3. Parse → chunk (hierarchical) → embed → upload to Qdrant
4. Verify retrieval with test queries

### Phase 2: Backend RAG Chain

1. FastAPI skeleton with `/api/chat` endpoint
2. LangChain chain: complexity classifier → retriever → generator
3. Wire up both system prompts with mode switching
4. Session-scoped memory (in-memory dict)
5. Test with curl / Postman

### Phase 3: Frontend

1. Next.js app with chat UI
2. Mode toggle (Student ↔ Professional)
3. Typewriter animation component
4. Citation display
5. Loading states

### Phase 4: Polish & Eval

1. Build golden eval set (50 student questions, 50 professional questions)
2. Run RAGAS evaluation
3. Tune chunk sizes, retrieval top-k, reranker threshold
4. Add weekly source refresh script

---

## Key Design Decisions Log

| Decision     | Choice                           | Reason                                                                               |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------ |
| RAG strategy | RAG-Fusion + Query Decomposition | Immigration queries are specific + multi-part; HyDE risks hallucination at retrieval |
| Vector DB    | Qdrant Cloud free tier           | No expiry, native hybrid search, 4GB disk                                            |
| Streaming    | No streaming API                 | Typewriter effect on frontend instead; simpler backend                               |
| Chat memory  | Session-scoped, in-memory, k=10  | No user accounts needed; fresh start per session                                     |
| Two modes    | System prompt switching          | Same retrieval pipeline, different generation persona                                |
| Chunking     | Hierarchical parent-child        | Small chunks for retrieval precision, parent chunks for generation context           |
| LLM          | GPT-OSS-120B on Azure            | Free credits                                                                         |
