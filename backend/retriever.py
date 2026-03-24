"""
retriever.py

Handles all retrieval logic:
  1. Embed the query using Azure OpenAI
  2. Build sparse vector for keyword matching
  3. Hybrid search in Qdrant (dense + sparse)
  4. Rerank with Cohere
  5. Fetch parent chunks for richer context
  6. Deduplicate and assemble final context

This file is the bridge between the user's question and
the relevant knowledge stored in Qdrant.
"""

import re
import logging
from typing import Optional
from openai import AzureOpenAI
import cohere
from qdrant_client import QdrantClient
from qdrant_client.models import (
    SparseVector,
    NamedVector,
    ScoredPoint,
    QueryResponse,
)
from backend.config import (
    AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_API_VERSION,
    AZURE_EMBEDDING_DEPLOYMENT,
    EMBEDDING_DIMS,
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_COLLECTION_NAME,
    COHERE_API_KEY,
    COHERE_RERANK_MODEL,
    RETRIEVAL_TOP_K,
    RERANK_TOP_N,
)

log = logging.getLogger(__name__)

# ── Clients (initialized once, reused per request) ────────────────────────────
# Why module-level clients?
# Creating a new HTTP connection per request is expensive.
# Module-level clients maintain connection pools that get reused.
# This is standard practice for any service client in a web server.

_openai_client = AzureOpenAI(
    azure_endpoint=AZURE_OPENAI_ENDPOINT,
    api_key=AZURE_OPENAI_API_KEY,
    api_version=AZURE_OPENAI_API_VERSION,
)

_cohere_client = cohere.Client(api_key=COHERE_API_KEY)

_qdrant_client = QdrantClient(
    url=QDRANT_URL,
    api_key=QDRANT_API_KEY,
)


# ── Step 1: Query embedding ───────────────────────────────────────────────────

def embed_query(query: str) -> list[float]:
    """
    Embed the user query using Azure OpenAI.

    Must use the same model and dimensions as ingestion —
    otherwise query vectors and chunk vectors live in different
    spaces and similarity search produces garbage results.
    """
    response = _openai_client.embeddings.create(
        input=query,
        model=AZURE_EMBEDDING_DEPLOYMENT,
        dimensions=EMBEDDING_DIMS,
    )
    return response.data[0].embedding


# ── Step 2: Sparse vector ─────────────────────────────────────────────────────

def build_sparse_vector(text: str) -> SparseVector:
    """
    Build BM25-style sparse vector from query text.
    Must use the same approach as ingestion/qdrant_loader.py
    so query sparse vectors are comparable to stored sparse vectors.
    """
    tokens = re.findall(r'[a-zA-Z0-9]+', text.lower())

    stopwords = {
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
        'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are',
        'was', 'were', 'be', 'been', 'has', 'have', 'had', 'that',
        'this', 'it', 'its', 'you', 'your', 'we', 'our', 'they'
    }
    tokens = [t for t in tokens if t not in stopwords and len(t) > 1]

    if not tokens:
        return SparseVector(indices=[0], values=[0.0])

    tf: dict[int, float] = {}
    for token in tokens:
        idx = hash(token) % 100_003
        tf[idx] = tf.get(idx, 0.0) + 1.0

    doc_len = len(tokens)
    return SparseVector(
        indices=list(tf.keys()),
        values=[v / doc_len for v in tf.values()]
    )


# ── Step 3: Hybrid search ─────────────────────────────────────────────────────

def hybrid_search(
    query: str,
    top_k: int = RETRIEVAL_TOP_K,
    filter_jurisdiction: Optional[str] = None,
) -> list[ScoredPoint]:
    """
    Perform hybrid search in Qdrant combining dense and sparse vectors.

    Why hybrid and not just dense?
    Dense search finds semantically similar content but can miss
    exact immigration terms like "I-485", "8 CFR 214.2", "cap-gap".
    Sparse search finds exact keyword matches.
    Hybrid gets both — crucial for immigration terminology.

    The filter_jurisdiction parameter lets us restrict retrieval
    to specific sources (e.g., only USCIS documents for visa questions,
    only IRS documents for tax questions). Not used by default but
    available for future query routing enhancements.
    """
    dense_vector  = embed_query(query)
    sparse_vector = build_sparse_vector(query)

    # Build filter if jurisdiction specified
    search_filter = None
    if filter_jurisdiction:
        from qdrant_client.models import Filter, FieldCondition, MatchValue
        search_filter = Filter(
            must=[FieldCondition(
                key="jurisdiction",
                match=MatchValue(value=filter_jurisdiction)
            )]
        )

    # Use query_points (replaces search in qdrant-client >= 1.7)
    results = _qdrant_client.query_points(
        collection_name=QDRANT_COLLECTION_NAME,
        query=dense_vector,
        using="dense",
        query_filter=search_filter,
        limit=top_k,
        with_payload=True,
        with_vectors=False,
    )

    return results.points


