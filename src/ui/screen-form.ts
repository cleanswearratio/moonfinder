/**
 * Screen 1 — the form (CLAUDE.md §7).
 *
 * Birth date, birth time with a prominent "I don't know my birth time" toggle,
 * city autocomplete. Nothing else, and no email field on this screen.
 */

import { cityLabel, loadCities, type City, type CityIndex } from '../lib/cities.js';
import type { WallClock } from '../lib/tz.js';
import { brandMark } from './brand.js';
import { clear, el } from './dom.js';
import { segmentedField } from './segmented-field.js';

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

/** A real calendar date within [minDate, maxDate], or null if not (yet) valid. */
function validateDate(
  values: (number | null)[], minDate: Date, maxDate: Date,
): { year: number; month: number; day: number } | null {
  const [day, month, year] = values;
  if (day == null || month == null || year == null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000) return null;
  const asUtc = Date.UTC(year, month - 1, day);
  const check = new Date(asUtc);
  // Catches rollover — e.g. day 31 in a 30-day month — which Date.UTC would
  // otherwise silently normalise into the following month.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  if (asUtc < minDate.getTime() || asUtc > maxDate.getTime()) return null;
  return { year, month, day };
}

function validateTime(values: (number | null)[]): { hour: number; minute: number } | null {
  const [hour, minute] = values;
  if (hour == null || minute == null) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function screenForm({ min, max, initial, onSubmit }: FormOptions): HTMLElement {
  let chosen: City | null = null;
  let index: CityIndex | null = null;
  let highlighted = -1;

  // The tables cover 1920-2035; keep a margin so the ribbon always has an
  // ingress on both sides of the birth.
  const minDate = new Date(min.getTime() + 2 * 86_400_000);
  const maxDate = new Date(max.getTime() - 7 * 86_400_000);

  const dateField = segmentedField(
    [
      { id: 'birth-day', label: 'Day', length: 2, placeholder: 'DD' },
      { id: 'birth-month', label: 'Month', length: 2, placeholder: 'MM' },
      { id: 'birth-year', label: 'Year', length: 4, placeholder: 'YYYY' },
    ],
    'Birth date',
    () => refresh(),
  );

  const timeField = segmentedField(
    [
      { id: 'birth-hour', label: 'Hour', length: 2, placeholder: 'HH' },
      { id: 'birth-minute', label: 'Minute', length: 2, placeholder: 'MM' },
    ],
    'Birth time',
    () => refresh(),
  );

  if (initial?.date) {
    const [y, mo, d] = initial.date.split('-').map(Number);
    if (y && mo && d) dateField.setValues([d, mo, y]);
  }
  if (initial?.time) {
    const [h, mi] = initial.time.split(':').map(Number);
    if (h !== undefined && mi !== undefined) timeField.setValues([h, mi]);
  }

  const unknown = el('input', { type: 'checkbox', id: 'time-unknown', class: 'toggle__box' });
  const dateError = el('p', { class: 'field__note field__note--error' });
  const timeError = el('p', { class: 'field__note field__note--error' });

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
    timeField.setDisabled(unknown.checked);

    const dateValues = dateField.values();
    const dateComplete = dateValues.every((v) => v !== null);
    const parsedDate = validateDate(dateValues, minDate, maxDate);
    dateError.textContent = dateComplete && parsedDate === null
      ? `Enter a date between ${minDate.getUTCFullYear()} and ${maxDate.getUTCFullYear()}.`
      : '';

    const timeValues = timeField.values();
    const timeComplete = timeValues.every((v) => v !== null);
    const parsedTime = validateTime(timeValues);
    timeError.textContent = !unknown.checked && timeComplete && parsedTime === null
      ? 'Enter a time on the 24-hour clock, 00:00 to 23:59.'
      : '';

    const timeReady = unknown.checked || parsedTime !== null;
    submit.disabled = !(parsedDate !== null && chosen !== null && timeReady);
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

  const timeHint = el('p', { class: 'field__note' },
    'Without it we can still narrow the answer, and often name it outright.');
  unknown.addEventListener('change', () => {
    timeHint.textContent = unknown.checked
      ? 'Without it we can still narrow the answer, and often name it outright.'
      : '24-hour clock — 2:30pm is 14:30.';
  });

  const form = el('form', {
    class: 'form', novalidate: true,
    onsubmit: (event: Event) => {
      event.preventDefault();
      if (chosen === null) return;

      const parsedDate = validateDate(dateField.values(), minDate, maxDate);
      if (parsedDate === null) return;

      let hour = 12;
      let minute = 0;
      if (!unknown.checked) {
        const parsedTime = validateTime(timeField.values());
        if (parsedTime === null) {
          error.textContent = 'Add your birth time, or tick that you do not know it.';
          return;
        }
        hour = parsedTime.hour;
        minute = parsedTime.minute;
      }

      error.textContent = '';
      onSubmit({
        wall: { ...parsedDate, hour, minute },
        tzid: chosen.tzid,
        timeKnown: !unknown.checked,
        place: cityLabel(chosen),
      });
    },
  },
    brandMark(),
    el('h1', { class: 'form__title' }, 'Find your moon sign'),
    el('p', { class: 'form__lede' },
      'Your sun sign is one twelfth of the sky. The Moon changes sign every two ' +
      'and a half days, which is why it says something more specific.'),

    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Birth date'),
      dateField.root,
      dateError),

    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Birth time'),
      timeField.root,
      el('label', { class: 'toggle', for: 'time-unknown' },
        unknown,
        el('span', {}, 'I don’t know my birth time')),
      timeError,
      timeHint),

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
