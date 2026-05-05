"""Resolve placeholder names in researchers.csv using ScholarMine.

When users provide only Scholar URLs (no names), the CSV contains Scholar IDs
as placeholder names. This script fetches the real author name from each
Google Scholar profile page — one lightweight request per researcher, no
full paper scraping.
"""

import csv
import re
import sys
import time


def is_placeholder_name(name: str, scholar_url: str) -> bool:
    """Check if a name is a placeholder (Scholar ID or auto-generated)."""
    match = re.search(r"[?&]user=([^&]+)", scholar_url)
    if not match:
        return False
    scholar_id = match.group(1)
    return (
        name == scholar_id
        or name.startswith("researcher_")
        or re.fullmatch(r"[A-Za-z0-9_-]{10,14}", name) is not None
    )


def resolve_names(csv_path: str) -> int:
    from scholarmine.scraper import TorScholarSearch

    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    if not rows or not fieldnames:
        print("No rows found in CSV")
        return 0

    to_resolve = [
        i
        for i, row in enumerate(rows)
        if is_placeholder_name(
            row.get("name", "").strip(),
            row.get("google_scholar_url", "").strip(),
        )
    ]

    if not to_resolve:
        print("All researchers already have real names — nothing to resolve")
        return 0

    print(f"Resolving names for {len(to_resolve)} researcher(s)...")

    scraper = TorScholarSearch()
    resolved = 0

    for idx in to_resolve:
        row = rows[idx]
        url = row["google_scholar_url"].strip()
        match = re.search(r"[?&]user=([^&]+)", url)
        if not match:
            continue
        scholar_id = match.group(1)

        try:
            profile_url = f"https://scholar.google.com/citations?user={scholar_id}&hl=en"
            html = scraper.visit_author_profile_with_more_papers(profile_url)
            if html:
                name = scraper.extract_author_name_from_profile(html)
                if name and name != "Unknown Author":
                    print(f"  {row['name']} -> {name}")
                    rows[idx]["name"] = name
                    resolved += 1
                else:
                    print(f"  Could not resolve: {row['name']}")
            else:
                print(f"  Failed to fetch profile: {row['name']}")
        except Exception as e:
            print(f"  Error for {row['name']}: {e}")

        time.sleep(1)

    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Resolved {resolved}/{len(to_resolve)} names")
    return resolved


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <researchers.csv>")
        sys.exit(1)
    resolve_names(sys.argv[1])
