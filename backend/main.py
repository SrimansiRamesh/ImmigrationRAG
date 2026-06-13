"""
main.py

FastAPI server for the immigration RAG assistant.
Exposes /api/chat endpoint + document parsing + eval service integration.

Usage:
    uvicorn backend.main:app --reload --port 8000
"""

import asyncio
import io
import logging
import os
import time
import uuid
import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Optional

from config import validate_config, AZURE_OPENAI_CHAT_DEPLOYMENT
from chain import run_chain, chat_client
from memory import clear_memory, get_active_sessions

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger(__name__)

# Eval service URL — runs on port 8001
EVAL_SERVICE_URL = os.getenv("EVAL_SERVICE_URL", "http://localhost:8001/evaluate")

# ── Eval (fire-and-forget) ────────────────────────────────────────────────────

EVAL_TIMEOUT_SECONDS = 4.0

async def _post_eval(eval_id: str, payload: dict) -> None:
    """
    Fire-and-forget POST to the eval service. Scheduled via asyncio.create_task
    so it runs after the chat response has already been returned — it must never
    add to response time. The eval_id lets the frontend poll for scores once the
    eval service finishes. Fails silently if the eval service is down or slow.
    """
    try:
        async with httpx.AsyncClient(timeout=EVAL_TIMEOUT_SECONDS) as client:
            await client.post(EVAL_SERVICE_URL, json={**payload, "eval_id": eval_id})
    except Exception as e:
        # Eval service being down/slow should never affect the user
        log.warning(f"Eval post failed: {e}")


# ── Lifespan (startup + shutdown) ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting ImmigrationIQ backend...")
    validate_config()
    log.info("Config validated. All environment variables present.")
    log.info("Server ready.")
    yield
    log.info("Shutting down. Active sessions: %d", get_active_sessions())


# ── App initialization ────────────────────────────────────────────────────────

app = FastAPI(
    title="ImmigrationIQ API",
    description="RAG-powered US immigration and tax guidance assistant",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://immigration-rag.vercel.app",
        "http://localhost:3000",
    ],
    # Also allow this project's Vercel preview/branch deployments, e.g.
    # https://immigration-rag-srimansi-ramesh.vercel.app
    allow_origin_regex=r"https://immigration-rag[a-z0-9-]*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ─────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    message:    str = Field(..., min_length=1, max_length=50000)
    mode:       str = Field(default="student", pattern="^(student|professional)$")
    document_context: Optional[str] = Field(default=None, max_length=10000)


class SourceItem(BaseModel):
    url:            str
    section:        str
    doc_type:       str
    jurisdiction:   str
    effective_date: Optional[int] = None


class ChatResponse(BaseModel):
    answer:      str
    sources:     list[SourceItem]
    complexity:  str
    tokens_used: int
    eval_id:     Optional[str] = None   # poll GET /result/{eval_id} for scores


class ParseDocumentResponse(BaseModel):
    filename:   str
    text:       str
    summarised: bool
    char_count: int


# ── Constants ─────────────────────────────────────────────────────────────────

