/**
 * Local wall-clock time + IANA zone id -> UTC instant.
 *
 * See CLAUDE.md §5. The birthplace affects nothing about the moon sign except
 * this conversion; latitude and longitude play no part.
 *
 * The method is offset inversion through `Intl.DateTimeFormat` + `formatToParts`,
 * so the zone rules always come from the platform's own tzdata and can never
 * drift from a bundled copy. No timezone library.
 *
 * Two wall readings are not a single instant, and both are surfaced rather than
 * silently resolved:
 *
 *   ambiguous   the DST fall-back hour, which occurs twice. We take the earlier
 *               offset (the pre-transition one) and set `tzAmbiguous`.
 *   nonexistent the spring-forward gap, which never occurs. We shift forward by
 *               the length of the gap and set `tzShifted`.
 *
 * Known platform limit: `Intl` resolves historical offsets from the engine's ICU
 * build, which simplifies pre-1970 rules for some zones — sub-minute offsets are
 * rounded away and a number of zones carry the wrong offset entirely before
 * ~1976. `tests/tz.test.ts` measures this against real tzdata and pins the
 * affected cases. Births from 1976 on are exact everywhere.
 */

const DAY_MS = 86_400_000;

/** A reading off a clock on a wall. Not an instant until paired with a zone. */
export interface WallClock {
  year: number;
  /** 1-12, not the 0-11 that `Date` uses. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

export interface ZonedInstant {
  /** The resolved UTC instant. */
  utc: Date;
  /** Offset applied, seconds east of UTC. Historical zones can carry seconds. */
  offsetSeconds: number;
  /** The wall reading occurs twice; this is the earlier of the two. */
  tzAmbiguous: boolean;
  /** The wall reading never occurs; this is it shifted past the gap. */
  tzShifted: boolean;
  /** Length of the gap skipped, in seconds. Zero unless `tzShifted`. */
  shiftSeconds: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tzid: string): Intl.DateTimeFormat {
  let f = formatters.get(tzid);
  if (f === undefined) {
    // h23 rather than hour12:false — some engines render midnight as hour 24.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tzid, f);
  }
  return f;
}

/**
 * Pack wall-clock fields into the timestamp they would have if the reading were
 * UTC. Not an instant — a comparable encoding of the reading itself.
 */
function packWall(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
): number {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC folds years 0-99 into 1900-1999. Outside this app's range, but the
  // silent wrong answer is bad enough to be worth two lines.
  if (year >= 0 && year < 100) {
    const d = new Date(ms);
    d.setUTCFullYear(year);
    return d.getTime();
  }
  return ms;
}

/** The wall reading an observer in `tzid` sees at `instantMs`, packed. */
function wallAt(instantMs: number, tzid: string): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(tzid).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return packWall(p.year!, p.month!, p.day!, p.hour!, p.minute!, p.second!);
}

/** Zone offset in effect at `instantMs`, in milliseconds east of UTC. */
function offsetAt(instantMs: number, tzid: string): number {
  return wallAt(instantMs, tzid) - instantMs;
}

/**
 * Resolve a wall reading in a zone to a UTC instant.
 *
 * @throws RangeError if `tzid` is not a zone this platform knows.
 */
export function wallTimeToUtc(wall: WallClock, tzid: string): ZonedInstant {
  const target = packWall(
    wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second ?? 0,
  );

  // Guess that the reading is UTC, measure the zone's error there, correct once.
  const guessOffset = offsetAt(target, tzid);
  const correctedOffset = offsetAt(target - guessOffset, tzid);

  // Those two cover the ordinary case. The ±1 day probes are what make a
  // fall-back visible: when the first guess already lands in the pre-transition
  // regime it agrees with itself and converges, so the repeated hour is
  // undetectable without sampling the other side of the transition.
  const candidates = new Set([
    guessOffset,
    correctedOffset,
    offsetAt(target - DAY_MS, tzid),
    offsetAt(target + DAY_MS, tzid),
  ]);

  // An offset is admissible only if applying it reproduces the requested
  // reading exactly. Intl arbitrates, so this cannot disagree with the zone data.
  const hits = [...new Set([...candidates].map((o) => target - o))]
    .filter((t) => wallAt(t, tzid) === target)
    .sort((a, b) => a - b);

  const first = hits[0];
  if (first !== undefined) {
    // More than one admissible instant means the reading repeats. Take the
    // earlier, which is the one carrying the pre-transition (larger) offset.
    return {
      utc: new Date(first),
      offsetSeconds: (target - first) / 1000,
      tzAmbiguous: hits.length > 1,
      tzShifted: false,
      shiftSeconds: 0,
    };
  }

  // Nothing admissible: the reading falls in a spring-forward gap. If the two
  // measured offsets agreed, the corrected instant would have round-tripped and
  // we would not be here, so they bracket the transition. The smaller offset
  // yields the later instant, which is the reading pushed past the gap.
  const before = Math.min(guessOffset, correctedOffset);
  const after = Math.max(guessOffset, correctedOffset);
  return {
    utc: new Date(target - before),
    offsetSeconds: before / 1000,
    tzAmbiguous: false,
    tzShifted: true,
    shiftSeconds: (after - before) / 1000,
  };
}

/**
 * Render an offset the way the reveal screen shows it: `UTC+05:30`, `UTC−05:00`.
 * Uses a true minus sign, and only shows seconds when a historical zone has them.
 */
export function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '−' : '+';
  const total = Math.abs(offsetSeconds);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const seconds = total % 60;
  const base = `UTC${sign}${pad(total / 3600)}:${pad((total % 3600) / 60)}`;
  return seconds === 0 ? base : `${base}:${pad(seconds)}`;
}
