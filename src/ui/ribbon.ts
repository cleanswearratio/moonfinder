/**
 * The ribbon — the one memorable thing on the page (CLAUDE.md §8).
 *
 * A horizontal band of the Moon's passage through signs, spanning the ingress
 * before the birth moment to the ingress after it, with a brass marker at the
 * birth instant and the distance to each boundary in mono beneath.
 *
 * It earns its place three ways: it renders the data structure the whole app is
 * built on, it makes the answer feel located rather than asserted, and in the
 * cusp state the marker sits inside a hatched zone spanning the whole birth
 * date, which shows the ambiguity instead of describing it. That last one is
 * the conversion argument, so the hatching is the part to get right.
 *
 * Built from positioned elements rather than SVG: text stays at its natural
 * size at any width, which is what keeps it readable and scroll-free at 360px.
 */

import type { Reading } from '../lib/ingress.js';
import { sign, signHue } from '../lib/signs.js';
import { el, prefersReducedMotion } from './dom.js';

const HOUR_MS = 3_600_000;

interface Segment {
  sign: number;
  start: Date;
  end: Date;
}

function segmentsOf(reading: Reading): Segment[] {
  if (reading.kind === 'cusp' && reading.boundary !== null) {
    return [
      { sign: reading.signs[0]!, start: reading.span.start, end: reading.boundary },
      { sign: reading.signs[1]!, start: reading.boundary, end: reading.span.end },
    ];
  }
  return [{ sign: reading.signs[0]!, start: reading.span.start, end: reading.span.end }];
}

function localTime(instant: Date, tzid: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tzid, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
}

function localDate(instant: Date, tzid: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tzid, day: 'numeric', month: 'short', year: 'numeric',
  }).format(instant);
}

const hours = (ms: number): string => `${(ms / HOUR_MS).toFixed(1)} h`;

/** Text the screen reader gets in place of the graphic. */
function describe(reading: Reading, tzid: string): string {
  const segments = segmentsOf(reading);
  const names = segments.map((s) => sign(s.sign).name);
  if (reading.kind === 'cusp') {
    return `Timeline of the Moon's passage. It leaves ${names[0]} and enters ` +
      `${names[1]} at ${localTime(reading.boundary!, tzid)} on ` +
      `${localDate(reading.boundary!, tzid)}. The birth date spans that boundary, ` +
      `so both signs remain possible.`;
  }
  const from = localDate(reading.span.start, tzid);
  const to = localDate(reading.span.end, tzid);
  return `Timeline of the Moon's passage through ${names[0]}, from ${from} to ${to}` +
    (reading.instant === null ? '.' : `, with the birth moment marked inside it.`);
}

/** Percentage position of an instant along the drawn span. */
function makeScale(reading: Reading): (instant: Date) => number {
  const start = reading.span.start.getTime();
  const total = reading.span.end.getTime() - start;
  return (instant) => {
    if (total <= 0) return 0;
    const pct = ((instant.getTime() - start) / total) * 100;
    return Math.max(0, Math.min(100, pct));
  };
}

function caption(reading: Reading, tzid: string): HTMLElement {
  const items: string[] = [];

  if (reading.instant !== null) {
    // §8: hours to the previous boundary, hours to the next.
    items.push(`${hours(reading.instant.getTime() - reading.span.start.getTime())} since ${sign(reading.signs[0]!).name} began`);
    items.push(`${hours(reading.span.end.getTime() - reading.instant.getTime())} until the next sign`);
  } else if (reading.kind === 'cusp' && reading.boundary !== null) {
    items.push(`Boundary at ${localTime(reading.boundary, tzid)} local`);
    items.push(`${sign(reading.signs[0]!).name} before, ${sign(reading.signs[1]!).name} after`);
  } else {
    items.push(`${sign(reading.signs[0]!).name} for the whole day`);
    items.push(`next boundary ${localDate(reading.span.end, tzid)}`);
  }

  return el('div', { class: 'ribbon__caption' },
    ...items.map((text) => el('span', {}, text)));
}

export function ribbon(reading: Reading, tzid: string): HTMLElement {
  const at = makeScale(reading);
  const segments = segmentsOf(reading);

  const track = el('div', { class: 'ribbon__track' });

  for (const segment of segments) {
    const left = at(segment.start);
    const width = at(segment.end) - left;
    track.append(el('div',
      {
        class: 'ribbon__segment',
        // Each stretch of the ribbon is tinted with the sign it represents, so
        // the boundary is a change of colour and not just a hairline.
        style: `left:${left}%;width:${width}%;--sign-hue:${signHue(segment.sign)}`,
        'data-sign': sign(segment.sign).name,
      },
      el('span', { class: 'ribbon__segment-label' },
        el('span', { class: 'ribbon__glyph', 'aria-hidden': 'true' }, sign(segment.sign).glyph),
        el('span', { class: 'ribbon__name' }, sign(segment.sign).name)),
    ));
  }

  // The hatched zone: the whole birth date when the time is unknown. In the
  // cusp state this is the argument — the visitor sees the width of what they
  // do not know, straddling a boundary.
  if (reading.day !== null) {
    const left = at(reading.day.start);
    track.append(el('div', {
      class: 'ribbon__band',
      style: `left:${left}%;width:${at(reading.day.end) - left}%`,
      'aria-hidden': 'true',
    }));
  }

  // The marker and the boundary sit in an unclipped layer over the track. The
  // track clips its segments and scales on draw-in; neither should happen to a
  // marker whose head deliberately stands proud of the band.
  const overlay = el('div', { class: 'ribbon__overlay', 'aria-hidden': 'true' });

  if (reading.kind === 'cusp' && reading.boundary !== null) {
    overlay.append(el('div', {
      class: 'ribbon__boundary',
      style: `left:${at(reading.boundary)}%`,
    }));
  }

  if (reading.instant !== null) {
    overlay.append(el('div', {
      class: 'ribbon__marker',
      style: `left:${at(reading.instant)}%`,
    }));
  }

  const figure = el('figure',
    {
      class: `ribbon${reading.kind === 'cusp' ? ' ribbon--cusp' : ''}`,
      role: 'img',
      'aria-label': describe(reading, tzid),
    },
    el('div', { class: 'ribbon__frame' }, track, overlay),
    caption(reading, tzid),
  );

  // One orchestrated moment: the ribbon draws in, the marker lands, the sign
  // name sets. Nothing animates after this.
  if (prefersReducedMotion()) {
    figure.classList.add('is-drawn');
  } else {
    requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.add('is-drawn')));
  }

  return figure;
}
