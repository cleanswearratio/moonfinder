import { describe, expect, it } from 'vitest';
import { IngressTable, resolve, type IngressTableJson } from '../src/lib/ingress.js';
import { wallTimeToUtc } from '../src/lib/tz.js';
import moonJson from '../public/data/moon-ingress.json' with { type: 'json' };
import sunJson from '../public/data/sun-ingress.json' with { type: 'json' };

const moon = new IngressTable(moonJson as IngressTableJson);
const sun = new IngressTable(sunJson as IngressTableJson);

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('table decoding', () => {
  it('materialises every ingress', () => {
    expect(moon.count).toBe(moonJson.deltas.length + 1);
    expect(sun.count).toBe(sunJson.deltas.length + 1);
    expect(moon.count).toBe(18609);
    expect(sun.count).toBe(1392);
  });

  it('starts where the epoch and first offset say it does', () => {
    const expected = Date.parse(moonJson.epoch) + moonJson.first_offset * 60_000;
    expect(moon.timeAt(0).getTime()).toBe(expected);
  });

  it('covers the span the spec asks for', () => {
    const { start, end } = moon.coverage;
    expect(start.getUTCFullYear()).toBe(1920);
    expect(end.getUTCFullYear()).toBe(2035);
  });

  it('reconstructs absolute times without accumulating drift', () => {
    // Rounding happened once, on absolute times, so summing deltas must land
    // exactly on each stored instant rather than wandering by a minute a decade.
    let ms = Date.parse(moonJson.epoch) + moonJson.first_offset * 60_000;
    for (let i = 0; i < moonJson.deltas.length; i++) {
      expect(moon.timeAt(i).getTime()).toBe(ms);
      ms += moonJson.deltas[i]! * 60_000;
    }
    expect(moon.timeAt(moon.count - 1).getTime()).toBe(ms);
  });
});

describe('binary search', () => {
  it('lands exactly on an ingress instant', () => {
    const next = rng(11);
    for (let n = 0; n < 500; n++) {
      const i = Math.floor(next() * moon.count);
      expect(moon.indexAt(moon.timeAt(i).getTime())).toBe(i);
    }
  });

  it('puts the millisecond before an ingress in the previous segment', () => {
    const next = rng(12);
    for (let n = 0; n < 500; n++) {
      const i = 1 + Math.floor(next() * (moon.count - 1));
      expect(moon.indexAt(moon.timeAt(i).getTime() - 1)).toBe(i - 1);
    }
  });

  it('reports -1 before the table begins, and the sign still resolves', () => {
    const before = moon.timeAt(0).getTime() - 1;
    expect(moon.indexAt(before)).toBe(-1);
    // (startSign + -1) mod 12 — the same formula, no special case.
    expect(moon.signAt(before)).toBe((moon.startSign + 11) % 12);
  });

  it('holds the last index past the end of the table', () => {
    const after = moon.coverage.end.getTime() + 86_400_000;
    expect(moon.indexAt(after)).toBe(moon.count - 1);
  });
});

describe('sign sequence', () => {
  it('advances by exactly one sign at every ingress', () => {
    for (let i = 1; i < moon.count; i++) {
      const step = (moon.signEnteredAt(i) - moon.signEnteredAt(i - 1) + 12) % 12;
      expect(step).toBe(1);
    }
  });

  it('agrees between signAt and signEnteredAt across the segment', () => {
    const next = rng(13);
    for (let n = 0; n < 300; n++) {
      const i = Math.floor(next() * (moon.count - 1));
      const a = moon.timeAt(i).getTime();
      const b = moon.timeAt(i + 1).getTime();
      const mid = a + (b - a) * next();
      expect(moon.signAt(mid)).toBe(moon.signEnteredAt(i));
    }
  });
});

describe('§7 reading with a known birth time', () => {
  it('is always definite', () => {
    const next = rng(21);
    for (let n = 0; n < 200; n++) {
      const r = resolve(moon, {
        wall: {
          year: 1930 + Math.floor(next() * 100),
          month: 1 + Math.floor(next() * 12),
          day: 1 + Math.floor(next() * 28),
          hour: Math.floor(next() * 24),
          minute: Math.floor(next() * 60),
        },
        tzid: 'America/New_York',
        timeKnown: true,
      });
      expect(r.kind).toBe('definite');
      expect(r.signs).toHaveLength(1);
      expect(r.boundary).toBeNull();
    }
  });

  it('places the birth instant inside the span it draws', () => {
    const next = rng(22);
    for (let n = 0; n < 200; n++) {
      const r = resolve(moon, {
        wall: {
          year: 1950 + Math.floor(next() * 80),
          month: 1 + Math.floor(next() * 12),
          day: 1 + Math.floor(next() * 28),
          hour: Math.floor(next() * 24),
          minute: Math.floor(next() * 60),
        },
        tzid: 'Europe/Berlin',
        timeKnown: true,
      });
      const t = r.instant!.getTime();
      expect(t).toBeGreaterThanOrEqual(r.span.start.getTime());
      expect(t).toBeLessThan(r.span.end.getTime());
      expect(r.signs[0]).toBe(moon.signAt(t));
    }
  });
});

