# Moon Sign Finder

A lead-magnet web app: enter a birth date, time, and city and get an instant
moon sign reveal, free and with no gate. The full report sits behind a single
email field, and the submitted contact is pushed to ActiveCampaign with
structured custom fields for segmentation.

See [`CLAUDE.md`](./CLAUDE.md) for the full technical specification —
architecture decisions, phase-by-phase build plan, design direction, and the
ActiveCampaign integration contract. That file is the source of truth; this
README is a shorter orientation for humans.

## How it works

1. **Build time.** A Python script (Skyfield + `de421.bsp`) walks the tropical
   zodiac from 1920–2035 and records every moment the Moon (and Sun) cross a
   sign boundary. The result is a small delta-encoded JSON table, cross-checked
   against an independent second ephemeris (Astronomy Engine) before the build
   is allowed to succeed.
2. **Run time.** The browser converts the user's local birth time to UTC
   (handling DST ambiguity/gaps explicitly), binary-searches the precomputed
   table, and renders the result. No ephemeris code and no network call is
   involved in producing an answer.
3. **The only server code** is `POST /api/subscribe`, a single Vercel
   Serverless Function that upserts the contact into ActiveCampaign. It never
   recomputes or second-guesses the result the client sends.

## Status

In progress. See the Definition of Done (§11 of `CLAUDE.md`) for what "shipped"
means.

- **Phase 1 — ingress tables.** Done. `npm run generate` emits both tables from
  DE421 and passes every self-check: 18,609 moon ingresses, 1,392 sun, 33 KB
  gzipped combined.
- **Phase 2 — timezone conversion and city data.** Done. `src/lib/tz.ts` inverts
  wall time to UTC through `Intl`, flagging DST-ambiguous and nonexistent
  readings; 25 tests pass against fixtures derived from real tzdata.
  `tools/trim_geonames.py` builds the city index.
- **Phase 3 — cross-validation gate.** Done. `npm run validate` re-checks all
  20,001 boundaries against Astronomy Engine in ~2s and runs as `prebuild`, so a
  disagreeing table cannot reach a deploy.
- **Phase 4 — flow, cusp logic and the ribbon.** Done. Four screens, no
  framework. The reveal renders in 25 ms with no network request, and first load
  is 47.6 KB gzipped against a 400 KB budget.
- **Phase 5 — `/api/subscribe`.** Next.

## Running it

```sh
npm install
npm run dev                    # or: npm run build && npm run preview
```

`npm run build` is gated by the cross-validation in §6 — a table Astronomy
Engine disagrees with cannot reach a deploy. The city index is not committed
(GeoNames is CC-BY); see `tools/README.md` to fetch it. Without it the form
falls back to a short built-in list of major cities.

Two spec constants and one platform assumption were corrected against measured
data during Phases 1–2; each is recorded inline in `CLAUDE.md` beside the text it
revises (§4 for the ingress rate and gap floor, §5 for what `Intl` actually knows
about pre-1976 offsets, §6 for how the validation gate should be stated).

## Stack

Vite + TypeScript (no UI framework) on the frontend, Python/Skyfield as a
build-time-only tool, one Node Vercel Function for ActiveCampaign, deployed to
Vercel. No database, no accounts, no runtime ephemeris — see `CLAUDE.md` §1
for why.

## Attribution

City data from [GeoNames](https://www.geonames.org/) (`cities15000`),
licensed CC-BY 4.0. Attribution appears in the app footer as required by the
license.

## License

TBD.
