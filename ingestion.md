# Ingestion Pipeline — Reference Document

## What this pipeline does

Converts raw government documents (HTML, PDF) into searchable vectors stored in Qdrant Cloud. Runs offline — once initially, then weekly to refresh stale content.

```
Gov websites (USCIS, IRS, DOL, State Dept)
        ↓
scraper.py       → data/raw/       (raw HTML + PDFs)
        ↓
parser.py        → data/parsed/    (clean text + tables as JSON)
        ↓
chunker.py       → data/chunks/    (hierarchical parent/child chunks)
        ↓
embedder.py      → data/embedded/  (chunks + 1536-dim vectors)
        ↓
qdrant_loader.py → Qdrant Cloud    (1553 points uploaded)
        ↓
cleanup          → data/ deleted   (only if all stages succeeded)
```

---

## Stage 1 — Scraper

### What it does

Fetches raw HTML and PDF files from government sources defined in `sources.yaml`. Saves raw files to `data/raw/` using a hash-based filename (`domain_md5hash.ext`).

### Key decisions

**sources.yaml over hardcoded URLs**
Separates _what_ to scrape from _how_ to scrape. Adding a new source only requires editing YAML, not Python.

**Three fetcher types**

- `html` — standard `requests` session for static pages
- `pdf` — same as HTML but with PDF content validation (`%PDF` header check)
- `js_rendered` — Playwright headless Chromium for JavaScript-rendered pages

**Idempotent scraping**
`already_fetched()` checks if a file exists before downloading. Re-running the scraper skips already-fetched files — safe to run multiple times without hammering servers.

**Rate limiting**
2 second delay between requests (`REQUEST_DELAY_SEC = 2`). Polite to government servers, avoids IP blocks.

**Retry with exponential backoff**
3 retries per URL. Wait time doubles each attempt (2s → 4s → 8s). Handles transient network failures gracefully.

**User-Agent spoofing**
Sets a real browser User-Agent header. Some government servers block default Python/requests agents.

### Issues encountered and fixes

- **USCIS processing times page** — blocked by Cloudflare bot detection. Removed from sources. Processing times are dynamic data, not suitable for a static knowledge base. System prompt handles this gracefully.
- **DOL HTML pages** — blocked by "Challenge Validation". Replaced with direct PDF URLs from DOL's WHD (Wage and Hour Division) legacy files path.

### Interview questions to prepare

- What is idempotent scraping and why does it matter?
- Why use Playwright instead of requests for some pages?
- How do you handle rate limits when scraping?
- What is exponential backoff and when do you use it?

---

## Stage 2 — Parser

### What it does

Converts raw HTML and PDF files into clean structured JSON. Each output file contains: `content` (clean text), `tables` (extracted separately), `sections` (headings), and metadata.

### Key decisions

**unstructured.io for HTML, pdfplumber for PDFs**
`unstructured.io` understands HTML document semantics — knows a `<h2>` is a heading, not body text. `pdfplumber` is better for PDFs because it extracts tables using PDF coordinate geometry — finds rectangular regions and reads them as grids. More reliable than unstructured for structured government PDFs.

**Tables wrapped in `[TABLE]...[/TABLE]` markers**
Two reasons:

1. Tells the chunker "never split this"
2. Signals to the LLM "this data came from a structured table, treat it precisely" — a fee of $730 in a table is a fact, not prose to paraphrase

**BeautifulSoup fallback**
If unstructured finds less than 500 characters, falls back to direct BS4 extraction. Removes nav/header/footer tags first (`tag.decompose()`).

**Boilerplate removal**
Regex patterns strip common gov website noise: "An official website of the United States government", "Here's how you know", etc. These add no semantic value to embeddings.

**effective_date as YYYYMMDD integer**
Qdrant range filters work on numbers, not strings. `20240101` format preserves chronological ordering and enables `effective_date >= 20230101` filters at query time.

**url_to_filename() reverse mapping**
The scraper hashed URLs to filenames. The parser rebuilds the mapping by re-running the same hash function on all source URLs from `sources.yaml`. This lets us attach the right metadata to each file without storing a lookup table.

### Interview questions to prepare

- Why store tables separately from body text?
- What is the difference between unstructured.io and BeautifulSoup?
- Why store dates as integers in a vector database?
- What is boilerplate removal and why does it matter for embeddings?

---

## Stage 3 — Chunker

### What it does

Splits parsed documents into hierarchical parent-child chunk pairs. Saves to `data/chunks/` as JSON arrays.

### The core problem chunking solves

LLMs have context window limits — you cannot feed an entire 300-page document to the LLM. Chunking breaks documents into pieces so only _relevant_ pieces are sent at query time. But chunk size creates a fundamental tradeoff:

- **Small chunks** → precise retrieval, poor generation context
- **Large chunks** → rich generation context, imprecise retrieval

### Hierarchical parent-child chunking

Resolves the tradeoff by using two chunk sizes:

