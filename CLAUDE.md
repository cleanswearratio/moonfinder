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
- every moon delta falls in `[2750, 3750]` minutes (~1.91–2.60 days)
- sign sequence increments by exactly 1 mod 12 with zero skips or repeats
- total moon ingress count is within 2% of `160.42 × years`
- `sun` deltas fall in `[41000, 46000]` minutes

Any assertion failure = hard exit, do not write the file.

> **Two constants corrected in Phase 1**, measured against DE421 over
> 1920–2035. Both originally rejected correct data.
>
> The rate was `157 × years` — that figure comes from the *synodic* month
> (~13 lunations/yr × 12). Ingresses track *tropical* longitude, so the right
> value is `12 × 365.25 / 27.321582 = 160.42/yr`. The run produced 18,609
> ingresses, matching that to four digits; `157 × 116 yr = 18,212` misses by
> 2.2%, just outside the ±2% gate.
>
> The moon delta floor was `3050` minutes, glossed as a 2.12-day minimum. A
> perigee transit covers 30° at ~15.4°/day — 1.95 days — so the measured range
> is `[2814, 3667]` and a 3050 floor rejected 24.9% of all gaps. Only the floor
> moved; the original upper bound already cleared the observed maximum.
>
> The sun bounds were correct as written: 0 of 1,392 gaps fell outside.

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
`tools/gen_tz_fixtures.py` does this: it reads the real IANA database through
Python's `zoneinfo` and writes `tests/fixtures/tz-cases.json`. That is a
different copy of the rules reached by a different code path from the ICU data
`tz.ts` uses, so the suite measures the inversion algorithm rather than
confirming its own assumptions.

> **Measured in Phase 2 — the claim above about ICU is not reliable.** Comparing
> `Intl` against real tzdata across 483 zones × 232 instants (112,056 checks):
> **2,680 disagree, every one of them between 1920 and 1975.** From 1976 on,
> `Intl` is exact everywhere we sampled. But 1,531 of those are off by **an hour
> or more**, across 81 zones, worst case 12.5 h (Antarctica/McMurdo). Sub-minute
> historical offsets are also rounded away — Amsterdam in June 1930 is
> `+01:19:32` in tzdata and `+01:00` in ICU, so §5's own required fixture cannot
> pass as written. It is kept as a documented failing assertion in
> `tests/tz.test.ts`.
>
> Most affected zones are remote (Antarctic, Pacific, Caribbean), and the big
> population centres — New York, London, Paris, Berlin, Kolkata, Tokyo, Shanghai,
> São Paulo, Sydney, Lagos, Cairo — are clean across the whole span. The
> populated exceptions are Amsterdam (to 1946), Stockholm, Oslo and Copenhagen
> (1940s), Reykjavik, and Tijuana (1953–1975).
>
> Impact is bounded: a wrong offset only changes the answer when it moves the
> birth across an ingress, so roughly `error / 3279 min` — about 1.8% of affected
> births for a one-hour error. Worth knowing that ICU data also varies by engine
> and version, so pre-1976 results are not identical across browsers.
>
> **Decision still open.** Living with it is defensible for a lead magnet. The
> alternative that fits §1 is to precompute a correction table at build time from
> real tzdata — the same move as the ingress tables, and it would remove the
> engine-dependence entirely. Not built; flagged for a call.

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

> **Built in Phase 3, and the gate is stated in arcseconds.** All 20,001
> boundaries pass in ~2 s: moon 18,609 and sun 1,392, both tables checked.
>
> The two models differ on the Moon by −2.29″ ± 10.61″ (max 30.4″) — zero-mean
> scatter, the signature of Astronomy Engine's truncated lunar series against
> DE421's numerical integration. DE421 is the accurate side; Astronomy Engine is
> a gross-error gate, not a precision reference. On the Sun they agree far more
> closely, −0.34″ ± 0.95″.
>
> A ±60 s tolerance is really an angular tolerance in disguise, and the disguise
> does not transfer between bodies: 60 s buys ~33″ of slack on the Moon but only
> ~2.5″ on the Sun. So the same rule passes the Moon with 11.3 s to spare and
> fails the Sun 11 times out of 1,392 — not from any error in the table, but
> because the Sun moves 0.041″/s, so 3.5″ of model difference becomes 86 s of
> time. The validator therefore gates on **angle**, with per-body limits set from
> the measured spread (moon 45″, sun 15″) plus a bias limit to catch a systematic
> frame or nutation error that scatter alone would hide. §6's ±60 s wording is
> still enforced verbatim for the Moon, where it holds.
>
> The gate was shown to fail on purpose before being trusted: a single ingress
> moved by **one minute** trips it (45.5″), as do an off-by-one `start_sign`
> (108,030″), a dropped ingress (16,869″), and a 3-minute shift of the whole
> table (139″).

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

