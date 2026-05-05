"""
Generate AI keywords and summaries for each researcher using a cloud LLM.

Reads combined_researcher_papers.csv (without ai_generated_* columns),
calls the LLM once per researcher, and writes the enriched CSV.

Supports: gemini, openai, anthropic

Progress is saved incrementally to a JSON sidecar file so that the script
can be re-run with --resume to pick up exactly where it left off.

Usage:
    python generate_summaries.py --input combined.csv --output enriched.csv --provider gemini
    python generate_summaries.py --input combined.csv --output enriched.csv --provider gemini --resume

Environment variables:
    GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (depending on --provider)
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from collections import OrderedDict

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

KEYWORDS_SYSTEM = "You are a research classification assistant."

KEYWORDS_PROMPT = """Given the following researcher profile and their papers, generate a comma-separated list of 10 research keywords that best describe their work. Include their existing keywords and expand with more specific topics based on their papers.

Researcher: {name}
Affiliation: {affiliation}
Existing Keywords: {keywords}
Total Citations: {citations}

Papers (sorted by citation count, descending):
{papers_text}

Return ONLY a comma-separated list of 10 keywords, nothing else."""

SUMMARY_SYSTEM = "You are an academic biography writer. Write in markdown format."

SUMMARY_PROMPT = """Write a detailed academic biography for the following researcher in markdown format. Use the exact structure below:

## Overview
A paragraph about the researcher's current position, lab/group, and primary research focus. Use **bold** for important terms and *italics* for emphasis. Use <u>underline</u> for key concepts.

---

## Research Areas
A paragraph describing their research areas in detail, referencing specific topics from their papers.

---

## Notable Works
A bulleted list (3 items) of their most significant research contributions, referencing specific papers.

---

## Academic Background
A paragraph about their academic history, awards, and affiliations (infer from affiliation and paper history where possible).

Researcher: {name}
Affiliation: {affiliation}
Homepage: {homepage}
Keywords: {keywords}
Total Citations: {citations}

Papers (sorted by citation count, descending):
{papers_text}

