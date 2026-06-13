"""
chain.py

The main RAG chain — orchestrates the full pipeline:
  1. Classify query complexity (simple vs complex)
  2. Route accordingly (direct retrieval vs decompose + RAG-Fusion)
  3. Retrieve and rerank relevant chunks
  4. Inject context + memory into system prompt
  5. Generate response with Azure OpenAI
  6. Return answer + sources + context + tokens used

This is the single function the FastAPI endpoint calls.
Everything else in the backend exists to support this.
"""

import logging
from langchain.memory import ConversationBufferWindowMemory
from openai import AsyncAzureOpenAI
from typing import Optional

import config
from config import MAX_SUB_QUERIES
from prompts import (
    get_system_prompt,
    CLASSIFIER_PROMPT,
    DECOMPOSITION_PROMPT,
)
from retriever import retrieve, retrieve_multi
from memory import get_memory

log = logging.getLogger(__name__)

# ── Azure OpenAI chat client ──────────────────────────────────────────────────
chat_client = AsyncAzureOpenAI(
    azure_endpoint=config.AZURE_OPENAI_CHAT_ENDPOINT,
    api_key=config.AZURE_OPENAI_CHAT_API_KEY,
    api_version=config.AZURE_OPENAI_CHAT_API_VERSION,
)


async def _chat_call(prompt: str, max_tokens: int) -> str:
    """
    Single-prompt Azure OpenAI chat completion.
    Used by the lightweight classifier and decomposer steps.
    """
    response = await chat_client.chat.completions.create(
        model=config.AZURE_OPENAI_CHAT_DEPLOYMENT,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=max_tokens,
    )
    return (response.choices[0].message.content or "").strip()


# ── Step 1: Complexity classifier ─────────────────────────────────────────────

async def classify_query(query: str) -> str:
    """
    Classify query as 'simple' or 'complex' using a lightweight LLM call.
    Capped at max_tokens=10 — classification is a routing decision, not a
    knowledge task, so it should be fast and cheap.
    Returns: "simple" or "complex"
    """
    prompt = CLASSIFIER_PROMPT.format(query=query)
    try:
        result = await _chat_call(prompt, max_tokens=10)
        return "complex" if "complex" in result.lower() else "simple"
    except Exception as e:
        log.warning(f"Classifier failed, defaulting to simple: {e}")
        return "simple"


# ── Step 2: Query decomposition ───────────────────────────────────────────────

async def decompose_query(query: str, n: int = MAX_SUB_QUERIES) -> list[str]:
    """
    Break a complex query into n focused sub-queries.
    Each sub-query is independently retrievable and covers
    a different aspect of the original question.
    Returns: list of sub-query strings
    """
    prompt = DECOMPOSITION_PROMPT.format(query=query, n=n)
    try:
        raw = await _chat_call(prompt, max_tokens=300)
        sub_queries = [
            line.strip()
            for line in raw.split("\n")
            if line.strip() and len(line.strip()) > 10
        ]
        if query not in sub_queries:
            sub_queries.insert(0, query)
        log.info(f"Decomposed into {len(sub_queries)} sub-queries")
        return sub_queries[:n + 1]
    except Exception as e:
        log.warning(f"Decomposition failed, using original query: {e}")
        return [query]


# ── Step 3: Format chat history ───────────────────────────────────────────────

def format_chat_history(memory: ConversationBufferWindowMemory) -> str:
    """
    Format LangChain memory into a string for the system prompt.
    Converts message objects into a readable conversation format.
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

async def generate_response(
    query: str,
    context: str,
    chat_history: str,
    mode: str,
    document_context: Optional[str] = None,
) -> tuple[str, int]:
    """
    Generate the final response using Azure OpenAI with context injected.
    If document_context is provided, it is injected before RAG context
    so the LLM always has the user's document fully in view.
    """
    system_prompt = get_system_prompt(mode).format(
        context=context,
        chat_history=chat_history,
    )

    # Prepend uploaded document context if present
    if document_context:
        doc_section = (
            "## User-Uploaded Document\n"
            "The user has uploaded the following document. "
            "Use it as primary context when answering their question.\n\n"
            f"{document_context}\n\n"
            "## Retrieved Context from Knowledge Base"
        )
        system_prompt = system_prompt.replace(
            "Context from official sources:",
            doc_section + "\nContext from official sources:"
        )

    user_prompt = query

    response = await chat_client.chat.completions.create(
        model=config.AZURE_OPENAI_CHAT_DEPLOYMENT,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0,
        max_tokens=2048,
    )

    answer = response.choices[0].message.content
    answer = (answer or "").strip()

    # Prefer the provider's token accounting; fall back to a rough estimate.
    # NOTE: max_tokens caps COMPLETION (output) tokens only. total_tokens also
    # includes the (large) prompt — context + history + system prompt — so a
    # high total does not mean the output cap is being ignored.
    if response.usage:
        log.info(
            f"Tokens | prompt={response.usage.prompt_tokens} "
            f"completion={response.usage.completion_tokens} "
            f"total={response.usage.total_tokens} (output cap=2048)"
        )
        tokens_used = response.usage.total_tokens
    else:
        tokens_used = len(system_prompt.split()) + len(user_prompt.split()) + len(answer.split())

    return answer, tokens_used


# ── Main chain function ───────────────────────────────────────────────────────

async def run_chain(
    message:          str,
    session_id:       str,
    mode:             str = "student",
    document_context: Optional[str] = None,
) -> dict:
    """
    Run the full RAG chain for a user message.

    Args:
        message:          The user's question
        session_id:       UUID identifying the chat session (from frontend)
        mode:             "student" or "professional"
        document_context: Optional extracted text from uploaded document

    Returns:
        dict with keys:
          - answer:      the LLM's response text
          - sources:     list of source dicts for citation display
          - context:     assembled context string (for eval service)
          - complexity:  "simple" or "complex"
          - tokens_used: total tokens consumed (for monitoring)
    """
    log.info(f"Chain invoked | session={session_id[:8]} | mode={mode}")
    log.info(f"Query: {message[:100]}...")

    # ── Get session memory ────────────────────────────────────────────────────
    memory       = get_memory(session_id)
    chat_history = format_chat_history(memory)

    # ── Step 1: Classify complexity ───────────────────────────────────────────
    complexity = await classify_query(message)
    log.info(f"Complexity: {complexity}")

    # ── Step 2: Route and retrieve ────────────────────────────────────────────
    if complexity == "simple":
        context, sources = retrieve(message)
    else:
        sub_queries = await decompose_query(message)
        log.info(f"Sub-queries: {sub_queries}")
        context, sources = retrieve_multi(sub_queries)

    # ── Step 3: Generate response ─────────────────────────────────────────────
    answer, tokens_used = await generate_response(
        query=message,
        context=context,
        chat_history=chat_history,
        mode=mode,
        document_context=document_context,
    )

    # ── Step 4: Save to memory ────────────────────────────────────────────────
    memory.save_context(
        inputs={"input": message},
        outputs={"answer": answer},
    )

    log.info(f"Response generated | tokens={tokens_used} | sources={len(sources)}")

    return {
        "answer":      answer,
        "sources":     sources,
        "context":     context,   # returned for eval service faithfulness scoring
        "complexity":  complexity,
        "tokens_used": tokens_used,
    }
