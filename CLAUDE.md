# CLAUDE.md — Moon Sign Finder

Lead-magnet web app. User enters birth date, time, and city → instant moon sign
reveal (free, no gate) → email gate for the full report → contact pushed to
ActiveCampaign with structured custom fields.

Read this file fully before writing code. The architecture decisions in
§1 are not suggestions; they are the reason this project is small.

---

## 1. Non-negotiable architecture decisions

1. **No runtime ephemeris.** The Moon's sign changes ~157 times per year.
   Precompute every sign-ingress moment once at build time and ship it as a
   static asset. Lookup at runtime is a binary search.
2. **All sign calculation is client-side.** Zero network calls to get an answer.
3. **The only server code is `POST /api/subscribe`.** Its sole job is to talk to
   ActiveCampaign with a token the browser never sees.
4. **No database, no accounts, no sessions in v1.**
5. **The ephemeris library is a build-time dependency only.** It must not appear
   in `package.json` dependencies or in any deployed runtime.

If you find yourself adding a server route to compute something astronomical,
stop — the answer belongs in the precomputed table.

---

## 2. Stack

- **Build/frontend:** Vite + TypeScript, no UI framework. This is four screens.
- **Ephemeris (build step only):** Python 3.11 + [Skyfield](https://rhodesmill.org/skyfield/)
  with `de421.bsp`. MIT-licensed. **Do not use pyswisseph** — it is AGPL or paid
  commercial, and this is a commercial funnel asset.
- **Cross-validation (build step only):** [Astronomy Engine](https://github.com/cosinekitty/astronomy)
  (MIT), used as an independent second implementation. See §6.
- **Timezone data:** IANA tzdata via the browser's `Intl` API. No tz library.
- **City data:** [GeoNames `cities15000`](https://download.geonames.org/export/dump/) (CC-BY 4.0).
- **Deploy:** Vercel. Static Vite build for the frontend, one Vercel Serverless
  Function (`/api/subscribe.ts`, Node runtime) for the ActiveCampaign call.
  Keep that function under 50 lines and framework-free (no Next.js, no extra
  deps) so it stays portable if you ever move it. Attribution for GeoNames
  goes in the footer — CC-BY requires it.

---

## 3. Repo layout

```
/
  CLAUDE.md
  package.json
  vite.config.ts
  .env.example
  /tools/                      # build-time only, not deployed
    requirements.txt
    generate_ingress.py
    validate_ingress.mjs
    trim_geonames.py
  /public/data/
    moon-ingress.json
    sun-ingress.json
    cities.json
  /src/
    main.ts
    lib/
      ingress.ts               # binary search over the tables
      tz.ts                    # local wall time -> UTC
      cities.ts                # autocomplete + index
      signs.ts                 # sign metadata, names, glyphs
    ui/
      screen-form.ts
      screen-reveal.ts
      screen-gate.ts
      screen-thanks.ts
      ribbon.ts                # the signature element, see §8
    copy/
      report.ts                # all report prose, one export per sign
    styles/
  /api/
    subscribe.ts                # Vercel Serverless Function
  /tests/
    ingress.test.ts
    tz.test.ts
```

---

## 4. Phase 1 — Generate the ingress tables

`tools/generate_ingress.py`

**Coordinate frame — get this right or every boundary is wrong.**
Astrology uses the *tropical* zodiac: apparent geocentric ecliptic longitude
**of date**. In Skyfield that is `.ecliptic_latlon(epoch='date')` on an
`earth.at(t).observe(moon).apparent()` position. Do **not** use the J2000
ecliptic — it drifts roughly 1.4° per century and will silently misclassify
anyone born near a boundary.

Algorithm:
1. Step coarsely (6 hours) from 1920-01-01T00:00Z to 2035-12-31T23:59Z.
2. Detect each crossing of a 30° multiple in ecliptic longitude (watch the
   360°→0° wrap).
3. Bisect each crossing to 1-second precision.
4. Emit sign index 0 = Aries … 11 = Pisces.

Output format (delta-encoded to keep it small):

```json
{
  "body": "moon",
  "epoch": "1920-01-01T00:00:00Z",
  "unit": "minutes",
  "start_sign": 7,
  "first_offset": 812,
  "deltas": [3341, 3358, 3372, ...]
}
```

`deltas[i]` is the gap in whole minutes from ingress `i` to ingress `i+1`.
Signs advance by exactly +1 (mod 12) at each entry.

Generate `sun-ingress.json` with the same script and same frame (~12 entries
per year, trivially small). You need the sun sign anyway — it costs nothing and
it makes the reveal screen feel complete.

**Self-check assertions the script must run before writing output:**
- deltas are strictly positive and monotonic in absolute time
- every moon delta falls in `[3050, 3750]` minutes (~2.12–2.60 days)
- sign sequence increments by exactly 1 mod 12 with zero skips or repeats
- total moon ingress count is within 2% of `157 × years`
- `sun` deltas fall in `[41000, 46000]` minutes

Any assertion failure = hard exit, do not write the file.

---

## 5. Phase 2 — Timezone conversion

The birthplace affects **nothing** about the moon sign except the conversion
from local wall time to UTC. Do not add lat/long into the calculation.

`src/lib/tz.ts` converts a wall-clock time plus an IANA tzid to a UTC instant.
Implement it as offset inversion using `Intl.DateTimeFormat` with
`timeZone` + `formatToParts`: guess UTC, format back into the zone, measure the
error, correct, and re-check once. Browsers carry historical tzdata in ICU, so
this handles pre-1970 offsets correctly.

Two edge cases must be handled explicitly and surfaced in the UI:
- **Ambiguous** (DST fall-back, the hour occurs twice): choose the earlier
  offset, set `tzAmbiguous: true`.
- **Nonexistent** (spring-forward gap): shift forward by the gap length, set
  `tzShifted: true`.

**Required test fixtures in `tests/tz.test.ts`** — these are the cases that
break every competitor tool:
- USA, Jan 1974 (year-round emergency DST)
- Indiana, June 2004 vs June 2007 (statewide DST adopted 2006)
- Israel, 1990s (annually legislated DST dates)
- Netherlands, 1930 (Amsterdam time, +00:19:32)
- Arizona vs Navajo Nation, July
- Southern-hemisphere DST: Sydney, October
- A birth at 02:30 on a US spring-forward date (nonexistent)
- A birth at 01:30 on a US fall-back date (ambiguous)

Assert against known UTC values you derive from tzdata itself, not from memory.

`tools/trim_geonames.py`: reduce `cities15000.txt` to
`[name, admin1, countryCode, tzid, population]`, sort by population descending,
write JSON. Target under 1.5 MB raw. Build a simple prefix index client-side;
do not pull in a search library.

---

## 6. Phase 3 — Cross-validation gate

Do not trust a single implementation. `tools/validate_ingress.mjs` loads
`moon-ingress.json` and, using **Astronomy Engine** (independent codebase,
independent ephemeris model), asserts for every single ingress timestamp:

- longitude at `t - 60s` is in the previous sign
- longitude at `t + 60s` is in the next sign

Every one of the ~18,000 boundaries must pass. Wire this into
`npm run validate` and make it a prerequisite of `npm run build`. If Skyfield
and Astronomy Engine disagree anywhere, the build fails.

This replaces hand-picked "known good" test dates, which are only as reliable
as whoever wrote them down.

---

## 7. Phase 4 — Flow and cusp logic

**Screen 1 — Form.** Birth date. Birth time with a prominent
"I don't know my birth time" toggle. City autocomplete. Nothing else. No email
field on this screen.

**Screen 2 — Reveal.** Free, instant, no gate. Three states:

| Time known? | Ingress on that date? | Result |
|---|---|---|
| Yes | — | Definite sign |
| No | No | Definite sign, stated plainly |
| No | Yes | **Cusp state**: two candidate signs |

The cusp state occurs for roughly 43% of unknown-time users (24h ÷ ~56h between
ingresses). Treat it as the primary conversion asset, not an error. Copy should
name both signs, show where the boundary falls that day, and say that five
questions can resolve it. Never guess or default to one sign.

Also show the sun sign here. It is free and it makes the screen feel like a
result rather than a single word.

**Screen 3 — Gate.** One email field. The offer differs by state:
- definite → the full moon profile
- cusp → the resolver questions *and* the profile

Submit is disabled until the email passes a basic shape check. Include a hidden
honeypot field. On success, transition in place — do not navigate.

**Screen 4 — Thanks.** Confirm what was sent and where. Offer a share link that
encodes the result in the URL hash so a friend lands on a prefilled reveal.

---

## 8. Design direction

The subject's world is the almanac and the tide table, not the crystal shop.
Precision instruments, engraved plates, tabular data. Lean into the fact that
this app is literally a lookup table of celestial events.

**Palette** (dusk, not midnight — the Moon is visible in daylight too):
```
--ground   #2E3552   deep dusk indigo, page field
--surface  #E4E2DA   cool bone, the result card
--ink      #161A2B   near-black text on bone
--brass    #C08A3E   single accent: the marker, the CTA
--muted    #8A93B0   secondary text on ground
```
Do not add a second accent.

**Type**
- Display: **Bodoni Moda** — didone, high contrast, engraving-plate lineage.
  Used only for sign names and the single reveal headline.
- Body: **Public Sans** — neutral, wide language coverage.
- Data: **IBM Plex Mono** — timestamps, UTC offsets, coordinates, boundary
  times. Mono here is truthful, not decorative: this content is tabular
  astronomical data.

**Signature element — the ribbon** (`src/ui/ribbon.ts`)

A horizontal band representing the Moon's passage through signs, spanning from
the ingress before the birth moment to the ingress after it. A brass marker sits
at the exact birth instant. Beneath it, in mono: hours to the previous boundary,
hours to the next.

This is the one memorable thing on the page, and it earns its place three ways:
it is a direct rendering of the data structure the whole app is built on; it
makes the answer feel *located* rather than asserted; and in the cusp state the
marker sits inside a hatched zone spanning the whole birth date, which shows the
user the ambiguity instead of describing it. That visual is the conversion
argument.

Keep everything else quiet. One orchestrated moment on reveal — the ribbon draws
in, the marker lands, the sign name sets. Nothing animates after that. Respect
`prefers-reduced-motion`. Keyboard focus visible throughout. Mobile first: the
ribbon is horizontal-scroll-free at 360px.

**Copy rules.** Sentence case. Active voice. The button says what happens
("Send my full profile"), and the confirmation uses the same verb. Errors state
what went wrong and what to do. No mystical filler, no exclamation marks.

---

## 9. Phase 5 — `/api/subscribe` (Vercel Serverless Function)

ActiveCampaign API v3. Base URL `https://{ACCOUNT}.api-us1.com/api/3/`,
authenticated with an `Api-Token` header. Docs:
https://developers.activecampaign.com/reference

Sequence:
1. `POST /api/3/contact/sync` — upsert by email, returns contact id.
   Custom fields can be included in this call as
   `fieldValues: [{ "field": "3", "value": "Taurus" }, ...]` using the numeric
   field IDs.
2. `POST /api/3/contactLists` with `{ contactList: { list, contact, status: 1 } }`
   to subscribe.
3. `POST /api/3/contactTags` for each tag.

Use `contact/sync` rather than `contacts` — repeat visitors are common with a
shareable lead magnet and you want an upsert, not a duplicate-email error.

**Custom fields.** These must be created manually in ActiveCampaign first;
retrieve their numeric IDs with `GET /api/3/fields` and record them in `.env`.
Do not hardcode IDs in source.

| Field | Type | Example |
|---|---|---|
| `MOON_SIGN` | text | `Taurus` |
| `MOON_ALT_SIGN` | text | `Gemini` (cusp only, else empty) |
| `MOON_CUSP` | text | `yes` / `no` |
| `SUN_SIGN` | text | `Leo` |
| `BIRTH_YEAR` | number | `1988` |
| `BIRTH_TZ` | text | `America/New_York` |
| `TIME_KNOWN` | text | `yes` / `no` |

**Tags:** `source-moon-app`, `moon-{sign}`, and `cusp-unresolved` when
applicable. The `cusp-unresolved` segment is the one to build an offer against
first — it is a self-identified group with an open question.

**`.env.example`**
```
AC_ACCOUNT=
AC_API_TOKEN=
AC_LIST_ID=
AC_FIELD_MOON_SIGN=
AC_FIELD_MOON_ALT_SIGN=
AC_FIELD_MOON_CUSP=
AC_FIELD_SUN_SIGN=
AC_FIELD_BIRTH_YEAR=
AC_FIELD_BIRTH_TZ=
AC_FIELD_TIME_KNOWN=
```

**Function hardening:**
- Reject if the honeypot field is non-empty (return 200, do nothing).
- Rate limit by IP: 5 requests per minute. Vercel functions are stateless
  per-invocation, so use a lightweight external store (Vercel KV / Upstash
  Redis) or, if you want zero extra infra for v1, skip persistent rate
  limiting and rely on the honeypot plus AC's own abuse limits — note this
  tradeoff in the PR rather than silently dropping the requirement.
- Validate email shape server-side; never trust the client check.
- Recompute nothing — the client sends the result, and a bad actor forging their
  own moon sign harms no one.
- Never return the AC token or raw AC error bodies to the client. Log server
  side, return a generic message.
- Store no birth data anywhere except ActiveCampaign.
- All `AC_*` values load from Vercel's environment variables (Project Settings
  → Environment Variables), never committed. `.env.example` stays as the local
  dev template; `vercel dev` reads `.env.local`.

---

## 10. Privacy

Birth date, time, and city together are identifying. One short privacy line
under the email field: what is collected, that it goes to the email provider,
that it is not sold, and how to unsubscribe. Link a real privacy page before
launch. (Not legal advice — have someone check this if you run EU traffic.)

---

## 11. Definition of done

- [ ] `npm run generate` produces both ingress tables and passes all assertions
- [ ] `npm run validate` confirms all ~18,000 boundaries against Astronomy Engine
- [ ] All `tests/tz.test.ts` fixtures pass, including ambiguous and nonexistent times
- [ ] Reveal renders in under 100ms after submit, with no network request
- [ ] Cusp state reachable, correct, and visually distinct on the ribbon
- [ ] Total transferred payload on first load under 400 KB gzipped
- [ ] Lighthouse performance and accessibility both ≥ 95 on mobile
- [ ] `/api/subscribe` creates the contact, subscribes to the list, sets all
      seven custom fields, and applies tags — verified against a live test list
- [ ] No API token reachable from the client bundle (grep the build output)
- [ ] GeoNames attribution present in footer

---

## 12. Explicitly out of scope for v1

Do not build these, even if they seem quick: user accounts, chart wheels,
houses, rising sign, full natal charts, PDF generation, payments, AI-generated
readings, compatibility matching, multi-language. Every one of these is a v2 or
a paid upsell. Rising sign in particular is the natural first paid product —
it needs the lat/long you already collected, which is the whole point of
collecting it.