> **Tripwire added, on the owner's instruction.** The thanks screen also shows
> a single upsell tied to the visitor's own result — reusing the same profile
> summary sentence the reveal already showed them, so the pitch reads as a
> continuation ("this meets you at your current position") rather than a
> generic offer bolted on afterward. It links out to an external sales page
> (`wonderlandmethod.com`) rather than processing payment itself, so it does
> not cross the "no payments in v1" line in §12 — this app never touches a
> card. `screen-thanks.ts` has the copy and pricing; both are literal strings,
> not configurable, since there is exactly one tripwire.
>
> Building this surfaced a real bug that predates it: `screen-gate.ts` and the
> plain-text lede on this screen both wrote `a ${sign}`, which reads "a
> Aquarius" and "a Aries" — wrong indefinite article for the two vowel-leading
> signs. Fixed with `article()` in `lib/signs.ts`, a lookup over the two
> affected names rather than a general vowel-letter heuristic, since exactly
> two of the twelve names need it and a lookup is exactly correct for them
> where a heuristic would only be approximately correct.

---

## 8. Design direction

> **Superseded.** The original direction below — almanac and tide table, one
> accent, "not the crystal shop" — was replaced on the owner's instruction: it
> read as too austere and corporate for the audience. Kept here because the
> reasoning still explains why the *structure* looks the way it does; the
> ribbon, the mono data lines and the refusal to guess a sign all come from it.
> What changed is the surface, not the substance. The current direction is in
> §8a, and `src/styles/app.css` is the source of truth.

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

---

## 8a. Design direction (current)

Warm dusk, and twelve signs that each own a colour. Still precise — the ribbon
renders real data and mono is still reserved for genuinely tabular values — but
inviting rather than clinical.

**Palette**
```
--ground       #2A2444   violet indigo, mid stop of the page gradient
--ground-deep  #1B1730   near-black violet, top of the gradient
--ground-warm  #3A2647   plum, bottom of the gradient
--surface      #FBF7EF   warm cream, the card
--ink          #241C38   violet-black text on cream
--muted        #B3AAD0   lavender-grey on ground, 6.68:1
--gold         #F0B65C   CTA gradient, start
--gold-deep    #E0864F   CTA gradient, end
--rose         #E88FA8   third stop on the card's top edge
```

**The twelve sign colours.** `signHue()` in `src/lib/signs.ts` gives each sign a
hue 30° apart, mirroring the 30° each sign occupies on the ecliptic — so
adjacent signs are adjacent colours and a cusp always pairs two genuinely
distinct ones. They are built in **OKLCH**, which holds perceived lightness
constant as hue turns; all twelve therefore measure between **5.19 and 6.69:1**
on the cream surface. HSL would have left the yellows muddy and the blues
washed out, and four of the twelve illegible.

The reveal sets `--sign-hue` on the card, which themes the headline, the
kicker, the card's glow, the top edge, focus rings and the sun panel. The
ribbon sets it per segment, so a sign boundary is a change of hue rather than
just a hairline.

> **Two things to know if you touch this.**
>
> `--sign` and friends are redeclared on `*` rather than composed once on
> `:root`. A custom property containing `var()` resolves where it is *declared*,
> so a root-level `--sign` bakes in the root hue and silently ignores every
> per-element override — which is exactly the bug that first rendered both cusp
> candidates in the same colour.
>
> The CTA is **ink on gold, not cream on gold**. The previous cream-on-brass
> measured **2.13:1**, far under AA. Lighthouse still scored accessibility 100,
> because the submit button is disabled on first load and axe skips disabled
> controls — the failure was real but invisible to the audit. Ink on the gold
> gradient is 5.93:1 at its darkest stop, and is now verified on the reveal
> screen where the button is enabled and actually gets checked.

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
in, the marker lands, the sign name sets. Respect `prefers-reduced-motion`.
Keyboard focus visible throughout. Mobile first: the ribbon is
horizontal-scroll-free at 360px.

> **Relaxed with §8a.** "Nothing animates after that" now has two exceptions,
> both ambient and both disabled under `prefers-reduced-motion`: the background
> colour blooms drift on a 34s cycle, and the oversized sign glyph behind the
> headline floats on a 9s cycle. Nothing in the reading itself moves.

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

> **Built in Phase 5 — one gap in the sequence above.** `POST /api/3/contactTags`
> takes a **numeric tag id**, not a tag name, so step 3 cannot be called with
> `moon-taurus` directly. Env vars are not the answer either: `moon-{sign}` is
> twelve possible tags and `.env.example` has no slot for them. The function
> therefore resolves each name through `GET /api/3/tags?filters[tag]=` and
> creates it if absent, which also means the tags do not have to be set up by
> hand before launch. Custom fields still come from `.env` as §9 requires —
> those ids are fixed and few.

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

