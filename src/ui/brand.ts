/**
 * The brand mark: a small brass crescent plus the wordmark, set above the
 * kicker on every screen. A generic lead-gate form is just an input and a
 * button; this exists so the page reads as one instrument with a name, seen
 * consistently on every screen, rather than a disposable one-off page.
 *
 * The crescent is two overlapping circles in CSS, not SVG or an image — same
 * reasoning as the ribbon (see ribbon.ts): no extra request, and it stays
 * exactly as sharp as the rest of the page at any zoom level.
 */

import { el } from './dom.js';

export function brandMark(): HTMLElement {
  return el('div', { class: 'brand' },
    el('span', { class: 'brand__mark', 'aria-hidden': 'true' }),
    el('span', { class: 'brand__word' }, 'Moon sign finder'));
}
