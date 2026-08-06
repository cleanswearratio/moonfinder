/**
 * App wiring: four screens, one container, no router.
 *
 * The ingress tables are fetched once at startup — 33 KB gzipped for both — and
 * every answer after that is a binary search with no network call, which is the
 * whole architecture (CLAUDE.md §1).
 */

import { IngressTable, resolve, type IngressTableJson, type Reading } from './lib/ingress.js';
import { screenForm, type Submission } from './ui/screen-form.js';
import { screenReveal } from './ui/screen-reveal.js';
import { screenGate } from './ui/screen-gate.js';
import { screenThanks } from './ui/screen-thanks.js';
import { clear, el } from './ui/dom.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('#app is missing from the document');

interface Answer {
  submission: Submission;
  moon: Reading;
  sun: Reading;
}

/** `#d=1988-07-12&t=14:30&z=America/New_York`. Time omitted when unknown. */
function encodeHash(s: Submission): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const params = [
    `d=${s.wall.year}-${pad(s.wall.month)}-${pad(s.wall.day)}`,
    s.timeKnown ? `t=${pad(s.wall.hour)}:${pad(s.wall.minute)}` : '',
    `z=${encodeURIComponent(s.tzid)}`,
  ].filter(Boolean);
  return `#${params.join('&')}`;
}

function decodeHash(hash: string): Submission | null {
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const date = params.get('d');
  const tzid = params.get('z');
  if (date === null || tzid === null) return null;

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (dateMatch === null) return null;
  const [, y, mo, d] = dateMatch;

  const time = params.get('t');
  let hour = 12;
  let minute = 0;
  if (time !== null) {
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
    if (timeMatch === null) return null;
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    if (hour > 23 || minute > 59) return null;
  }

  // An unknown zone would throw deep inside the conversion; refuse it here.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
  } catch {
    return null;
  }

  return {
    wall: { year: Number(y), month: Number(mo), day: Number(d), hour, minute },
    tzid,
    timeKnown: time !== null,
    place: tzid.split('/').pop()?.replace(/_/g, ' ') ?? tzid,
  };
}

async function fetchTable(body: string): Promise<IngressTable> {
  const response = await fetch(`/data/${body}-ingress.json`);
  if (!response.ok) throw new Error(`${body} table: HTTP ${response.status}`);
  return new IngressTable((await response.json()) as IngressTableJson);
}

function show(node: HTMLElement): void {
  clear(root!);
  root!.append(node);
  // Send focus to the new screen so a keyboard or screen-reader user is not
  // left where the old one used to be.
  const heading = node.querySelector<HTMLElement>('h1, h2');
  if (heading !== null) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

async function start(): Promise<void> {
  let moonTable: IngressTable;
  let sunTable: IngressTable;
  try {
    [moonTable, sunTable] = await Promise.all([fetchTable('moon'), fetchTable('sun')]);
  } catch (cause) {
    show(el('section', { class: 'fatal', role: 'alert' },
      el('h1', {}, 'The sign tables did not load'),
      el('p', {}, 'Reload the page. If it keeps happening the data files are missing from this deploy.'),
      el('p', { class: 'fatal__detail' }, String(cause))));
    return;
  }

  const answer = (submission: Submission): Answer => ({
    submission,
    moon: resolve(moonTable, submission),
    sun: resolve(sunTable, submission),
  });

  const toThanks = (current: Answer, email: string): void => {
    const share = new URL(window.location.href);
    share.hash = encodeHash(current.submission);
    show(screenThanks({
      moon: current.moon,
      email,
      shareUrl: share.toString(),
      onRestart: () => {
        history.replaceState(null, '', window.location.pathname);
        toForm();
      },
    }));
  };

  const toGate = (current: Answer): void => {
    show(screenGate({
      moon: current.moon,
      sun: current.sun,
      birthYear: current.submission.wall.year,
      tzid: current.submission.tzid,
      onDone: (email) => toThanks(current, email),
    }));
  };

  const toReveal = (current: Answer): void => {
    show(screenReveal({
      moon: current.moon,
      sun: current.sun,
      tzid: current.submission.tzid,
      place: current.submission.place,
      onContinue: () => toGate(current),
    }));
  };

  function toForm(initial?: Submission): void {
    const coverage = moonTable.coverage;
    const pad = (n: number) => String(n).padStart(2, '0');
    show(screenForm({
      min: coverage.start,
      max: coverage.end,
      initial: initial && {
        date: `${initial.wall.year}-${pad(initial.wall.month)}-${pad(initial.wall.day)}`,
        time: initial.timeKnown ? `${pad(initial.wall.hour)}:${pad(initial.wall.minute)}` : '',
      },
      onSubmit: (submission) => toReveal(answer(submission)),
    }));
  }

  // A shared link lands straight on the result it encodes.
  const shared = decodeHash(window.location.hash);
  if (shared !== null) toReveal(answer(shared));
  else toForm();

  // Following a link to a different result on an already-open page is a
  // same-document navigation, so nothing would re-render without this. It also
  // makes the browser's back button behave the way the address bar implies.
  window.addEventListener('hashchange', () => {
    const next = decodeHash(window.location.hash);
    if (next !== null) toReveal(answer(next));
    else toForm();
  });
}

void start();
