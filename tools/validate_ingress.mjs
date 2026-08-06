#!/usr/bin/env node
/**
 * Cross-validate the precomputed ingress tables against a second, independent
 * ephemeris. See CLAUDE.md §6.
 *
 * The tables come from Skyfield reading JPL DE421, a numerically integrated
 * ephemeris. This checks them with Astronomy Engine, which is a separate
 * codebase built on truncated analytic series. Two implementations sharing no
 * code and no data model; if they disagree anywhere, the build stops.
 *
 * Node-only on purpose. Vercel builds have no Python, so this is the gate that
 * actually runs on the deploy host, and it re-checks the committed tables'
 * internal structure as well as their astronomy.
 *
 * ---------------------------------------------------------------------------
 * Why the gate is stated in arcseconds
 *
 * §6 specifies the check as "longitude at t±60s is in the adjacent sign". That
 * reads as a tolerance on time, but it is really a tolerance on angle wearing a
 * disguise, and the disguise does not transfer between bodies:
 *
 *   Moon   0.5486"/s   60 s of slack ~= 33" of slack
 *   Sun    0.0410"/s   60 s of slack ~=  2.5" of slack
 *
 * The two models differ on the Moon by -2.29" +/- 10.61" (max 30.4"), which is
 * Astronomy Engine's truncated lunar series against DE421's integration. DE421
 * is the accurate side; Astronomy Engine is a gross-error gate, not a precision
 * reference. On the Sun they agree to -0.34" +/- 0.95".
 *
 * So the same 60 s rule passes the Moon with 4.7 s to spare and fails the Sun
 * 11 times out of 1,392 -- not from any error in the table, but because the Sun
 * moves so slowly that 3.5" of model difference becomes 86 s of time. Gating on
 * angle is scale-free and says what we actually mean.
 *
 * The §6 wording is still enforced verbatim for the Moon, where it holds.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import * as Astronomy from 'astronomy-engine';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `--data-dir` exists so the gate can be pointed at deliberately corrupted
// copies and shown to fail. A check nobody has watched fail is not a check.
const dirArg = process.argv.indexOf('--data-dir');
const DATA_DIR = dirArg === -1
  ? join(REPO_ROOT, 'public', 'data')
  : process.argv[dirArg + 1];

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

/**
 * Thresholds are empirical, not aspirational: each is set from the measured
 * spread with enough headroom to absorb ordinary variation and not so much that
 * a real regression slips through. A wrong coordinate frame (J2000 instead of
 * of-date) drifts ~1.4 deg/century and would blow past these by three orders of
 * magnitude; dropping nutation would add up to 17" and also trip them.
 */
const BODIES = {
  moon: {
    longitude: (date) => Astronomy.EclipticGeoMoon(date).lon,
    maxArcsec: 45,        // observed max 30.4"
    maxBiasArcsec: 8,     // observed mean -2.29"
    deltaRange: [2750, 3750],
    enforceSpecWindow: true,   // §6's literal +/-60 s wording holds here
  },
  sun: {
    longitude: (date) => Astronomy.SunPosition(date).elon,
    maxArcsec: 15,        // observed max 3.5"
    maxBiasArcsec: 3,     // observed mean -0.34"
    deltaRange: [41000, 46000],
    enforceSpecWindow: false,  // 0.041"/s makes a 60 s window impossible here
  },
};

const SPEC_WINDOW_SECONDS = 60;
const RATE_PROBE_SECONDS = 300;

const wrap180 = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;
const signAt = (deg) => Math.floor(((deg % 360) + 360) % 360 / 30);

const failures = [];
const fail = (msg) => failures.push(msg);

/** Rebuild absolute UTC instants from the delta encoding. */
function reconstruct(table) {
  const epoch = Date.parse(table.epoch);
  if (Number.isNaN(epoch)) throw new Error(`unparseable epoch ${table.epoch}`);
  const times = new Array(table.deltas.length + 1);
  let ms = epoch + table.first_offset * 60_000;
  times[0] = ms;
  for (let i = 0; i < table.deltas.length; i++) {
    ms += table.deltas[i] * 60_000;
    times[i + 1] = ms;
  }
  return times;
}

