"""
scraper.py

Fetches raw content (HTML, PDF) from government sources defined in sources.yaml.
Saves raw files to data/raw/ for the parser to process next.

Why save raw files instead of piping directly to the parser?
- Decouples scraping from parsing — if parsing fails, you don't re-scrape
- Raw files are a debugging artifact — you can inspect what was fetched
- Re-running the pipeline doesn't hammer government servers repeatedly

Usage:
    python ingestion/scraper.py
    python ingestion/scraper.py --source uscis   # scrape only uscis sources
"""

import os
import sys
import time
import hashlib
import logging
import argparse
import yaml
import requests
from pathlib import Path
from typing import Optional
from playwright.sync_api import sync_playwright

# ── Logging setup ─────────────────────────────────────────────────────────────
# Industry standard: use logging, never print() in production code.
# print() can't be filtered by level, can't be redirected to files easily.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()]
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT      = Path(__file__).parent.parent          # project root
RAW_DIR   = ROOT / "data" / "raw"                 # where raw files are saved
YAML_PATH = Path(__file__).parent / "sources.yaml"

RAW_DIR.mkdir(parents=True, exist_ok=True)

# ── HTTP session config ───────────────────────────────────────────────────────
# Reusing a session is faster than creating a new connection per request.
# Headers make us look like a real browser — some gov sites block default
# Python/requests user agents.
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
})

# ── Rate limiting ─────────────────────────────────────────────────────────────
# Be a good citizen — don't hammer government servers.
# 2 seconds between requests is polite and avoids IP blocks.
REQUEST_DELAY_SEC = 2
MAX_RETRIES       = 3
TIMEOUT_SEC       = 30


# ── Helpers ───────────────────────────────────────────────────────────────────

def url_to_filename(url: str, ext: str) -> str:
    """
    Convert a URL to a safe, unique filename.
    We hash the URL so long URLs don't exceed filesystem limits,
    but also include a human-readable prefix for easy debugging.

    e.g. "https://uscis.gov/policy-manual/volume-2-part-b"
      → "uscis.gov_a3f9b2c1.html"
    """
    domain = url.split("/")[2].replace("www.", "")
    url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
    return f"{domain}_{url_hash}.{ext}"


def already_fetched(filename: str) -> bool:
    """Skip re-fetching if file already exists and is non-empty."""
    path = RAW_DIR / filename
    return path.exists() and path.stat().st_size > 0


# ── Fetchers ──────────────────────────────────────────────────────────────────

