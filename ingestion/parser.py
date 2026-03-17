"""
parser.py

Converts raw HTML and PDF files from data/raw/ into clean structured JSON
saved to data/parsed/.

Each output JSON has:
  - content      : clean plain text (main body)
  - tables       : list of tables extracted as lists of rows
  - sections     : list of section headings found in the document
  - metadata     : source_url, doc_type, topic_tags, jurisdiction, effective_date

Why separate text, tables, and sections?
- Tables contain critical structured data (fees, deadlines, form numbers)
  that gets mangled if treated as plain text
- Section headings become metadata that helps the chunker preserve
  document structure and helps retrieval with context

Usage:
    python ingestion/parser.py
    python ingestion/parser.py --source uscis
"""

import os
import re
import json
import logging
import argparse
import yaml
from pathlib import Path
from datetime import datetime
from typing import Optional
import hashlib

from bs4 import BeautifulSoup
import pdfplumber
from unstructured.partition.html import partition_html
from unstructured.documents.elements import Table, Title, NarrativeText, ListItem

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent.parent
RAW_DIR    = ROOT / "data" / "raw"
PARSED_DIR = ROOT / "data" / "parsed"
YAML_PATH  = Path(__file__).parent / "sources.yaml"

PARSED_DIR.mkdir(parents=True, exist_ok=True)


# ── Text cleaning ─────────────────────────────────────────────────────────────

def clean_text(text: str) -> str:
    """
    Normalize whitespace and remove common boilerplate patterns.

    Why this matters: raw HTML/PDF text has inconsistent whitespace,
    unicode artifacts, and repeated nav/footer text that adds noise
    to embeddings without adding meaning.
    """
    if not text:
        return ""

    # Normalize unicode whitespace characters to regular spaces
    text = re.sub(r'[\u00a0\u2009\u200b\u202f\ufeff]', ' ', text)

    # Collapse multiple whitespace/newlines into single space or newline
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)

    # Remove common gov website boilerplate patterns
    boilerplate = [
        r'Skip to main content',
        r'An official website of the United States government',
        r'Here\'s how you know',
        r'Official websites use \.gov',
        r'Secure \.gov websites use HTTPS',
        r'Share sensitive information only on official.*?websites\.',
        r'Looking for U\.S\. government information.*?here\.',
    ]
    for pattern in boilerplate:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE)

    return text.strip()


def extract_effective_date(text: str, url: str) -> int:
    """
    Try to extract an effective/revision date from document text.
    Returns as YYYYMMDD integer for easy range filtering in Qdrant.
    Falls back to today's date if none found.

    Why integer? Qdrant's range filters work on integers/floats,
    not strings. YYYYMMDD format preserves chronological ordering.
    """
    # Look for common date patterns in government docs
    patterns = [
        r'(?:revised|updated|effective|as of)[:\s]+(\w+ \d{1,2},?\s*\d{4})',
        r'(\w+ \d{4})',           # "January 2024"
        r'(\d{1,2}/\d{1,2}/\d{4})',  # "01/15/2024"
    ]
    for pattern in patterns:
        match = re.search(pattern, text[:2000], re.IGNORECASE)
        if match:
            try:
                date_str = match.group(1)
                for fmt in ['%B %d, %Y', '%B %d %Y', '%B %Y', '%m/%d/%Y']:
                    try:
                        dt = datetime.strptime(date_str.strip(), fmt)
                        return int(dt.strftime('%Y%m%d'))
                    except ValueError:
                        continue
            except Exception:
                pass

    # Default to today if no date found
    return int(datetime.today().strftime('%Y%m%d'))


# ── HTML Parser ───────────────────────────────────────────────────────────────