Write the biography now. Do not include any preamble or explanation, just the markdown."""

# ---------------------------------------------------------------------------
# LLM provider implementations
# ---------------------------------------------------------------------------

MAX_REQUEST_RETRIES = 6
INITIAL_BACKOFF = 5.0
DEFAULT_RESEARCHER_RETRIES = 3
DEFAULT_RESEARCHER_BACKOFF = 20.0


def _call_with_retry(make_request, parse_response, label: str) -> str:
    """Call an LLM API with exponential backoff on rate-limit / server errors."""
    import urllib.request
    import urllib.error

    backoff = INITIAL_BACKOFF
    for attempt in range(1, MAX_REQUEST_RETRIES + 1):
        try:
            req = make_request()
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            return parse_response(data)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code in (429, 500, 503) and attempt < MAX_REQUEST_RETRIES:
                retry_after = e.headers.get("Retry-After")
                delay = backoff
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        pass
                print(f"    {label} HTTP {e.code}, retry {attempt}/{MAX_REQUEST_RETRIES} in {delay:.0f}s", flush=True)
                time.sleep(delay)
                backoff *= 2
            else:
                raise RuntimeError(f"HTTP {e.code}: {body[:300]}") from e
        except Exception as e:
            if attempt < MAX_REQUEST_RETRIES:
                print(f"    {label} error ({e}), retry {attempt}/{MAX_REQUEST_RETRIES} in {backoff:.0f}s", flush=True)
                time.sleep(backoff)
                backoff *= 2
            else:
                raise


def call_gemini(prompt: str, system: str, api_key: str, model: str = "gemini-2.5-flash") -> str:
    import urllib.request

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = json.dumps({
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048},
    }).encode()

    def make_req():
        return urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")

    def parse(data):
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()

    return _call_with_retry(make_req, parse, f"Gemini({model})")


def call_openai(prompt: str, system: str, api_key: str, model: str = "gpt-5.2") -> str:
    import urllib.request

    url = "https://api.openai.com/v1/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 1,
        "max_completion_tokens": 2048,
    }).encode()

    def make_req():
        return urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }, method="POST")

    def parse(data):
        return data["choices"][0]["message"]["content"].strip()

    return _call_with_retry(make_req, parse, f"OpenAI({model})")


def call_anthropic(prompt: str, system: str, api_key: str, model: str = "claude-sonnet-4-6-20250514") -> str:
    import urllib.request

    url = "https://api.anthropic.com/v1/messages"
    body = json.dumps({
        "model": model,
        "max_tokens": 2048,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    def make_req():
        return urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }, method="POST")

    def parse(data):
        return data["content"][0]["text"].strip()

    return _call_with_retry(make_req, parse, f"Anthropic({model})")


# (env_var, call_fn, keywords_model, summary_model)
PROVIDERS = {
    "gemini": ("GEMINI_API_KEY", call_gemini, "gemini-2.5-pro", "gemini-2.5-pro"),
    "openai": ("OPENAI_API_KEY", call_openai, "gpt-5-mini", "gpt-5-mini"),
    "anthropic": ("ANTHROPIC_API_KEY", call_anthropic, "claude-sonnet-4-6-20250514", "claude-sonnet-4-6-20250514"),
}


def validate_api_key(provider: str, call_llm, api_key: str, model: str) -> None:
    """Make a tiny provider call so bad keys fail before the full summary run."""
    print(f"Validating {provider} API key with {model}...", flush=True)
    response = call_llm(
        "Reply with OK.",
        "You validate API connectivity. Keep the response short.",
        api_key,
        model=model,
    )
    if not response or not response.strip():
        raise RuntimeError("validation request returned an empty response")
    print("API key validation succeeded.", flush=True)

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def format_papers(papers: list[dict]) -> str:
    sorted_papers = sorted(
        papers,
        key=lambda p: int(p.get("paper_citations", 0) or 0),
        reverse=True,
    )
    lines = []
    for p in sorted_papers:
        title = p.get("paper_title", "")
        year = p.get("paper_year", "")
        citations = p.get("paper_citations", "")
        abstract = p.get("paper_abstract", "")[:300]
        lines.append(f"- \"{title}\" ({year}, {citations} citations)")
        if abstract:
            lines.append(f"  Abstract: {abstract}...")
    return "\n".join(lines)


def group_by_researcher(input_path: Path) -> OrderedDict:
    groups: OrderedDict[str, dict] = OrderedDict()
    with open(input_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            scholar_id = row["google_scholar_id"]
            if scholar_id not in groups:
                groups[scholar_id] = {
                    "profile": {
                        "name": row["researcher_name"],
                        "profile_url": row["profile_url"],
                        "google_scholar_id": scholar_id,
                        "affiliation": row["affiliation"],
                        "citations": row["researcher_total_citations"],
                        "keywords": row["researcher_keywords"],
                        "homepage": row.get("researcher_homepage", ""),
                    },
                    "papers": [],
                }
            groups[scholar_id]["papers"].append(row)
    return groups


def generate_for_researcher(
    profile: dict,
    papers: list[dict],
    call_llm,
    api_key: str,
    rate_delay: float,
    kw_model: str,
    summary_model: str,
) -> tuple[str, str]:
    papers_text = format_papers(papers)

    keywords_prompt = KEYWORDS_PROMPT.format(
        name=profile["name"],
        affiliation=profile["affiliation"],
        keywords=profile["keywords"],
        citations=profile["citations"],
        papers_text=papers_text,
    )

    summary_prompt = SUMMARY_PROMPT.format(
        name=profile["name"],
        affiliation=profile["affiliation"],
        homepage=profile["homepage"],
        keywords=profile["keywords"],
        citations=profile["citations"],
        papers_text=papers_text,
    )

    keywords = call_llm(keywords_prompt, KEYWORDS_SYSTEM, api_key, model=kw_model)
    time.sleep(rate_delay)

    summary = call_llm(summary_prompt, SUMMARY_SYSTEM, api_key, model=summary_model)
    time.sleep(rate_delay)

    return keywords, summary


def load_progress(progress_path: Path) -> dict[str, dict]:
    """Load the incremental progress sidecar file."""
    if progress_path.exists():
        with open(progress_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def is_successful_progress_entry(entry: dict | None) -> bool:
    """Return true for completed entries, including legacy progress files."""
    if not isinstance(entry, dict):
        return False
    status = entry.get("status", "success")
    return (
        status == "success"
        and bool(str(entry.get("keywords", "")).strip())
        and bool(str(entry.get("summary", "")).strip())
    )


def redact_error(error: Exception | str, api_key: str) -> str:
    text = str(error).replace("\n", " ").strip()
    if api_key:
        text = text.replace(api_key, "[redacted-api-key]")
    return text[:500] or "Unknown error"


def save_progress_entry(progress_path: Path, scholar_id: str, keywords: str, summary: str, attempts: int):
    """Append a single completed researcher to the progress file."""
    progress = load_progress(progress_path)
    progress[scholar_id] = {
        "status": "success",
        "keywords": keywords,
        "summary": summary,
        "attempts": attempts,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(progress_path, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False)


def save_progress_failure(progress_path: Path, scholar_id: str, name: str, error: str, attempts: int):
    """Record an exhausted researcher so reruns can retry it and the UI can name it."""
    progress = load_progress(progress_path)
    progress[scholar_id] = {
        "status": "failed",
        "name": name,
        "keywords": "",
        "summary": "",
        "attempts": attempts,
        "error": error,
        "failed_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(progress_path, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False)


def emit_summary_progress(
    status: str,
    scholar_id: str,
    name: str,
    chunk_index: int | None,
    overall_index: int,
    attempt: int | None = None,
    max_attempts: int | None = None,
    error: str | None = None,
    retry_delay_sec: float | None = None,
):
    """Emit machine-readable progress for the homepage log parser."""
    payload = {
        "status": status,
        "google_scholar_id": scholar_id,
        "name": name,
        "chunk_index": chunk_index,
        "overall_index": overall_index,
    }
    if attempt is not None:
        payload["attempt"] = attempt
    if max_attempts is not None:
        payload["max_attempts"] = max_attempts
    if error:
        payload["error"] = error[:300]
    if retry_delay_sec is not None:
        payload["retry_delay_sec"] = round(retry_delay_sec, 1)

    print("SUMMARY_PROGRESS_JSON:" + json.dumps(payload, ensure_ascii=False), flush=True)


def write_enriched_csv(output_path: Path, groups: OrderedDict, results: dict[str, dict]):
    """Write the final enriched CSV from combined data + completed results."""
    output_columns = [
        "researcher_name", "profile_url", "google_scholar_id", "affiliation",
        "researcher_total_citations", "researcher_keywords", "researcher_homepage",
        "paper_title", "paper_citations", "paper_year", "paper_url", "paper_abstract",
        "ai_generated_keywords", "ai_generated_summary",
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=output_columns)
        writer.writeheader()

        for scholar_id, data in groups.items():
            papers = data["papers"]
            r = results.get(scholar_id, {})
            keywords = r.get("keywords", "")
            summary = r.get("summary", "")

            for paper in papers:
                writer.writerow({
                    "researcher_name": paper["researcher_name"],
                    "profile_url": paper["profile_url"],
                    "google_scholar_id": paper["google_scholar_id"],
                    "affiliation": paper["affiliation"],
                    "researcher_total_citations": paper["researcher_total_citations"],
                    "researcher_keywords": paper["researcher_keywords"],
                    "researcher_homepage": paper.get("researcher_homepage", ""),
                    "paper_title": paper["paper_title"],
                    "paper_citations": paper["paper_citations"],
                    "paper_year": paper["paper_year"],
                    "paper_url": paper["paper_url"],
                    "paper_abstract": paper["paper_abstract"],
                    "ai_generated_keywords": keywords,
                    "ai_generated_summary": summary,
                })


def slice_groups(groups: OrderedDict, chunk_index: int, total_chunks: int) -> OrderedDict:
    """Return only the contiguous subset of researchers for this chunk."""
    keys = list(groups.keys())
    n = len(keys)
    chunk_size = (n + total_chunks - 1) // total_chunks
    start = chunk_index * chunk_size
    end = min(start + chunk_size, n)
    sliced = OrderedDict()
    for key in keys[start:end]:
        sliced[key] = groups[key]
    return sliced


def main():
    parser = argparse.ArgumentParser(description="Generate LLM summaries for researchers")
    parser.add_argument("--input", "-i", type=Path, help="Input combined CSV")
    parser.add_argument("--output", "-o", type=Path, help="Output enriched CSV")
    parser.add_argument("--provider", "-p", choices=["gemini", "openai", "anthropic"], default="gemini")
    parser.add_argument("--rate-delay", type=float, default=4.0, help="Seconds between API calls (default: 4)")
    parser.add_argument("--resume", action="store_true", help="Continue from where a previous run stopped")
    parser.add_argument("--chunk-index", type=int, default=None, help="Chunk index for parallel mode (0-based)")
    parser.add_argument("--total-chunks", type=int, default=None, help="Total number of chunks for parallel mode")
    parser.add_argument("--validate-only", action="store_true", help="Validate provider credentials and exit")
    parser.add_argument("--researcher-retries", type=int, default=DEFAULT_RESEARCHER_RETRIES,
                        help=f"Attempts per researcher before marking summary generation failed (default: {DEFAULT_RESEARCHER_RETRIES})")
    parser.add_argument("--researcher-retry-backoff", type=float, default=DEFAULT_RESEARCHER_BACKOFF,
                        help=f"Initial seconds between per-researcher retry attempts (default: {DEFAULT_RESEARCHER_BACKOFF:.0f})")
    args = parser.parse_args()

    chunk_mode = args.chunk_index is not None and args.total_chunks is not None
    if (args.chunk_index is None) != (args.total_chunks is None):
        print("Error: --chunk-index and --total-chunks must both be provided or both omitted", file=sys.stderr)
        sys.exit(1)
    if args.researcher_retries < 1:
        print("Error: --researcher-retries must be at least 1", file=sys.stderr)
        sys.exit(1)
    if args.researcher_retry_backoff < 0:
        print("Error: --researcher-retry-backoff cannot be negative", file=sys.stderr)
        sys.exit(1)

    env_var, call_llm, kw_model, summary_model = PROVIDERS[args.provider]
    api_key = os.environ.get(env_var)
    if not api_key:
        print(f"Set {env_var} environment variable", file=sys.stderr)
        sys.exit(1)

    if args.validate_only:
        try:
            validate_api_key(args.provider, call_llm, api_key, kw_model)
        except Exception as e:
            print(f"ERROR: {args.provider} API key validation failed: {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.input is None or args.output is None:
        parser.error("--input and --output are required unless --validate-only is used")

    all_groups = group_by_researcher(args.input)
    print(f"Loaded {len(all_groups)} researchers total")

    if chunk_mode:
        groups = slice_groups(all_groups, args.chunk_index, args.total_chunks)
        print(f"Chunk {args.chunk_index}/{args.total_chunks}: processing {len(groups)} researchers")
    else:
        groups = all_groups

    # Progress sidecar — chunk-specific filename in chunk mode
    if chunk_mode:
        progress_path = args.output.parent / f"summaries_progress_{args.chunk_index}.json"
    else:
        progress_path = args.output.parent / "summaries_progress.json"

    progress = load_progress(progress_path) if args.resume else {}

    if progress:
        completed = sum(1 for sid in groups if is_successful_progress_entry(progress.get(sid)))
        failed = sum(1 for sid in groups if progress.get(sid, {}).get("status") == "failed")
        print(f"Resuming: {completed}/{len(groups)} researchers already completed, {failed} marked for retry")

    remaining = [
        (sid, data)
        for sid, data in groups.items()
        if not is_successful_progress_entry(progress.get(sid))
    ]
    print(f"Researchers to process: {len(remaining)}")
    print(f"Models: keywords={kw_model}, summaries={summary_model}")
    print(f"Researcher retries: {args.researcher_retries} attempts")

    for scholar_id, data in remaining:
        profile = data["profile"]
        name = profile["name"]
        overall_idx = list(groups.keys()).index(scholar_id) + 1
        emit_summary_progress(
            "pending", scholar_id, name, args.chunk_index, overall_idx,
            max_attempts=args.researcher_retries,
        )

    failures: list[dict] = []
    for i, (scholar_id, data) in enumerate(remaining):
        profile = data["profile"]
        papers = data["papers"]
        name = profile["name"]
        overall_idx = list(groups.keys()).index(scholar_id) + 1

        keywords = ""
        summary = ""
        success_attempt = 0
        last_error = "Unknown error"

        for attempt in range(1, args.researcher_retries + 1):
            emit_summary_progress(
                "running", scholar_id, name, args.chunk_index, overall_idx,
                attempt=attempt, max_attempts=args.researcher_retries,
            )
            try:
                keywords, summary = generate_for_researcher(
                    profile, papers, call_llm, api_key, args.rate_delay,
                    kw_model, summary_model,
                )
                success_attempt = attempt
                break
            except Exception as e:
                last_error = redact_error(e, api_key)
                if attempt < args.researcher_retries:
                    delay = args.researcher_retry_backoff * (2 ** (attempt - 1))
                    emit_summary_progress(
                        "retrying", scholar_id, name, args.chunk_index, overall_idx,
                        attempt=attempt + 1, max_attempts=args.researcher_retries,
                        error=last_error, retry_delay_sec=delay,
                    )
                    print(
                        f"  [{overall_idx}/{len(groups)}] {name} failed attempt "
                        f"{attempt}/{args.researcher_retries}: {last_error}; retrying in {delay:.0f}s",
                        flush=True,
                    )
                    time.sleep(delay)
                else:
                    emit_summary_progress(
                        "failed", scholar_id, name, args.chunk_index, overall_idx,
                        attempt=attempt, max_attempts=args.researcher_retries,
                        error=last_error,
                    )

        if success_attempt:
            # Save immediately so we never lose progress
            save_progress_entry(progress_path, scholar_id, keywords, summary, success_attempt)
            progress[scholar_id] = {
                "status": "success",
                "keywords": keywords,
                "summary": summary,
                "attempts": success_attempt,
            }
            emit_summary_progress(
                "success", scholar_id, name, args.chunk_index, overall_idx,
                attempt=success_attempt, max_attempts=args.researcher_retries,
            )
            suffix = f" after {success_attempt} attempts" if success_attempt > 1 else ""
            print(f"  [{overall_idx}/{len(groups)}] {name} — done{suffix} ({i+1}/{len(remaining)} this run)", flush=True)
        else:
            save_progress_failure(progress_path, scholar_id, name, last_error, args.researcher_retries)
            progress[scholar_id] = {
                "status": "failed",
                "name": name,
                "keywords": "",
                "summary": "",
                "attempts": args.researcher_retries,
                "error": last_error,
            }
            failures.append({
                "google_scholar_id": scholar_id,
                "name": name,
                "error": last_error,
                "attempts": args.researcher_retries,
            })
            print(
                f"  [{overall_idx}/{len(groups)}] {name} — failed after "
                f"{args.researcher_retries} attempts: {last_error}",
                flush=True,
            )

    success_count = sum(1 for sid in groups if is_successful_progress_entry(progress.get(sid)))
    failed_entries = [
        {
            "google_scholar_id": sid,
            "name": groups[sid]["profile"]["name"],
            "error": progress.get(sid, {}).get("error", "Unknown error"),
            "attempts": progress.get(sid, {}).get("attempts", args.researcher_retries),
        }
        for sid in groups
        if progress.get(sid, {}).get("status") == "failed"
    ]

    # In chunk mode, skip writing the enriched CSV — merge_summaries.py handles that
    if chunk_mode:
        print(f"\nChunk {args.chunk_index} complete: {success_count}/{len(groups)} researchers succeeded")
        print(f"Progress: {progress_path}")
    else:
        if failed_entries:
            print(
                "SUMMARY_FAILURES_JSON:" + json.dumps({"failed": failed_entries}, ensure_ascii=False),
                flush=True,
            )
            print(f"ERROR: {len(failed_entries)} researchers failed summary generation", file=sys.stderr)
            sys.exit(1)
        print(f"\nWriting enriched CSV...")
        write_enriched_csv(args.output, groups, progress)
        print(f"Output: {args.output}")
        print(f"Progress: {progress_path} ({success_count} researchers)")

    if failed_entries:
        print(
            "SUMMARY_FAILURES_JSON:" + json.dumps({"failed": failed_entries}, ensure_ascii=False),
            flush=True,
        )
        print(f"ERROR: {len(failed_entries)} researchers failed summary generation", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