def fetch_html(url: str, filename: str) -> bool:
    """
    Fetch a plain HTML page using requests.
    Works for static HTML pages (most of USCIS, IRS, DOL).
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            log.info(f"  Fetching HTML [{attempt}/{MAX_RETRIES}]: {url}")
            resp = SESSION.get(url, timeout=TIMEOUT_SEC)
            resp.raise_for_status()  # raises on 4xx/5xx

            path = RAW_DIR / filename
            path.write_bytes(resp.content)
            log.info(f"  Saved: {filename} ({len(resp.content) / 1024:.1f} KB)")
            return True

        except requests.RequestException as e:
            log.warning(f"  Attempt {attempt} failed: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(REQUEST_DELAY_SEC * attempt)  # exponential-ish backoff
    log.error(f"  Failed after {MAX_RETRIES} attempts: {url}")
    return False


def fetch_pdf(url: str, filename: str) -> bool:
    """
    Fetch a PDF file using requests.
    Same as HTML fetch but we save raw bytes (already binary).
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            log.info(f"  Fetching PDF [{attempt}/{MAX_RETRIES}]: {url}")
            resp = SESSION.get(url, timeout=TIMEOUT_SEC * 2)  # PDFs can be slow
            resp.raise_for_status()

            # Sanity check — make sure we actually got a PDF
            if b"%PDF" not in resp.content[:10]:
                log.warning(f"  Response doesn't look like a PDF: {url}")

            path = RAW_DIR / filename
            path.write_bytes(resp.content)
            log.info(f"  Saved: {filename} ({len(resp.content) / 1024:.1f} KB)")
            return True

        except requests.RequestException as e:
            log.warning(f"  Attempt {attempt} failed: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(REQUEST_DELAY_SEC * attempt)
    log.error(f"  Failed after {MAX_RETRIES} attempts: {url}")
    return False


def fetch_js_rendered(url: str, filename: str) -> bool:
    """
    Fetch a JavaScript-rendered page using Playwright.

    Why Playwright and not requests?
    Some pages (like USCIS processing times) load their content via JS
    after the initial HTML response. requests only gets the shell HTML —
    the actual content hasn't loaded yet. Playwright runs a real browser,
    waits for JS to execute, then gives us the fully rendered HTML.

    This is slower (~5s vs ~0.5s) so we only use it for js_rendered sources.
    """
    log.info(f"  Fetching JS-rendered page: {url}")
    try:
        with sync_playwright() as p:
            # headless=True means no visible browser window
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            # Wait until network is mostly idle — means JS has finished loading
            page.goto(url, wait_until="networkidle", timeout=60000)

            # Extra wait for any lazy-loaded content
            page.wait_for_timeout(2000)

            html = page.content()
            browser.close()

        path = RAW_DIR / filename
        path.write_text(html, encoding="utf-8")
        log.info(f"  Saved: {filename} ({len(html) / 1024:.1f} KB)")
        return True

    except Exception as e:
        log.error(f"  Playwright fetch failed: {e}")
        return False


# ── Main scrape logic ─────────────────────────────────────────────────────────

def scrape_source(source: dict) -> dict:
    """
    Scrape all URLs for a single source entry from sources.yaml.
    Returns a summary dict for reporting.
    """
    name      = source["name"]
    src_type  = source["type"]
    urls      = source["urls"]

    log.info(f"\nScraping: {name} ({src_type})")

    results = {"name": name, "total": len(urls), "success": 0, "skipped": 0, "failed": 0}

    for url in urls:
        ext      = "pdf" if src_type == "pdf" else "html"
        filename = url_to_filename(url, ext)

        # Skip if already fetched — idempotent scraping
        # This means you can re-run the scraper safely without re-downloading
        if already_fetched(filename):
            log.info(f"  Skipping (already fetched): {filename}")
            results["skipped"] += 1
            continue

        # Route to the right fetcher based on type
        if src_type == "html":
            ok = fetch_html(url, filename)
        elif src_type == "pdf":
            ok = fetch_pdf(url, filename)
        elif src_type == "js_rendered":
            ok = fetch_js_rendered(url, filename)
        else:
            log.warning(f"  Unknown type '{src_type}' — skipping")
            ok = False

        if ok:
            results["success"] += 1
        else:
            results["failed"] += 1

        # Polite delay between requests — only for successful/attempted fetches
        time.sleep(REQUEST_DELAY_SEC)

    return results


def run(filter_jurisdiction: Optional[str] = None) -> None:
    """
    Load sources.yaml and scrape everything.
    Optionally filter to a single jurisdiction (e.g. "uscis").
    """
    if not YAML_PATH.exists():
        log.error(f"sources.yaml not found at {YAML_PATH}")
        sys.exit(1)

    with open(YAML_PATH) as f:
        config = yaml.safe_load(f)

    sources = config["sources"]

    # Filter if --source flag was passed
    if filter_jurisdiction:
        sources = [s for s in sources if s["jurisdiction"] == filter_jurisdiction]
        log.info(f"Filtered to jurisdiction: {filter_jurisdiction} ({len(sources)} sources)")

    log.info(f"Starting scrape: {len(sources)} sources → {RAW_DIR}")

    all_results = []
    for source in sources:
        result = scrape_source(source)
        all_results.append(result)

    # ── Summary report ────────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("Scrape complete. Summary:")
    print("─" * 50)
    total_s, total_sk, total_f = 0, 0, 0
    for r in all_results:
        print(f"  {r['name'][:50]:<50} ✓{r['success']} ↷{r['skipped']} ✗{r['failed']}")
        total_s  += r["success"]
        total_sk += r["skipped"]
        total_f  += r["failed"]
    print("─" * 50)
    print(f"  Total: {total_s} fetched, {total_sk} skipped, {total_f} failed")
    print(f"  Raw files saved to: {RAW_DIR}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape immigration data sources")
    parser.add_argument(
        "--source",
        type=str,
        help="Filter by jurisdiction (e.g. uscis, irs, dol)",
        default=None
    )
    args = parser.parse_args()

    run(filter_jurisdiction=args.source)