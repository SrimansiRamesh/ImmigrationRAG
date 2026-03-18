"""
qdrant_loader.py

Uploads embedded chunks to Qdrant Cloud.

Children → uploaded with dense vector + sparse vector + full payload
Parents  → uploaded with NO vector, just payload (fetched by ID at query time)

Why upload parents at all if they have no vector?
Because at query time we need to fetch parent text by parent_id.
Qdrant lets us store and retrieve points by ID even without a vector.
Think of it like a lookup table sitting alongside the vector index.

Usage:
    python ingestion/qdrant_loader.py
    python ingestion/qdrant_loader.py --source uscis
"""

import os
import json
import time
import logging
import argparse
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from tqdm import tqdm

from qdrant_client import QdrantClient
from qdrant_client.models import (
    PointStruct,
    SparseVector,
    NamedVector,
    NamedSparseVector,
    VectorParams,
    Distance,
)

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT         = Path(__file__).parent.parent
EMBEDDED_DIR = ROOT / "data" / "embedded"

# ── Qdrant config ─────────────────────────────────────────────────────────────
QDRANT_URL       = os.getenv("QDRANT_URL")
QDRANT_API_KEY   = os.getenv("QDRANT_API_KEY")
COLLECTION_NAME  = os.getenv("QDRANT_COLLECTION_NAME", "immigration_docs")

# Upload in batches of 64 points at a time
# Why batch? Uploading one point at a time = 1280 HTTP requests
# Batching = ~20 requests. Much faster, less network overhead.
UPLOAD_BATCH_SIZE = 64


# ── Sparse vector generation ──────────────────────────────────────────────────

def build_sparse_vector(text: str) -> SparseVector:
    """
    Build a simple BM25-style sparse vector from text.

    In a full production system you'd use Qdrant's built-in sparse
    encoder or FastEmbed. For our purposes we build a simple TF
    (term frequency) sparse vector — good enough for keyword matching.

    Why sparse vectors at all?
    Dense vectors capture semantic meaning but miss exact keyword matches.
    If a user types "I-485" or "8 CFR 214.2", dense search might miss it
    because the embedding averages out the meaning. Sparse vectors do
    exact/near-exact term matching — critical for immigration terminology.

    The sparse vector is a dict of {token_id: weight} where:
    - token_id = hash of the word (mod large prime to avoid collisions)
    - weight   = term frequency (how often the word appears)
    """
    # Simple tokenization — lowercase, split on non-alphanumeric
    import re
    tokens = re.findall(r'[a-zA-Z0-9]+', text.lower())

    # Remove very common stopwords that add noise
    stopwords = {
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
        'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are',
        'was', 'were', 'be', 'been', 'has', 'have', 'had', 'that',
        'this', 'it', 'its', 'you', 'your', 'we', 'our', 'they'
    }
    tokens = [t for t in tokens if t not in stopwords and len(t) > 1]

    if not tokens:
        # Return minimal sparse vector if no tokens
        return SparseVector(indices=[0], values=[0.0])

    # Count term frequencies
    tf: dict[int, float] = {}
    for token in tokens:
        # Hash token to an integer index
        # Using a large prime modulus reduces collision probability
        idx = hash(token) % 100_003
        tf[idx] = tf.get(idx, 0.0) + 1.0

    # Normalize by document length (standard TF normalization)
    doc_len = len(tokens)
    indices = list(tf.keys())
    values  = [v / doc_len for v in tf.values()]

    return SparseVector(indices=indices, values=values)


# ── Point builders ────────────────────────────────────────────────────────────

def build_child_point(chunk: dict) -> PointStruct:
    """
    Build a Qdrant point for a child chunk.
    Has both dense and sparse vectors for hybrid search.
    """
    embedding = chunk.get("embedding", [])
    if not embedding:
        raise ValueError(f"Child chunk {chunk['chunk_id']} has no embedding")

    sparse = build_sparse_vector(chunk["text"])

    return PointStruct(
        id=chunk["chunk_id"],
        vector={
            "dense":  embedding,       # from Azure OpenAI
            "sparse": sparse,          # BM25-style keyword vector
        },
        payload={
            "chunk_id":     chunk["chunk_id"],
            "parent_id":    chunk["parent_id"],
            "chunk_type":   "child",
            "text":         chunk["text"],
            "section":      chunk.get("section", ""),
            "is_table":     chunk.get("is_table", False),
            "source_url":   chunk.get("source_url", ""),
            "doc_type":     chunk.get("doc_type", ""),
            "topic_tags":   chunk.get("topic_tags", []),
            "jurisdiction": chunk.get("jurisdiction", ""),
            "effective_date": chunk.get("effective_date", 0),
        }
    )


