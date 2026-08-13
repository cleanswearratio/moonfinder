/**
 * Screen 4 — thanks (CLAUDE.md §7).
 *
 * Confirm what was sent and where, using the same verb the button used (§8).
 * Offer a share link that encodes the result in the URL hash, so a friend lands
 * on a prefilled reveal rather than an empty form.
 *
 * Also carries a tripwire offer tied to the visitor's own result — see
 * `tripwireOffer` below. It links out to an external sales page; this app
 * never processes the payment itself, so it does not touch the "no payments
 * in v1" boundary in CLAUDE.md §12.
 */

import type { Reading } from '../lib/ingress.js';
import { moonProfile } from '../copy/report.js';
import { article, sign, signHue } from '../lib/signs.js';
import { brandMark } from './brand.js';
import { el } from './dom.js';

export interface ThanksOptions {
  moon: Reading;
  email: string;
  shareUrl: string;
  onRestart: () => void;
}

const TRIPWIRE_URL = 'https://wonderlandmethod.com/sales-letter-with-bonus';
const TRIPWIRE_PRICE = '$15';
const TRIPWIRE_WAS = '$28';

/**
 * The tie-in line: "this might meet you at your current position." Built from
 * the same profile summaries the reveal already uses, lowercased into a
 * clause, so the pitch is specific to what they were just told rather than a
 * generic upsell blurb.
 */
function tripwireOffer(moon: Reading): HTMLElement {
  const cusp = moon.kind === 'cusp';
  const first = sign(moon.signs[0]!);
  const lede = cusp
    ? `Whichever side of the boundary you land on, ${moonProfile(moon.signs[0]!).summary.toLowerCase()} ` +
      `Or ${moonProfile(moon.signs[1]!).summary.toLowerCase()} The Wonderland Method works with either.`
    : `${moonProfile(first.index).summary} That is exactly where The Wonderland Method starts.`;

  return el('div', { class: 'tripwire', style: `--sign-hue:${signHue(first.index)}` },
    el('p', { class: 'tripwire__kicker' }, 'One thing that meets you here'),
    el('p', { class: 'tripwire__lede' }, lede),
    el('div', { class: 'tripwire__price' },
      el('span', { class: 'tripwire__was' }, TRIPWIRE_WAS),
      el('span', { class: 'tripwire__now' }, TRIPWIRE_PRICE),
      el('span', { class: 'tripwire__price-note' }, 'today, as a thank-you for finishing your reading')),
    el('a', {
      class: 'button tripwire__button',
      href: TRIPWIRE_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, 'Get The Wonderland Method'),
  );
}

export function screenThanks({ moon, email, shareUrl, onRestart }: ThanksOptions): HTMLElement {
  const cusp = moon.kind === 'cusp';
  const names = moon.signs.map((s) => sign(s).name);

  const link = el('input', {
    type: 'text', class: 'share__input', readonly: true, value: shareUrl,
    'aria-label': 'Share link',
    onfocus: (event: Event) => (event.target as HTMLInputElement).select(),
  });

  const copy = el('button', { type: 'button', class: 'button button--quiet' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copy.textContent = 'Copied';
    } catch {
      link.select();
      copy.textContent = 'Press ⌘C to copy';
    }
    window.setTimeout(() => (copy.textContent = 'Copy link'), 2400);
  });

  return el('section', { class: 'thanks', 'aria-live': 'polite' },
    brandMark(),
    el('h2', { class: 'thanks__title' }, 'Sent'),
    el('p', { class: 'thanks__lede' },
      cusp
        ? `We sent the five questions that separate ${article(names[0]!)} ${names[0]} moon ` +
          `from ${article(names[1]!)} ${names[1]} one, plus both profiles, to `
        : `We sent your full ${names[0]} moon profile to `,
      el('strong', { class: 'thanks__email' }, email),
      '. It should arrive within a few minutes.'),
    el('p', { class: 'thanks__note' },
      'If it does not, check the spam folder — that is where a first email from ' +
      'a new sender usually lands.'),

    tripwireOffer(moon),

    el('div', { class: 'share' },
      el('p', { class: 'share__label' }, 'Send someone else straight to their result'),
      el('div', { class: 'share__row' }, link, copy)),

    el('button', { type: 'button', class: 'button button--quiet', onclick: onRestart },
      'Look up another birth'),
  );
}
