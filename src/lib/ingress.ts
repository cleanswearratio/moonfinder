/**
 * Lookup over the precomputed ingress tables, and the cusp logic built on it.
 *
 * See CLAUDE.md §1 and §7. Nothing here computes astronomy — every boundary was
 * fixed at build time and cross-validated (§6). This is a binary search and some
 * date arithmetic, which is the whole point of the architecture.
 */

import { wallTimeToUtc, type WallClock } from './tz.js';

/** The on-disk shape written by `tools/generate_ingress.py`. */
export interface IngressTableJson {
  body: string;
  epoch: string;
  unit: 'minutes';
  /** Sign entered at the first ingress. */
  start_sign: number;
  /** Minutes from `epoch` to the first ingress. */
  first_offset: number;
  /** Minutes from each ingress to the next. */
  deltas: number[];
}

/**
 * A decoded table. Absolute instants are materialised once at load so lookup is
 * a plain binary search rather than a running sum.
 */
export class IngressTable {
  readonly body: string;
  readonly startSign: number;
  private readonly times: Float64Array;

  constructor(json: IngressTableJson) {
    if (json.unit !== 'minutes') {
      throw new Error(`${json.body}: unsupported unit ${json.unit}`);
    }
    const epoch = Date.parse(json.epoch);
    if (Number.isNaN(epoch)) throw new Error(`${json.body}: bad epoch ${json.epoch}`);

    this.body = json.body;
    this.startSign = json.start_sign;
    this.times = new Float64Array(json.deltas.length + 1);
    let ms = epoch + json.first_offset * 60_000;
    this.times[0] = ms;
    for (let i = 0; i < json.deltas.length; i++) {
      ms += json.deltas[i]! * 60_000;
      this.times[i + 1] = ms;
    }
  }

  get count(): number {
    return this.times.length;
  }

  /** First and last ingress the table knows about. */
  get coverage(): { start: Date; end: Date } {
    return { start: new Date(this.times[0]!), end: new Date(this.times[this.times.length - 1]!) };
  }

  /** Index of the last ingress at or before `ms`; -1 if `ms` precedes the table. */
  indexAt(ms: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! <= ms) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  timeAt(index: number): Date {
    const t = this.times[index];
    if (t === undefined) throw new RangeError(`no ingress at index ${index}`);
    return new Date(t);
  }

  /** Sign entered at ingress `index`. */
  signEnteredAt(index: number): number {
    return (((this.startSign + index) % 12) + 12) % 12;
  }

  /**
   * Sign in force at `ms`. Falls out of the same formula before the table
   * starts, where the index is -1.
   */
  signAt(ms: number): number {
    return this.signEnteredAt(this.indexAt(ms));
  }
}

export interface BirthInput {
  /** Local calendar date. `hour`/`minute` are ignored when `timeKnown` is false. */
  wall: WallClock;
  tzid: string;
  timeKnown: boolean;
}

export interface Reading {
  /** `cusp` means the sign cannot be pinned down without the birth time. */
  kind: 'definite' | 'cusp';
  /** One sign when definite, two candidates when cusp, in order. */
  signs: number[];
  /** The resolved birth instant. Null when the time is unknown. */
  instant: Date | null;
  /** The local calendar day, when the time is unknown. */
  day: { start: Date; end: Date } | null;
  /** The stretch the ribbon draws, ingress to ingress. */
  span: { start: Date; end: Date };
  /** Ingress inside the day. Only set for a cusp. */
  boundary: Date | null;
  tzAmbiguous: boolean;
  tzShifted: boolean;
  offsetSeconds: number;
}

/** The wall-clock day after `w`, at midnight. `Date.UTC` handles the rollover. */
function nextDay(w: WallClock): WallClock {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

/**
 * Resolve a birth against one table.
 *
 * With a known time this is a single lookup. Without one, the answer depends on
 * whether an ingress falls inside the local day: if it does the sign genuinely
 * cannot be determined, and §7 is emphatic that we name both candidates rather
 * than guess or default to one.
 *
 * At most one ingress can land in a single day for either body — the Moon's
 * shortest gap is 2,814 minutes and the Sun's is 42,395, both comfortably over
 * 1,440 — so a cusp always has exactly two candidates.
 */
export function resolve(table: IngressTable, birth: BirthInput): Reading {
  const last = table.count - 1;
  const clamp = (i: number) => Math.max(0, Math.min(i, last));

  if (birth.timeKnown) {
    const zoned = wallTimeToUtc(birth.wall, birth.tzid);
    const ms = zoned.utc.getTime();
    const i = table.indexAt(ms);
    return {
      kind: 'definite',
      signs: [table.signEnteredAt(i)],
      instant: zoned.utc,
      day: null,
      span: { start: table.timeAt(clamp(i)), end: table.timeAt(clamp(i + 1)) },
      boundary: null,
      tzAmbiguous: zoned.tzAmbiguous,
      tzShifted: zoned.tzShifted,
      offsetSeconds: zoned.offsetSeconds,
    };
  }

  const midnight = { ...birth.wall, hour: 0, minute: 0, second: 0 };
  const dayStart = wallTimeToUtc(midnight, birth.tzid);
  const dayEnd = wallTimeToUtc(nextDay(birth.wall), birth.tzid);
  const day = { start: dayStart.utc, end: dayEnd.utc };

  const startIndex = table.indexAt(day.start.getTime());
  const endIndex = table.indexAt(day.end.getTime() - 1);

  if (startIndex === endIndex) {
    return {
      kind: 'definite',
      signs: [table.signEnteredAt(startIndex)],
      instant: null,
      day,
      span: { start: table.timeAt(clamp(startIndex)), end: table.timeAt(clamp(startIndex + 1)) },
      boundary: null,
      tzAmbiguous: dayStart.tzAmbiguous,
      tzShifted: dayStart.tzShifted,
      offsetSeconds: dayStart.offsetSeconds,
    };
  }

  // A boundary falls inside the day. Draw from the ingress that opened the first
  // candidate to the one that closes the second, so both signs are on screen
  // with the boundary between them.
  return {
    kind: 'cusp',
    signs: [table.signEnteredAt(startIndex), table.signEnteredAt(endIndex)],
    instant: null,
    day,
    span: { start: table.timeAt(clamp(startIndex)), end: table.timeAt(clamp(endIndex + 1)) },
    boundary: table.timeAt(clamp(endIndex)),
    tzAmbiguous: dayStart.tzAmbiguous,
    tzShifted: dayStart.tzShifted,
    offsetSeconds: dayStart.offsetSeconds,
  };
}
