#!/usr/bin/env python3
"""Derive timezone test fixtures from the IANA database.

Build-time only. CLAUDE.md §5 requires the tz tests to assert "against known UTC
values you derive from tzdata itself, not from memory" — so this reads the real
zoneinfo database through Python's `zoneinfo` and writes the answers to
`tests/fixtures/tz-cases.json`.

That makes the fixtures genuinely independent of the code under test: `src/lib/tz.ts`
resolves offsets through the JS engine's ICU build, which is a different copy of the
tz rules reached by a different code path. Where the two disagree, the test suite is
measuring something real rather than confirming its own assumptions.

Three kinds of case are emitted:

  named        the eight fixtures §5 calls out by name, each with its tzdata rule
  transition   wall readings sitting inside a real DST overlap or gap, found by
               bisecting each zone's offset — the ambiguous/nonexistent paths
  sample       a broad spread of zones and instants, for regression cover

Usage:  npm run fixtures
"""

from __future__ import annotations

import json
import random
import sys
import zoneinfo
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "tests" / "fixtures" / "tz-cases.json"

# Deterministic sampling so the fixture file only changes when we mean it to.
SEED = 20260805
SAMPLE_ZONES = 90
SAMPLE_PER_ZONE = 4

# §5 names these eight. Each note records the tzdata rule being exercised, so a
# future reader can check the fixture against the database rather than trust it.
NAMED: list[tuple[str, str, tuple, str]] = [
    ("USA, January 1974 — year-round emergency DST",
     "America/New_York", (1974, 1, 15, 9, 0),
     "The Emergency Daylight Saving Time Energy Conservation Act put the US on DST "
     "through the winter of 1973-74, so this January reading is EDT (-04), not EST."),
    ("Indiana, June 2004 — before statewide DST",
     "America/Indiana/Indianapolis", (2004, 6, 15, 9, 0),
     "Indiana largely stayed on EST year-round until 2006, so June 2004 is -05."),
    ("Indiana, June 2007 — after statewide DST",
     "America/Indiana/Indianapolis", (2007, 6, 15, 9, 0),
     "From 2006 Indiana observes DST, so the same June reading is -04."),
    ("Israel, July 1993 — annually legislated DST",
     "Asia/Jerusalem", (1993, 7, 15, 9, 0),
     "Israeli DST dates were set by annual legislation through the 1990s rather "
     "than by a standing rule; tzdata carries each year separately."),
    ("Netherlands, 1930 — Amsterdam time",
     "Europe/Amsterdam", (1930, 6, 15, 12, 0),
     "Europe/Amsterdam ran on +00:19:32 from 1835 to 1937, plus Dutch summer time "
     "in June 1930, giving +01:19:32. A sub-minute offset most engines round away."),
    ("Arizona, July — no DST",
     "America/Phoenix", (2020, 7, 15, 9, 0),
     "Arizona does not observe DST, so July is -07 while its neighbours are -06."),
    ("Navajo Nation, July — observes DST",
     "America/Denver", (2020, 7, 15, 9, 0),
     "The Navajo Nation does observe DST; tzdata models it as America/Denver "
     "(America/Shiprock is a link to that zone), so the same July reading is -06."),
    ("Sydney, October — southern-hemisphere DST",
     "Australia/Sydney", (2020, 10, 15, 9, 0),
     "DST starts in October in the southern hemisphere, giving +11."),
]

# The spring-forward and fall-back readings §5 requires. Dates are located from
# tzdata below rather than written down, so they stay correct if the rules move.
US_EDGE_YEAR = 2024


def resolve(tzid: str, wall: tuple) -> dict:
    """Resolve a wall reading against tzdata. Mirrors the contract of tz.ts.

    Returns the UTC instant plus the ambiguous/shifted classification, decided by
    round-tripping rather than by inspecting rules: a reading is real if
    converting it to UTC and back reproduces it.
    """
    z = ZoneInfo(tzid)
    y, mo, d, h, mi = wall
    s = 0

    valid = []
    for fold in (0, 1):
        local = datetime(y, mo, d, h, mi, s, tzinfo=z, fold=fold)
        inst = local.astimezone(timezone.utc)
        back = inst.astimezone(z)
        if (back.year, back.month, back.day, back.hour, back.minute, back.second) == \
           (y, mo, d, h, mi, s):
            valid.append(inst)

    unique = sorted(set(valid))
    if unique:
        chosen = unique[0]  # earlier occurrence, per §5
        packed = datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)
        return {
            "utc": iso(chosen),
            "offsetSeconds": int((packed - chosen).total_seconds()),
            "tzAmbiguous": len(unique) > 1,
            "tzShifted": False,
            "shiftSeconds": 0,
        }

    # Nonexistent: PEP 495 gives the pre-transition offset at fold=0 and the
    # post-transition offset at fold=1. Shift forward by the gap, per §5.
    offsets = [datetime(y, mo, d, h, mi, s, tzinfo=z, fold=f).utcoffset() for f in (0, 1)]
    before, after = min(offsets), max(offsets)  # type: ignore[type-var]
    packed = datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)
    return {
        "utc": iso(packed - before),
        "offsetSeconds": int(before.total_seconds()),
        "tzAmbiguous": False,
        "tzShifted": True,
        "shiftSeconds": int((after - before).total_seconds()),
    }


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def case(label: str, tzid: str, wall: tuple, note: str, kind: str) -> dict:
    y, mo, d, h, mi = wall
    return {
        "label": label,
        "kind": kind,
        "tzid": tzid,
        "wall": {"year": y, "month": mo, "day": d, "hour": h, "minute": mi, "second": 0},
        "note": note,
        "expect": resolve(tzid, wall),
    }


