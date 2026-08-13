/**
 * Screen 3 — the gate (CLAUDE.md §7).
 *
 * One email field. The offer differs by state: a definite reading buys the full
 * moon profile, a cusp buys the resolver questions as well. Submit stays
 * disabled until the address passes a shape check, there is a hidden honeypot,
 * and success transitions in place rather than navigating.
 *
 * ---------------------------------------------------------------------------
 * TEMPORARY — PREVIEW_SKIP_AC, requested by the owner while ActiveCampaign is
 * broken. While true:
 *   - any non-empty text passes where an email address would normally be
 *     required (looksLikeEmail below)
 *   - submit never calls POST /api/subscribe — it goes straight to onDone, so
 *     the gate cannot fail against a backend that is not wired up yet
 *
 * This is live on production the moment it merges: real visitors hitting the
 * deployed site can click through with garbage text and nothing is captured
 * or sent anywhere. Flip this back to false (or delete the branches below it)
 * as the first step of wiring up ActiveCampaign for real — searching this
 * file for PREVIEW_SKIP_AC finds every line it touches.
 */

import type { Reading } from '../lib/ingress.js';
import { article, sign } from '../lib/signs.js';
import { brandMark } from './brand.js';
import { el } from './dom.js';

const PREVIEW_SKIP_AC = true;

export interface GateOptions {
  moon: Reading;
  sun: Reading;
  birthYear: number;
  tzid: string;
  onDone: (email: string) => void;
}

/**
 * Deliberately loose. The server validates too (§9), and the only job here is
 * to stop an obvious slip before it costs the visitor a round trip.
 */
export const looksLikeEmail = (value: string): boolean =>
  PREVIEW_SKIP_AC
    ? value.trim().length > 0
    : /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());

export function screenGate({ moon, sun, birthYear, tzid, onDone }: GateOptions): HTMLElement {
  const cusp = moon.kind === 'cusp';
  const primary = sign(moon.signs[0]!);
  const alternate = cusp ? sign(moon.signs[1]!) : null;

  const email = el('input', {
    type: 'email', id: 'email', class: 'field__input',
    placeholder: 'you@example.com', required: true,
    autocomplete: 'email', inputmode: 'email',
  });

  // Honeypot. Hidden from people, tempting to a bot; §9 has the server return
  // 200 and do nothing when it arrives filled.
  const honeypot = el('input', {
    type: 'text', name: 'company', class: 'honeypot',
    tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true',
  });

  const error = el('p', { class: 'form__error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'button', disabled: true },
    cusp ? 'Send my questions and profile' : 'Send my full profile');

  email.addEventListener('input', () => {
    submit.disabled = !looksLikeEmail(email.value);
    if (error.textContent !== '') error.textContent = '';
  });

  const form = el('form', {
    class: 'form gate', novalidate: true,
    onsubmit: async (event: Event) => {
      event.preventDefault();
      if (!looksLikeEmail(email.value)) return;

      submit.disabled = true;
      submit.textContent = 'Sending…';
      error.textContent = '';

      // See PREVIEW_SKIP_AC above: no request goes out while this is true.
      if (PREVIEW_SKIP_AC) {
        onDone(email.value.trim());
        return;
      }

      try {
        const response = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: email.value.trim(),
            company: honeypot.value,
            moonSign: primary.name,
            moonAltSign: alternate?.name ?? '',
            moonCusp: cusp ? 'yes' : 'no',
            sunSign: sign(sun.signs[0]!).name,
            birthYear,
            birthTz: tzid,
            timeKnown: moon.instant === null ? 'no' : 'yes',
          }),
        });
        if (!response.ok) throw new Error(String(response.status));
        onDone(email.value.trim());
      } catch {
        // §8: say what went wrong and what to do about it.
        error.textContent = 'That did not send. Check your connection and try again.';
        submit.disabled = false;
        submit.textContent = cusp ? 'Send my questions and profile' : 'Send my full profile';
      }
    },
  },
    brandMark(),
    el('h2', { class: 'gate__title' },
      cusp
        ? `Which one you are, and what it means`
        : `Your ${primary.name} moon, in full`),

    el('p', { class: 'gate__lede' },
      cusp
        ? `Five questions that separate ${article(primary.name)} ${primary.name} moon from ` +
          `${article(alternate!.name)} ${alternate!.name} one, and the full profile for ` +
          'whichever you turn out to be.'
        : 'The long version: how this sign handles stress, rest, closeness and ' +
          'conflict, and where it tends to cost you.'),

    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'email' }, 'Email address'),
      email),

    honeypot,
    error,
    submit,

    // §10. Birth date, time and city together identify a person, so this says
    // plainly what happens to them.
    el('p', { class: 'privacy' },
      'We send this to your email address and store your result with our email ' +
      'provider. We do not sell it, and every email we send has an unsubscribe ' +
      'link. ',
      el('a', { href: '/privacy.html', class: 'privacy__link' }, 'Privacy'), '.'),
  );

  return form;
}
