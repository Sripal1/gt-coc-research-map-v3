"""
Merge chunk-level summary progress files into one enriched CSV.

Globs summaries_progress_*.json, merges results, and writes the final
enriched_researcher_papers.csv via generate_summaries.write_enriched_csv().

Usage:
    python merge_summaries.py --input combined.csv --output enriched.csv --progress-dir ./output
"""

import argparse
import glob
import json
import sys
from pathlib import Path

from generate_summaries import group_by_researcher, write_enriched_csv


def is_successful_entry(entry: dict | None) -> bool:
    if not isinstance(entry, dict):
        return False
    return (
        entry.get("status", "success") == "success"
        and bool(str(entry.get("keywords", "")).strip())
        and bool(str(entry.get("summary", "")).strip())
    )


def merge_progress_files(progress_dir: Path) -> dict[str, dict]:
    pattern = str(progress_dir / "summaries_progress_*.json")
    files = sorted(glob.glob(pattern))

    if not files:
        print(f"No progress files found matching {pattern}", file=sys.stderr)
        sys.exit(1)

    merged: dict[str, dict] = {}
    for f in files:
        print(f"  Loading {Path(f).name}")
        with open(f, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            merged.update(data)

    print(f"Merged {len(merged)} researchers from {len(files)} progress files")
    return merged


def main():
    parser = argparse.ArgumentParser(description="Merge summary progress files into enriched CSV")
    parser.add_argument("--input", "-i", type=Path, required=True, help="Input combined CSV")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Output enriched CSV")
    parser.add_argument("--progress-dir", type=Path, required=True, help="Directory containing summaries_progress_*.json files")
    parser.add_argument("--allow-incomplete", action="store_true", help="Write output even when some summaries are missing or failed")
    args = parser.parse_args()

    groups = group_by_researcher(args.input)
    print(f"Loaded {len(groups)} researchers from CSV")

    merged = merge_progress_files(args.progress_dir)

    missing = [sid for sid in groups if sid not in merged]
    failed = [sid for sid in groups if sid in merged and not is_successful_entry(merged.get(sid))]
    incomplete = missing + failed

    if incomplete:
        details = []
        if missing:
            print(f"ERROR: {len(missing)} researchers have no summary progress entry")
        if failed:
            print(f"ERROR: {len(failed)} researchers failed or have blank summary data")

        for sid in incomplete:
            entry = merged.get(sid, {})
            details.append({
                "google_scholar_id": sid,
                "name": groups[sid]["profile"]["name"],
                "status": entry.get("status", "missing") if isinstance(entry, dict) else "missing",
                "attempts": entry.get("attempts") if isinstance(entry, dict) else None,
                "error": entry.get("error") if isinstance(entry, dict) else None,
            })

        for item in details[:10]:
            print(f"  - {item['name']} ({item['google_scholar_id']}): {item['status']}")
        if len(details) > 10:
            print(f"  ... and {len(details) - 10} more")
        print("SUMMARY_FAILURES_JSON:" + json.dumps({"failed": details}, ensure_ascii=False))

        if not args.allow_incomplete:
            print("Refusing to write enriched CSV with incomplete summaries.", file=sys.stderr)
            sys.exit(1)

    write_enriched_csv(args.output, groups, merged)
    print(f"Output: {args.output}")
    print(f"Total researchers: {len(groups)}, with summaries: {len(groups) - len(incomplete)}")


if __name__ == "__main__":
    main()