/**
 * Re-check the table's own invariants. The Python generator asserts these before
 * writing, but that runs on a developer machine and these files are committed —
 * this is the copy the deploy actually ships.
 */
function checkStructure(name, table, cfg) {
  if (table.body !== name) fail(`${name}: body field says ${table.body}`);
  if (table.unit !== 'minutes') fail(`${name}: unit is ${table.unit}, expected minutes`);
  if (!Number.isInteger(table.start_sign) || table.start_sign < 0 || table.start_sign > 11) {
    fail(`${name}: start_sign ${table.start_sign} is not a sign index`);
  }
  if (!Number.isInteger(table.first_offset) || table.first_offset < 0) {
    fail(`${name}: first_offset ${table.first_offset} is not a non-negative integer`);
  }

  const [lo, hi] = cfg.deltaRange;
  let bad = 0, worst = null;
  for (let i = 0; i < table.deltas.length; i++) {
    const d = table.deltas[i];
    if (!Number.isInteger(d)) { fail(`${name}: delta[${i}] is not an integer`); break; }
    if (d < lo || d > hi) {
      bad++;
      if (worst === null || Math.abs(d - (lo + hi) / 2) > Math.abs(worst.d - (lo + hi) / 2)) {
        worst = { i, d };
      }
    }
  }
  if (bad > 0) {
    fail(`${name}: ${bad} delta(s) outside [${lo}, ${hi}] min, worst delta[${worst.i}] = ${worst.d}`);
  }
}

