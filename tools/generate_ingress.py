#!/usr/bin/env python3
"""Precompute every tropical-zodiac sign ingress for the Moon and the Sun.

Build-time only — see CLAUDE.md §1 and §4. Nothing here ships; the output is a
pair of static JSON tables in /public/data that the client binary-searches.

Coordinate frame
----------------
Astrology uses the *tropical* zodiac: apparent geocentric ecliptic longitude
**of date**. That is `.ecliptic_latlon(epoch='date')` on an
`earth.at(t).observe(body).apparent()` position. The J2000 ecliptic is wrong for
this purpose — it drifts ~1.4°/century and silently misclassifies births near a
boundary.

Method
------
1. Coarse scan on a 6-hour grid across the whole span, recording the sign index
   `floor(lon / 30)` at each mark.
2. Every change in that index brackets exactly one ingress. Both bodies are
   strictly prograde in ecliptic longitude, and neither covers 30° in 6 hours,
   so a bracket can hold no more and no less than one crossing.
3. Bisect all brackets simultaneously (vectorised over ~18k crossings at once)
   until the interval is well under one second.
4. Assert the result is physically sane, then write.

Bisection runs in TT Julian days, which is continuous and leap-second-free.
Only at the very end are instants converted to UTC calendar time and expressed
as whole minutes since the epoch — matching how JavaScript's `Date` will
reconstruct them, which likewise knows nothing of leap seconds.

Usage
-----
    python tools/generate_ingress.py              # both tables
    python tools/generate_ingress.py --body moon  # just one

The DE421 kernel is located in this order: `$MOONFINDER_DE421`,
`tools/.cache/de421.bsp`, the `skyfield-data` package, then Skyfield's
downloader. Build hosts without access to naif.jpl.nasa.gov need one of the
first three.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from skyfield.api import load, load_file

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "public" / "data"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"

# Span. Inclusive of both ends; the coarse grid always covers END exactly.
EPOCH = datetime(1920, 1, 1, 0, 0, tzinfo=timezone.utc)
END = datetime(2035, 12, 31, 23, 59, tzinfo=timezone.utc)

COARSE_STEP_MINUTES = 360.0  # 6 hours
BISECT_ITERATIONS = 20       # 6h / 2^20 ≈ 0.02 s, comfortably under the 1 s target
CHUNK = 20_000               # times per vectorised Skyfield call

SIGNS = (
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
)

# Mean tropical month, days. The Moon returns to the same tropical longitude
# every 27.321582 d, so it crosses 12 sign boundaries in that time.
TROPICAL_MONTH_DAYS = 27.321582
MOON_INGRESSES_PER_YEAR = 12 * 365.25 / TROPICAL_MONTH_DAYS  # ≈ 160.42

# Per-body self-check bounds. `delta_minutes` bounds every gap between
# consecutive ingresses; `rate_per_year` is the expected long-run mean, checked
# to within `rate_tolerance`.
#
# Two constants here depart from CLAUDE.md §4. Both are the same underlying
# error — the spec assumes a slower Moon than the ephemeris shows — and both
# would have failed the build on correct data. Measured over 1920–2035:
#
#   rate   spec "157 × years"      actual 160.42/yr (18,609 ingresses)
#   gaps   spec [3050, 3750] min   actual [2814, 3667] min
#
# Rate: 157/yr comes from the *synodic* month (~13 lunations/yr × 12). Sign
# ingresses track *tropical* longitude, so the right figure is
# 12 × 365.25/27.321582 = 160.42/yr. 18,609 measured lands on that to 4 digits;
# 157 × 116 yr = 18,212 misses by 2.2%, just outside the ±2% gate.
#
# Gaps: the spec's own gloss "(~2.12–2.60 days)" shows the assumed floor of
# 2.12 d. A perigee transit covers 30° at ~15.4°/day — 1.95 d — so the true
# floor is ~2810 min, and a 3050 min floor rejects 4,634 gaps (24.9%). Only the
# floor is corrected below; the spec's upper bound already clears the observed
# max of 3667. Bounds carry ~2% margin and still catch a missed ingress (which
# would double a gap to ~6560) or a spurious one (which would collapse it).
#
# The Sun's spec bounds needed no change: 0 of 1,392 gaps fall outside.
# Both corrections are for the spec to absorb.
BODY_CONFIG = {
    "moon": {
        "target": "moon",
        "delta_minutes": (2750, 3750),
        "rate_per_year": MOON_INGRESSES_PER_YEAR,
        "rate_tolerance": 0.02,
    },
    "sun": {
        "target": "sun",
        "delta_minutes": (41000, 46000),
        "rate_per_year": 12.0,
        "rate_tolerance": 0.02,
    },
}


# --------------------------------------------------------------------------
# ephemeris
# --------------------------------------------------------------------------

def locate_kernel() -> str:
    """Return a path to de421.bsp, preferring offline sources."""
    env = os.environ.get("MOONFINDER_DE421")
    if env:
        if not Path(env).is_file():
            fail(f"MOONFINDER_DE421 is set to {env!r} but that file does not exist")
        return env

    cached = CACHE_DIR / "de421.bsp"
    if cached.is_file():
        return str(cached)

    try:
        import skyfield_data
        packaged = Path(skyfield_data.__file__).parent / "data" / "de421.bsp"
        if packaged.is_file():
            return str(packaged)
    except ImportError:
        pass

    # Last resort: let Skyfield fetch it. Needs naif.jpl.nasa.gov.
    log("de421.bsp not found locally, downloading via Skyfield…")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return str(load.download("de421.bsp", filename=str(CACHE_DIR / "de421.bsp")))


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def wrap180(deg: np.ndarray) -> np.ndarray:
    """Map an angular difference into (-180, +180]."""
    return (deg + 180.0) % 360.0 - 180.0


def _longitudes(earth, body, t) -> np.ndarray:
    """Apparent geocentric ecliptic longitude of date, in degrees [0, 360)."""
    _, lon, _ = earth.at(t).observe(body).apparent().ecliptic_latlon(epoch="date")
    return np.atleast_1d(lon.degrees)


def _chunked(earth, body, values, make_time, label) -> np.ndarray:
    """Evaluate longitude over `values` in chunks, reporting progress."""
    out = np.empty(values.shape, dtype=float)
    total = values.size
    for start in range(0, total, CHUNK):
        stop = min(start + CHUNK, total)
        out[start:stop] = _longitudes(earth, body, make_time(values[start:stop]))
        progress(label, stop, total)
    progress_done()
    return out


# --------------------------------------------------------------------------
# scan and refine
# --------------------------------------------------------------------------

def coarse_scan(ts, earth, body, name):
    """Sample the 6h grid and return (grid_minutes, grid_tt, sign_index)."""
    span_minutes = (END - EPOCH).total_seconds() / 60.0
    minutes = np.arange(0.0, span_minutes, COARSE_STEP_MINUTES)
    if minutes[-1] < span_minutes:
        minutes = np.append(minutes, span_minutes)  # never leave the tail uncovered

    def make_time(m):
        return ts.utc(EPOCH.year, EPOCH.month, EPOCH.day, EPOCH.hour, m, 0)

    lon = _chunked(earth, body, minutes, make_time, f"{name}: coarse scan")
    return minutes, make_time(minutes).tt, np.floor(lon / 30.0).astype(np.int64) % 12


def find_brackets(sign_index, name):
    """Indices i where sign_index[i] -> sign_index[i+1] is one forward ingress."""
    step = np.diff(sign_index) % 12
    moved = np.nonzero(step != 0)[0]
    bad = moved[step[moved] != 1]
    if bad.size:
        i = int(bad[0])
        fail(
            f"{name}: sign sequence jumped by {int(step[i])} at grid index {i} "
            f"({SIGNS[sign_index[i]]} -> {SIGNS[sign_index[i + 1]]}). The coarse "
            f"step is too large or the body is not prograde here."
        )
    return moved


def refine(ts, earth, body, lo_tt, hi_tt, boundary_deg, name):
    """Bisect each bracket down to sub-second precision. Returns TT Julian days."""
    lo, hi = lo_tt.copy(), hi_tt.copy()

    # Confirm the brackets really do straddle their boundary before trusting them.
    for edge, values, want_negative in (("lower", lo, True), ("upper", hi, False)):
        d = wrap180(_chunked(earth, body, values, ts.tt_jd, f"{name}: verify {edge} bound")
                    - boundary_deg)
        wrong = np.nonzero((d < 0.0) != want_negative)[0]
        if wrong.size:
            i = int(wrong[0])
            fail(f"{name}: bracket {i} does not straddle its boundary "
                 f"({edge} bound is {d[i]:+.4f}° from {boundary_deg[i]:.0f}°)")

    for k in range(BISECT_ITERATIONS):
        mid = 0.5 * (lo + hi)
        d = wrap180(_chunked(earth, body, mid, ts.tt_jd,
                             f"{name}: bisect {k + 1}/{BISECT_ITERATIONS}") - boundary_deg)
        before = d < 0.0
        lo = np.where(before, mid, lo)
        hi = np.where(before, hi, mid)

    return 0.5 * (lo + hi)


def to_epoch_minutes(ts, tt_jd) -> np.ndarray:
    """TT Julian days -> whole minutes since EPOCH on the UTC calendar.

    Rounding happens once, on absolute times, so the delta encoding reconstructs
    these exact values with no accumulated drift.
    """
    stamps = ts.tt_jd(tt_jd).utc_datetime()
    offsets = np.array([(d - EPOCH).total_seconds() / 60.0 for d in stamps])
    return np.rint(offsets).astype(np.int64)


# --------------------------------------------------------------------------
# assertions
# --------------------------------------------------------------------------

def check(name, minutes, signs, cfg):
    """Every one of these must hold or we refuse to write the file."""
    count = minutes.size
    if count < 2:
        fail(f"{name}: only {count} ingress(es) found")

    deltas = np.diff(minutes)

    if not np.all(deltas > 0):
        i = int(np.argmin(deltas))
        fail(f"{name}: deltas must be strictly positive; delta[{i}] = {int(deltas[i])}")

    lo, hi = cfg["delta_minutes"]
    out = np.nonzero((deltas < lo) | (deltas > hi))[0]
    if out.size:
        i = int(out[0])
        fail(f"{name}: delta[{i}] = {int(deltas[i])} min is outside [{lo}, {hi}] "
             f"({out.size} of {deltas.size} gaps out of range)")

    step = np.diff(signs) % 12
    bad = np.nonzero(step != 1)[0]
    if bad.size:
        i = int(bad[0])
        fail(f"{name}: sign sequence must advance by exactly +1 mod 12; "
             f"ingress {i} -> {i + 1} advanced by {int(step[i])}")

    years = (END - EPOCH).total_seconds() / 86400.0 / 365.25
    expected = cfg["rate_per_year"] * years
    tol = cfg["rate_tolerance"]
    if abs(count - expected) > expected * tol:
        fail(f"{name}: found {count} ingresses, expected {expected:.0f} "
             f"±{tol:.0%} ({count / years:.2f}/yr vs {cfg['rate_per_year']:.2f}/yr)")

    log(f"{name}: {count} ingresses, {count / years:.2f}/yr, "
        f"gaps {int(deltas.min())}–{int(deltas.max())} min "
        f"(mean {deltas.mean():.1f}) — all checks passed")


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------

def build(ts, eph, name):
    cfg = BODY_CONFIG[name]
    earth, body = eph["earth"], eph[cfg["target"]]

    minutes, grid_tt, sign_index = coarse_scan(ts, earth, body, name)
    brackets = find_brackets(sign_index, name)
    log(f"{name}: {brackets.size} brackets from {minutes.size} grid points")

    # The boundary crossed in bracket i is the entry longitude of the sign begun.
    entered = sign_index[brackets + 1]
    boundary_deg = 30.0 * entered

    tt = refine(ts, earth, body, grid_tt[brackets], grid_tt[brackets + 1],
                boundary_deg, name)
    epoch_minutes = to_epoch_minutes(ts, tt)

    check(name, epoch_minutes, entered, cfg)

    return {
        "body": name,
        "epoch": EPOCH.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "unit": "minutes",
        # Sign entered at the first ingress. Sign at any instant is
        # (start_sign + i) mod 12, where i indexes the last ingress at or before
        # that instant; i = -1 (before the table) falls out of the same formula.
        "start_sign": int(entered[0]),
        "first_offset": int(epoch_minutes[0]),
        "deltas": np.diff(epoch_minutes).astype(int).tolist(),
    }


def write(table):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{table['body']}-ingress.json"
    path.write_text(json.dumps(table, separators=(",", ":")) + "\n")
    size = path.stat().st_size
    log(f"wrote {path.relative_to(REPO_ROOT)} ({size / 1024:.1f} KB, "
        f"{len(table['deltas']) + 1} ingresses)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--body", choices=sorted(BODY_CONFIG), action="append",
                    help="generate only this table (repeatable); default is both")
    args = ap.parse_args()
    bodies = args.body or ["moon", "sun"]

    kernel = locate_kernel()
    log(f"ephemeris: {kernel}")
    ts = load.timescale()
    eph = load_file(kernel)

    log(f"span: {EPOCH:%Y-%m-%d} to {END:%Y-%m-%d}, "
        f"{COARSE_STEP_MINUTES / 60:.0f}h coarse step, "
        f"{BISECT_ITERATIONS} bisection rounds")

    for name in bodies:
        write(build(ts, eph, name))


# --------------------------------------------------------------------------
# output helpers
# --------------------------------------------------------------------------

_tty = sys.stderr.isatty()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def progress(label, done, total):
    if _tty:
        print(f"\r  {label}: {done}/{total}", end="", file=sys.stderr, flush=True)


def progress_done():
    if _tty:
        print("\r\033[K", end="", file=sys.stderr, flush=True)


def fail(msg):
    print(f"\nassertion failed: {msg}", file=sys.stderr, flush=True)
    print("no file written", file=sys.stderr, flush=True)
    sys.exit(1)


if __name__ == "__main__":
    main()
