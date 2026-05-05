"""
Combine per-researcher ScholarMine data into a single CSV.

Reads each Researcher_Profiles/{scholar_id}/profile.json + papers.csv
and outputs combined_researcher_papers.csv matching the ai-map format.

Usage:
    python combine_profiles.py --input ../Researcher_Profiles --output combined_researcher_papers.csv
"""

import argparse
import csv
import json
import sys
from pathlib import Path


OUTPUT_COLUMNS = [
    "researcher_name",
    "profile_url",
    "google_scholar_id",
    "affiliation",
    "researcher_total_citations",
    "researcher_keywords",
    "researcher_homepage",
    "paper_title",
    "paper_citations",
    "paper_year",
    "paper_url",
    "paper_abstract",
]


def load_profile(profile_path: Path) -> dict:
    with open(profile_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_papers(papers_path: Path) -> list[dict]:
    rows = []
    with open(papers_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def combine(input_dir: Path, output_path: Path) -> None:
    researcher_dirs = sorted(
        [d for d in input_dir.iterdir() if d.is_dir()],
        key=lambda d: d.name,
    )

    if not researcher_dirs:
        print(f"No researcher directories found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    total_papers = 0
    skipped = 0

    with open(output_path, "w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()

        for rdir in researcher_dirs:
            profile_path = rdir / "profile.json"
            papers_path = rdir / "papers.csv"

            if not profile_path.exists():
                print(f"  Skipping {rdir.name}: no profile.json", file=sys.stderr)
                skipped += 1
                continue

            if not papers_path.exists():
                print(f"  Skipping {rdir.name}: no papers.csv", file=sys.stderr)
                skipped += 1
                continue

            profile = load_profile(profile_path)
            papers = load_papers(papers_path)

            for paper in papers:
                description = paper.get("Description", "")
                if description == "Description not available":
                    description = ""

                writer.writerow({
                    "researcher_name": profile.get("author_name", ""),
                    "profile_url": profile.get("profile_url", ""),
                    "google_scholar_id": profile.get("scholar_id", ""),
                    "affiliation": profile.get("author_affiliation", ""),
                    "researcher_total_citations": profile.get("author_citations", ""),
                    "researcher_keywords": profile.get("research_keywords", ""),
                    "researcher_homepage": profile.get("homepage", ""),
                    "paper_title": paper.get("Title", ""),
                    "paper_citations": paper.get("Citations", ""),
                    "paper_year": paper.get("Year", ""),
                    "paper_url": paper.get("URL", ""),
                    "paper_abstract": description,
                })
                total_papers += 1

    print(f"Combined {total_papers} papers from {len(researcher_dirs) - skipped} researchers")
    print(f"Skipped {skipped} directories")
    print(f"Output: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Combine ScholarMine profiles into a single CSV")
    parser.add_argument(
        "--input", "-i",
        type=Path,
        required=True,
        help="Path to Researcher_Profiles directory",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path("combined_researcher_papers.csv"),
        help="Output CSV path (default: combined_researcher_papers.csv)",
    )
    args = parser.parse_args()

    if not args.input.is_dir():
        print(f"Input directory does not exist: {args.input}", file=sys.stderr)
        sys.exit(1)

    combine(args.input, args.output)


if __name__ == "__main__":
    main()
