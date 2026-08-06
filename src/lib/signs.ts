/**
 * Sign metadata. Index 0 = Aries through 11 = Pisces, matching the ingress
 * tables (CLAUDE.md §4).
 */

export interface Sign {
  index: number;
  name: string;
  /** Unicode astrological glyph. Decorative — always paired with the name. */
  glyph: string;
}

const NAMES = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
] as const;

const GLYPHS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'] as const;

export const SIGNS: readonly Sign[] = NAMES.map((name, index) => ({
  index,
  name,
  glyph: GLYPHS[index]!,
}));

export function sign(index: number): Sign {
  const s = SIGNS[((index % 12) + 12) % 12];
  if (s === undefined) throw new RangeError(`no sign at index ${index}`);
  return s;
}

export const signName = (index: number): string => sign(index).name;
