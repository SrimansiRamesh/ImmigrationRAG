# Backend — Reference Document

## What this backend does

Receives a user message from the frontend, runs a full RAG pipeline, and returns a grounded answer with citations. Built with FastAPI + LangChain + Azure OpenAI.

```
User message + session_id + mode
        ↓
FastAPI /api/chat
        ↓
Complexity classifier (simple vs complex)
        ↓
Simple → direct hybrid retrieval
Complex → query decomposition → RAG-Fusion (RRF)
        ↓
Qdrant hybrid search (dense + sparse)
        ↓
Cohere reranker
        ↓
Parent chunk fetcher
        ↓
System prompt + context + chat history → Gemini 2.5 Flash
        ↓
Answer + citations returned to frontend
```

---

## File Overview

| File           | Responsibility                                                                 |
| -------------- | ------------------------------------------------------------------------------ |
| `config.py`    | All env vars + model parameters in one place                                   |
| `prompts.py`   | Student + professional system prompts, classifier prompt, decomposition prompt |
| `memory.py`    | Session-scoped ConversationBufferWindowMemory                                  |
| `retriever.py` | Embed → hybrid search → rerank → fetch parents → assemble context              |
| `chain.py`     | Classify → route → retrieve → generate → save memory                           |
| `main.py`      | FastAPI server, CORS, request/response validation                              |

---

## config.py

### Purpose

Single source of truth for all configuration. Every other file imports from here. If a model name or parameter changes, it changes in exactly one place.

### Key parameters and why they were chosen

**`TEMPERATURE = 0.0`**
Controls LLM randomness. At 0.0 the model always picks the most probable next token — fully deterministic. For immigration and tax content we want consistency and accuracy, not creativity. The same question should get the same answer every time.

**`RETRIEVAL_TOP_K = 20`**
Number of child chunks retrieved from Qdrant before reranking. Cast a wide net first. Too few (e.g. 5) and the reranker has poor candidates. Too many (e.g. 50) and the reranker call gets slow.

**`RERANK_TOP_N = 5`**
Chunks kept after reranking and sent to the LLM. The 20→5 funnel is a standard production ratio. Sending all 20 to the LLM would exceed context budget and include irrelevant content.

**`MEMORY_K = 10`**
Last 10 conversation turns kept in session memory. At ~200 tokens per turn = ~2000 tokens of history per request. Beyond 10 turns, oldest context is usually irrelevant anyway.

**`MAX_TOKENS = 8192`**
Maximum response length. Long enough for detailed immigration explanations, short enough to prevent runaway costs.

**Two model deployments**

- `GEMINI_CHAT_MODEL = "gemini-2.5-flash"` — full model for generation, accuracy matters
- `GEMINI_CLASSIFIER_MODEL = "gemini-2.5-flash-lite"` — cheaper/faster for routing decisions

### Interview questions to prepare

- Why centralize configuration instead of using environment variables directly?
- Why use temperature=0 for this use case?
- What is the tradeoff between RETRIEVAL_TOP_K and RERANK_TOP_N?

---

## prompts.py

### Purpose

Defines the system prompts that shape LLM behavior, tone, output format, citation style, and hard boundaries. Also defines the classifier and decomposition prompts for routing decisions.

### Why two separate system prompts?

The two user types have fundamentally different needs:

| Student mode                       | Professional mode                    |
| ---------------------------------- | ------------------------------------ |
| Plain English, no jargon           | Assumes full terminology familiarity |
| Numbered steps, analogies          | Regulatory structure with headings   |
| Empathetic tone                    | Formal, compliance-oriented          |
| "What to do next" section          | Compliance risks section             |
| Cite by name (USCIS Policy Manual) | Cite by regulation (8 CFR §214.2(h)) |

A single prompt trying to serve both produces mediocre results for each. Two focused prompts produce excellent results for their target audience.

### Key prompt engineering decisions

**Explicit formatting instructions**
Without them LLMs produce walls of text. For immigration content, numbered steps with bolded deadlines is genuinely more useful than paragraphs. The more specific the format instruction, the more consistent the output.