SUMMARISE_THRESHOLD = 8_000
ACCEPTED_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown"}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {
        "status":          "healthy",
        "active_sessions": get_active_sessions(),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Main chat endpoint. Generates the answer and returns immediately. Eval is
    fired as a non-blocking background task (asyncio.create_task) and never
    awaited, so it adds nothing to response time; the response carries no scores.
    """
    start = time.time()
    try:
        result = await run_chain(
            message=request.message,
            session_id=request.session_id,
            mode=request.mode,
            document_context=request.document_context,
        )

        # Fire-and-forget eval — scheduled on the loop, never awaited, so it
        # adds nothing to response time. The frontend polls /result/{eval_id}.
        eval_id = str(uuid.uuid4())
        asyncio.create_task(_post_eval(eval_id, {
            "session_id":  request.session_id,
            "question":    request.message,
            "answer":      result["answer"],
            "context":     result.get("context", ""),
            "sources":     result["sources"],
            "mode":        request.mode,
            "complexity":  result["complexity"],
            "tokens_used": result["tokens_used"],
        }))

        response = ChatResponse(
            answer=result["answer"],
            sources=[SourceItem(**s) for s in result["sources"]],
            complexity=result["complexity"],
            tokens_used=result["tokens_used"],
            eval_id=eval_id,
        )
        log.info(f"Request completed in {time.time() - start:.2f}s")
        return response
    except Exception as e:
        log.error(f"Chain error for session {request.session_id[:8]}: {e}")
        err_text = str(e)
        if "503" in err_text or "UNAVAILABLE" in err_text:
            raise HTTPException(status_code=503, detail="UNAVAILABLE")
        raise HTTPException(
            status_code=500,
            detail="An error occurred processing your request. Please try again."
        )


@app.post("/api/parse-document", response_model=ParseDocumentResponse)
async def parse_document(file: UploadFile = File(...)):
    """
    Parse an uploaded document and return its text.
    Summarises via Azure OpenAI if the document exceeds the size threshold.
    Supports: PDF, .txt, .md
    """
    filename = file.filename or "document"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext not in ACCEPTED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Upload a PDF, .txt, or .md file.",
        )

    content = await file.read()

    # Extract text
    try:
        if ext == ".pdf":
            import pdfplumber
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                pages = [p.extract_text() for p in pdf.pages if p.extract_text()]
            raw_text = "\n\n".join(pages).strip()
        else:
            raw_text = content.decode("utf-8", errors="replace").strip()
    except Exception as e:
        log.error(f"Document extraction failed ({filename}): {e}")
        raise HTTPException(status_code=422, detail=f"Could not read file: {e}")

    if not raw_text:
        raise HTTPException(status_code=422, detail="No text could be extracted from this file.")

    # Summarise if too large
    summarised = False
    if len(raw_text) > SUMMARISE_THRESHOLD:
        try:
            prompt = (
                "Summarise the following document for use as context when answering questions. "
                "Preserve ALL of the following verbatim: dates, deadlines, dollar amounts, fees, "
                "form numbers (I-20, W-2, I-485, etc.), ID numbers, SEVIS IDs, visa types, "
                "case numbers, names, and regulatory references (8 CFR, INA sections). "
                "For narrative sections, summarise concisely.\n\n"
                f"Document ({filename}):\n{raw_text}"
            )
            resp = await chat_client.chat.completions.create(
                model=AZURE_OPENAI_CHAT_DEPLOYMENT,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_tokens=2048,
            )
            raw_text   = (resp.choices[0].message.content or "").strip()
            summarised = True
            log.info(f"Document summarised | file={filename} | chars={len(raw_text)}")
        except Exception as e:
            log.warning(f"Summarisation failed, using full text: {e}")

    return ParseDocumentResponse(
        filename=filename,
        text=raw_text,
        summarised=summarised,
        char_count=len(raw_text),
    )


@app.delete("/api/session/{session_id}")
async def clear_session(session_id: str):
    """Clear conversation memory for a session."""
    clear_memory(session_id)
    return {"status": "cleared", "session_id": session_id}


@app.get("/api/health/detailed")
async def detailed_health():
    """Detailed health check — verifies all downstream services."""
    from qdrant_client import QdrantClient
    from config import QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION_NAME

    status = {
        "server":          "healthy",
        "active_sessions": get_active_sessions(),
        "qdrant":          "unknown",
        "eval_service":    "unknown",
    }

    try:
        client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
        info   = client.get_collection(QDRANT_COLLECTION_NAME)
        status["qdrant"] = f"healthy ({info.points_count} points)"
    except Exception as e:
        status["qdrant"] = f"error: {str(e)}"

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get("http://localhost:8001/health")
            status["eval_service"] = "healthy" if resp.status_code == 200 else "unhealthy"
    except Exception:
        status["eval_service"] = "not running"

    return status