def parse_html(raw_path: Path, meta: dict) -> Optional[dict]:
    """
    Parse an HTML file into structured content.

    Strategy:
    1. Use unstructured.io to partition into typed elements
       (Title, NarrativeText, Table, ListItem etc.)
    2. Fall back to BeautifulSoup for direct extraction if unstructured
       doesn't find enough content

    Why unstructured.io first?
    It understands document semantics — it knows a <h2> is a section title
    and a <table> should be extracted differently from paragraph text.
    BeautifulSoup is just an HTML tree parser — it doesn't understand meaning.
    """
    log.info(f"  Parsing HTML: {raw_path.name}")

    try:
        # Partition with unstructured
        elements = partition_html(filename=str(raw_path))

        text_parts = []
        tables = []
        sections = []

        for el in elements:
            if isinstance(el, Title):
                heading = clean_text(str(el))
                if heading and len(heading) > 3:
                    sections.append(heading)
                    text_parts.append(f"\n## {heading}\n")

            elif isinstance(el, (NarrativeText, ListItem)):
                cleaned = clean_text(str(el))
                if cleaned and len(cleaned) > 20:  # skip tiny fragments
                    text_parts.append(cleaned)

            elif isinstance(el, Table):
                # Tables get stored separately AND included in text
                # so both structured and semantic retrieval can find them
                table_text = clean_text(str(el))
                if table_text:
                    tables.append(table_text)
                    text_parts.append(f"\n[TABLE]\n{table_text}\n[/TABLE]\n")

        content = "\n".join(text_parts)

        # Fallback: if unstructured found very little, use BeautifulSoup
        if len(content) < 500:
            log.warning(f"  Unstructured found little content, falling back to BS4")
            content, sections = parse_html_bs4(raw_path)

        if not content or len(content) < 100:
            log.warning(f"  Skipping {raw_path.name} — insufficient content after parsing")
            return None

        effective_date = extract_effective_date(content, meta.get("source_url", ""))

        return {
            "filename": raw_path.name,
            "source_url": meta.get("source_url", ""),
            "doc_type": meta.get("doc_type", "unknown"),
            "topic_tags": meta.get("topic_tags", []),
            "jurisdiction": meta.get("jurisdiction", "unknown"),
            "effective_date": effective_date,
            "content": clean_text(content),
            "tables": tables,
            "sections": sections,
            "char_count": len(content),
        }

    except Exception as e:
        log.error(f"  HTML parse failed for {raw_path.name}: {e}")
        return None


def parse_html_bs4(raw_path: Path) -> tuple[str, list]:
    """
    Fallback HTML parser using BeautifulSoup directly.
    Used when unstructured.io finds insufficient content.
    """
    html = raw_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    # Remove nav, header, footer, scripts — pure noise
    for tag in soup(["nav", "header", "footer", "script", "style",
                     "aside", "noscript", "iframe"]):
        tag.decompose()

    # Extract section headings
    sections = [h.get_text(strip=True) for h in soup.find_all(["h1", "h2", "h3"])
                if h.get_text(strip=True)]

    # Get main content — prefer <main> or <article> tags if present
    main = soup.find("main") or soup.find("article") or soup.find("body")
    content = main.get_text(separator="\n") if main else soup.get_text(separator="\n")

    return clean_text(content), sections


# ── PDF Parser ────────────────────────────────────────────────────────────────