**Hard boundary section**
Every system prompt has explicit "Never do this" rules:

- Never speculate on case outcomes
- Never provide legal strategy advice
- Only answer from provided context — never hallucinate
- For processing times, always direct to uscis.gov directly

**Mandatory disclaimer**
Every response ends with the same exact disclaimer. Two reasons: legal protection (users acting on incorrect information face real consequences) and trust calibration (users learn to treat the tool as a research starting point, not a lawyer).

**`{context}` and `{chat_history}` placeholders**
These are filled at query time by the chain. `{context}` = assembled parent chunks. `{chat_history}` = last k turns of conversation. LangChain handles substitution automatically.

### Classifier prompt design

```
Returns exactly one word: "simple" or "complex"
max_tokens=5 forces brevity — prevents the model from explaining reasoning
Sanitized: "complex" if "complex" in result else "simple"
```

Simple = single fact/definition/fee, one concept, straightforward lookup.
Complex = multiple visa categories, status transitions, dependents, multi-stage timelines.

### Decomposition prompt design

```
Returns exactly n sub-questions, one per line
Each sub-question is self-contained and independently searchable
Uses precise immigration terminology
Original query always inserted as first sub-query
```

The original query is always included because decomposed sub-questions can lose the overall intent. Including the original ensures the primary question is always retrieved.

### Interview questions to prepare

- What is prompt engineering?
- Why does the format of a system prompt matter?
- What is a hard boundary in an LLM system and why include one?
- How do you prevent an LLM from hallucinating in a RAG system?
- Why is a legal disclaimer important in this application?

---

## memory.py

### Purpose

Manages session-scoped conversation history so users can ask follow-up questions without repeating context.

### The problem memory solves

LLMs are stateless — every API call is independent. Without memory:

```
Turn 1: "What is cap-gap?"  → LLM answers
Turn 2: "How long does it last?"  → LLM has no idea what "it" refers to
Turn 3: "What about my spouse?"  → LLM has no idea what situation this refers to
```

Memory injects the conversation history into every prompt, giving the LLM context about prior turns.

### ConversationBufferWindowMemory

LangChain memory types compared:

| Type                              | Behavior             | Problem                                |
| --------------------------------- | -------------------- | -------------------------------------- |
| `ConversationBufferMemory`        | Keeps full history   | Context window fills up infinitely     |
| `ConversationBufferWindowMemory`  | Keeps last k turns   | Our choice — bounded, predictable cost |
| `ConversationSummaryMemory`       | Summarizes old turns | Loses precision on specific details    |
| `ConversationSummaryBufferMemory` | Hybrid               | Complex, overkill for this use case    |

### Key parameters

**`return_messages=True`**
Returns message objects (HumanMessage, AIMessage) instead of a string. Modern LangChain chains and Azure OpenAI work better with message objects — they map directly to the chat API's message format.

**`output_key="answer"`**
The RAG chain returns a dict with multiple keys (answer, sources, complexity). Memory needs to know which key contains the assistant's response to store. We tell it explicitly: store "answer", ignore the rest.

**`memory_key="chat_history"`**
Must match the `{chat_history}` placeholder in the system prompt exactly. LangChain uses this key to inject memory into the prompt template.

### Architecture decision — in-memory dict

Sessions stored in a Python dict (`_session_store`) keyed by UUID. No Redis, no database.

Why this is correct for this project:

- No user accounts — nothing to persist across server restarts
- Privacy by design — conversations never stored permanently
- Simple architecture — no Redis dependency to manage
- Fresh start per session is the intended UX

In production with multiple server instances (horizontal scaling), you'd replace the dict with Redis — each server instance needs access to the same session store.

### Session lifecycle

```
Frontend generates UUID on page load → stored in browser
        ↓
UUID sent with every message in the request body
        ↓
get_memory(session_id):
  - First call → creates fresh ConversationBufferWindowMemory
  - Subsequent calls → returns existing memory with history
        ↓
Memory injected into prompt as {chat_history}
        ↓
After LLM responds → memory.save_context() stores the turn
        ↓
If > k turns → oldest turn dropped from window automatically
```

