#!/usr/bin/env python3
"""
Script to download researcher profile images from Google Scholar by Google Scholar ID
and save them locally for use in the AI Map.
"""

import os
import csv
import requests
from urllib.parse import urlparse
import time
from pathlib import Path
import hashlib

def create_directories():
    """Create necessary directories for storing images."""
    images_dir = Path("public/images/researchers")
    images_dir.mkdir(parents=True, exist_ok=True)
    return images_dir

def get_google_scholar_image_url(google_scholar_id):
    """
    Construct the Google Scholar profile image URL from the scholar ID.
    Google Scholar profile images follow a pattern.
    """
    if not google_scholar_id or google_scholar_id == "No ID Specified":
        return None

    # Google Scholar image URL pattern
    return f"https://scholar.googleusercontent.com/citations?view_op=view_photo&user={google_scholar_id}&citpid=2"

def download_image(url, filepath, timeout=10):
    """
    Download an image from a URL and save it to the specified filepath.

    Args:
        url (str): The URL to download the image from
        filepath (Path): Path where to save the image
        timeout (int): Request timeout in seconds

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }

        response = requests.get(url, headers=headers, timeout=timeout, stream=True)
        response.raise_for_status()

        # Check if the response contains an image
        content_type = response.headers.get('content-type', '')
        if not content_type.startswith('image/'):
            print(f"Warning: URL {url} did not return an image (content-type: {content_type})")
            return False

        # Save the image
        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        # Verify the file was created and has content
        if filepath.exists() and filepath.stat().st_size > 0:
            return True
        else:
            return False

    except requests.exceptions.RequestException as e:
        print(f"Error downloading {url}: {e}")
        return False
    except Exception as e:
        print(f"Unexpected error downloading {url}: {e}")
        return False

def get_researcher_data(csv_file_path):
    """
    Read researcher data from CSV file and extract Google Scholar IDs.

    Args:
        csv_file_path (str): Path to the CSV file containing researcher data

    Returns:
        list: List of dictionaries containing researcher data
    """
    researchers = []

    try:
        with open(csv_file_path, 'r', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                researchers.append({
                    'name': row.get('researcher_name', ''),
                    'google_scholar_id': row.get('google_scholar_id', ''),
                    'profile_url': row.get('profile_url', '')
                })
    except Exception as e:
        print(f"Error reading CSV file: {e}")

    return researchers

def sanitize_filename(name):
    """
    Sanitize a researcher name to create a valid filename.

    Args:
        name (str): Researcher name

    Returns:
        str: Sanitized filename
    """
    # Remove or replace invalid characters
    sanitized = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    # Replace spaces with underscores
    sanitized = sanitized.replace(' ', '_')
    # Limit length
    sanitized = sanitized[:50]
    return sanitized

def main():
    print("Starting researcher image download process...")

    # Create directories
    images_dir = create_directories()

    # Find the CSV file with researcher data
    csv_files = [
        "data/combined_researcher_papers.csv",
        "public/prof-abstract.csv",
        "combinedData.csv"
    ]

    csv_file = None
    for file_path in csv_files:
        if os.path.exists(file_path):
            csv_file = file_path
            break

    if not csv_file:
        print("Error: Could not find researcher data CSV file")
        print(f"Looked for: {csv_files}")
        return

    print(f"Using CSV file: {csv_file}")

    # Get researcher data
    researchers = get_researcher_data(csv_file)
    print(f"Found {len(researchers)} researchers")

    downloaded = 0
    skipped = 0
    failed = 0

    # Track mapping of scholar ID to local image path
    id_to_image_mapping = {}

    for i, researcher in enumerate(researchers):
        name = researcher['name']
        google_scholar_id = researcher['google_scholar_id']

        if not google_scholar_id or google_scholar_id == "No ID Specified":
            print(f"[{i+1}/{len(researchers)}] Skipping {name} - No Google Scholar ID")
            skipped += 1
            continue

        # Create filename based on scholar ID to ensure uniqueness
        filename = f"{google_scholar_id}.jpg"
        filepath = images_dir / filename

        # Skip if already downloaded
        if filepath.exists():
            print(f"[{i+1}/{len(researchers)}] Already exists: {name} ({google_scholar_id})")
            id_to_image_mapping[google_scholar_id] = f"images/researchers/{filename}"
            skipped += 1
            continue

        # Get the image URL
        image_url = get_google_scholar_image_url(google_scholar_id)
        if not image_url:
            print(f"[{i+1}/{len(researchers)}] Skipping {name} - Could not construct image URL")
            skipped += 1
            continue

        print(f"[{i+1}/{len(researchers)}] Downloading: {name} ({google_scholar_id})")

        # Download the image
        if download_image(image_url, filepath):
            print(f"  ✓ Successfully downloaded to {filename}")
            id_to_image_mapping[google_scholar_id] = f"images/researchers/{filename}"
            downloaded += 1
        else:
            print(f"  ✗ Failed to download")
            failed += 1

        # Be polite to Google's servers
        time.sleep(0.5)

    # Save the mapping to a JSON file for easy reference
    import json
    mapping_file = images_dir / "id_to_image_mapping.json"
    with open(mapping_file, 'w') as f:
        json.dump(id_to_image_mapping, f, indent=2)

    print(f"\nDownload complete!")
    print(f"Downloaded: {downloaded}")
    print(f"Skipped: {skipped}")
    print(f"Failed: {failed}")
    print(f"Total: {len(researchers)}")
    print(f"Mapping saved to: {mapping_file}")

if __name__ == "__main__":
    main()