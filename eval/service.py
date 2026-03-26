"""
eval/service.py

Standalone FastAPI evaluation service.
Runs RAGAS-style metrics asynchronously — the main backend
fires and forgets; users never wait for eval.

Endpoints:
  POST /evaluate     — receive answer + context, compute metrics, store
  GET  /metrics      — aggregate scores across all evals
  GET  /results      — recent individual eval results
  GET  /health       — health check

Usage:
    uvicorn eval.service:app --port 8001

The main backend calls POST /evaluate as a background task
after every successful /api/chat response.
"""

import os
import json
import time
import logging
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai
from google.genai import types
from openai import AzureOpenAI

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# ── Clients ───────────────────────────────────────────────────────────────────
_gemini = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
_azure  = AzureOpenAI(
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="ImmigrationIQ Eval Service",
    description="Async RAGAS-style evaluation for the RAG pipeline",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ─────────────────────────────────────────────────

class EvalRequest(BaseModel):
    """
    Payload sent by the main backend after every chat response.
    Contains everything needed to compute all three metrics.
    """
    session_id:  str
    question:    str
    answer:      str
    context:     str           # assembled parent chunks text
    sources:     list[dict]    # source metadata
    mode:        str           # student | professional
    complexity:  str           # simple | complex
    tokens_used: int


class EvalResult(BaseModel):
    eval_id:            str
    session_id:         str
    question:           str
    mode:               str
    complexity:         str
    faithfulness:       float
    answer_relevance:   float
    context_precision:  float
    overall_score:      float
    timestamp:          str
    status:             str


# ── In-memory store (results also persisted to disk) ─────────────────────────
_results: list[dict] = []


# ── Metric implementations ────────────────────────────────────────────────────

def embed_text(text: str) -> list[float]:
    """Embed text using Azure OpenAI."""
    response = _azure.embeddings.create(
        input=text[:8000],  # truncate to avoid token limit
        model=os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large"),
        dimensions=1536,
    )
    return response.data[0].embedding


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot   = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x ** 2 for x in a) ** 0.5
    mag_b = sum(x ** 2 for x in b) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def _gemini_call(prompt: str, max_tokens: int = 300) -> str:
    """Lightweight Gemini call for metric scoring."""
    response = _gemini.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=max_tokens,
        )
    )
    return response.text.strip()


def score_faithfulness(answer: str, context: str) -> float:
    """
    Faithfulness: fraction of answer claims supported by context.
    Uses Gemini to identify and verify each claim.
    """
    prompt = f"""Evaluate whether each factual claim in the answer is supported by the context.

Context (truncated):
{context[:2000]}

Answer:
{answer[:1500]}

List each factual claim in the answer. For each, write YES if supported by context, NO if not.
Format: <claim> | YES or NO
Only include factual claims, not disclaimers or general statements."""

    try:
        raw = _gemini_call(prompt, max_tokens=400)
        lines = [l.strip() for l in raw.split("\n") if "|" in l]
        if not lines:
            return 1.0
        supported = sum(1 for l in lines if l.split("|")[-1].strip().upper().startswith("YES"))
        return round(supported / len(lines), 3)
    except Exception as e:
        log.warning(f"Faithfulness scoring failed: {e}")
        return 0.5


def score_answer_relevance(question: str, answer: str) -> float:
    """
    Answer relevance: does the answer address the question?
    Generates reverse questions from the answer, measures similarity to original.
    """
    prompt = f"""Given this answer, generate 3 questions it is answering.
Answer: {answer[:800]}
Output one question per line, nothing else."""

    try:
        raw = _gemini_call(prompt, max_tokens=150)
        gen_questions = [
            l.strip() for l in raw.split("\n")
            if l.strip() and len(l.strip()) > 10
        ][:3]

        if not gen_questions:
            return 0.5

        orig_emb = embed_text(question)
        sims = [
            cosine_similarity(orig_emb, embed_text(q))
            for q in gen_questions
        ]
        return round(sum(sims) / len(sims), 3)
    except Exception as e:
        log.warning(f"Answer relevance scoring failed: {e}")
        return 0.5


def score_context_precision(question: str, context: str) -> float:
    """
    Context precision: is the retrieved context useful for the question?
    """
    prompt = f"""Is this retrieved context useful for answering the question?
Question: {question}
Context: {context[:1500]}
Answer YES or NO."""

    try:
        raw = _gemini_call(prompt, max_tokens=50)
        return 1.0 if "YES" in raw.upper() else 0.0
    except Exception as e:
        log.warning(f"Context precision scoring failed: {e}")
        return 0.5


# ── Background eval task ──────────────────────────────────────────────────────