def parse_pdf(raw_path: Path, meta: dict) -> Optional[dict]:
    """
    Parse a PDF file into structured content.

    Strategy: use pdfplumber as primary for better table extraction,
    fall back to unstructured for complex layouts.

    Why pdfplumber for PDFs?
    pdfplumber excels at table extraction from PDFs — it uses the actual
    PDF coordinate system to detect table boundaries. This matters a lot
    for IRS and DOL PDFs which contain critical fee/deadline tables.
    unstructured is better for complex multi-column layouts.
    """
    log.info(f"  Parsing PDF: {raw_path.name}")

    try:
        text_parts = []
        tables = []
        sections = []

        with pdfplumber.open(raw_path) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):

                # Extract tables first — pdfplumber finds them by coordinate
                page_tables = page.extract_tables()
                for tbl in page_tables:
                    if not tbl:
                        continue
                    # Convert table rows to readable text
                    table_rows = []
                    for row in tbl:
                        # Filter None cells, join with pipe separator
                        row_text = " | ".join(
                            str(cell).strip() for cell in row if cell
                        )
                        if row_text:
                            table_rows.append(row_text)

                    if table_rows:
                        table_text = "\n".join(table_rows)
                        tables.append(table_text)
                        text_parts.append(f"\n[TABLE]\n{table_text}\n[/TABLE]\n")

                # Extract text (exclude table bounding boxes to avoid duplication)
                page_text = page.extract_text(x_tolerance=3, y_tolerance=3)
                if page_text:
                    cleaned = clean_text(page_text)

                    # Detect section headings heuristically:
                    # lines that are short, title-case, and not ending with punctuation
                    for line in cleaned.split('\n'):
                        line = line.strip()
                        if (10 < len(line) < 80
                                and not line.endswith(('.', ',', ';', ':'))
                                and sum(1 for c in line if c.isupper()) > len(line) * 0.3):
                            sections.append(line)

                    text_parts.append(f"\n--- Page {page_num} ---\n{cleaned}")

        content = "\n".join(text_parts)

        # Fallback: if pdfplumber got little content, try raw text extraction
        if len(content) < 500:
            log.warning(f"  pdfplumber found little content, trying raw extraction")
            with pdfplumber.open(raw_path) as pdf:
                content = "\n".join(
                    page.extract_text() or "" for page in pdf.pages
                )

        if not content or len(content) < 100:
            log.warning(f"  Skipping {raw_path.name} — insufficient content")
            return None

        effective_date = extract_effective_date(content, meta.get("source_url", ""))

        return {
            "filename": raw_path.name,
            "source_url": meta.get("source_url", ""),
            "doc_type": meta.get("doc_type", "unknown"),
            "topic_tags": meta.get("topic_tags", []),
            "jurisdiction": meta.get("jurisdiction", "unknown"),
            "effective_date": effective_date,
            "content": clean_text(content),
            "tables": tables,
            "sections": sections[:20],  # cap sections list
            "char_count": len(content),
        }

    except Exception as e:
        log.error(f"  PDF parse failed for {raw_path.name}: {e}")
        return None


# ── Source metadata lookup ────────────────────────────────────────────────────

def build_url_meta_map(yaml_path: Path) -> dict:
    """
    Build a mapping from filename hash back to source metadata.

    The scraper named files using url_to_filename() which hashes the URL.
    We need to reverse this to know which source each file came from
    and attach the right metadata (doc_type, topic_tags etc.)
    """
    with open(yaml_path) as f:
        config = yaml.safe_load(f)

    url_meta = {}
    for source in config["sources"]:
        for url in source["urls"]:
            ext = "pdf" if source["type"] == "pdf" else "html"
            domain = url.split("/")[2].replace("www.", "")
            url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
            filename = f"{domain}_{url_hash}.{ext}"
            url_meta[filename] = {
                "source_url": url,
                "doc_type": source["doc_type"],
                "topic_tags": source["topic_tags"],
                "jurisdiction": source["jurisdiction"],
            }
    return url_meta


# ── Main parse logic ──────────────────────────────────────────────────────────

def run(filter_jurisdiction: Optional[str] = None) -> None:
    url_meta_map = build_url_meta_map(YAML_PATH)

    raw_files = list(RAW_DIR.glob("*"))
    if not raw_files:
        log.error(f"No files found in {RAW_DIR}. Run scraper first.")
        return

    success, skipped, failed = 0, 0, 0

    for raw_path in sorted(raw_files):
        # Look up metadata for this file
        meta = url_meta_map.get(raw_path.name, {})

        # Filter by jurisdiction if flag passed
        if filter_jurisdiction and meta.get("jurisdiction") != filter_jurisdiction:
            continue

        # Skip if already parsed
        out_path = PARSED_DIR / (raw_path.stem + ".json")
        if out_path.exists():
            log.info(f"  Skipping (already parsed): {raw_path.name}")
            skipped += 1
            continue

        # Route to correct parser based on extension
        ext = raw_path.suffix.lower()
        if ext == ".html":
            result = parse_html(raw_path, meta)
        elif ext == ".pdf":
            result = parse_pdf(raw_path, meta)
        else:
            log.warning(f"  Unknown file type: {raw_path.name}")
            continue

        if result:
            out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
            log.info(f"  Saved: {out_path.name} ({result['char_count']:,} chars)")
            success += 1
        else:
            failed += 1

    print("\n" + "─" * 50)
    print(f"Parse complete: {success} parsed, {skipped} skipped, {failed} failed")
    print(f"Parsed files saved to: {PARSED_DIR}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parse raw scraped files")
    parser.add_argument("--source", type=str, default=None,
                        help="Filter by jurisdiction (e.g. uscis, irs, dol)")
    args = parser.parse_args()
    run(filter_jurisdiction=args.source)