describe('§7 cusp logic with an unknown birth time', () => {
  const sample = (seed: number, tzid: string, count: number) => {
    const next = rng(seed);
    const out = [];
    for (let n = 0; n < count; n++) {
      out.push(resolve(moon, {
        wall: {
          year: 1925 + Math.floor(next() * 105),
          month: 1 + Math.floor(next() * 12),
          day: 1 + Math.floor(next() * 28),
          hour: 0,
          minute: 0,
        },
        tzid,
        timeKnown: false,
      }));
    }
    return out;
  };

  it('names two adjacent signs on a cusp, never guessing between them', () => {
    for (const r of sample(31, 'America/Chicago', 400)) {
      if (r.kind !== 'cusp') continue;
      expect(r.signs).toHaveLength(2);
      expect(r.signs[1]).toBe((r.signs[0]! + 1) % 12);
      expect(r.boundary).not.toBeNull();
    }
  });

  it('puts the boundary inside the birth day, and only then calls it a cusp', () => {
    for (const r of sample(32, 'Asia/Tokyo', 400)) {
      const { start, end } = r.day!;
      if (r.kind === 'cusp') {
        const b = r.boundary!.getTime();
        expect(b).toBeGreaterThan(start.getTime());
        expect(b).toBeLessThan(end.getTime());
      } else {
        // Definite means no ingress anywhere in the day.
        expect(moon.indexAt(start.getTime())).toBe(moon.indexAt(end.getTime() - 1));
        expect(r.boundary).toBeNull();
      }
    }
  });

  it('spans a local day exactly, DST included', () => {
    // 2024-03-10 is 23 hours long in New York; 2024-11-03 is 25.
    const short = resolve(moon, {
      wall: { year: 2024, month: 3, day: 10, hour: 0, minute: 0 },
      tzid: 'America/New_York', timeKnown: false,
    });
    const long = resolve(moon, {
      wall: { year: 2024, month: 11, day: 3, hour: 0, minute: 0 },
      tzid: 'America/New_York', timeKnown: false,
    });
    const hours = (r: typeof short) => (r.day!.end.getTime() - r.day!.start.getTime()) / 3_600_000;
    expect(hours(short)).toBe(23);
    expect(hours(long)).toBe(25);
  });

  it('draws a span containing both candidates and the boundary', () => {
    for (const r of sample(33, 'Europe/London', 400)) {
      if (r.kind !== 'cusp') continue;
      expect(r.span.start.getTime()).toBeLessThanOrEqual(r.day!.start.getTime());
      expect(r.span.end.getTime()).toBeGreaterThanOrEqual(r.day!.end.getTime());
      expect(moon.signAt(r.span.start.getTime())).toBe(r.signs[0]);
      expect(moon.signAt(r.boundary!.getTime())).toBe(r.signs[1]);
    }
  });

  it('hits the ~43% cusp rate §7 predicts', () => {
    // 24h over a mean 3278.6-minute gap is 43.9%. This is a live check on the
    // whole chain — tables, timezone inversion and day windowing together.
    const rs = sample(34, 'America/Denver', 3000);
    const rate = rs.filter((r) => r.kind === 'cusp').length / rs.length;
    expect(rate).toBeGreaterThan(0.40);
    expect(rate).toBeLessThan(0.48);
  });
});

describe('the sun table behaves the same way', () => {
  it('resolves a known instant and agrees with a direct lookup', () => {
    const r = resolve(sun, {
      wall: { year: 1988, month: 8, day: 12, hour: 9, minute: 0 },
      tzid: 'America/New_York', timeKnown: true,
    });
    expect(r.kind).toBe('definite');
    expect(r.signs[0]).toBe(sun.signAt(r.instant!.getTime()));
    // Mid-August is Leo, index 4.
    expect(r.signs[0]).toBe(4);
  });

  it('is far less likely to land on a cusp than the moon', () => {
    const next = rng(41);
    let cusps = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const r = resolve(sun, {
        wall: {
          year: 1940 + Math.floor(next() * 90),
          month: 1 + Math.floor(next() * 12),
          day: 1 + Math.floor(next() * 28),
          hour: 0, minute: 0,
        },
        tzid: 'Australia/Sydney', timeKnown: false,
      });
      if (r.kind === 'cusp') cusps++;
    }
    // 1440 minutes over a ~43,830-minute gap is about 3.3%.
    expect(cusps / n).toBeGreaterThan(0.015);
    expect(cusps / n).toBeLessThan(0.055);
  });
});

describe('timezone edge cases surface in the reading', () => {
  it('carries the ambiguous flag through', () => {
    const r = resolve(moon, {
      wall: { year: 2024, month: 11, day: 3, hour: 1, minute: 30 },
      tzid: 'America/New_York', timeKnown: true,
    });
    expect(r.tzAmbiguous).toBe(true);
    expect(r.instant!.toISOString()).toBe('2024-11-03T05:30:00.000Z');
  });

  it('carries the shifted flag through', () => {
    const r = resolve(moon, {
      wall: { year: 2024, month: 3, day: 10, hour: 2, minute: 30 },
      tzid: 'America/New_York', timeKnown: true,
    });
    expect(r.tzShifted).toBe(true);
    expect(r.instant!.toISOString()).toBe('2024-03-10T07:30:00.000Z');
  });

  it('agrees with tz.ts on the instant it used', () => {
    const wall = { year: 1975, month: 6, day: 4, hour: 18, minute: 45 };
    const r = resolve(moon, { wall, tzid: 'Asia/Kolkata', timeKnown: true });
    expect(r.instant!.getTime()).toBe(wallTimeToUtc(wall, 'Asia/Kolkata').utc.getTime());
    expect(r.offsetSeconds).toBe(5.5 * 3600);
  });
});
