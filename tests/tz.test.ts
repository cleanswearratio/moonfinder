import { describe, expect, it } from 'vitest';
import { formatOffset, wallTimeToUtc, type WallClock } from '../src/lib/tz.js';
import fixtures from './fixtures/tz-cases.json' with { type: 'json' };

/**
 * Fixtures come from `tools/gen_tz_fixtures.py`, which reads the IANA database
 * through Python's `zoneinfo`. `src/lib/tz.ts` reads the engine's ICU build.
 * Two copies of the rules, two code paths — so these assertions test the
 * inversion algorithm rather than restating what it already believes.
 */

interface Expect {
  utc: string;
  offsetSeconds: number;
  tzAmbiguous: boolean;
  tzShifted: boolean;
  shiftSeconds: number;
}
interface Case {
  label: string;
  kind: 'named' | 'transition' | 'sample';
  tzid: string;
  wall: WallClock & { second: number };
  note: string;
  expect: Expect;
}

const cases = fixtures.cases as Case[];
const named = (label: string): Case => {
  const c = cases.find((x) => x.label.startsWith(label));
  if (!c) throw new Error(`no fixture starting "${label}"`);
  return c;
};

/**
 * The year from which `Intl` is exact for every zone we sampled. Before this,
 * ICU simplifies some pre-1970 rules — see the divergence block at the bottom.
 */
const ICU_EXACT_FROM = 1976;

const actual = (c: Case) => wallTimeToUtc(c.wall, c.tzid);

