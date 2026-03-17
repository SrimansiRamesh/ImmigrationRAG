"""
chunker.py

Splits parsed JSON documents into hierarchical parent-child chunks.
Saves output to data/chunks/ as JSON files.

Key design:
  - Child chunks (256 tokens) → embedded and indexed in Qdrant
  - Parent chunks (1024 tokens) → fetched at query time for LLM context
  - Each child knows its parent_id so we can fetch the parent at retrieval time
  - Tables are never split — always kept as atomic chunks
  - Section headers are preserved as metadata on every chunk

Usage:
    python ingestion/chunker.py
    python ingestion/chunker.py --source uscis
"""

import os
import json
import uuid
import logging
import argparse
import re
from pathlib import Path
from typing import Optional

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT        = Path(__file__).parent.parent
PARSED_DIR  = ROOT / "data" / "parsed"
CHUNKS_DIR  = ROOT / "data" / "chunks"

CHUNKS_DIR.mkdir(parents=True, exist_ok=True)

# ── Chunk size config ─────────────────────────────────────────────────────────
# Measured in approximate tokens (1 token ≈ 4 chars in English)
# These are the empirically established defaults — tune in Phase 4 with RAGAS
PARENT_TOKENS  = 1024
CHILD_TOKENS   = 256
OVERLAP_TOKENS = 32   # overlap between consecutive chunks to preserve context

CHARS_PER_TOKEN = 4   # rough approximation
PARENT_CHARS    = PARENT_TOKENS * CHARS_PER_TOKEN   # 4096 chars
CHILD_CHARS     = CHILD_TOKENS  * CHARS_PER_TOKEN   # 1024 chars
OVERLAP_CHARS   = OVERLAP_TOKENS * CHARS_PER_TOKEN  # 128 chars


# ── Text splitting ────────────────────────────────────────────────────────────

def split_into_sentences(text: str) -> list[str]:
    """
    Split text into sentences, respecting common abbreviations.

    Why not just split on '.'?
    Legal/government text is full of "e.g.", "i.e.", "8 C.F.R.", "U.S.C."
    A naive '.' split destroys these. We use a regex that looks for
    sentence-ending punctuation followed by whitespace and a capital letter.
    """
    # Split on sentence boundaries but keep the delimiter
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    return [s.strip() for s in sentences if s.strip()]


def split_on_paragraphs(text: str) -> list[str]:
    """
    Split text on double newlines (paragraph boundaries).
    More reliable than sentence splitting for structured gov docs.
    """
    paragraphs = re.split(r'\n\n+', text)
    return [p.strip() for p in paragraphs if p.strip()]


def is_table_block(text: str) -> bool:
    """Check if a text block is a table (wrapped in our [TABLE] markers)."""
    return text.strip().startswith("[TABLE]")


def split_text_into_chunks(text: str, max_chars: int, overlap_chars: int) -> list[str]:
    """
    Split text into chunks of max_chars with overlap_chars overlap.

    Strategy:
    1. Try to split on paragraph boundaries first (preserves semantic units)
    2. If a paragraph is too long, fall back to sentence splitting
    3. Accumulate until we hit max_chars, then start a new chunk
       with overlap from the previous chunk

    Why overlap?
    Without overlap, a sentence that straddles a chunk boundary is split.
    The first chunk ends mid-thought, the second starts mid-context.
    Overlap means both chunks contain the boundary content — at the cost
    of some redundancy, which is acceptable.
    """
    if not text:
        return []

    # Separate table blocks first — they're never split
    parts = re.split(r'(\[TABLE\].*?\[/TABLE\])', text, flags=re.DOTALL)

    chunks = []
    current_chunk = ""

    for part in parts:
        if is_table_block(part):
            # Flush current chunk if non-empty
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
                current_chunk = ""
            # Table is always its own atomic chunk
            chunks.append(part.strip())
            continue

        # Split non-table text into paragraphs
        paragraphs = split_on_paragraphs(part)

        for para in paragraphs:
            if len(para) > max_chars:
                # Paragraph itself is too long — split into sentences
                sentences = split_into_sentences(para)
                for sent in sentences:
                    if len(current_chunk) + len(sent) + 1 <= max_chars:
                        current_chunk += (" " if current_chunk else "") + sent
                    else:
                        if current_chunk.strip():
                            chunks.append(current_chunk.strip())
                        # Start new chunk with overlap from previous
                        overlap = current_chunk[-overlap_chars:] if current_chunk else ""
                        current_chunk = overlap + " " + sent if overlap else sent
            else:
                if len(current_chunk) + len(para) + 2 <= max_chars:
                    current_chunk += ("\n\n" if current_chunk else "") + para
                else:
                    if current_chunk.strip():
                        chunks.append(current_chunk.strip())
                    overlap = current_chunk[-overlap_chars:] if current_chunk else ""
                    current_chunk = overlap + "\n\n" + para if overlap else para

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks


# ── Section header tracking ───────────────────────────────────────────────────

def extract_current_section(text: str, known_sections: list[str]) -> str:
    """
    Find which section heading is most relevant to a chunk of text.

    We do this by checking if any known section heading appears in the
    chunk or immediately precedes it. Falls back to "General" if none found.

    Why this matters for RAG:
    A chunk saying "The fee is $730" is ambiguous.
    A chunk saying "The fee is $730" with section="H-1B Filing Fees"
    gives the LLM the context it needs to answer correctly.
    """
    for section in reversed(known_sections):  # reversed = most recent first
        if section.lower() in text.lower():
            return section
    return known_sections[0] if known_sections else "General"


