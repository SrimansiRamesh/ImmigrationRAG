"""
main.py

FastAPI server for the immigration RAG assistant.
Exposes /api/chat endpoint + document parsing + eval service integration.

Usage:
    uvicorn backend.main:app --reload --port 8000
"""

import io
import logging
import os
import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Optional

from config import validate_config, GEMINI_API_KEY, GEMINI_CLASSIFIER_MODEL
from chain import run_chain
from memory import clear_memory, get_active_sessions

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger(__name__)

# Eval service URL — runs on port 8001
EVAL_SERVICE_URL = os.getenv("EVAL_SERVICE_URL", "http://localhost:8001/evaluate")

# ── Eval fire-and-forget ──────────────────────────────────────────────────────

async def fire_eval(payload: dict) -> None:
    """
    Fire-and-forget POST to the eval service.
    Runs as a background task — never blocks the chat response.
    Fails silently if the eval service is down.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(EVAL_SERVICE_URL, json=payload)
    except Exception as e:
        # Eval service being down should never affect the user
        log.warning(f"Eval service unreachable: {e}")


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
async def chat(request: ChatRequest, background_tasks: BackgroundTasks):
    """
    Main chat endpoint. Returns answer immediately.
    Fires eval as a background task — user never waits for it.
    """
    try:
        result = run_chain(
            message=request.message,
            session_id=request.session_id,
            mode=request.mode,
            document_context=request.document_context,
        )

        # Fire eval as background task — non-blocking
        background_tasks.add_task(fire_eval, {
            "session_id":  request.session_id,
            "question":    request.message,
            "answer":      result["answer"],
            "context":     result.get("context", ""),
            "sources":     result["sources"],
            "mode":        request.mode,
            "complexity":  result["complexity"],
            "tokens_used": result["tokens_used"],
        })

        return ChatResponse(
            answer=result["answer"],
            sources=[SourceItem(**s) for s in result["sources"]],
            complexity=result["complexity"],
            tokens_used=result["tokens_used"],
        )
    except Exception as e:
        log.error(f"Chain error for session {request.session_id[:8]}: {e}")
        raise HTTPException(
            status_code=500,
            detail="An error occurred processing your request. Please try again."
        )


@app.post("/api/parse-document", response_model=ParseDocumentResponse)
async def parse_document(file: UploadFile = File(...)):
    """
    Parse an uploaded document and return its text.
    Summarises via Gemini if the document exceeds the size threshold.
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
            from google import genai
            from google.genai import types as gtypes

            client = genai.Client(api_key=GEMINI_API_KEY)
            prompt = (
                "Summarise the following document for use as context when answering questions. "
                "Preserve ALL of the following verbatim: dates, deadlines, dollar amounts, fees, "
                "form numbers (I-20, W-2, I-485, etc.), ID numbers, SEVIS IDs, visa types, "
                "case numbers, names, and regulatory references (8 CFR, INA sections). "
                "For narrative sections, summarise concisely.\n\n"
                f"Document ({filename}):\n{raw_text}"
            )
            resp = client.models.generate_content(
                model=GEMINI_CLASSIFIER_MODEL,
                contents=prompt,
                config=gtypes.GenerateContentConfig(
                    temperature=0.0,
                    max_output_tokens=2048,
                ),
            )
            raw_text   = resp.text.strip()
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
    from backend.config import QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION_NAME

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