- [x] `npm run generate` produces both ingress tables and passes all assertions
      — moon 18,609, sun 1,392
- [x] `npm run validate` confirms all ~18,000 boundaries against Astronomy Engine
      — 20,001 in 1.9 s, both tables
- [x] All `tests/tz.test.ts` fixtures pass, including ambiguous and nonexistent times
      — 25 tests; Amsterdam 1930 is a documented `it.fails`, see §5
- [x] Reveal renders in under 100ms after submit, with no network request
      — measured 25.2 ms and 0 requests in Chromium
- [x] Cusp state reachable, correct, and visually distinct on the ribbon
- [x] Total transferred payload on first load under 400 KB gzipped
      — 47.6 KB: 14.1 KB app, 33.5 KB tables. `cities.json` loads on demand and
      is excluded by design; webfonts are the remaining third-party cost
- [x] Lighthouse performance and accessibility both ≥ 95 on mobile
      — performance 98, accessibility 100, best practices 100, SEO 100
      (mobile, simulated throttling, against `vite build` served statically).
      The 2 points off performance are `http-server`'s missing cache headers,
      which Vercel sets automatically on hashed static assets — not an app fix
- [ ] `/api/subscribe` creates the contact, subscribes to the list, sets all
      seven custom fields, and applies tags — **verified against a stubbed API
      only** (14 tests pin the call order, request shapes and failure paths).
      Still needs one run against a live test list, which needs real credentials
- [x] No API token reachable from the client bundle (grep the build output)
      — built with secrets set in the environment; token, account name,
      `Api-Token` and `api-us1.com` are all absent from `dist/`
- [x] GeoNames attribution present in footer

> **Remaining before launch**, beyond the two boxes above: fetch the GeoNames
> dump so `cities.json` exists (§5); add a real contact address to the privacy
> page (marked with a `TODO` in `privacy.html` — none was ever configured for
> this project); and decide the pre-1976 timezone question in §5.
>
> **Privacy page written.** `/privacy.html` describes what the code actually
> sends, which is less than the generic version above implies: `screen-gate.ts`
> transmits the email address, both candidate signs, birth **year** only, and
> the birth time zone — never the birth date, birth time, or city name. The
> page states that precisely rather than reusing this section's looser wording.
> Linked as `/privacy.html` rather than the extensionless `/privacy` this
> section names, so it resolves in `vite dev`, `vite preview`, and a plain
> static deploy with no rewrite rule to configure.
>
> **Closed out in a follow-up pass.** Webfonts are now self-hosted as
> Latin-subset woff2 in `public/fonts/` (OFL-1.1, redistribution permitted) —
> the page makes no third-party request at all now, not just under the 400 KB
> budget. Running Lighthouse also caught two real defects the earlier text-only
> checks couldn't: `--muted` on `--ground` measured 3.94:1, under WCAG AA's
> 4.5:1 for body text, so it moved to `#9aa3bd` (4.78:1); and there was no
> favicon. Accessibility and Best Practices are both 100 now.

> **Phase 4 note.** `public/data/cities.json` was not originally in the repo,
> since the GeoNames dump is CC-BY and must be fetched by whoever builds
> (`npm run cities`, see `tools/README.md`). `cities.ts` falls back to ~60
> built-in major cities when it is absent, which is also what protects the form
> if the fetch ever fails in production. The four flows, all three §7 reveal
> states, the share link and the honeypot were driven end to end in Chromium at
> 360 px.
>
> **Closed out via `.github/workflows/fetch-cities.yml`.** GeoNames is
> unreachable from some sandboxed build environments (the same block that hit
> `naif.jpl.nasa.gov` in Phase 1), so city data fetching moved to a manual
> GitHub Action on an ordinary hosted runner, which has normal internet access
> and needs no credentials. Run: 34,076 cities, 356 time zones, 244 countries,
> 1.33 MB raw — under the 1.5 MB target — verified server-side (correct
> structure, sorted by population, capitals included per GeoNames convention
> even at zero population) and client-side (autocomplete resolves cities well
> outside the fallback list, e.g. Timbuktu and Reykjavik, with the full flow
> driven end to end through a real, non-fallback city).

---

## 12. Explicitly out of scope for v1

Do not build these, even if they seem quick: user accounts, chart wheels,
houses, rising sign, full natal charts, PDF generation, payments, AI-generated
readings, compatibility matching, multi-language. Every one of these is a v2 or
a paid upsell. Rising sign in particular is the natural first paid product —
it needs the lat/long you already collected, which is the whole point of
collecting it.