| Type   | Size        | Purpose                                                           |
| ------ | ----------- | ----------------------------------------------------------------- |
| Child  | 256 tokens  | Embedded and indexed — small enough for precise semantic matching |
| Parent | 1024 tokens | Sent to LLM — large enough for rich generation context            |

**Flow:** query matches child → fetch parent by ID → send parent to LLM.

Child is the _index entry_. Parent is the _actual page_. You search the index, you read the page.

### Chunk size numbers

- 256 tokens ≈ 1024 characters ≈ 2-3 dense paragraphs
- 1024 tokens ≈ 4096 characters ≈ one full document section
- These are empirically established defaults from LangChain research, tuned in Phase 4 with RAGAS

### Splitting strategy

1. Separate `[TABLE]` blocks first — never split
2. Split remaining text on paragraph boundaries (`\n\n`) first
3. If a single paragraph exceeds max size, fall back to sentence splitting
4. Regex sentence splitter respects common abbreviations (`e.g.`, `i.e.`, `8 C.F.R.`) — naive `.` split would destroy legal citations

### Overlap

`OVERLAP_TOKENS = 32` (128 chars) carried over between consecutive chunks.

Without overlap:

```
Chunk 1: "...employer must file the LCA with"
Chunk 2: "Department of Labor before submitting..."  ← starts cold
```

With overlap:

```
Chunk 1: "...employer must file the LCA with"
Chunk 2: "...file the LCA with Department of Labor before submitting..."
```

Both chunks have complete semantic context at boundaries.

### Tables as atomic chunks

Tables become their own parent chunk. A child chunk is created pointing to the table parent. The child's text IS the table — it gets embedded whole. Tables are never split because splitting mid-row produces meaningless fragments.

### Section heading preservation

Each chunk carries `section` metadata — the nearest heading from the parsed document. A chunk saying `"The fee is $730"` with `section: "H-1B Filing Fees"` gives the LLM the context it needs to answer correctly.

### Interview questions to prepare

- What is the small-to-large retrieval pattern?
- Why is chunk size a tradeoff? What are you trading off?
- What is overlap and why does it help?
- Why are tables never split?
- What is the "lost in the middle" problem in LLMs?

---

## Stage 4 — Embedder

### What it does

Converts child chunk text into 1536-dimensional vectors using Azure OpenAI `text-embedding-3-large`. Saves to `data/embedded/` before uploading.

### What is an embedding?

A text embedding converts text into a list of numbers (a vector) where semantically similar texts produce numerically similar vectors. Similarity is measured by cosine similarity — the angle between two vectors. Small angle = similar meaning.

### Why 1536 dimensions and not 3072?

`text-embedding-3-large` defaults to 3072 dimensions. We truncate to 1536 using the `dimensions` parameter. This works because of **Matryoshka Representation Learning (MRL)** — the most important information is packed into the first dimensions, each additional dimension adds progressively less signal. Result: same quality, half storage cost, faster search.

### Why only embed child chunks?

Parent chunks are retrieved by ID, never by vector similarity. Embedding them wastes API calls and storage with vectors that are never queried.

### Batching

Azure OpenAI accepts up to 16 texts per call. We use batches of 8 to stay within per-request token limits. 1280 chunks / 8 = ~160 API calls instead of 1280.

### Rate limiting — two layers

1. **Proactive** — `RATE_LIMIT_DELAY = 0.5s` between batches. Slows us down before hitting limits.
2. **Reactive** — `RateLimitError` handler with exponential backoff (2s → 4s → 8s). The OpenAI SDK also has its own built-in retry on 429 errors.

### Why save to data/embedded/ before uploading?

Embeddings cost money. If the Qdrant upload fails after 1000 chunks are embedded, you don't want to re-call the Azure API for those 1000 chunks again. Checkpointing to disk decouples the expensive embedding step from the upload step.

### Cost

`text-embedding-3-large` at 1536 dims costs $0.00013/1000 tokens. 1280 chunks × 256 tokens = ~328k tokens ≈ **$0.04 total**.

### Interview questions to prepare

- What is cosine similarity and how does it relate to embeddings?
- What is Matryoshka Representation Learning?
- Why use batching when calling embedding APIs?
- What is exponential backoff?
- Why checkpoint embeddings to disk before uploading?

---

## Stage 5 — Qdrant Loader

### What it does

Uploads all embedded chunks to Qdrant Cloud as points. Children get vectors + payload. Parents get payload only.

### What is a Qdrant point?

A point has three parts:

```
Point
├── id      → UUID (chunk_id)
├── vector  → { "dense": [1536 floats], "sparse": {idx: weight} }
│              empty {} for parent points
└── payload → { text, source_url, doc_type, section, parent_id, ... }
```

### Dense vs sparse vectors — hybrid search

We store two vector types per child point:

**Dense (semantic)** — from Azure OpenAI embeddings. Finds conceptually similar content even if words don't match. "Work permit" finds chunks about "employment authorization".

