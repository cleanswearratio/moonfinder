/**
 * Screen 2 — the reveal (CLAUDE.md §7).
 *
 * Free, instant, no gate. Three states:
 *
 *   known time                     definite sign
 *   unknown time, no ingress       definite sign, stated plainly
 *   unknown time, ingress that day cusp — two candidates, never a guess
 *
 * The cusp is roughly 43% of unknown-time visitors and is the primary
 * conversion asset, not an error state. The copy names both signs, shows where
 * the boundary falls, and says what would settle it.
 *
 * The sun sign is here too. It costs nothing and it makes the screen feel like
 * a result rather than a single word.
 */

import type { Reading } from '../lib/ingress.js';
import { sign } from '../lib/signs.js';
import { formatOffset } from '../lib/tz.js';
import { moonProfile } from '../copy/report.js';
import { brandMark } from './brand.js';
import { el } from './dom.js';
import { ribbon } from './ribbon.js';

export interface RevealOptions {
  moon: Reading;
  sun: Reading;
  tzid: string;
  place: string;
  onContinue: () => void;
}

function stamp(instant: Date, tzid: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tzid, day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
}

/** The one-line data row under the headline, in mono. This is tabular truth. */
function dataLine(moon: Reading, tzid: string, place: string): HTMLElement {
  const parts: string[] = [place];
  if (moon.instant !== null) {
    parts.push(stamp(moon.instant, tzid));
    parts.push(`${formatOffset(moon.offsetSeconds)} · ${moon.instant.toISOString().replace('.000', '')}`);
  } else {
    parts.push('time unknown');
    parts.push(formatOffset(moon.offsetSeconds));
  }
  return el('p', { class: 'reveal__data' }, ...parts.map((t) => el('span', {}, t)));
}

function tzNotice(moon: Reading, tzid: string): HTMLElement | null {
  if (moon.tzShifted) {
    return el('p', { class: 'notice' },
      'That clock time did not exist where you were born — the clocks went ' +
      'forward through it. We used the moment one hour later.');
  }
  if (moon.tzAmbiguous) {
    return el('p', { class: 'notice' },
      'The clocks went back that night, so your birth time happened twice. ' +
      'We used the first of the two, which is the earlier instant.');
  }
  if (moon.instant === null && moon.day !== null) {
    const hours = (moon.day.end.getTime() - moon.day.start.getTime()) / 3_600_000;
    if (hours !== 24) {
      return el('p', { class: 'notice' },
        `That day was ${hours} hours long in ${tzid.replace(/_/g, ' ')}, not 24 — ` +
        'the clocks changed. We used the real length.');
    }
  }
  return null;
}

function sunLine(sun: Reading): HTMLElement {
  const names = sun.signs.map((s) => sign(s).name);
  return el('p', { class: 'reveal__sun' },
    'Sun in ',
    el('strong', {}, names.length === 2 ? `${names[0]} or ${names[1]}` : names[0]!),
    names.length === 2 ? ' — the Sun also changed sign that day.' : '',
  );
}

export function screenReveal(options: RevealOptions): HTMLElement {
  const { moon, sun, tzid, place, onContinue } = options;
  const cusp = moon.kind === 'cusp';
  const first = sign(moon.signs[0]!);
  const second = cusp ? sign(moon.signs[1]!) : null;

  const headline = cusp
    ? el('h1', { class: 'reveal__headline' },
        el('span', { class: 'reveal__sign' }, first.name),
        el('span', { class: 'reveal__or' }, 'or'),
        el('span', { class: 'reveal__sign' }, second!.name))
    : el('h1', { class: 'reveal__headline' },
        el('span', { class: 'reveal__sign' }, first.name));

  const body = cusp
    ? el('div', { class: 'reveal__body' },
        el('p', {},
          'The Moon left ', el('strong', {}, first.name), ' and entered ',
          el('strong', {}, second!.name), ' on the day you were born. Without a ' +
          'birth time both remain possible, and we will not pick one for you.'),
        el('p', {},
          'They are not close in temperament. ',
          el('em', {}, moonProfile(first.index).summary), ' ',
          el('em', {}, moonProfile(second!.index).summary),
          ' Five questions about how you actually behave will settle it.'))
    : el('div', { class: 'reveal__body' },
        el('p', { class: 'reveal__summary' }, moonProfile(first.index).summary),
        el('p', {}, moonProfile(first.index).body),
        moon.instant === null
          ? el('p', {}, 'The Moon did not change sign that day, so the answer holds ' +
              'whatever time you were born.')
          : null);

  return el('section', { class: `reveal${cusp ? ' reveal--cusp' : ''}`, 'aria-live': 'polite' },
    brandMark(),
    el('p', { class: 'reveal__kicker' }, cusp ? 'Your moon sign is one of two' : 'Your moon sign'),
    headline,
    dataLine(moon, tzid, place),
    ribbon(moon, tzid),
    tzNotice(moon, tzid),
    body,
    sunLine(sun),
    el('button', { type: 'button', class: 'button', onclick: onContinue },
      cusp ? 'Send the questions that settle it' : 'Send my full moon profile'),
  );
}