def find_transitions(tzid: str, year: int) -> list[datetime]:
    """Instants in `year` where the zone's offset changes, to the second."""
    z = ZoneInfo(tzid)
    off = lambda t: t.astimezone(z).utcoffset()
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    edges, cursor, prev = [], start, off(start)
    while cursor < end:
        step = min(cursor + timedelta(days=1), end)
        cur = off(step)
        if cur != prev:
            lo, hi = cursor, step
            while (hi - lo).total_seconds() > 1:
                mid = lo + (hi - lo) / 2
                if off(mid) == prev:
                    lo = mid
                else:
                    hi = mid
            edges.append(hi)
            prev = cur
        cursor = step
    return edges


def transition_cases() -> list[dict]:
    """Wall readings that land inside a real overlap or gap."""
    zones = [
        "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
        "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam",
        "Europe/Dublin", "Europe/Lisbon", "Europe/Moscow", "Asia/Jerusalem",
        "Asia/Tehran", "Australia/Sydney", "Australia/Adelaide", "Australia/Lord_Howe",
        "Pacific/Auckland", "Pacific/Chatham", "America/Sao_Paulo", "America/Santiago",
        "America/Havana", "Africa/Cairo", "Asia/Beirut", "America/Mexico_City",
        "Atlantic/Azores", "America/St_Johns", "Asia/Gaza", "Europe/Chisinau",
    ]
    years = [1930, 1945, 1974, 1987, 1999, 2004, 2007, 2015, 2024, 2030]
    out = []
    for tzid in zones:
        try:
            ZoneInfo(tzid)
        except Exception:
            continue
        for year in years:
            z = ZoneInfo(tzid)
            for edge in find_transitions(tzid, year):
                after = edge.astimezone(z).utcoffset()
                before = (edge - timedelta(seconds=1)).astimezone(z).utcoffset()
                assert after is not None and before is not None
                # Step in by half the transition, so a 30-minute shift (Lord Howe)
                # lands inside its gap just as a 1-hour one does.
                span = abs((after - before).total_seconds()) / 60
                step = timedelta(minutes=max(1.0, min(30.0, span / 2)))
                local = edge.astimezone(z)
                # Spring forward opens a gap *below* the new local time; falling
                # back repeats the hour *above* it.
                probe = local - step if after > before else local + step
                wall = (probe.year, probe.month, probe.day, probe.hour, probe.minute)
                r = resolve(tzid, wall)
                if r["tzAmbiguous"] or r["tzShifted"]:
                    out.append(case(
                        f"{tzid} {year} transition {'overlap' if r['tzAmbiguous'] else 'gap'}",
                        tzid, wall,
                        "Wall reading inside a real tzdata transition, located by bisection.",
                        "transition"))
    return out


def sample_cases() -> list[dict]:
    rng = random.Random(SEED)
    zones = sorted(z for z in zoneinfo.available_timezones() if "/" in z)
    picked = rng.sample(zones, min(SAMPLE_ZONES, len(zones)))
    out = []
    for tzid in picked:
        for _ in range(SAMPLE_PER_ZONE):
            y = rng.randint(1920, 2035)
            wall = (y, rng.randint(1, 12), rng.randint(1, 28),
                    rng.randint(0, 23), rng.choice([0, 15, 30, 45]))
            out.append(case(f"{tzid} {y} sample", tzid, wall,
                            "Randomised regression cover, seeded for reproducibility.",
                            "sample"))
    return out


def us_edge_cases() -> list[dict]:
    """The 02:30 spring-forward and 01:30 fall-back readings §5 requires."""
    out = []
    edges = find_transitions("America/New_York", US_EDGE_YEAR)
    for edge in edges:
        local = edge.astimezone(ZoneInfo("America/New_York"))
        forward = local.utcoffset() > (edge - timedelta(hours=1)).astimezone(
            ZoneInfo("America/New_York")).utcoffset()
        if forward:
            wall = (local.year, local.month, local.day, 2, 30)
            out.append(case(
                f"US spring-forward {US_EDGE_YEAR} — 02:30 does not exist",
                "America/New_York", wall,
                "02:30 falls in the gap; §5 requires shifting forward by the gap length.",
                "named"))
        else:
            wall = (local.year, local.month, local.day, 1, 30)
            out.append(case(
                f"US fall-back {US_EDGE_YEAR} — 01:30 occurs twice",
                "America/New_York", wall,
                "01:30 occurs twice; §5 requires taking the earlier offset.",
                "named"))
    return out


def main() -> None:
    named = [case(l, t, w, n, "named") for l, t, w, n in NAMED] + us_edge_cases()
    transitions = transition_cases()
    samples = sample_cases()
    cases = named + transitions + samples

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generator": "tools/gen_tz_fixtures.py",
        "source": "IANA tzdata via Python zoneinfo",
        "tzdataPath": str(zoneinfo.TZPATH[0]),
        "seed": SEED,
        "cases": cases,
    }, indent=1) + "\n")

    kinds = {k: sum(1 for c in cases if c["kind"] == k) for k in ("named", "transition", "sample")}
    amb = sum(1 for c in cases if c["expect"]["tzAmbiguous"])
    gap = sum(1 for c in cases if c["expect"]["tzShifted"])
    print(f"wrote {OUT.relative_to(REPO_ROOT)}: {len(cases)} cases "
          f"({kinds['named']} named, {kinds['transition']} transition, {kinds['sample']} sample); "
          f"{amb} ambiguous, {gap} shifted", file=sys.stderr)


if __name__ == "__main__":
    main()