**Sparse (keyword/BM25)** — term frequency weights. Finds exact/near-exact term matches. Critical for immigration because terms like "I-485", "8 CFR §214.2", "cap-gap" are specific and must be found exactly.

Hybrid search combines both. Immigration queries need both — "I-485" needs exact matching, "how do I get a green card" needs semantic search.

### Our sparse vector implementation

Simple TF (term frequency) approach:

1. Tokenize text, remove stopwords
2. Hash each token to an integer index (`hash(token) % 100_003`)
3. Weight = term frequency / document length (normalized)

In production you'd use FastEmbed or Qdrant's built-in sparse encoder (SPLADE). Our implementation is sufficient for this project.

### Why upload parents with no vector?

Parents need to be fetchable by ID at query time. Qdrant stores and retrieves points by ID even without a vector — like a lookup table. `client.retrieve(ids=[parent_id])` returns the parent payload directly without any vector search.

### Upsert vs insert

We use `client.upsert()` not `client.insert()`. Upsert = insert if not exists, update if exists. Safe to re-run the loader without creating duplicate points.

### Payload indexes (created in setup script)

Indexes on `doc_type`, `topic_tag`, `jurisdiction`, `source_url`, `effective_date` allow pre-filtering before vector search. Without indexes, filtering scans every point. With indexes, Qdrant jumps to matching subset first. Standard practice for production vector DBs.

### Final counts

```
Children uploaded : 1280  (searchable by vector)
Parents uploaded  :  273  (fetchable by ID only)
Total points      : 1553
```

### Interview questions to prepare

- What is hybrid search and when do you need it?
- What is the difference between dense and sparse vectors?
- What is BM25?
- Why do parent points have no vector?
- What is an upsert and why use it over insert?
- What are payload indexes and why do they matter at scale?

---

## Stage 6 — Cleanup

### What it does

Deletes `data/raw/`, `data/parsed/`, `data/chunks/`, `data/embedded/` after a successful upload.

### Why only after all stages succeed?

If any stage fails, local data is preserved for debugging and resuming. If upload fails at chunk 900, you can fix the issue and re-run `qdrant_loader.py` directly — no need to re-scrape or re-embed.

### Why delete at all?

- IRS Publication 519 embedded JSON = 32MB. 1280 chunks × 1536 floats × 4 bytes = ~7.9MB of pure vectors stored locally. No need to keep this on disk once it's safely in Qdrant Cloud.
- Data/raw contains scraped government content — not your IP, not worth tracking in git.

---

## run_ingestion.py — The Orchestrator

Single entry point for the full pipeline:

```bash
python ingestion/run_ingestion.py                    # full pipeline
python ingestion/run_ingestion.py --skip-scrape      # reuse existing raw files
python ingestion/run_ingestion.py --no-cleanup       # keep local data
python ingestion/run_ingestion.py --source uscis     # one jurisdiction only
```

### Why an orchestrator matters

- Enforces stage ordering — chunker can't run before parser
- Fails fast — aborts on first failure, doesn't run downstream stages
- Single command for the weekly refresh cron job
- `--skip-scrape` flag allows resuming after a parse/chunk/embed failure without re-downloading

---

## Architecture decisions summary

| Decision          | Choice                         | Why                                                  |
| ----------------- | ------------------------------ | ---------------------------------------------------- |
| Scraping          | requests + Playwright          | Static pages need requests, JS pages need Playwright |
| PDF parsing       | pdfplumber                     | Superior table extraction via coordinate geometry    |
| HTML parsing      | unstructured.io                | Understands document semantics, not just HTML tree   |
| Chunking strategy | Hierarchical parent-child      | Resolves small/large chunk tradeoff                  |
| Child chunk size  | 256 tokens                     | Precise embeddings, accurate retrieval               |
| Parent chunk size | 1024 tokens                    | Rich LLM generation context                          |
| Overlap           | 32 tokens                      | Preserves context at chunk boundaries                |
| Embedding model   | text-embedding-3-large         | Best OpenAI embedding model                          |
| Embedding dims    | 1536 (truncated)               | MRL — same quality, half storage                     |
| Vector search     | Hybrid dense + sparse          | Semantic + exact keyword matching                    |
| Vector DB         | Qdrant Cloud free tier         | No expiry, native hybrid search, fast                |
| Checkpointing     | Save to disk between stages    | Resume without re-running expensive stages           |
| Cleanup           | Delete after successful upload | Save disk space, data lives in Qdrant                |

---

## Data flow summary

```
14 raw files (HTML + PDF)
        ↓ parser.py
14 parsed JSON files (~clean text)
        ↓ chunker.py
14 chunk JSON files (273 parents + 1280 children + 36 tables)
        ↓ embedder.py
14 embedded JSON files (children now have 1536-dim vectors)
        ↓ qdrant_loader.py
1553 points in Qdrant Cloud
  ├── 1280 child points (vector + payload)
  └──  273 parent points (payload only)
```