### Interview questions to prepare

- What is stateless vs stateful in the context of LLMs?
- Why use a sliding window for memory instead of keeping full history?
- What would you replace the in-memory dict with at production scale?
- What is the difference between session memory and persistent memory?

---

## retriever.py

### Purpose

The bridge between the user's question and the knowledge base. Runs the full retrieval pipeline: embed → hybrid search → rerank → fetch parents → assemble context.

### Step 1 — Query embedding

The query is embedded using the exact same model and dimensions (text-embedding-3-large, 1536 dims) as ingestion. This is critical — if you embed queries with a different model than chunks, the vectors live in different spaces and similarity search produces meaningless results.

### Step 2 — Sparse vector

Same BM25-style term frequency approach as ingestion. Must be identical to ingestion — consistency between query and document sparse vectors is what makes keyword matching work.

### Step 3 — Hybrid search

Two vector types searched simultaneously in Qdrant:

**Dense (semantic)** — finds conceptually similar content even if words differ. "Work permit" finds chunks about "employment authorization".

**Sparse (keyword/BM25)** — finds exact/near-exact term matches. Critical for immigration because terms like "I-485", "8 CFR §214.2", "cap-gap" are specific and must be found exactly.

Why hybrid matters for immigration: USCIS says "specialty occupation", DOL says "H1B nonimmigrant worker", IRS says "nonresident alien on work visa" — all mean related things. Dense search handles the semantic variation. Sparse search handles exact regulatory citations.

### Step 4 — Cohere reranker

**The problem with retrieval alone:**
Vector search finds topically similar chunks but doesn't understand whether a chunk actually answers the query. It answers "are these texts about the same topic?" not "does this chunk answer this question?"

**How the reranker works:**
Cross-encoder architecture — sees query AND chunk together simultaneously:

```
Input:  [QUERY] Can my H1B employer reduce my salary?
        [CHUNK] H1B employers must pay the prevailing wage...
Output: relevance score 0.94
```

By seeing both together it understands the relationship, not just topical overlap.

**Why not use reranker for everything?**
Cross-encoders can't be pre-computed — run fresh for every (query, chunk) pair at query time. Running it over all 1280 chunks per query = 30+ seconds. Solution: two-stage pipeline — vector search (fast, broad, top-20) → reranker (slow, precise, top-5).

**Fallback:**
If Cohere reranking fails, falls back to original vector search order. The system degrades gracefully rather than crashing.

### Step 5 — Parent chunk fetching

Child chunks (256 tokens) are precise for retrieval but too short for good generation context. Parent chunks (1024 tokens) provide the full section the LLM needs.

**Deduplication:** Multiple child chunks may share the same parent_id (e.g., three children from the same section all matched the query). We deduplicate so the LLM doesn't receive the same parent content twice.

**Direct ID lookup:** Parents are fetched using `client.retrieve(ids=[...])` — not vector search. Like a primary key lookup in SQL. Fast and deterministic.

### Step 6 — Context assembly

Each parent chunk formatted with source metadata:

```
---
[Source: https://uscis.gov/... | Section: H-1B Eligibility | Type: policy_manual]
<text content>
---
```

This format gives the LLM everything it needs to generate accurate inline citations. The source URL, section heading, and doc type are all present in the context so the LLM can reference them in its answer.

### RAG-Fusion with RRF (retrieve_multi)

Used for complex queries decomposed into sub-queries.

**The problem:** Different sub-queries return different ranked lists of chunks. How do you merge them?

**Reciprocal Rank Fusion (RRF):**

```
RRF score = Σ 1 / (k + rank)  where k=60
```

A chunk that appears at rank 1 in one list and rank 3 in another gets a higher combined score than a chunk that only appears in one list — even at rank 1. This rewards breadth of relevance across multiple sub-questions.

**Why k=60?**
Comes from the original RRF paper (Cormack et al., 2009). Dampens the impact of very high ranks — without it rank 1 would have an outsized effect. k=60 is the standard value used across virtually all production RAG systems.

