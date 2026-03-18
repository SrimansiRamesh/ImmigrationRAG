"""
run_ingestion.py

End-to-end ingestion pipeline orchestrator.
Runs all 5 stages in order and cleans up local data after successful upload.

Stages:
  1. scraper.py      → data/raw/
  2. parser.py       → data/parsed/
  3. chunker.py      → data/chunks/
  4. embedder.py     → data/embedded/
  5. qdrant_loader.py → Qdrant Cloud
  6. cleanup()       → deletes data/ (only if all stages succeeded)

Why an orchestrator?
In production, pipelines are never run as individual scripts.
You need one entry point that handles ordering, error propagation,
and cleanup. If stage 3 fails, stages 4 and 5 should not run.
If stage 5 fails, cleanup should not run.

Usage:
    python ingestion/run_ingestion.py
    python ingestion/run_ingestion.py --skip-scrape   # reuse existing raw files
    python ingestion/run_ingestion.py --no-cleanup    # keep local data after upload
    python ingestion/run_ingestion.py --source uscis  # run only one jurisdiction
"""

import sys
import time
import shutil
import logging
import argparse
from pathlib import Path

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT         = Path(__file__).parent.parent
DATA_DIRS    = [
    ROOT / "data" / "raw",
    ROOT / "data" / "parsed",
    ROOT / "data" / "chunks",
    ROOT / "data" / "embedded",
]


# ── Stage runner ──────────────────────────────────────────────────────────────

def run_stage(name: str, func, *args, **kwargs) -> bool:
    """
    Run a pipeline stage function, catch exceptions, return success/failure.

    Why wrap in try/except here instead of inside each script?
    The orchestrator is the right place to decide what happens on failure.
    Individual scripts should focus on their job — the orchestrator decides
    whether to abort, retry, or skip.
    """
    log.info(f"\n{'─' * 50}")
    log.info(f"Stage: {name}")
    log.info(f"{'─' * 50}")
    start = time.time()

    try:
        func(*args, **kwargs)
        elapsed = time.time() - start
        log.info(f"✓ {name} completed in {elapsed:.1f}s")
        return True
    except Exception as e:
        log.error(f"✗ {name} FAILED: {e}")
        return False


# ── Cleanup ───────────────────────────────────────────────────────────────────

def cleanup_local_data() -> None:
    """
    Delete all local data directories after successful upload to Qdrant.

    Why only after ALL stages succeed?
    If upload fails halfway through, we keep local data so we can
    retry the upload without re-scraping and re-embedding everything.
    Cleanup only happens when we're certain Qdrant has everything.
    """
    log.info("\nCleaning up local data directories...")
    for d in DATA_DIRS:
        if d.exists():
            shutil.rmtree(d)
            log.info(f"  Deleted: {d}")
    log.info("Cleanup complete — all data lives in Qdrant Cloud now.")


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(
    skip_scrape: bool = False,
    no_cleanup:  bool = False,
    source:      str  = None,
) -> None:
    """
    Run the full ingestion pipeline end to end.
    Aborts immediately if any stage fails — no partial uploads.
    """

    # Import stage functions here to avoid circular imports
    # and to keep startup fast if a stage fails early
    from scraper       import run as scrape
    from parser        import run as parse
    from chunker       import run as chunk
    from embedder      import run as embed
    from qdrant_loader import run as load

    stages = []

    # Optionally skip scraping if raw files already exist
    if not skip_scrape:
        stages.append(("Scraper",       scrape, {"filter_jurisdiction": source}))

    stages += [
        ("Parser",         parse,  {"filter_jurisdiction": source}),
        ("Chunker",        chunk,  {"filter_jurisdiction": source}),
        ("Embedder",       embed,  {"filter_jurisdiction": source}),
        ("Qdrant Loader",  load,   {"filter_jurisdiction": source}),
    ]

    # Run each stage — abort pipeline on first failure
    for name, func, kwargs in stages:
        success = run_stage(name, func, **kwargs)
        if not success:
            log.error(f"\nPipeline aborted at stage: {name}")
            log.error("Local data preserved for debugging.")
            log.error("Fix the issue and re-run with --skip-scrape to resume from parsing.")
            sys.exit(1)

    # All stages succeeded
    log.info("\n" + "═" * 50)
    log.info("Pipeline complete — all data uploaded to Qdrant.")
    log.info("═" * 50)

    # Cleanup local data (unless --no-cleanup flag was passed)
    if no_cleanup:
        log.info("Skipping cleanup (--no-cleanup flag set).")
        log.info(f"Local data preserved in: {ROOT / 'data'}")
    else:
        cleanup_local_data()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run full ingestion pipeline")
    parser.add_argument(
        "--skip-scrape",
        action="store_true",
        help="Skip scraping — reuse existing files in data/raw/"
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Keep local data after upload (default: delete after success)"
    )
    parser.add_argument(
        "--source",
        type=str,
        default=None,
        help="Run only one jurisdiction (e.g. uscis, irs, dol, state_dept)"
    )
    args = parser.parse_args()

    run_pipeline(
        skip_scrape=args.skip_scrape,
        no_cleanup=args.no_cleanup,
        source=args.source,
    )