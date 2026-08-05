# `/tools` — build-time only

Everything in this directory runs once, on a developer's or CI machine, and
produces static JSON in `/public/data`. **None of it ships.**

| | |
|---|---|
| `requirements.txt` | Python 3.11 deps, pinned so output is reproducible |
| `generate_ingress.py` | emits `moon-ingress.json` / `sun-ingress.json` (CLAUDE.md §4) |
| `validate_ingress.mjs` | cross-checks them against Astronomy Engine (§6) — *Phase 3* |
| `trim_geonames.py` | emits `cities.json` (§5) — *Phase 2* |

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

## Current output

Regenerated tables should match these numbers; a material change means
something moved.

```
moon   18,609 ingresses  160.42/yr   gaps 2814–3667 min   93 KB raw / 31 KB gz
sun     1,392 ingresses   12.00/yr   gaps 42395–45298 min  8 KB raw /  2 KB gz
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