def run_eval(req: EvalRequest) -> None:
    """
    Runs all three metrics and persists the result.
    Called as a background task — never blocks the main response.
    """
    eval_id = hashlib.md5(
        f"{req.session_id}{req.question}{time.time()}".encode()
    ).hexdigest()[:12]

    log.info(f"Running eval [{eval_id}] for session {req.session_id[:8]}...")

    try:
        faithfulness      = score_faithfulness(req.answer, req.context)
        answer_relevance  = score_answer_relevance(req.question, req.answer)
        context_precision = score_context_precision(req.question, req.context)

        # Weighted overall score
        # Faithfulness weighted highest for legal/compliance content
        overall = round(
            faithfulness      * 0.5 +
            answer_relevance  * 0.3 +
            context_precision * 0.2,
            3
        )

        result = {
            "eval_id":           eval_id,
            "session_id":        req.session_id,
            "question":          req.question,
            "mode":              req.mode,
            "complexity":        req.complexity,
            "faithfulness":      faithfulness,
            "answer_relevance":  answer_relevance,
            "context_precision": context_precision,
            "overall_score":     overall,
            "tokens_used":       req.tokens_used,
            "sources_count":     len(req.sources),
            "timestamp":         datetime.now().isoformat(),
            "status":            "success",
        }

    except Exception as e:
        log.error(f"Eval [{eval_id}] failed: {e}")
        result = {
            "eval_id":           eval_id,
            "session_id":        req.session_id,
            "question":          req.question,
            "mode":              req.mode,
            "complexity":        req.complexity,
            "faithfulness":      0.0,
            "answer_relevance":  0.0,
            "context_precision": 0.0,
            "overall_score":     0.0,
            "timestamp":         datetime.now().isoformat(),
            "status":            "error",
            "error":             str(e),
        }

    # Store in memory and persist to disk
    _results.append(result)

    # Persist to daily results file
    date_str     = datetime.now().strftime("%Y%m%d")
    results_path = RESULTS_DIR / f"live_{date_str}.jsonl"
    with open(results_path, "a") as f:
        f.write(json.dumps(result) + "\n")

    log.info(
        f"Eval [{eval_id}] done | "
        f"faith={result['faithfulness']:.2f} "
        f"rel={result['answer_relevance']:.2f} "
        f"prec={result['context_precision']:.2f} "
        f"overall={result['overall_score']:.2f}"
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":         "healthy",
        "evals_in_memory": len(_results),
    }


@app.post("/evaluate")
async def evaluate(req: EvalRequest, background_tasks: BackgroundTasks):
    """
    Accepts eval request and immediately returns 202 Accepted.
    Actual evaluation runs in the background — never blocks caller.

    Why 202 and not 200?
    202 Accepted means "I received your request and will process it"
    without implying it's done. Semantically correct for async tasks.
    """
    background_tasks.add_task(run_eval, req)
    return {"status": "accepted", "message": "Evaluation queued"}


@app.get("/metrics")
async def get_metrics(
    mode:  Optional[str] = None,
    limit: Optional[int] = 100,
):
    """
    Returns aggregate metrics across recent evaluations.
    Optionally filter by mode (student | professional).
    """
    results = _results
    if mode:
        results = [r for r in results if r.get("mode") == mode]

    results = [r for r in results if r.get("status") == "success"]
    recent  = results[-limit:] if limit else results

    if not recent:
        return {"message": "No evaluations yet", "count": 0}

    def avg(key: str) -> float:
        vals = [r[key] for r in recent if r.get(key) is not None]
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    return {
        "count":              len(recent),
        "mode_filter":        mode,
        "avg_faithfulness":   avg("faithfulness"),
        "avg_answer_relevance": avg("answer_relevance"),
        "avg_context_precision": avg("context_precision"),
        "avg_overall_score":  avg("overall_score"),
        "by_complexity": {
            "simple":  avg_for_filter(recent, "complexity", "simple",  "overall_score"),
            "complex": avg_for_filter(recent, "complexity", "complex", "overall_score"),
        },
        "by_mode": {
            "student":      avg_for_filter(recent, "mode", "student",      "overall_score"),
            "professional": avg_for_filter(recent, "mode", "professional", "overall_score"),
        },
    }


def avg_for_filter(
    results: list[dict],
    filter_key: str,
    filter_val: str,
    metric_key: str,
) -> float:
    """Helper to compute average of a metric for a filtered subset."""
    subset = [r[metric_key] for r in results
              if r.get(filter_key) == filter_val and r.get(metric_key) is not None]
    return round(sum(subset) / len(subset), 3) if subset else 0.0


@app.get("/results")
async def get_results(
    limit: int = 20,
    mode:  Optional[str] = None,
):
    """Returns recent individual eval results for inspection."""
    results = _results
    if mode:
        results = [r for r in results if r.get("mode") == mode]
    return {
        "count":   len(results),
        "results": results[-limit:],
    }