/** Format an instant back into its zone — the invariant that must always hold. */
function wallInZone(instant: Date, tzid: string) {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

describe('§5 named fixtures — the cases that break competitor tools', () => {
  const exact: [string, string, number][] = [
    ['USA, January 1974', '1974-01-15T13:00:00.000Z', -4 * 3600],
    ['Indiana, June 2004', '2004-06-15T14:00:00.000Z', -5 * 3600],
    ['Indiana, June 2007', '2007-06-15T13:00:00.000Z', -4 * 3600],
    ['Israel, July 1993', '1993-07-15T06:00:00.000Z', 3 * 3600],
    ['Arizona, July', '2020-07-15T16:00:00.000Z', -7 * 3600],
    ['Navajo Nation, July', '2020-07-15T15:00:00.000Z', -6 * 3600],
    ['Sydney, October', '2020-10-14T22:00:00.000Z', 11 * 3600],
  ];

  for (const [label, utc, offsetSeconds] of exact) {
    it(label, () => {
      const c = named(label);
      // The fixture is tzdata's answer; the literal is a second pair of eyes on it.
      expect(c.expect.utc).toBe(utc);
      expect(c.expect.offsetSeconds).toBe(offsetSeconds);

      const got = actual(c);
      expect(got.utc.toISOString()).toBe(utc);
      expect(got.offsetSeconds).toBe(offsetSeconds);
      expect(got.tzAmbiguous).toBe(false);
      expect(got.tzShifted).toBe(false);
    });
  }

  it('Indiana 2004 and 2007 differ by an hour on the same wall reading', () => {
    const a = actual(named('Indiana, June 2004'));
    const b = actual(named('Indiana, June 2007'));
    expect(a.offsetSeconds - b.offsetSeconds).toBe(-3600);
  });

  it('Arizona and the Navajo Nation differ by an hour in July', () => {
    const az = actual(named('Arizona, July'));
    const nn = actual(named('Navajo Nation, July'));
    expect(nn.offsetSeconds - az.offsetSeconds).toBe(3600);
  });

  it('01:30 on a US fall-back date is ambiguous and takes the earlier offset', () => {
    const c = named('US fall-back');
    const got = actual(c);
    expect(got.tzAmbiguous).toBe(true);
    expect(got.tzShifted).toBe(false);
    expect(got.utc.toISOString()).toBe(c.expect.utc);
    // -04 is EDT, the offset in force *before* the transition.
    expect(got.offsetSeconds).toBe(-4 * 3600);

    // The later of the two readings is a real instant an hour on.
    const later = new Date(got.utc.getTime() + 3600_000);
    expect(wallInZone(later, c.tzid)).toMatchObject({ hour: 1, minute: 30 });
  });

  it('02:30 on a US spring-forward date does not exist and shifts forward', () => {
    const c = named('US spring-forward');
    const got = actual(c);
    expect(got.tzShifted).toBe(true);
    expect(got.tzAmbiguous).toBe(false);
    expect(got.shiftSeconds).toBe(3600);
    expect(got.utc.toISOString()).toBe(c.expect.utc);
    // Shifted past the gap, so it reads 03:30 locally — never 02:30.
    expect(wallInZone(got.utc, c.tzid)).toMatchObject({ hour: 3, minute: 30 });
  });
});

describe('§5 Netherlands 1930 — a real limit of the Intl approach', () => {
  const c = named('Netherlands, 1930');

  it('tzdata puts Amsterdam on +01:19:32 in June 1930', () => {
    // 0:19:32 Amsterdam Mean Time plus an hour of Dutch summer time.
    expect(c.expect.offsetSeconds).toBe(1 * 3600 + 19 * 60 + 32);
    expect(c.expect.utc).toBe('1930-06-15T10:40:28.000Z');
  });

  // ICU rounds Amsterdam's sub-minute historical offset away and reports +01:00,
  // so this is off by 19m32s. Kept as a failing assertion rather than deleted:
  // it documents the gap and will start passing if ICU ever carries the rule.
  it.fails('Intl reproduces that offset (currently it does not)', () => {
    expect(actual(c).offsetSeconds).toBe(c.expect.offsetSeconds);
  });

  it('is still internally consistent — the instant round-trips', () => {
    const got = actual(c);
    expect(wallInZone(got.utc, c.tzid)).toMatchObject({
      year: 1930, month: 6, day: 15, hour: 12, minute: 0,
    });
  });
});

describe('round-trip invariant', () => {
  // The deepest property, and the only one that holds regardless of whose tz
  // rules the engine ships: a resolved instant, formatted back into its zone,
  // must reproduce the reading asked for. Shifted readings are excluded because
  // they deliberately name a wall time that does not exist.
  it(`holds for every non-shifted case (${cases.length} total)`, () => {
    const broken: string[] = [];
    for (const c of cases) {
      const got = actual(c);
      if (got.tzShifted) continue;
      const back = wallInZone(got.utc, c.tzid);
      const w = c.wall;
      if (back.year !== w.year || back.month !== w.month || back.day !== w.day ||
          back.hour !== w.hour || back.minute !== w.minute || back.second !== w.second) {
        broken.push(`${c.label}: asked ${JSON.stringify(w)} got ${JSON.stringify(back)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('shifted readings land exactly one gap past the reading asked for', () => {
    const shifted = cases.filter((c) => actual(c).tzShifted);
    expect(shifted.length).toBeGreaterThan(100);
    for (const c of shifted) {
      const got = actual(c);
      const asked = Date.UTC(c.wall.year, c.wall.month - 1, c.wall.day,
                             c.wall.hour, c.wall.minute, c.wall.second);
      const landed = wallInZone(got.utc, c.tzid);
      const landedMs = Date.UTC(landed.year, landed.month - 1, landed.day,
                                landed.hour, landed.minute, landed.second);
      expect(landedMs - asked).toBe(got.shiftSeconds * 1000);
    }
  });
});

describe('transition classification', () => {
  // Scoped to years where ICU and tzdata agree on the rules themselves. Before
  // that a zone can have a transition in one database and not the other, which
  // would be measuring ICU's history rather than this module's logic. The
  // pre-1976 cases get their own reporting block below.
  const transitions = cases.filter(
    (c) => c.kind === 'transition' && c.wall.year >= ICU_EXACT_FROM,
  );

  it('flags every real overlap as ambiguous', () => {
    const want = transitions.filter((c) => c.expect.tzAmbiguous);
    expect(want.length).toBeGreaterThan(100);
    const missed = want.filter((c) => !actual(c).tzAmbiguous).map((c) => c.label);
    expect(missed).toEqual([]);
  });

  it('flags every real gap as shifted, with the right gap length', () => {
    const want = transitions.filter((c) => c.expect.tzShifted);
    expect(want.length).toBeGreaterThan(100);
    const wrong = want
      .filter((c) => {
        const got = actual(c);
        return !got.tzShifted || got.shiftSeconds !== c.expect.shiftSeconds;
      })
      .map((c) => c.label);
    expect(wrong).toEqual([]);
  });

  it('never flags an ordinary reading', () => {
    const plain = cases.filter(
      (c) => c.wall.year >= ICU_EXACT_FROM && !c.expect.tzAmbiguous && !c.expect.tzShifted,
    );
    const noisy = plain
      .filter((c) => { const g = actual(c); return g.tzAmbiguous || g.tzShifted; })
      .map((c) => c.label);
    expect(noisy).toEqual([]);
  });
});

describe(`exact agreement with tzdata from ${ICU_EXACT_FROM}`, () => {
  const modern = cases.filter((c) => c.wall.year >= ICU_EXACT_FROM);

  it(`matches tzdata on all ${modern.length} cases`, () => {
    const wrong: string[] = [];
    for (const c of modern) {
      const got = actual(c);
      if (got.utc.toISOString() !== c.expect.utc ||
          got.offsetSeconds !== c.expect.offsetSeconds ||
          got.tzAmbiguous !== c.expect.tzAmbiguous ||
          got.tzShifted !== c.expect.tzShifted) {
        wrong.push(`${c.label}: want ${c.expect.utc}/${c.expect.offsetSeconds}s ` +
                   `got ${got.utc.toISOString()}/${got.offsetSeconds}s`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('pre-1976 ICU divergence', () => {
  // Not an aspiration — a measurement, so a regression in either direction shows
  // up. Every divergence must sit before ICU_EXACT_FROM; if one appears after it,
  // the assumption above has broken and the suite should fail loudly.
  it('confines every disagreement to earlier than ICU_EXACT_FROM', () => {
    const late = cases
      .filter((c) => c.wall.year >= ICU_EXACT_FROM)
      .filter((c) => actual(c).offsetSeconds !== c.expect.offsetSeconds)
      .map((c) => c.label);
    expect(late).toEqual([]);
  });

  it('reports the historical cases ICU gets wrong', () => {
    const early = cases.filter((c) => c.wall.year < ICU_EXACT_FROM);
    const off = early.filter((c) => actual(c).offsetSeconds !== c.expect.offsetSeconds);
    const zones = [...new Set(off.map((c) => c.tzid))].sort();
    const worst = Math.max(0, ...off.map((c) => Math.abs(actual(c).offsetSeconds - c.expect.offsetSeconds)));
    const share = off.length / early.length;
    console.info(
      `      pre-${ICU_EXACT_FROM}: ${off.length}/${early.length} cases diverge ` +
      `(${(share * 100).toFixed(1)}%) across ${zones.length} zone(s); ` +
      `worst ${(worst / 3600).toFixed(2)}h\n      ${zones.join(', ') || '(none)'}`,
    );
    // Divergence is a known, bounded defect in ICU's historical data — mostly
    // remote zones, worst cases several hours. The bound here is deliberately
    // loose: it exists to catch ICU dropping historical rules wholesale, not to
    // pin a number that legitimately moves with the engine's data.
    expect(share).toBeLessThan(0.2);
  });

  it('misclassifies no more than a handful of pre-1976 transitions', () => {
    const early = cases.filter((c) => c.kind === 'transition' && c.wall.year < ICU_EXACT_FROM);
    const wrong = early.filter((c) => {
      const got = actual(c);
      return got.tzAmbiguous !== c.expect.tzAmbiguous || got.tzShifted !== c.expect.tzShifted;
    });
    console.info(
      `      pre-${ICU_EXACT_FROM} transitions: ${wrong.length}/${early.length} misclassified` +
      (wrong.length ? `\n      ${[...new Set(wrong.map((c) => c.tzid))].join(', ')}` : ''),
    );
    // Where ICU places a transition on a different instant than tzdata, a probe
    // aimed at tzdata's edge can miss ICU's. Bounded, and confined to zones the
    // divergence report above already names.
    expect(wrong.length / early.length).toBeLessThan(0.2);
  });
});

describe('formatOffset', () => {
  it('renders whole and half-hour offsets', () => {
    expect(formatOffset(0)).toBe('UTC+00:00');
    expect(formatOffset(-5 * 3600)).toBe('UTC−05:00');
    expect(formatOffset(5.5 * 3600)).toBe('UTC+05:30');
    expect(formatOffset(11 * 3600)).toBe('UTC+11:00');
  });

  it('shows seconds only when a historical zone carries them', () => {
    expect(formatOffset(19 * 60 + 32)).toBe('UTC+00:19:32');
    expect(formatOffset(-(4 * 3600 + 56 * 60 + 2))).toBe('UTC−04:56:02');
  });
});
