"""
chain.py

The main RAG chain — orchestrates the full pipeline:
  1. Classify query complexity (simple vs complex)
  2. Route accordingly (direct retrieval vs decompose + RAG-Fusion)
  3. Retrieve and rerank relevant chunks
  4. Inject context + memory into system prompt
  5. Generate response with Azure OpenAI
  6. Return answer + sources + tokens used

This is the single function the FastAPI endpoint calls.
Everything else in the backend exists to support this.
"""

import logging
from openai import AzureOpenAI
from langchain.memory import ConversationBufferWindowMemory

from backend.config import (
    AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_API_VERSION,
    AZURE_CHAT_DEPLOYMENT,
    AZURE_CLASSIFIER_DEPLOYMENT,
    TEMPERATURE,
    MAX_TOKENS,
    MAX_SUB_QUERIES,
)
from backend.prompts import (
    get_system_prompt,
    CLASSIFIER_PROMPT,
    DECOMPOSITION_PROMPT,
)
from backend.retriever import retrieve, retrieve_multi
from backend.memory import get_memory

log = logging.getLogger(__name__)

# ── LLM client ────────────────────────────────────────────────────────────────
_llm = AzureOpenAI(
    azure_endpoint=AZURE_OPENAI_ENDPOINT,
    api_key=AZURE_OPENAI_API_KEY,
    api_version=AZURE_OPENAI_API_VERSION,
)


# ── Step 1: Complexity classifier ─────────────────────────────────────────────

def classify_query(query: str) -> str:
    """
    Classify query as 'simple' or 'complex' using a lightweight LLM call.

    Uses the cheaper/faster classifier model (gpt-4o-mini) — not the
    full generation model. This saves tokens since classification is
    a simple routing decision, not a knowledge task.

    Returns: "simple" or "complex"
    """
    prompt = CLASSIFIER_PROMPT.format(query=query)
    try:
        response = _llm.chat.completions.create(
            model=AZURE_CLASSIFIER_DEPLOYMENT,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,    # fully deterministic for routing
            max_tokens=5,       # we only need one word back
        )
        result = response.choices[0].message.content.strip().lower()
        # Sanitize — only accept exactly "simple" or "complex"
        return "complex" if "complex" in result else "simple"
    except Exception as e:
        # If classifier fails, default to simple — safer than crashing
        log.warning(f"Classifier failed, defaulting to simple: {e}")
        return "simple"


# ── Step 2: Query decomposition ───────────────────────────────────────────────

def decompose_query(query: str, n: int = MAX_SUB_QUERIES) -> list[str]:
    """
    Break a complex query into n focused sub-queries.

    Each sub-query is independently retrievable and covers
    a different aspect of the original question.

    Returns: list of sub-query strings
    """
    prompt = DECOMPOSITION_PROMPT.format(query=query, n=n)
    try:
        response = _llm.chat.completions.create(
            model=AZURE_CLASSIFIER_DEPLOYMENT,  # use mini model here too
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=300,
        )
        raw = response.choices[0].message.content.strip()

        # Parse one sub-query per line, filter empty lines
        sub_queries = [
            line.strip()
            for line in raw.split("\n")
            if line.strip() and len(line.strip()) > 10
        ]

        # Always include original query as first entry
        # This ensures the primary intent is always retrieved
        if query not in sub_queries:
            sub_queries.insert(0, query)

        log.info(f"Decomposed into {len(sub_queries)} sub-queries")
        return sub_queries[:n + 1]  # cap at n+1 (n sub-queries + original)

    except Exception as e:
        log.warning(f"Decomposition failed, using original query: {e}")
        return [query]


# ── Step 3: Format chat history ───────────────────────────────────────────────

def format_chat_history(memory: ConversationBufferWindowMemory) -> str:
    """
    Format LangChain memory into a string for the system prompt.

    Converts message objects into a readable conversation format
    that the LLM can understand as prior context.
    """
    messages = memory.chat_memory.messages
    if not messages:
        return "No previous conversation."

    formatted = []
    for msg in messages:
        role = "User" if msg.type == "human" else "Assistant"
        formatted.append(f"{role}: {msg.content}")

    return "\n".join(formatted)


# ── Step 4+5: Generate response ───────────────────────────────────────────────

def generate_response(
    query: str,
    context: str,
    chat_history: str,
    mode: str,
) -> tuple[str, int]:
    """
    Generate the final response using the full LLM with context injected.

    Fills in the system prompt template with:
    - {context}: assembled parent chunks from retrieval
    - {chat_history}: formatted conversation history

    Returns:
        tuple of (answer_text, tokens_used)
    """
    system_prompt = get_system_prompt(mode).format(
        context=context,
        chat_history=chat_history,
    )

    response = _llm.chat.completions.create(
        model=AZURE_CHAT_DEPLOYMENT,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": query},
        ],
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
    )

    answer      = response.choices[0].message.content
    tokens_used = response.usage.total_tokens

    return answer, tokens_used


# ── Main chain function ───────────────────────────────────────────────────────

def run_chain(
    message: str,
    session_id: str,
    mode: str = "student",
) -> dict:
    """
    Run the full RAG chain for a user message.

    This is the single function called by the FastAPI endpoint.
    Handles the complete pipeline from raw user message to
    structured response with citations.

    Args:
        message:    The user's question
        session_id: UUID identifying the chat session (from frontend)
        mode:       "student" or "professional"

    Returns:
        dict with keys:
          - answer:      the LLM's response text
          - sources:     list of source dicts for citation display
          - complexity:  "simple" or "complex" (for debugging/analytics)
          - tokens_used: total tokens consumed (for monitoring)
    """
    log.info(f"Chain invoked | session={session_id[:8]} | mode={mode}")
    log.info(f"Query: {message[:100]}...")

    # ── Get session memory ────────────────────────────────────────────────────
    memory       = get_memory(session_id)
    chat_history = format_chat_history(memory)

    # ── Step 1: Classify complexity ───────────────────────────────────────────
    complexity = classify_query(message)
    log.info(f"Complexity: {complexity}")

    # ── Step 2: Route and retrieve ────────────────────────────────────────────
    if complexity == "simple":
        # Direct single-query retrieval
        context, sources = retrieve(message)
    else:
        # Decompose into sub-queries → RAG-Fusion
        sub_queries = decompose_query(message)
        log.info(f"Sub-queries: {sub_queries}")
        context, sources = retrieve_multi(sub_queries)

    # ── Step 3: Generate response ─────────────────────────────────────────────
    answer, tokens_used = generate_response(
        query=message,
        context=context,
        chat_history=chat_history,
        mode=mode,
    )

    # ── Step 4: Save to memory ────────────────────────────────────────────────
    # Store this turn so follow-up questions have context
    memory.save_context(
        inputs={"input": message},
        outputs={"answer": answer},
    )

    log.info(f"Response generated | tokens={tokens_used} | sources={len(sources)}")

    return {
        "answer":     answer,
        "sources":    sources,
        "complexity": complexity,
        "tokens_used": tokens_used,
    }