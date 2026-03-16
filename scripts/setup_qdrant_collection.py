"""
setup_qdrant_collection.py

Run this ONCE before ingestion to create the Qdrant collection.
Think of this as CREATE TABLE — defines the schema for all vectors.

Usage:
    python scripts/setup_qdrant_collection.py
"""

import os
import sys
from dotenv import load_dotenv
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams,
    Distance,
    SparseVectorParams,
    SparseIndexParams,
    PayloadSchemaType,
)

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────

QDRANT_URL        = os.getenv("QDRANT_URL")
QDRANT_API_KEY    = os.getenv("QDRANT_API_KEY")
COLLECTION_NAME   = os.getenv("QDRANT_COLLECTION_NAME", "immigration_docs")

# Must match the embedding model's output dimension.
# text-embedding-3-large → 3072 dims by default.
# We use 1536 (truncated) — same quality, half the storage cost.
# Azure OpenAI lets you specify `dimensions=1536` in the API call.
DENSE_DIM = 1536

# ── Client ────────────────────────────────────────────────────────────────────

def get_client() -> QdrantClient:
    if not QDRANT_URL or not QDRANT_API_KEY:
        print("ERROR: QDRANT_URL or QDRANT_API_KEY missing from .env")
        sys.exit(1)
    return QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)


# ── Collection setup ──────────────────────────────────────────────────────────

def create_collection(client: QdrantClient) -> None:
    existing = [c.name for c in client.get_collections().collections]

    if COLLECTION_NAME in existing:
        print(f"Collection '{COLLECTION_NAME}' already exists — skipping creation.")
        print("If you want to recreate it, run with --recreate flag.")
        return

    print(f"Creating collection '{COLLECTION_NAME}'...")

    client.create_collection(
        collection_name=COLLECTION_NAME,

        # Dense vectors — used for semantic similarity search.
        # Named "dense" so we can reference it explicitly in hybrid queries.
        vectors_config={
            "dense": VectorParams(
                size=DENSE_DIM,
                distance=Distance.COSINE,  # cosine similarity is standard for text embeddings
            )
        },

        # Sparse vectors — used for BM25 keyword search.
        # Qdrant computes these internally; we just declare the config.
        # Named "sparse" to reference in hybrid queries alongside "dense".
        sparse_vectors_config={
            "sparse": SparseVectorParams(
                index=SparseIndexParams(
                    on_disk=False  # keep in RAM for speed on free tier
                )
            )
        },
    )
    print(f"Collection '{COLLECTION_NAME}' created.")


def create_payload_indexes(client: QdrantClient) -> None:
    """
    Create indexes on metadata fields we'll filter by at query time.

    Why this matters: without indexes, filtering scans every vector.
    With indexes, Qdrant can pre-filter before doing vector search —
    much faster at scale.

    We'll filter by:
    - doc_type: e.g. "policy_manual", "tax_guide", "visa_bulletin"
    - topic_tag: e.g. "h1b", "f1_opt", "tax_treaty"
    - jurisdiction: e.g. "federal", "uscis", "irs"
    """
    print("Creating payload indexes...")

    indexes = [
        ("doc_type",    PayloadSchemaType.KEYWORD),
        ("topic_tag",   PayloadSchemaType.KEYWORD),
        ("jurisdiction",PayloadSchemaType.KEYWORD),
        ("source_url",  PayloadSchemaType.KEYWORD),
        # effective_date as integer (YYYYMMDD) so we can do range filters
        # e.g. "only use docs effective after 20230101"
        ("effective_date", PayloadSchemaType.INTEGER),
    ]

    for field, schema_type in indexes:
        client.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name=field,
            field_schema=schema_type,
        )
        print(f"  Index created: {field} ({schema_type})")


def verify_collection(client: QdrantClient) -> None:
    """Print collection info so we can visually confirm the setup."""
    info = client.get_collection(COLLECTION_NAME)
    points = getattr(info, "points_count", None) or getattr(info, "vectors_count", 0)
    print("\nCollection info:")
    print(f"  Name:           {COLLECTION_NAME}")
    print(f"  Status:         {info.status}")
    print(f"  Points count:   {points}")
    print(f"  Dense dim:      {info.config.params.vectors['dense'].size}")
    print(f"  Distance:       {info.config.params.vectors['dense'].distance}")


# ── Recreate helper (optional) ────────────────────────────────────────────────

def recreate_collection(client: QdrantClient) -> None:
    """
    Deletes and recreates the collection from scratch.
    Use this during development when you want a clean slate.
    DESTRUCTIVE — all vectors are lost.
    """
    print(f"WARNING: Deleting collection '{COLLECTION_NAME}'...")
    client.delete_collection(COLLECTION_NAME)
    print("Deleted.")
    create_collection(client)
    create_payload_indexes(client)
    verify_collection(client)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    recreate = "--recreate" in sys.argv

    client = get_client()

    if recreate:
        recreate_collection(client)
    else:
        create_collection(client)
        create_payload_indexes(client)
        verify_collection(client)

    print("\nSetup complete.")