"""
Download researcher profile images from Google Scholar.

Reads the enriched CSV (or embeddings.csv) to get scholar IDs, downloads
each researcher's profile photo, and saves to an output directory.

Usage:
    python download_images.py --input enriched.csv --output-dir ./public/images/researchers
"""

import argparse
import csv
import json
import time
import urllib.request
from pathlib import Path


PHOTO_URL_TEMPLATE = "https://scholar.googleusercontent.com/citations?view_op=view_photo&user={}&citpid=2"
DEFAULT_AVATAR = "https://scholar.google.com/citations/images/avatar_scholar_256.png"


def download_image(url: str, filepath: Path, timeout: int = 10) -> bool:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if not content_type.startswith("image/"):
                return False
            data = resp.read()
            if len(data) == 0:
                return False
            with open(filepath, "wb") as f:
                f.write(data)
            return True
    except Exception as e:
        print(f"    Error: {e}")
        return False


def get_unique_researchers(input_path: Path) -> list[dict]:
    seen = set()
    researchers = []
    with open(input_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = row.get("google_scholar_id", "")
            if sid and sid not in seen:
                seen.add(sid)
                researchers.append({
                    "name": row.get("researcher_name", ""),
                    "google_scholar_id": sid,
                })
    return researchers


def main():
    parser = argparse.ArgumentParser(description="Download researcher profile images")
    parser.add_argument("--input", "-i", type=Path, required=True, help="CSV with google_scholar_id column")
    parser.add_argument("--output-dir", "-o", type=Path, default=Path("public/images/researchers"))
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds between downloads (default: 0.5)")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    researchers = get_unique_researchers(args.input)
    print(f"Found {len(researchers)} unique researchers")

    downloaded = 0
    skipped = 0
    failed = 0
    mapping = {}

    for i, r in enumerate(researchers):
        sid = r["google_scholar_id"]
        name = r["name"]
        filename = f"{sid}.jpg"
        filepath = args.output_dir / filename

        if filepath.exists() and filepath.stat().st_size > 0:
            print(f"  [{i+1}/{len(researchers)}] {name} — cached")
            mapping[sid] = f"images/researchers/{filename}"
            skipped += 1
            continue

        url = PHOTO_URL_TEMPLATE.format(sid)
        print(f"  [{i+1}/{len(researchers)}] {name} — downloading")

        if download_image(url, filepath):
            mapping[sid] = f"images/researchers/{filename}"
            downloaded += 1
        else:
            failed += 1

        time.sleep(args.delay)

    # Save mapping
    mapping_path = args.output_dir / "id_to_image_mapping.json"
    with open(mapping_path, "w") as f:
        json.dump(mapping, f, indent=2)

    print(f"\nDone: {downloaded} downloaded, {skipped} cached, {failed} failed")
    print(f"Mapping: {mapping_path}")


if __name__ == "__main__":
    main()
