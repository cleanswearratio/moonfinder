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

Pre-build. `CLAUDE.md` is written; implementation has not started. See its
Definition of Done (§11) for what "shipped" means.

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
