"""
Orchestrator: runs the full pipeline from scraped profiles to map data.

Steps:
  1. combine_profiles.py   — merge per-researcher data into combined CSV
  2. generate_summaries.py — call LLM to add keywords + summaries
  3. generate_map_data.py  — embeddings + UMAP + data.ndjson + grid.json
  4. download_images.py    — download researcher profile photos

Usage:
    python run_pipeline.py \
        --profiles-dir ./Researcher_Profiles \
        --output-dir ./output \
        --provider gemini

Environment variables:
    GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (depending on --provider)
"""

import argparse
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], description: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {description}")
    print(f"{'='*60}\n")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        print(f"\nERROR: {description} failed (exit code {result.returncode})")
        sys.exit(result.returncode)


def main():
    parser = argparse.ArgumentParser(description="Run the full research map pipeline")
    parser.add_argument("--profiles-dir", type=Path, required=True, help="Path to Researcher_Profiles directory")
    parser.add_argument("--output-dir", type=Path, default=Path("output"), help="Output directory for all generated files")
    parser.add_argument("--provider", choices=["gemini", "openai", "anthropic"], default="gemini", help="LLM provider for summaries")
    parser.add_argument("--rate-delay", type=float, default=2.0, help="Seconds between LLM API calls")
    parser.add_argument("--resume", action="store_true", help="Resume LLM generation from partial output")
    parser.add_argument("--skip-summaries", action="store_true", help="Skip LLM step (use if enriched CSV already exists)")
    parser.add_argument("--skip-images", action="store_true", help="Skip image download step")
    args = parser.parse_args()

    pipeline_dir = Path(__file__).parent
    args.output_dir.mkdir(parents=True, exist_ok=True)

    combined_csv = args.output_dir / "combined_researcher_papers.csv"
    enriched_csv = args.output_dir / "enriched_researcher_papers.csv"
    images_dir = args.output_dir / "public" / "images" / "researchers"

    # Step 1: Combine profiles
    run(
        [sys.executable, str(pipeline_dir / "combine_profiles.py"),
         "--input", str(args.profiles_dir),
         "--output", str(combined_csv)],
        "Step 1/4: Combining researcher profiles",
    )

    # Step 2: Generate LLM summaries
    if args.skip_summaries:
        print("\nSkipping LLM summaries (--skip-summaries)")
        if not enriched_csv.exists():
            print(f"ERROR: {enriched_csv} does not exist. Cannot skip summaries.")
            sys.exit(1)
    else:
        cmd = [
            sys.executable, str(pipeline_dir / "generate_summaries.py"),
            "--input", str(combined_csv),
            "--output", str(enriched_csv),
            "--provider", args.provider,
            "--rate-delay", str(args.rate_delay),
        ]
        if args.resume:
            cmd.append("--resume")
        run(cmd, "Step 2/4: Generating LLM keywords + summaries")

    # Step 3: Generate map data (embeddings + UMAP + ndjson + grid)
    run(
        [sys.executable, str(pipeline_dir / "generate_map_data.py"),
         "--input", str(enriched_csv),
         "--output-dir", str(args.output_dir)],
        "Step 3/4: Generating embeddings + UMAP + map data",
    )

    # Step 4: Download researcher images
    if args.skip_images:
        print("\nSkipping image download (--skip-images)")
    else:
        run(
            [sys.executable, str(pipeline_dir / "download_images.py"),
             "--input", str(enriched_csv),
             "--output-dir", str(images_dir)],
            "Step 4/4: Downloading researcher profile images",
        )

    print(f"\n{'='*60}")
    print(f"  Pipeline complete!")
    print(f"{'='*60}")
    print(f"\nOutput files in {args.output_dir}/:")
    print(f"  combined_researcher_papers.csv")
    print(f"  enriched_researcher_papers.csv")
    print(f"  data.ndjson")
    print(f"  grid.json")
    print(f"  embeddings.csv")
    if not args.skip_images:
        print(f"  public/images/researchers/")


if __name__ == "__main__":
    main()
