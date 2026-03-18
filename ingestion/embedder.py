"""
embedder.py

Reads child chunks from data/chunks/, calls Azure OpenAI to get embeddings,
and saves the results to data/embedded/ as JSON files ready for Qdrant upload.

Why save to data/embedded/ instead of uploading directly?
- Embeddings cost money (small, but real) — we don't want to re-embed if
  the Qdrant upload fails
- Checkpointing: if embedding crashes at chunk 800, we resume from 800
- Easier to inspect/debug before uploading

Usage:
    python ingestion/embedder.py
    python ingestion/embedder.py --source uscis
"""

import os
import json
import time
import logging
import argparse
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from openai import AzureOpenAI, RateLimitError, APIError
from tqdm import tqdm

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT         = Path(__file__).parent.parent
CHUNKS_DIR   = ROOT / "data" / "chunks"
EMBEDDED_DIR = ROOT / "data" / "embedded"

EMBEDDED_DIR.mkdir(parents=True, exist_ok=True)

# ── Azure OpenAI config ───────────────────────────────────────────────────────
client = AzureOpenAI(
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
)

EMBEDDING_MODEL = os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large")
EMBEDDING_DIMS  = 1536   # truncated from 3072 — same quality, half storage

# ── Batching config ───────────────────────────────────────────────────────────
# Azure OpenAI accepts up to 16 texts per embedding call
# We use 8 to stay well within token limits per request
BATCH_SIZE      = 8
RATE_LIMIT_DELAY = 0.5   # seconds between batches — polite to the API


# ── Embedding logic ───────────────────────────────────────────────────────────

def embed_batch(texts: list[str], retries: int = 3) -> list[list[float]]:
    """
    Embed a batch of texts using Azure OpenAI.
    Returns a list of embedding vectors (one per text).

    Retries on rate limit errors with exponential backoff.
    Why exponential backoff? If we hit the rate limit, waiting a fixed time
    might not be enough. Doubling the wait each retry gives the API time
    to recover: 2s → 4s → 8s.
    """
    for attempt in range(1, retries + 1):
        try:
            response = client.embeddings.create(
                input=texts,
                model=EMBEDDING_MODEL,
                dimensions=EMBEDDING_DIMS,
            )
            # Response comes back in the same order as input
            return [item.embedding for item in response.data]

        except RateLimitError:
            wait = 2 ** attempt   # exponential backoff: 2, 4, 8 seconds
            log.warning(f"Rate limit hit — waiting {wait}s (attempt {attempt}/{retries})")
            time.sleep(wait)

        except APIError as e:
            log.error(f"API error on attempt {attempt}: {e}")
            if attempt == retries:
                raise
            time.sleep(2)

    raise RuntimeError(f"Failed to embed batch after {retries} retries")


# ── Main embedding logic ──────────────────────────────────────────────────────

def embed_chunks_file(chunks_path: Path) -> dict:
    """
    Embed all child chunks from one chunks JSON file.

    Only child chunks get embedded — parent chunks are stored in Qdrant
    as payload only (no vector). Tables that are child chunks DO get
    embedded — we want them to be searchable.

    Returns a dict with:
      - parents: list of parent chunk dicts (no embedding)
      - children: list of child chunk dicts with 'embedding' field added
    """
    with open(chunks_path) as f:
        chunks = json.load(f)

    parents  = [c for c in chunks if c["chunk_type"] == "parent"]
    children = [c for c in chunks if c["chunk_type"] == "child"]

    log.info(f"  {len(parents)} parents, {len(children)} children to embed")

    # Embed children in batches
    embedded_children = []
    batch_texts  = []
    batch_chunks = []

    for chunk in tqdm(children, desc="  Embedding", unit="chunk", leave=False):
        batch_texts.append(chunk["text"])
        batch_chunks.append(chunk)

        if len(batch_texts) >= BATCH_SIZE:
            embeddings = embed_batch(batch_texts)
            for c, emb in zip(batch_chunks, embeddings):
                embedded_children.append({**c, "embedding": emb})
            batch_texts  = []
            batch_chunks = []
            time.sleep(RATE_LIMIT_DELAY)

    # Handle remaining chunks that didn't fill a full batch
    if batch_texts:
        embeddings = embed_batch(batch_texts)
        for c, emb in zip(batch_chunks, embeddings):
            embedded_children.append({**c, "embedding": emb})

    return {
        "parents":  parents,
        "children": embedded_children,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

def run(filter_jurisdiction: Optional[str] = None) -> None:
    chunk_files = sorted(CHUNKS_DIR.glob("*_chunks.json"))
    if not chunk_files:
        log.error(f"No chunk files found in {CHUNKS_DIR}. Run chunker first.")
        return

    total_embedded = 0
    total_parents  = 0

    for chunks_path in chunk_files:
        # Derive jurisdiction from filename by loading first chunk
        with open(chunks_path) as f:
            first_chunk = json.load(f)[0]

        if filter_jurisdiction and first_chunk.get("jurisdiction") != filter_jurisdiction:
            continue

        # Skip if already embedded
        out_path = EMBEDDED_DIR / chunks_path.name.replace("_chunks.json", "_embedded.json")
        if out_path.exists():
            log.info(f"Skipping (already embedded): {chunks_path.name}")
            continue

        log.info(f"Embedding: {chunks_path.name}")

        result = embed_chunks_file(chunks_path)

        # Save embedded output
        out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))

        n_children = len(result["children"])
        n_parents  = len(result["parents"])
        log.info(f"  Saved: {out_path.name} ({n_children} embedded, {n_parents} parents)")

        total_embedded += n_children
        total_parents  += n_parents

    print("\n" + "─" * 50)
    print(f"Embedding complete:")
    print(f"  Total children embedded : {total_embedded}")
    print(f"  Total parents stored    : {total_parents}")
    print(f"  Output saved to         : {EMBEDDED_DIR}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Embed child chunks via Azure OpenAI")
    parser.add_argument("--source", type=str, default=None,
                        help="Filter by jurisdiction (e.g. uscis, irs, dol)")
    args = parser.parse_args()
    run(filter_jurisdiction=args.source)