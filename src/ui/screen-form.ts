/**
 * Screen 1 — the form (CLAUDE.md §7).
 *
 * Birth date, birth time with a prominent "I don't know my birth time" toggle,
 * city autocomplete. Nothing else, and no email field on this screen.
 */

import { cityLabel, loadCities, type City, type CityIndex } from '../lib/cities.js';
import type { WallClock } from '../lib/tz.js';
import { clear, el } from './dom.js';

export interface Submission {
  wall: WallClock;
  tzid: string;
  timeKnown: boolean;
  place: string;
}

export interface FormOptions {
  min: Date;
  max: Date;
  initial?: Partial<Submission> & { date?: string; time?: string };
  onSubmit: (submission: Submission) => void;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function screenForm({ min, max, initial, onSubmit }: FormOptions): HTMLElement {
  let chosen: City | null = null;
  let index: CityIndex | null = null;
  let highlighted = -1;

  const date = el('input', {
    type: 'date', id: 'birth-date', class: 'field__input',
    // The tables cover 1920-2035; keep a margin so the ribbon always has an
    // ingress on both sides of the birth.
    min: isoDate(new Date(min.getTime() + 2 * 86_400_000)),
    max: isoDate(new Date(max.getTime() - 7 * 86_400_000)),
    required: true,
    value: initial?.date ?? '',
  });

  const time = el('input', {
    type: 'time', id: 'birth-time', class: 'field__input',
    value: initial?.time ?? '',
  });

  const unknown = el('input', { type: 'checkbox', id: 'time-unknown', class: 'toggle__box' });

  const cityInput = el('input', {
    type: 'text', id: 'birth-city', class: 'field__input',
    role: 'combobox', autocomplete: 'off', 'aria-expanded': 'false',
    'aria-controls': 'city-list', 'aria-autocomplete': 'list',
    placeholder: 'Start typing a city', required: true,
    value: initial?.place ?? '',
  });

  const list = el('ul', { id: 'city-list', class: 'combo__list', role: 'listbox', hidden: true });
  const cityNote = el('p', { class: 'field__note', id: 'city-note' });
  const error = el('p', { class: 'form__error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'button', disabled: true }, 'Show my moon sign');

  function refresh(): void {
    time.disabled = unknown.checked;
    const ready = date.value !== '' && chosen !== null && (unknown.checked || time.value !== '');
    submit.disabled = !ready;
  }

  function closeList(): void {
    list.hidden = true;
    clear(list);
    highlighted = -1;
    cityInput.setAttribute('aria-expanded', 'false');
    cityInput.removeAttribute('aria-activedescendant');
  }

  function choose(city: City): void {
    chosen = city;
    cityInput.value = cityLabel(city);
    cityNote.textContent = `Times resolved in ${city.tzid.replace(/_/g, ' ')}`;
    closeList();
    refresh();
  }

  function highlight(next: number): void {
    const options = [...list.querySelectorAll('li')];
    if (options.length === 0) return;
    highlighted = (next + options.length) % options.length;
    options.forEach((option, i) => {
      const active = i === highlighted;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
      if (active) cityInput.setAttribute('aria-activedescendant', option.id);
    });
  }

  async function suggest(): Promise<void> {
    chosen = null;
    cityNote.textContent = '';
    refresh();

    const query = cityInput.value.trim();
    if (query.length < 2) return closeList();

    index ??= await loadCities();
    // The field may have moved on while the fetch was in flight.
    if (cityInput.value.trim() !== query) return;

    const matches = index.search(query);
    clear(list);
    if (matches.length === 0) {
      closeList();
      cityNote.textContent = 'No match yet — try the nearest larger city.';
      return;
    }

    matches.forEach((city, i) => {
      list.append(el('li', {
        id: `city-option-${i}`, role: 'option', class: 'combo__option',
        'aria-selected': 'false',
        onmousedown: (event: Event) => { event.preventDefault(); choose(city); },
      },
        el('span', { class: 'combo__name' }, city.name),
        el('span', { class: 'combo__meta' }, [city.admin1, city.country].filter(Boolean).join(', ')),
      ));
    });
    list.hidden = false;
    cityInput.setAttribute('aria-expanded', 'true');
    highlighted = -1;

    if (index.usingFallback) {
      cityNote.textContent = 'Showing a short built-in list — the full city index is unavailable.';
    }
  }

  cityInput.addEventListener('input', () => void suggest());
  cityInput.addEventListener('blur', () => window.setTimeout(closeList, 120));
  cityInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (list.hidden) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight(highlighted + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(highlighted - 1); }
    else if (event.key === 'Escape') { closeList(); }
    else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault();
      list.querySelectorAll('li')[highlighted]?.dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  unknown.addEventListener('change', refresh);
  date.addEventListener('input', refresh);
  time.addEventListener('input', refresh);

  const form = el('form', {
    class: 'form', novalidate: true,
    onsubmit: (event: Event) => {
      event.preventDefault();
      if (chosen === null || date.value === '') return;

      const [year, month, day] = date.value.split('-').map(Number);
      if (year === undefined || month === undefined || day === undefined) return;

      let hour = 12;
      let minute = 0;
      if (!unknown.checked) {
        const [h, m] = time.value.split(':').map(Number);
        if (h === undefined || m === undefined) {
          error.textContent = 'Add your birth time, or tick that you do not know it.';
          return;
        }
        hour = h;
        minute = m;
      }

      error.textContent = '';
      onSubmit({
        wall: { year, month, day, hour, minute },
        tzid: chosen.tzid,
        timeKnown: !unknown.checked,
        place: cityLabel(chosen),
      });
    },
  },
    el('h1', { class: 'form__title' }, 'Find your moon sign'),
    el('p', { class: 'form__lede' },
      'Your sun sign is one twelfth of the sky. The Moon changes sign every two ' +
      'and a half days, which is why it says something more specific.'),

    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'birth-date' }, 'Birth date'),
      date),

    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'birth-time' }, 'Birth time'),
      time,
      el('label', { class: 'toggle', for: 'time-unknown' },
        unknown,
        el('span', {}, 'I don’t know my birth time')),
      el('p', { class: 'field__note' },
        'Without it we can still narrow the answer, and often name it outright.')),

    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'birth-city' }, 'Birth city'),
      el('div', { class: 'combo' }, cityInput, list),
      cityNote),

    error,
    submit,
  );

  refresh();
  return form;
}