**Why RRF over averaging scores?**
Vector similarity scores are not comparable across queries. A score of 0.85 from sub-query 1 and 0.85 from sub-query 2 don't mean the same thing — different queries produce different score distributions. RRF uses rank position which is comparable across any ranked list regardless of underlying scores.

### Module-level clients

Qdrant, Cohere, and Azure OpenAI clients are initialized once at module load time, not per request. Creating a new HTTP connection per request adds 200-500ms overhead. Module-level clients maintain persistent connection pools reused across all requests. Standard practice for any service client in a web server.

### `with_vectors=False`

When Qdrant returns search results it can optionally include the full vector (1536 floats) alongside each result. We don't need them — we only need the payload. Excluding them saves ~120KB of bandwidth per request (20 results × 1536 floats × 4 bytes).

### Interview questions to prepare

- What is the difference between a bi-encoder and a cross-encoder?
- Why does hybrid search outperform pure semantic search for this domain?
- What is RRF and why use rank position instead of raw scores?
- What is the two-stage retrieval pattern and why is it standard?
- Why deduplicate parent chunks?
- What is the "lost in the middle" problem and how does reranking help?

---

## chain.py

### Purpose

Orchestrates the full RAG pipeline end to end. The single function `run_chain()` is what the FastAPI endpoint calls.

### Complexity classifier

Uses `gemini-2.5-flash-lite` (not the full model) with `max_tokens=5` to return exactly "simple" or "complex".

**Simple:** Single fact, definition, fee, deadline, one concept.
**Complex:** Multiple visa categories, status transitions, dependents, multi-stage timelines, tax + immigration combined.

**Why LLM and not heuristics?**
Immigration questions are deceptive. "Can I work?" looks simple but implies a complex status question. "What is cap-gap?" looks technical but is a single definition lookup. LLM judgment handles these edge cases better than word count or keyword rules.

**Why `gemini-2.5-flash-lite` for classification?**
Classification is a structural routing task — it doesn't require deep domain knowledge. Using the lite model saves tokens and adds speed. The full `gemini-2.5-flash` is reserved for the only task requiring its full capability: generating the final answer.

### Query routing

```
Simple  → retrieve(query)          — single Qdrant search
Complex → decompose_query(query)
          → retrieve_multi(sub_queries)  — RAG-Fusion
```

Both paths converge at the same generation step — routing only affects retrieval.

### Memory save order

Memory is formatted (read) BEFORE generation so the LLM sees prior context. Memory is saved (write) AFTER generation so we store the actual answer. If we saved before generation we'd store an empty answer. Simple ordering dependency that's easy to get wrong.

### Error handling philosophy

The classifier and decomposer both have try/except with graceful fallbacks:

- Classifier failure → default to "simple" (safer than crashing)
- Decomposition failure → use original query directly

The generation step does not have a silent fallback — if the LLM fails, that's a real error that should propagate to the user via FastAPI's exception handler.

### Interview questions to prepare

- What is query routing and why is it useful in RAG?
- Why use a cheaper model for classification vs generation?
- What is the difference between the classifier and the decomposer?
- Why must memory be read before generation and saved after?
- What is graceful degradation and where do we use it?

---

## main.py

### Purpose

FastAPI HTTP server. Validates requests, calls the chain, returns structured responses. Also handles CORS and health checking.

### Why FastAPI over Flask?

| Feature            | FastAPI                 | Flask           |
| ------------------ | ----------------------- | --------------- |
| Request validation | Automatic via Pydantic  | Manual          |
| API docs           | Auto-generated at /docs | Manual          |
| Async support      | Native                  | Plugin required |
| Type hints         | Throughout              | Optional        |
| Performance        | Higher (Starlette)      | Lower           |

For this project Pydantic validation is the biggest win — `ChatRequest` automatically validates that `mode` is "student" or "professional", message is 1-2000 chars, session_id is non-empty. Zero manual validation code.

### CORS middleware

Browsers enforce Same-Origin Policy — JavaScript on `localhost:3000` cannot call an API on `localhost:8000` unless the server explicitly allows it. CORS middleware adds the right response headers. Without it the frontend gets blocked immediately.

In production: replace `localhost:3000` with your actual deployed frontend domain.

