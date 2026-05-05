"""
Generate embeddings, UMAP coordinates, data.ndjson, and grid.json from the
enriched combined_researcher_papers.csv.

Uses the same WizMap functions as the example.ipynb notebook.

Steps:
  1. Load enriched CSV (with ai_generated_keywords + ai_generated_summary)
  2. Embed each paper's text with gte-small (384-dim)
  3. Group by researcher, take median embedding
  4. UMAP to 2D
  5. Use WizMap functions to output data.ndjson + grid.json

Usage:
    python generate_map_data.py --input enriched.csv --output-dir ./output
"""

import argparse
import csv
import json
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd

from wizmap_utils import generate_grid_dict, generate_data_list, save_json_files


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def load_model():
    from transformers import AutoTokenizer, AutoModel
    print("Loading gte-small model...")
    tokenizer = AutoTokenizer.from_pretrained("thenlper/gte-small")
    model = AutoModel.from_pretrained("thenlper/gte-small")
    return tokenizer, model


def get_embedding(text: str, tokenizer, model):
    import torch
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True, max_length=512)
    with torch.no_grad():
        outputs = model(**inputs)
    embedding = outputs.last_hidden_state.mean(dim=1).squeeze().numpy()
    return embedding


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate map data (embeddings + UMAP + ndjson + grid)")
    parser.add_argument("--input", "-i", type=Path, required=True, help="Enriched combined CSV (with ai_generated columns)")
    parser.add_argument("--output-dir", "-o", type=Path, default=Path("."), help="Directory for data.ndjson and grid.json")
    parser.add_argument("--umap-neighbors", type=int, default=5)
    parser.add_argument("--umap-min-dist", type=float, default=0.15)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--allow-incomplete-summaries", action="store_true",
                        help="Continue even when AI summary fields are blank")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load CSV into DataFrame (same as notebook)
    print("Loading data...")
    df = pd.read_csv(args.input)
    print(f"  {len(df)} rows")

    required_summary_cols = ["ai_generated_keywords", "ai_generated_summary"]
    missing_cols = [col for col in required_summary_cols if col not in df.columns]
    if missing_cols:
        print(f"ERROR: Missing required summary columns: {', '.join(missing_cols)}", file=sys.stderr)
        sys.exit(1)

    def is_blank_summary(value) -> bool:
        if pd.isna(value):
            return True
        text = str(value).strip()
        return text == "" or text == "Error generating summary"

    incomplete_rows = df[
        df["ai_generated_keywords"].apply(is_blank_summary)
        | df["ai_generated_summary"].apply(is_blank_summary)
    ]
    if not incomplete_rows.empty and not args.allow_incomplete_summaries:
        failed = []
        for _, row in incomplete_rows.drop_duplicates("google_scholar_id").iterrows():
            failed.append({
                "google_scholar_id": row.get("google_scholar_id", ""),
                "name": row.get("researcher_name", ""),
                "status": "missing_summary",
            })
        print(f"ERROR: {len(failed)} researchers have missing or failed AI summaries", file=sys.stderr)
        for item in failed[:10]:
            print(f"  - {item['name']} ({item['google_scholar_id']})", file=sys.stderr)
        if len(failed) > 10:
            print(f"  ... and {len(failed) - 10} more", file=sys.stderr)
        print("SUMMARY_FAILURES_JSON:" + json.dumps({"failed": failed}, ensure_ascii=False))
        sys.exit(1)

    # 2. Create text to embed (same as notebook: title + abstract + ai_keywords + researcher_keywords)
    df["text_to_embed"] = (
        df["paper_title"].fillna("")
        + " " + df["paper_abstract"].fillna("")
        + " " + df["ai_generated_keywords"].fillna("")
        + " " + df["researcher_keywords"].fillna("")
    ).astype(str)

    # 3. Generate embeddings per paper
    tokenizer, model = load_model()

    print("Generating embeddings...")
    embeddings = []
    for i, text in enumerate(df["text_to_embed"].tolist()):
        emb = get_embedding(text, tokenizer, model)
        embeddings.append(emb)
        if (i + 1) % 100 == 0 or i == len(df) - 1:
            print(f"  [{i+1}/{len(df)}] embedded")

    df["embedding"] = embeddings

    # 4. Group by researcher, take median embedding (same as notebook)
    def median_embedding(x):
        return np.median(np.vstack(x), axis=0)

    def first_value(x):
        return x.iloc[0]

    output_columns = [
        "researcher_name", "profile_url", "google_scholar_id", "affiliation",
        "researcher_total_citations", "researcher_keywords", "researcher_homepage",
        "paper_abstract", "ai_generated_keywords", "ai_generated_summary",
    ]

    agg_dict = {"embedding": median_embedding}
    for col in output_columns:
        if col != "google_scholar_id":
            agg_dict[col] = first_value

    researcher_df = df.groupby("google_scholar_id").agg(agg_dict).reset_index()
    print(f"  {len(researcher_df)} unique researchers")

    # 5. UMAP (same as notebook)
    import umap
    print("Running UMAP...")
    emb_matrix = np.vstack(researcher_df["embedding"].values)

    reducer = umap.UMAP(
        n_neighbors=args.umap_neighbors,
        min_dist=args.umap_min_dist,
        n_components=2,
        random_state=args.seed,
    )
    coords_2d = reducer.fit_transform(emb_matrix)

    researcher_df["x"] = coords_2d[:, 0]
    researcher_df["y"] = coords_2d[:, 1]

    # 6. Create picture URLs (same as notebook)
    researcher_df["picture_url"] = (
        "https://scholar.google.com/citations?view_op=medium_photo&user="
        + researcher_df["google_scholar_id"]
    )

    # 7. Convert embeddings to string format (same as notebook)
    researcher_df["embedding_array"] = researcher_df["embedding"].apply(
        lambda x: str(x.tolist())
    )

    # 8. Fix newline characters in summaries and handle missing values
    researcher_df["ai_generated_summary"] = (
        researcher_df["ai_generated_summary"]
        .fillna("Error generating summary")
        .str.replace("\\n", "\n", regex=False)
    )
    researcher_df["ai_generated_keywords"] = (
        researcher_df["ai_generated_keywords"].fillna("Error generating summary")
    )

    # 9. Generate data list using WizMap function (same as notebook)
    xs = researcher_df["x"].tolist()
    ys = researcher_df["y"].tolist()

    print("Generating data list (WizMap)...")
    data_list = generate_data_list(
        xs, ys,
        researcher_df["ai_generated_keywords"].tolist(),
        embeddings=researcher_df["embedding_array"].tolist(),
        labels=researcher_df["researcher_name"].tolist(),
        citations=researcher_df["researcher_total_citations"].tolist(),
        scholarURLs=researcher_df["picture_url"].tolist(),
        resSummaries=researcher_df["ai_generated_summary"].tolist(),
        googleScholarURLs=researcher_df["profile_url"].tolist(),
        googleScholarKeywords=researcher_df["researcher_keywords"].tolist(),
        affiliations=researcher_df["affiliation"].tolist(),
        homePageURLs=researcher_df["researcher_homepage"].tolist(),
    )

    # 10. Generate grid dict using WizMap function (same as notebook)
    print("Generating grid dict (WizMap)...")
    grid_dict = generate_grid_dict(
        xs, ys,
        researcher_df["ai_generated_keywords"].tolist(),
    )

    # 11. Save output files
    print("Saving output files...")
    save_json_files(data_list, grid_dict, output_dir=str(args.output_dir))

    # 12. Also save embeddings.csv for reference (same as notebook)
    emb_csv_columns = output_columns + ["x", "y", "embedding_array"]
    researcher_df[emb_csv_columns].to_csv(
        args.output_dir / "embeddings.csv", index=False,
    )

    print(f"\nDone! Output files in {args.output_dir}/")
    print(f"  data.ndjson  ({len(researcher_df)} researchers)")
    print(f"  grid.json    (200x200 KDE grid + topics)")
    print(f"  embeddings.csv")


if __name__ == "__main__":
    main()
