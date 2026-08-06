/**
 * Screen 4 — thanks (CLAUDE.md §7).
 *
 * Confirm what was sent and where, using the same verb the button used (§8).
 * Offer a share link that encodes the result in the URL hash, so a friend lands
 * on a prefilled reveal rather than an empty form.
 */

import type { Reading } from '../lib/ingress.js';
import { sign } from '../lib/signs.js';
import { el } from './dom.js';

export interface ThanksOptions {
  moon: Reading;
  email: string;
  shareUrl: string;
  onRestart: () => void;
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
    el('h2', { class: 'thanks__title' }, 'Sent'),
    el('p', { class: 'thanks__lede' },
      cusp
        ? `We sent the five questions that separate a ${names[0]} moon from a ` +
          `${names[1]} one, plus both profiles, to `
        : `We sent your full ${names[0]} moon profile to `,
      el('strong', { class: 'thanks__email' }, email),
      '. It should arrive within a few minutes.'),
    el('p', { class: 'thanks__note' },
      'If it does not, check the spam folder — that is where a first email from ' +
      'a new sender usually lands.'),

    el('div', { class: 'share' },
      el('p', { class: 'share__label' }, 'Send someone else straight to their result'),
      el('div', { class: 'share__row' }, link, copy)),

    el('button', { type: 'button', class: 'button button--quiet', onclick: onRestart },
      'Look up another birth'),
  );
}
