/**
 * All report prose, one export per sign.
 *
 * Voice per CLAUDE.md §8: sentence case, active voice, no mystical filler, no
 * exclamation marks. The register is the almanac, not the crystal shop —
 * observational, concrete, and willing to name a cost as well as a strength.
 */

export interface SignProfile {
  /** One line under the sign name on the reveal screen. */
  summary: string;
  /** The short profile shown free, above the gate. */
  body: string;
}

export const MOON_PROFILES: readonly SignProfile[] = [
  {
    summary: 'Feeling arrives as motion.',
    body:
      'You know you are upset because you are already moving. Reaction comes ' +
      'first and the reasoning catches up, usually accurate and usually late. ' +
      'Rest is something you have to schedule, because you will not drift into it.',
  },
  {
    summary: 'Steady, and slow to be moved.',
    body:
      'You settle rather than react, and you keep settling long after others ' +
      'have moved on. Comfort is not indulgence for you, it is how you regulate. ' +
      'The cost is that you will stay in a situation well past the point you knew it was over.',
  },
  {
    summary: 'You process by talking it through.',
    body:
      'A feeling does not become real until you have put it into words, so you ' +
      'narrate, ask, and revise in company. This makes you quick to understand ' +
      'yourself and slow to sit still with anything you have not yet explained.',
  },
  {
    summary: 'You take the temperature of the room before you enter it.',
    body:
      'You read atmosphere early and absorb more of it than you intend. Care is ' +
      'your default move, often before anyone asks. The work is telling your own ' +
      'weather apart from everyone else\'s.',
  },
  {
    summary: 'You need to be seen clearly, not constantly.',
    body:
      'Recognition steadies you, and its absence unsettles you more than you let ' +
      'on. You give warmth generously and in the open. What stings is not being ' +
      'disliked but being overlooked by someone whose attention you had counted on.',
  },
  {
    summary: 'You steady yourself by fixing something.',
    body:
      'Worry turns practical in your hands — you tidy, correct, prepare. Being ' +
      'useful is how you say you care, and you would rather be relied on than ' +
      'thanked. The cost is treating your own needs as the last item on the list.',
  },
  {
    summary: 'You regulate by keeping things even.',
    body:
      'You notice imbalance quickly and move to correct it, often by adjusting ' +
      'yourself. Company settles you and conflict costs you more than it costs ' +
      'most people. The work is saying the unbalancing thing anyway.',
  },
  {
    summary: 'You feel in full depth or not at all.',
    body:
      'Nothing registers as mild. You read what people are not saying, and you ' +
      'keep your own counsel until you are certain. Trust is slow, specific, and ' +
      'once given it is close to unconditional — which is exactly what makes ' +
      'betrayal so expensive.',
  },
  {
    summary: 'You need somewhere further to go.',
    body:
      'Confinement reads to you as a problem to solve, not a mood to sit in. You ' +
      'recover by changing the view, literally or intellectually. The risk is ' +
      'treating every difficult feeling as a signal to leave.',
  },
  {
    summary: 'You would rather manage a feeling than have one.',
    body:
      'You take responsibility early, often earlier than was fair. Composure ' +
      'comes easily and costs more than it looks like it does. Being cared for ' +
      'takes practice, because you learned to be the one who copes.',
  },
  {
    summary: 'You watch your own feelings from a step back.',
    body:
      'You understand what you feel before you are willing to be inside it. ' +
      'Distance is how you stay fair, and it is also how you avoid. You are ' +
      'loyal in a wide, principled way that can read as cool up close.',
  },
  {
    summary: 'The boundary between you and the room is thin.',
    body:
      'You absorb mood without deciding to, which makes you unusually kind and ' +
      'unusually porous. You need retreat the way other people need sleep. The ' +
      'work is naming which of the feelings in the room is actually yours.',
  },
];

/**
 * The five questions that separate two candidate signs when the birth time is
 * unknown. §7 treats the cusp state as the conversion asset, and this is what
 * the gate is promising — they resolve a pair by behaviour rather than by data
 * the visitor does not have.
 */
export const RESOLVER_QUESTIONS: readonly string[] = [
  'When something goes wrong, does your body move first or does your mind start explaining first?',
  'After a hard day, do you recover with company or with the door shut?',
  'When you are hurt, is it obvious within a minute, or does it surface days later?',
  'Do you soothe yourself by making a plan, or by changing your surroundings?',
  'When someone needs you, do you offer practical help or do you sit with them?',
];

export function moonProfile(sign: number): SignProfile {
  const p = MOON_PROFILES[((sign % 12) + 12) % 12];
  if (p === undefined) throw new RangeError(`no profile for sign ${sign}`);
  return p;
}