# ── Main chunking logic ───────────────────────────────────────────────────────

def chunk_document(parsed: dict) -> list[dict]:
    """
    Takes a parsed document dict and returns a list of chunk dicts.

    Each chunk dict has:
      - chunk_id      : unique UUID for this chunk
      - parent_id     : UUID of parent chunk (None if this IS a parent)
      - chunk_type    : "parent" or "child"
      - text          : the actual text content
      - source_url    : from original document
      - doc_type      : from original document
      - topic_tags    : from original document
      - jurisdiction  : from original document
      - effective_date: from original document
      - section       : nearest section heading
      - is_table      : whether this chunk is a table
      - char_count    : length of text
    """
    content  = parsed.get("content", "")
    sections = parsed.get("sections", ["General"])
    metadata = {
        "source_url":    parsed.get("source_url", ""),
        "doc_type":      parsed.get("doc_type", "unknown"),
        "topic_tags":    parsed.get("topic_tags", []),
        "jurisdiction":  parsed.get("jurisdiction", "unknown"),
        "effective_date": parsed.get("effective_date", 20240101),
    }

    if not content:
        log.warning(f"  Empty content in {parsed.get('filename', '?')} — skipping")
        return []

    all_chunks = []

    # ── Step 1: Create parent chunks ──────────────────────────────────────────
    parent_texts = split_text_into_chunks(content, PARENT_CHARS, OVERLAP_CHARS)

    for parent_text in parent_texts:
        parent_id   = str(uuid.uuid4())
        is_tbl      = is_table_block(parent_text)
        section     = extract_current_section(parent_text, sections)

        parent_chunk = {
            "chunk_id":    parent_id,
            "parent_id":   None,       # parents have no parent
            "chunk_type":  "parent",
            "text":        parent_text,
            "section":     section,
            "is_table":    is_tbl,
            "char_count":  len(parent_text),
            **metadata,
        }
        all_chunks.append(parent_chunk)

        # ── Step 2: Create child chunks from each parent ───────────────────
        # Tables don't get child-chunked — the table IS the atomic unit
        if is_tbl:
            # Table becomes its own child pointing to itself as parent
            # This way retrieval always returns the full table
            child_chunk = {
                "chunk_id":   str(uuid.uuid4()),
                "parent_id":  parent_id,
                "chunk_type": "child",
                "text":       parent_text,
                "section":    section,
                "is_table":   True,
                "char_count": len(parent_text),
                **metadata,
            }
            all_chunks.append(child_chunk)
            continue

        # Regular text: split parent into child chunks
        child_texts = split_text_into_chunks(parent_text, CHILD_CHARS, OVERLAP_CHARS)

        for child_text in child_texts:
            if len(child_text) < 50:
                # Skip tiny fragments — they make terrible embeddings
                continue

            child_chunk = {
                "chunk_id":   str(uuid.uuid4()),
                "parent_id":  parent_id,
                "chunk_type": "child",
                "text":       child_text,
                "section":    extract_current_section(child_text, sections),
                "is_table":   False,
                "char_count": len(child_text),
                **metadata,
            }
            all_chunks.append(child_chunk)

    return all_chunks


# ── Entry point ───────────────────────────────────────────────────────────────

def run(filter_jurisdiction: Optional[str] = None) -> None:
    parsed_files = list(PARSED_DIR.glob("*.json"))
    if not parsed_files:
        log.error(f"No parsed files found in {PARSED_DIR}. Run parser first.")
        return

    total_parents = 0
    total_children = 0
    total_tables = 0

    for parsed_path in sorted(parsed_files):
        with open(parsed_path) as f:
            parsed = json.load(f)

        # Filter by jurisdiction if flag passed
        if filter_jurisdiction and parsed.get("jurisdiction") != filter_jurisdiction:
            continue

        # Skip if already chunked
        out_path = CHUNKS_DIR / (parsed_path.stem + "_chunks.json")
        if out_path.exists():
            log.info(f"  Skipping (already chunked): {parsed_path.name}")
            continue

        log.info(f"Chunking: {parsed_path.name}")
        chunks = chunk_document(parsed)

        if not chunks:
            log.warning(f"  No chunks produced for {parsed_path.name}")
            continue

        # Save all chunks for this document
        out_path.write_text(json.dumps(chunks, indent=2, ensure_ascii=False))

        parents  = sum(1 for c in chunks if c["chunk_type"] == "parent")
        children = sum(1 for c in chunks if c["chunk_type"] == "child")
        tables   = sum(1 for c in chunks if c["is_table"])

        log.info(f"  {parents} parents, {children} children, {tables} tables → {out_path.name}")

        total_parents  += parents
        total_children += children
        total_tables   += tables

    print("\n" + "─" * 50)
    print(f"Chunking complete:")
    print(f"  Total parent chunks : {total_parents}")
    print(f"  Total child chunks  : {total_children}")
    print(f"  Total table chunks  : {total_tables}")
    print(f"  Total chunks        : {total_parents + total_children}")
    print(f"  Chunks saved to     : {CHUNKS_DIR}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Chunk parsed documents")
    parser.add_argument("--source", type=str, default=None,
                        help="Filter by jurisdiction (e.g. uscis, irs, dol)")
    args = parser.parse_args()
    run(filter_jurisdiction=args.source)