def build_parent_point(chunk: dict) -> PointStruct:
    """
    Build a Qdrant point for a parent chunk.
    No vectors — only payload. Retrieved by ID, never by similarity search.
    """
    return PointStruct(
        id=chunk["chunk_id"],
        vector={},          # empty — parents are not searchable by vector
        payload={
            "chunk_id":     chunk["chunk_id"],
            "parent_id":    None,
            "chunk_type":   "parent",
            "text":         chunk["text"],
            "section":      chunk.get("section", ""),
            "is_table":     chunk.get("is_table", False),
            "source_url":   chunk.get("source_url", ""),
            "doc_type":     chunk.get("doc_type", ""),
            "topic_tags":   chunk.get("topic_tags", []),
            "jurisdiction": chunk.get("jurisdiction", ""),
            "effective_date": chunk.get("effective_date", 0),
        }
    )


# ── Upload logic ──────────────────────────────────────────────────────────────

def upload_points(client: QdrantClient, points: list[PointStruct]) -> None:
    """
    Upload a list of points to Qdrant in batches.
    Retries once on failure before raising.
    """
    for i in range(0, len(points), UPLOAD_BATCH_SIZE):
        batch = points[i:i + UPLOAD_BATCH_SIZE]
        for attempt in range(1, 3):
            try:
                client.upsert(
                    collection_name=COLLECTION_NAME,
                    points=batch,
                    wait=True,   # wait for indexing before returning
                )
                break
            except Exception as e:
                if attempt == 2:
                    log.error(f"Upload failed after 2 attempts: {e}")
                    raise
                log.warning(f"Upload attempt {attempt} failed: {e} — retrying")
                time.sleep(2)


def load_embedded_file(
    client: QdrantClient,
    embedded_path: Path,
) -> tuple[int, int]:
    """
    Load one embedded JSON file and upload all its points to Qdrant.
    Returns (n_children_uploaded, n_parents_uploaded).
    """
    with open(embedded_path) as f:
        data = json.load(f)

    parents  = data.get("parents", [])
    children = data.get("children", [])

    # Build and upload child points (have vectors)
    child_points = []
    for chunk in tqdm(children, desc="  Building child points", leave=False):
        try:
            child_points.append(build_child_point(chunk))
        except ValueError as e:
            log.warning(f"  Skipping child chunk: {e}")

    if child_points:
        log.info(f"  Uploading {len(child_points)} child points...")
        upload_points(client, child_points)

    # Build and upload parent points (no vectors)
    parent_points = [build_parent_point(p) for p in parents]
    if parent_points:
        log.info(f"  Uploading {len(parent_points)} parent points...")
        upload_points(client, parent_points)

    return len(child_points), len(parent_points)


# ── Entry point ───────────────────────────────────────────────────────────────

def run(filter_jurisdiction: Optional[str] = None) -> None:
    client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)

    # Verify collection exists
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION_NAME not in collections:
        log.error(f"Collection '{COLLECTION_NAME}' not found. Run setup_qdrant_collection.py first.")
        return

    embedded_files = sorted(EMBEDDED_DIR.glob("*_embedded.json"))
    if not embedded_files:
        log.error(f"No embedded files found in {EMBEDDED_DIR}. Run embedder.py first.")
        return

    total_children = 0
    total_parents  = 0

    for embedded_path in embedded_files:
        # Check jurisdiction filter
        with open(embedded_path) as f:
            data = json.load(f)
        all_chunks = data.get("children", []) + data.get("parents", [])
        if not all_chunks:
            continue

        jurisdiction = all_chunks[0].get("jurisdiction", "")
        if filter_jurisdiction and jurisdiction != filter_jurisdiction:
            continue

        log.info(f"Loading: {embedded_path.name}")
        n_children, n_parents = load_embedded_file(client, embedded_path)
        total_children += n_children
        total_parents  += n_parents
        log.info(f"  Done: {n_children} children + {n_parents} parents uploaded")

    # Final verification — check Qdrant point count
    info = client.get_collection(COLLECTION_NAME)
    points_count = getattr(info, "points_count", None) or 0

    print("\n" + "─" * 50)
    print(f"Upload complete:")
    print(f"  Children uploaded : {total_children}")
    print(f"  Parents uploaded  : {total_parents}")
    print(f"  Total uploaded    : {total_children + total_parents}")
    print(f"  Qdrant points     : {points_count}")
    print(f"  Collection        : {COLLECTION_NAME}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload embedded chunks to Qdrant")
    parser.add_argument("--source", type=str, default=None,
                        help="Filter by jurisdiction (e.g. uscis, irs, dol)")
    args = parser.parse_args()
    run(filter_jurisdiction=args.source)