/** The astronomy: does the second implementation agree a boundary is here? */
function checkBoundaries(name, table, cfg, times) {
  const residuals = new Float64Array(times.length);
  let maxAbs = 0, worst = null, specFailures = 0, specWorst = null;
  let windowFailures = 0, windowWorst = null;
  let minSpecMarginSeconds = Infinity;

  for (let i = 0; i < times.length; i++) {
    const entered = (table.start_sign + i) % 12;
    const previous = (entered + 11) % 12;
    const boundary = 30 * entered;
    const t = times[i];

    // Angular residual: how far Astronomy Engine puts this instant from the
    // boundary the table claims it sits on.
    const residualDeg = wrap180(cfg.longitude(new Date(t)) - boundary);
    const arcsec = residualDeg * 3600;
    residuals[i] = arcsec;
    if (Math.abs(arcsec) > maxAbs) {
      maxAbs = Math.abs(arcsec);
      worst = { i, arcsec, t, entered };
    }

    // Local angular rate, measured rather than assumed, so the time-equivalent
    // window adapts to the Moon's 11.8-15.4 deg/day swing.
    const ahead = cfg.longitude(new Date(t + RATE_PROBE_SECONDS * 1000));
    const behind = cfg.longitude(new Date(t - RATE_PROBE_SECONDS * 1000));
    const rateArcsecPerSec = (wrap180(ahead - behind) * 3600) / (2 * RATE_PROBE_SECONDS);
    if (rateArcsecPerSec <= 0) {
      fail(`${name}: non-prograde local rate at ingress ${i} (${new Date(t).toISOString()})`);
      continue;
    }

    // Scale-free window: the time needed to cover maxArcsec at this rate.
    const windowSeconds = cfg.maxArcsec / rateArcsecPerSec;
    const before = signAt(cfg.longitude(new Date(t - windowSeconds * 1000)));
    const after = signAt(cfg.longitude(new Date(t + windowSeconds * 1000)));
    if (before !== previous || after !== entered) {
      windowFailures++;
      if (!windowWorst) windowWorst = { i, t, before, after, previous, entered, windowSeconds };
    }

    // §6 verbatim, where it is meaningful.
    if (cfg.enforceSpecWindow) {
      const sBefore = signAt(cfg.longitude(new Date(t - SPEC_WINDOW_SECONDS * 1000)));
      const sAfter = signAt(cfg.longitude(new Date(t + SPEC_WINDOW_SECONDS * 1000)));
      if (sBefore !== previous || sAfter !== entered) {
        specFailures++;
        if (!specWorst) specWorst = { i, t, sBefore, sAfter, previous, entered };
      }
      // How close this ingress came to breaking the 60 s rule.
      const margin = SPEC_WINDOW_SECONDS - Math.abs(arcsec) / rateArcsecPerSec;
      if (margin < minSpecMarginSeconds) minSpecMarginSeconds = margin;
    }
  }

  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const sd = Math.sqrt(residuals.reduce((a, b) => a + (b - mean) ** 2, 0) / residuals.length);

  if (maxAbs > cfg.maxArcsec) {
    fail(`${name}: worst residual ${worst.arcsec.toFixed(2)}" exceeds ${cfg.maxArcsec}" ` +
         `at ingress ${worst.i} (${new Date(worst.t).toISOString()}, entering ${SIGNS[worst.entered]})`);
  }
  if (Math.abs(mean) > cfg.maxBiasArcsec) {
    fail(`${name}: mean residual ${mean.toFixed(2)}" exceeds the ${cfg.maxBiasArcsec}" bias budget ` +
         `— a systematic offset suggests a frame or nutation difference, not model scatter`);
  }
  if (windowFailures > 0) {
    const w = windowWorst;
    fail(`${name}: ${windowFailures} boundary/boundaries fail the +/-${cfg.maxArcsec}" sign check, ` +
         `first at ingress ${w.i} (${new Date(w.t).toISOString()}): expected ` +
         `${SIGNS[w.previous]} -> ${SIGNS[w.entered]}, got ${SIGNS[w.before]} -> ${SIGNS[w.after]}`);
  }
  if (specFailures > 0) {
    const w = specWorst;
    fail(`${name}: ${specFailures} boundary/boundaries fail §6's literal +/-${SPEC_WINDOW_SECONDS}s check, ` +
         `first at ingress ${w.i} (${new Date(w.t).toISOString()}): expected ` +
         `${SIGNS[w.previous]} -> ${SIGNS[w.entered]}, got ${SIGNS[w.sBefore]} -> ${SIGNS[w.sAfter]}`);
  }

  return { mean, sd, maxAbs, worst, minSpecMarginSeconds };
}

function main() {
  const started = Date.now();
  let total = 0;

  for (const [name, cfg] of Object.entries(BODIES)) {
    const path = join(DATA_DIR, `${name}-ingress.json`);
    let table;
    try {
      table = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      fail(`${name}: cannot read ${relative(REPO_ROOT, path)} — ${err.message}`);
      continue;
    }

    checkStructure(name, table, cfg);
    const times = reconstruct(table);
    total += times.length;

    // The table must not wander outside the range it claims to cover.
    const span = (times[times.length - 1] - times[0]) / (365.25 * 86_400_000);
    const stats = checkBoundaries(name, table, cfg, times);

    const spec = cfg.enforceSpecWindow
      ? `, §6 ±60s margin ${stats.minSpecMarginSeconds.toFixed(1)}s`
      : '';
    console.log(
      `${name.padEnd(5)} ${String(times.length).padStart(6)} boundaries over ${span.toFixed(1)} yr  ` +
      `residual ${stats.mean.toFixed(2)}" ± ${stats.sd.toFixed(2)}"  ` +
      `max ${stats.maxAbs.toFixed(2)}" (limit ${cfg.maxArcsec}")${spec}`,
    );
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\nvalidation failed — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nThe tables and Astronomy Engine disagree. Do not ship this build.');
    process.exit(1);
  }
  console.log(`\nok — ${total} boundaries cross-validated against Astronomy Engine in ${seconds}s`);
}

main();
