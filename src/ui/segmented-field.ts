/**
 * A segmented numeric field — a row of small boxes (DAY / MONTH / YEAR, or
 * HOUR / MINUTE) instead of a native `<input type="date">` or `type="time">`.
 *
 * Built to replace the native pickers, whose browser-drawn calendar/clock
 * chrome looks inconsistent across platforms and reads as generic rather than
 * as part of this app's instrument. The digit-box-on-a-plate look fits §8's
 * "engraved plate, tabular data" direction directly, and it sidesteps native
 * date-input locale quirks (some browsers render mm/dd, others dd/mm, with no
 * way to control it) since every box here carries its own explicit caption.
 *
 * Behaviour: digits only, auto-advances to the next box on completion,
 * Backspace on an empty box steps back to the previous one, arrow keys move
 * between boxes at the text-cursor boundary. No smart paste-splitting — a
 * pasted "07/01/1988" landing in one box is deliberately not redistributed,
 * since guessing whether that means 7 January or 1 July is exactly the
 * ambiguity the labelled boxes exist to avoid.
 */

import { el } from './dom.js';

export interface Segment {
  id: string;
  /** Visible caption under the box, e.g. "Day". Also used as the aria-label. */
  label: string;
  length: number;
  placeholder: string;
}

export interface SegmentedField {
  root: HTMLElement;
  inputs: HTMLInputElement[];
  /** One entry per segment; null where the box is empty. */
  values(): (number | null)[];
  setValues(values: (number | null)[]): void;
  setDisabled(disabled: boolean): void;
  focusFirst(): void;
}

export function segmentedField(
  segments: Segment[],
  ariaLabel: string,
  onChange: () => void,
): SegmentedField {
  const inputs: HTMLInputElement[] = [];

  const boxes = segments.map((seg, i) => {
    const input = el('input', {
      type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off',
      id: seg.id, class: 'seg__input', maxlength: seg.length,
      placeholder: seg.placeholder, 'aria-label': seg.label,
      size: seg.length,
    });
    inputs.push(input);

    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, seg.length);
      input.value = digits;
      if (digits.length === seg.length && i < segments.length - 1) {
        inputs[i + 1]!.focus();
        inputs[i + 1]!.select();
      }
      onChange();
    });

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (event.key === 'Backspace' && input.value === '' && i > 0) {
        event.preventDefault();
        inputs[i - 1]!.focus();
        inputs[i - 1]!.select();
      } else if (event.key === 'ArrowLeft' && atStart && i > 0) {
        event.preventDefault();
        inputs[i - 1]!.focus();
        inputs[i - 1]!.setSelectionRange(inputs[i - 1]!.value.length, inputs[i - 1]!.value.length);
      } else if (event.key === 'ArrowRight' && atEnd && i < segments.length - 1) {
        event.preventDefault();
        inputs[i + 1]!.focus();
        inputs[i + 1]!.setSelectionRange(0, 0);
      }
    });

    input.addEventListener('focus', () => input.select());

    return el('div', { class: 'seg' },
      input,
      el('label', { class: 'seg__label', for: seg.id }, seg.label));
  });

  const root = el('div', { class: 'seg-group', role: 'group', 'aria-label': ariaLabel },
    ...boxes.flatMap((box, i) => (i === 0 ? [box] : [el('span', { class: 'seg__sep', 'aria-hidden': 'true' }, '·'), box])),
  );

  return {
    root,
    inputs,
    values: () => inputs.map((input) => (input.value === '' ? null : Number(input.value))),
    setValues: (values) => values.forEach((v, i) => { if (inputs[i]) inputs[i]!.value = v === null ? '' : String(v); }),
    setDisabled: (disabled) => inputs.forEach((input) => { input.disabled = disabled; }),
    focusFirst: () => inputs[0]?.focus(),
  };
}
