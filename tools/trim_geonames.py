#!/usr/bin/env python3
"""Reduce the GeoNames cities15000 dump to the city index the form needs.

Build-time only. CLAUDE.md §5: keep `[name, admin1, countryCode, tzid, population]`,
sort by population descending, stay under 1.5 MB raw, and build the prefix index
client-side rather than pulling in a search library.

Input is not committed — it is ~12 MB and CC-BY 4.0 licensed. Fetch it first:

    mkdir -p tools/.cache && cd tools/.cache
    curl -O https://download.geonames.org/export/dump/cities15000.zip
    curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
    unzip cities15000.zip
    cd ../.. && npm run cities

`admin1CodesASCII.txt` is optional. With it, admin1 becomes a readable name
("Île-de-France") instead of the raw GeoNames code ("11"), which is what the
autocomplete should show. Without it the code is passed through unchanged.

Encoding note: timezone ids and country codes are interned into lookup arrays and
referenced by index. The logical record is still the five fields §5 asks for —
this only stops ~24,000 copies of "America/Argentina/Buenos_Aires" from dominating
the payload. It roughly halves the file and gzips better.

Attribution for GeoNames belongs in the footer; CC-BY requires it.
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
import zoneinfo
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".cache"
DEFAULT_INPUT = CACHE / "cities15000.txt"
DEFAULT_ADMIN1 = CACHE / "admin1CodesASCII.txt"
DEFAULT_OUTPUT = REPO_ROOT / "public" / "data" / "cities.json"

# Column offsets in the GeoNames dump, which is tab-separated with no header.
COL_NAME, COL_COUNTRY, COL_ADMIN1 = 1, 8, 10
COL_POPULATION, COL_TZID = 14, 17
COLUMNS = 19

TARGET_BYTES = 1_500_000  # §5


def load_admin1(path: Path) -> dict[str, str]:
    """`US.NY -> New York`. Missing file is fine; codes pass through."""
    if not path.is_file():
        return {}
    names: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            names[parts[0]] = parts[1]
    return names


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--admin1", type=Path, default=DEFAULT_ADMIN1)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    ap.add_argument("--max-bytes", type=int, default=TARGET_BYTES)
    args = ap.parse_args()

    if not args.input.is_file():
        fail(f"{args.input} not found. See the header of this file for how to fetch it.")

    admin1_names = load_admin1(args.admin1)
    known_zones = zoneinfo.available_timezones()

    tz_index: dict[str, int] = {}
    country_index: dict[str, int] = {}
    rows: list[tuple[int, str, str, int, int]] = []
    skipped_zone: dict[str, int] = {}
    malformed = 0

    with args.input.open(encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < COLUMNS:
                malformed += 1
                continue

            tzid = parts[COL_TZID].strip()
            # An id the browser cannot resolve would break the conversion for
            # every birth in that city, so drop it here rather than at runtime.
            if tzid not in known_zones:
                skipped_zone[tzid] = skipped_zone.get(tzid, 0) + 1
                continue

            name = parts[COL_NAME].strip()
            country = parts[COL_COUNTRY].strip()
            if not name or not country:
                malformed += 1
                continue

            try:
                population = int(parts[COL_POPULATION] or 0)
            except ValueError:
                malformed += 1
                continue

            admin1_code = parts[COL_ADMIN1].strip()
            admin1 = admin1_names.get(f"{country}.{admin1_code}", admin1_code)

            tz_id = tz_index.setdefault(tzid, len(tz_index))
            country_id = country_index.setdefault(country, len(country_index))
            rows.append((population, name, admin1, country_id, tz_id))

    if not rows:
        fail("no usable rows parsed — is this really the cities15000 dump?")

    # Population descending; name as a tiebreak so the output is stable.
    rows.sort(key=lambda r: (-r[0], r[1]))

    payload = {
        "source": "GeoNames cities15000, CC-BY 4.0, https://www.geonames.org/",
        "fields": ["name", "admin1", "country", "tz", "population"],
        "countries": [c for c, _ in sorted(country_index.items(), key=lambda kv: kv[1])],
        "tz": [t for t, _ in sorted(tz_index.items(), key=lambda kv: kv[1])],
        "cities": [[n, a, c, t, p] for p, n, a, c, t in rows],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    size = len(text.encode("utf-8"))

    if size > args.max_bytes:
        fail(f"output is {size/1e6:.2f} MB, over the {args.max_bytes/1e6:.2f} MB target")

    args.output.write_text(text, encoding="utf-8")

    log(f"wrote {display(args.output)}: {len(rows)} cities, "
        f"{len(tz_index)} zones, {len(country_index)} countries, {size/1e6:.2f} MB raw")
    if not admin1_names:
        log(f"note: {args.admin1.name} absent — admin1 stays a raw GeoNames code")
    if malformed:
        log(f"note: skipped {malformed} malformed row(s)")
    if skipped_zone:
        worst = sorted(skipped_zone.items(), key=lambda kv: -kv[1])[:5]
        log(f"note: dropped {sum(skipped_zone.values())} row(s) with timezone ids this "
            f"tzdata does not know: {', '.join(f'{z} x{n}' for z, n in worst)}")

    # The client folds diacritics when matching, so nothing here needs an ascii
    # column; flag it only if the assumption ever stops holding.
    folded = sum(1 for _, n, _, _, _ in rows[:2000]
                 if unicodedata.normalize("NFD", n) != n)
    log(f"note: {folded}/2000 top names carry diacritics — cities.ts folds on lookup")


def display(path: Path) -> str:
    """Repo-relative when it can be, absolute otherwise (tests write elsewhere)."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


if __name__ == "__main__":
    main()
