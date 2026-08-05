# `/tools` — build-time only

Everything in this directory runs once, on a developer's or CI machine, and
produces static JSON in `/public/data`. **None of it ships.**

| | |
|---|---|
| `requirements.txt` | Python 3.11 deps, pinned so output is reproducible |
| `generate_ingress.py` | emits `moon-ingress.json` / `sun-ingress.json` (CLAUDE.md §4) |
| `gen_tz_fixtures.py` | emits `tests/fixtures/tz-cases.json` from real tzdata (§5) |
| `trim_geonames.py` | emits `cities.json` from the GeoNames dump (§5) |
| `validate_ingress.mjs` | cross-checks the tables against Astronomy Engine (§6) — *Phase 3* |

## Setup

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
npm run generate                      # ~6 min for both tables
```

`generate_ingress.py` finds the DE421 kernel in this order:
`$MOONFINDER_DE421` → `tools/.cache/de421.bsp` → the `skyfield-data` package →
Skyfield's downloader. Only the last needs network access, so build hosts that
cannot reach `naif.jpl.nasa.gov` should install `skyfield-data` (it is in
`requirements.txt`) or drop a kernel in `tools/.cache/`. The kernel is ~16 MB
and is never committed.

## City data

`cities15000.txt` is ~12 MB and CC-BY 4.0, so it is not committed. Fetch it,
then build the index:

```sh
mkdir -p tools/.cache && cd tools/.cache
curl -O https://download.geonames.org/export/dump/cities15000.zip
curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
unzip cities15000.zip && cd ../..
npm run cities
```

`admin1CodesASCII.txt` is optional but wanted: with it the autocomplete shows
"Île-de-France" instead of the raw GeoNames code "11".

At ~25,000 rows the output lands near 0.8 MB raw, comfortably under the 1.5 MB
target in §5 (timezone ids and country codes are interned rather than repeated).
**It must not sit on the first-load critical path** — §11 budgets 400 KB gzipped
for that, so `cities.ts` should fetch this when the city field is first focused.

GeoNames attribution goes in the footer; CC-BY requires it.

## Current output

Regenerated tables should match these numbers; a material change means
something moved.

```
moon   18,609 ingresses  160.42/yr   gaps 2814–3667 min   93 KB raw / 31 KB gz
sun     1,392 ingresses   12.00/yr   gaps 42395–45298 min  8 KB raw /  2 KB gz
tz      818 fixture cases  226 ambiguous, 224 shifted
```

## Rules

- The generated JSON **is committed**. Vercel builds run `npm run build` with no
  Python available, so regeneration is a local step and the tables are inputs to
  the deploy, not build products of it. `npm run validate` is Node-only by
  design and does run on Vercel.
- Nothing in `/public/data` may require anything from this directory at runtime.
  If the browser or `/api/subscribe` ever needs to import from `/tools`, the
  architecture has drifted — the answer belongs in the precomputed table, not in
  a live computation (CLAUDE.md §1).
- Keep the ephemeris stack out of `package.json` `dependencies`. There is no
  `dependencies` block at all right now; that is deliberate.
- New build steps get an `npm run` script rather than a line in a wiki.