### Pydantic models

**`ChatRequest`** — validates incoming request:

- `session_id`: non-empty string
- `message`: 1-2000 characters
- `mode`: must match pattern `^(student|professional)$`

**`ChatResponse`** — structures outgoing response:

- `answer`: LLM response text
- `sources`: list of SourceItem for citation display
- `complexity`: "simple" or "complex" (useful for frontend analytics)
- `tokens_used`: total tokens (for cost monitoring)

### Three endpoints

**`GET /health`** — instant, no downstream calls. For deployment platform health checks (Kubernetes, Docker) that ping every few seconds.

**`POST /api/chat`** — main endpoint. Full RAG pipeline.

**`DELETE /api/session/{session_id}`** — clears conversation memory. Called when user clicks "New Chat".

**`GET /api/health/detailed`** — actually checks Qdrant connectivity. For human debugging, not automated pings.

### Lifespan (startup validation)

`validate_config()` runs at startup and raises immediately if any required environment variable is missing. Fail fast — better to know about a missing `QDRANT_URL` when the server starts than when the first user request fails.

### Interview questions to prepare

- What is CORS and why is it needed?
- What is Pydantic and what problem does it solve?
- What is the difference between a health check and a detailed health check?
- Why use FastAPI's lifespan for startup validation?
- What is the difference between a 422 and a 500 error in FastAPI?

---

## End to end request flow

```
1. Frontend sends POST /api/chat
   { session_id, message, mode }
        ↓
2. Pydantic validates request fields
        ↓
3. run_chain() called
        ↓
4. get_memory(session_id) → fetch or create session memory
        ↓
5. classify_query(message) → "simple" or "complex"
   (gemini-2.5-flash-lite, max_tokens=5, temperature=0)
        ↓
6a. Simple → retrieve(message)
      embed_query → hybrid_search (Qdrant, top-20)
      → rerank_results (Cohere, top-5)
      → fetch_parent_chunks (Qdrant ID lookup)
      → assemble_context

6b. Complex → decompose_query(message)
      → retrieve_multi(sub_queries)
        per sub-query: embed → hybrid_search
        RRF fusion → rerank → fetch parents → assemble
        ↓
7. generate_response(query, context, chat_history, mode)
   system_prompt.format(context=..., chat_history=...)
   → gpt-4o → answer text + tokens_used
        ↓
8. memory.save_context(message, answer)
        ↓
9. Return ChatResponse
   { answer, sources, complexity, tokens_used }
        ↓
10. Frontend renders answer with typewriter animation
    Citation sidebar populated from sources
```

---

## Architecture decisions summary

| Decision               | Choice                                     | Why                                                 |
| ---------------------- | ------------------------------------------ | --------------------------------------------------- |
| Framework              | FastAPI                                    | Pydantic validation, async, auto-docs               |
| LLM                    | Gemini 2.5 Flash (generation), Gemini 2.5 Flash Lite (routing) | Quality where it matters, speed where it doesn't    |
| Temperature            | 0.0                                        | Deterministic — legal/tax content needs consistency |
| Retrieval              | Hybrid dense + sparse                      | Semantic + exact keyword matching                   |
| Reranker               | Cohere rerank-english-v3.0                 | Best free-tier cross-encoder available              |
| RAG strategy           | RAG-Fusion + query decomposition           | Handles complex multi-part immigration queries      |
| Memory                 | ConversationBufferWindowMemory k=10        | Bounded cost, covers all realistic follow-ups       |
| Session store          | In-memory dict                             | No persistence needed, simple, private by design    |
| Two system prompts     | Student + Professional                     | Fundamentally different user needs                  |
| Complexity routing     | LLM classifier                             | Immigration questions too deceptive for heuristics  |
| Parent-child retrieval | Small-to-large                             | Precise retrieval, rich generation context          |
| Context format         | Source-labeled blocks                      | LLM can generate accurate inline citations          |
| Fail fast              | Config validated at startup                | Know about missing env vars immediately             |
| Graceful degradation   | Classifier/reranker fallbacks              | System stays up even if routing/reranking fails     |
