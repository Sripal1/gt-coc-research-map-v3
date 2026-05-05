"""Split a CSV file into chunks for parallel processing."""

import csv
import sys


def split_csv(input_file: str, chunk_index: int, chunk_size: int, output_file: str):
    with open(input_file, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    start = chunk_index * chunk_size
    end = start + chunk_size
    chunk_rows = rows[start:end]

    with open(output_file, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(chunk_rows)

    print(f"Chunk {chunk_index}: rows {start}-{min(end, len(rows))} of {len(rows)} ({len(chunk_rows)} rows)")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <input.csv> <chunk_index> <chunk_size> <output.csv>")
        sys.exit(1)

    split_csv(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