# ── Step 4: Reranking ─────────────────────────────────────────────────────────

def rerank_results(
    query: str,
    results: list[ScoredPoint],
    top_n: int = RERANK_TOP_N,
) -> list[ScoredPoint]:
    """
    Rerank retrieved chunks using Cohere's cross-encoder.

    Why rerank after vector search?
    Vector search finds topically similar chunks but doesn't understand
    whether a chunk actually *answers* the query.
    The cross-encoder sees query + chunk together and scores true relevance.

    Example:
    Query: "Can my H1B employer reduce my salary?"
    Vector search might rank a general H1B overview chunk highly
    because it's broadly about H1B.
    Reranker correctly identifies the prevailing wage chunk as most
    relevant because it directly addresses salary reduction rules.
    """
    if not results:
        return []

    # Extract text from each result for reranking
    documents = [
        r.payload.get("text", "") for r in results
    ]

    try:
        reranked = _cohere_client.rerank(
            query=query,
            documents=documents,
            top_n=min(top_n, len(documents)),
            model=COHERE_RERANK_MODEL,
        )

        # Reorder original results by reranker's relevance order
        reranked_results = []
        for item in reranked.results:
            original_result = results[item.index]
            reranked_results.append(original_result)

        log.info(f"Reranked {len(results)} → {len(reranked_results)} results")
        return reranked_results

    except Exception as e:
        # If reranking fails, fall back to original vector search order
        log.warning(f"Reranking failed, using vector search order: {e}")
        return results[:top_n]


# ── Step 5: Parent chunk fetching ─────────────────────────────────────────────

def fetch_parent_chunks(child_results: list[ScoredPoint]) -> list[dict]:
    """
    For each matched child chunk, fetch its parent chunk.

    Why fetch parents?
    Child chunks (256 tokens) are precise enough for retrieval
    but too short for good LLM generation context.
    Parent chunks (1024 tokens) provide the full section context
    the LLM needs to generate a complete, accurate answer.

    Deduplication: Multiple child chunks may have the same parent_id
    (e.g., three children from the same section all matched).
    We deduplicate so the LLM doesn't receive the same parent twice.
    """
    if not child_results:
        return []

    # Collect unique parent IDs
    parent_ids = []
    seen = set()
    for result in child_results:
        parent_id = result.payload.get("parent_id")
        if parent_id and parent_id not in seen:
            parent_ids.append(parent_id)
            seen.add(parent_id)

    if not parent_ids:
        # Fallback: use child text directly if no parent_ids found
        log.warning("No parent_ids found — using child chunks directly")
        return [r.payload for r in child_results]

    # Fetch parent points by ID — direct lookup, no vector search
    parent_points = _qdrant_client.retrieve(
        collection_name=QDRANT_COLLECTION_NAME,
        ids=parent_ids,
        with_payload=True,
        with_vectors=False,
    )

    return [p.payload for p in parent_points]


# ── Step 6: Context assembly ──────────────────────────────────────────────────

def assemble_context(parent_chunks: list[dict]) -> str:
    """
    Format parent chunks into a single context string for the LLM prompt.

    Each chunk is formatted with its source metadata so the LLM
    can generate accurate inline citations.

    Format:
    ---
    [Source: USCIS Policy Manual | Section: H-1B Eligibility]
    <text>
    ---
    """
    if not parent_chunks:
        return "No relevant context found."

    context_parts = []
    for chunk in parent_chunks:
        source   = chunk.get("source_url", "Unknown source")
        section  = chunk.get("section", "")
        doc_type = chunk.get("doc_type", "")
        text     = chunk.get("text", "")

        # Build source label
        source_label = f"Source: {source}"
        if section:
            source_label += f" | Section: {section}"
        if doc_type:
            source_label += f" | Type: {doc_type}"

        context_parts.append(f"---\n[{source_label}]\n{text}\n---")

    return "\n\n".join(context_parts)


