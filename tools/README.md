# `/tools` — build-time only

Everything in this directory runs once, at build time, on a developer's or
CI machine. **None of it ships.**

- `requirements.txt` — Python 3.11 deps (Skyfield, etc.)
- `generate_ingress.py` — walks 1920–2035 and emits `moon-ingress.json` /
  `sun-ingress.json` into `/public/data`, with hard self-check assertions
  before it will write output (see `CLAUDE.md` §4)
- `validate_ingress.mjs` — cross-checks every ingress in those tables against
  Astronomy Engine, an independent implementation (see `CLAUDE.md` §6);
  wired into `npm run validate`, a prerequisite of `npm run build`
- `trim_geonames.py` — reduces GeoNames `cities15000.txt` to the fields the
  city autocomplete needs and writes `/public/data/cities.json`

## Rules

- The Python ephemeris stack (Skyfield, `de421.bsp`) must never appear in
  `package.json` `dependencies`, and none of this directory's output should
  reference or require anything here at runtime. If a browser or the
  `/api/subscribe` function needs to import from `/tools`, that's a sign the
  architecture has drifted — the answer belongs in the precomputed table in
  `/public/data`, not in a live computation.
- If you add a new build step here, wire it into the relevant `npm run`
  script rather than expecting it to be run by hand.
