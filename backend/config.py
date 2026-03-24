"""
config.py

Central configuration for the backend.
All environment variables and model parameters live here.
Every other backend file imports from this module.

Why centralize config?
- Change a model name in one place, not five files
- Easy to see all tuneable parameters at a glance
- Prevents hardcoded strings scattered across files
- Makes switching between dev/prod environments clean
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Azure OpenAI ──────────────────────────────────────────────────────────────
AZURE_OPENAI_ENDPOINT    = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_API_KEY     = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")

# Generation model (Phase 2) — using Gemini via Google AI
GEMINI_API_KEY           = os.getenv("GEMINI_API_KEY")
GEMINI_CHAT_MODEL        = os.getenv("GEMINI_CHAT_MODEL", "gemini-2.5-flash")
GEMINI_CLASSIFIER_MODEL  = os.getenv("GEMINI_CLASSIFIER_MODEL", "gemini-2.5-flash-lite")

# Embedding model (used in retriever to embed queries)
AZURE_EMBEDDING_DEPLOYMENT = os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large")
EMBEDDING_DIMS             = 1536   # must match what we used in ingestion

# ── Qdrant ────────────────────────────────────────────────────────────────────
QDRANT_URL             = os.getenv("QDRANT_URL")
QDRANT_API_KEY         = os.getenv("QDRANT_API_KEY")
QDRANT_COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "immigration_docs")

# ── Cohere ────────────────────────────────────────────────────────────────────
COHERE_API_KEY         = os.getenv("COHERE_API_KEY")
COHERE_RERANK_MODEL    = "rerank-english-v3.0"

# ── Retrieval parameters ──────────────────────────────────────────────────────
# How many child chunks to retrieve from Qdrant before reranking
# We cast a wide net first (20), then reranker narrows it down to top 5
RETRIEVAL_TOP_K  = 20

# How many chunks to keep after reranking and send to the LLM
RERANK_TOP_N     = 5

# Number of sub-queries to generate for complex questions
MAX_SUB_QUERIES  = 3

# ── LLM generation parameters ────────────────────────────────────────────────
# temperature=0 → deterministic, factual responses
# For immigration/legal content we want consistency, not creativity
TEMPERATURE      = 0.0
MAX_TOKENS       = 16384

# ── Memory ────────────────────────────────────────────────────────────────────
# How many conversation turns to keep in session memory
# k=10 means last 10 exchanges (10 user messages + 10 assistant responses)
MEMORY_K         = 10

# ── Validation ────────────────────────────────────────────────────────────────
def validate_config() -> None:
    """
    Check all required environment variables are set.
    Called once at server startup — fails fast before any requests are served.
    """
    required = {
        "AZURE_OPENAI_ENDPOINT":    AZURE_OPENAI_ENDPOINT,
        "AZURE_OPENAI_API_KEY":     AZURE_OPENAI_API_KEY,
        "QDRANT_URL":               QDRANT_URL,
        "QDRANT_API_KEY":           QDRANT_API_KEY,
        "COHERE_API_KEY":           COHERE_API_KEY,
        "GEMINI_API_KEY":           GEMINI_API_KEY,
    }
    missing = [k for k, v in required.items() if not v]
    if missing:
        raise EnvironmentError(
            f"Missing required environment variables: {', '.join(missing)}\n"
            f"Check your .env file."
        )