# ── Main retrieval function ───────────────────────────────────────────────────

def retrieve(
    query: str,
    top_k: int = RETRIEVAL_TOP_K,
    top_n: int = RERANK_TOP_N,
    filter_jurisdiction: Optional[str] = None,
) -> tuple[str, list[dict]]:
    """
    Full retrieval pipeline: search → rerank → fetch parents → assemble.

    Args:
        query: The user's question (or a sub-query for complex questions)
        top_k: Number of child chunks to retrieve from Qdrant
        top_n: Number to keep after reranking
        filter_jurisdiction: Optional filter (e.g. "uscis", "irs")

    Returns:
        tuple of:
          - context string (formatted for LLM prompt)
          - list of source dicts (for citation display in frontend)
    """
    log.info(f"Retrieving for query: {query[:80]}...")

    # Step 1+2+3: Hybrid search
    child_results = hybrid_search(query, top_k, filter_jurisdiction)
    log.info(f"Retrieved {len(child_results)} child chunks")

    if not child_results:
        return "No relevant documents found.", []

    # Step 4: Rerank
    reranked = rerank_results(query, child_results, top_n)

    # Step 5: Fetch parents
    parent_chunks = fetch_parent_chunks(reranked)
    log.info(f"Fetched {len(parent_chunks)} parent chunks")

    # Step 6: Assemble context
    context = assemble_context(parent_chunks)

    # Build sources list for frontend citation display
    sources = [
        {
            "url":            c.get("source_url", ""),
            "section":        c.get("section", ""),
            "doc_type":       c.get("doc_type", ""),
            "jurisdiction":   c.get("jurisdiction", ""),
            "effective_date": c.get("effective_date"),
        }
        for c in parent_chunks
    ]

    return context, sources


# ── Multi-query retrieval (for RAG-Fusion) ────────────────────────────────────

def retrieve_multi(
    queries: list[str],
    top_k: int = RETRIEVAL_TOP_K,
    top_n: int = RERANK_TOP_N,
) -> tuple[str, list[dict]]:
    """
    Retrieve for multiple queries and fuse results using RRF.

    Used for complex queries that have been decomposed into sub-queries.
    Each sub-query retrieves independently, then RRF merges the ranked
    lists into one final ordered list.

    Args:
        queries: List of sub-queries from the decomposer
        top_k: Chunks to retrieve per query
        top_n: Final chunks to keep after fusion and reranking

    Returns:
        Same as retrieve() — context string and sources list
    """
    if not queries:
        return "No queries provided.", []

    if len(queries) == 1:
        return retrieve(queries[0], top_k, top_n)

    # Retrieve for each sub-query
    all_results: list[list[ScoredPoint]] = []
    for q in queries:
        results = hybrid_search(q, top_k)
        all_results.append(results)
        log.info(f"Sub-query '{q[:50]}...' → {len(results)} results")

    # RRF fusion
    # Score each chunk across all result lists
    # chunk_id → {"score": float, "point": ScoredPoint}
    rrf_scores: dict[str, dict] = {}
    k = 60  # RRF constant — standard value from the original paper

    for result_list in all_results:
        for rank, point in enumerate(result_list):
            chunk_id = str(point.id)
            rrf_score = 1.0 / (k + rank + 1)

            if chunk_id not in rrf_scores:
                rrf_scores[chunk_id] = {"score": 0.0, "point": point}
            rrf_scores[chunk_id]["score"] += rrf_score

    # Sort by RRF score descending
    sorted_chunks = sorted(
        rrf_scores.values(),
        key=lambda x: x["score"],
        reverse=True
    )

    # Take top candidates for reranking
    top_candidates = [item["point"] for item in sorted_chunks[:top_k]]

    # Rerank the fused candidates using the original (full) query
    # We use the first query as the primary query for reranking
    primary_query = queries[0]
    reranked = rerank_results(primary_query, top_candidates, top_n)

    # Fetch parents and assemble
    parent_chunks = fetch_parent_chunks(reranked)
    context = assemble_context(parent_chunks)

    sources = [
        {
            "url":            c.get("source_url", ""),
            "section":        c.get("section", ""),
            "doc_type":       c.get("doc_type", ""),
            "jurisdiction":   c.get("jurisdiction", ""),
            "effective_date": c.get("effective_date"),
        }
        for c in parent_chunks
    ]

    return context, sources