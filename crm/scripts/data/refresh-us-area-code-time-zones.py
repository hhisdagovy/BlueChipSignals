#!/usr/bin/env python3
"""Refresh the CRM's U.S. area-code time-zone lookup from NANPA."""

from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path


DEFAULT_SOURCE = "https://reports.nanpa.com/public/npa_report.csv"
DEFAULT_OUTPUT = Path(__file__).with_name("us-area-code-time-zones.js")
ORDERED_LABELS = ["Eastern", "Central", "Mountain", "Pacific", "Alaska", "Hawaii", "Unknown"]
UNSUPPORTED_LOCATIONS = {"PR", "VI", "GU", "CNMI", "AS"}
CANONICAL_TIME_ZONES = {
    "E": "Eastern",
    "C": "Central",
    "M": "Mountain",
    "P": "Pacific",
    "AK": "Alaska",
    "(UTC-10)": "Hawaii",
}


def main() -> int:
    args = parse_args()
    raw_csv = read_source(args.source)
    file_date, rows = parse_npa_report(raw_csv)
    grouped_codes = build_grouped_codes(rows)
    output = render_module(file_date, grouped_codes)
    args.output.write_text(output, encoding="utf-8")
    print(
        f"Wrote {args.output} with "
        f"{sum(len(grouped_codes[label]) for label in ORDERED_LABELS)} U.S. area codes "
        f"from NANPA file date {file_date or 'unknown'}."
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh crm/scripts/data/us-area-code-time-zones.js from the official NANPA NPA CSV."
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help="NANPA CSV URL or local CSV path. Defaults to the official NANPA public NPA report CSV.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output JS module path. Defaults to {DEFAULT_OUTPUT}.",
    )
    return parser.parse_args()


def read_source(source: str) -> str:
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source) as response:
            return response.read().decode("utf-8")

    return Path(source).read_text(encoding="utf-8")


def parse_npa_report(raw_csv: str) -> tuple[str, list[dict[str, str]]]:
    reader = list(csv.reader(io.StringIO(raw_csv)))

    if len(reader) < 3:
        raise ValueError("Unexpected NANPA CSV format: not enough rows.")

    meta_row = reader[0]
    headers = reader[1]
    file_date = meta_row[1].strip() if len(meta_row) > 1 else ""
    rows = [dict(zip(headers, row)) for row in reader[2:]]
    return file_date, rows


def build_grouped_codes(rows: list[dict[str, str]]) -> dict[str, list[str]]:
    grouped = defaultdict(list)

    for row in rows:
        if not is_supported_us_geographic_area_code(row):
            continue

        label = resolve_group_label(row)
        grouped[label].append(row["NPA_ID"])

    for label in ORDERED_LABELS:
        grouped[label] = sorted(grouped[label], key=lambda value: int(value))

    return grouped


def is_supported_us_geographic_area_code(row: dict[str, str]) -> bool:
    return (
        row.get("COUNTRY") == "US"
        and row.get("USE") == "G"
        and row.get("ASSIGNED") == "Yes"
        and row.get("IN_SERVICE") == "Y"
    )


def resolve_group_label(row: dict[str, str]) -> str:
    if row.get("LOCATION") in UNSUPPORTED_LOCATIONS:
        return "Unknown"

    return CANONICAL_TIME_ZONES.get(row.get("TIME_ZONE", "").strip(), "Unknown")


def render_module(file_date: str, grouped_codes: dict[str, list[str]]) -> str:
    lines = [f"// Generated from NANPA npa_report.csv file dated {file_date or 'unknown'}.",
             "export const US_AREA_CODE_TIME_ZONE_GROUPS = Object.freeze({"]

    for label in ORDERED_LABELS:
        values = ", ".join(f"'{value}'" for value in grouped_codes[label])
        lines.append(f"    {label}: Object.freeze([{values}]),")

    lines.append("});")
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # pragma: no cover - CLI guard
        print(f"Failed to refresh NANPA area-code data: {error}", file=sys.stderr)
        raise SystemExit(1)
