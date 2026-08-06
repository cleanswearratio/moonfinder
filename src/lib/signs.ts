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

/**
 * Hue for a sign, in OKLCH degrees.
 *
 * The zodiac is a 360° wheel cut into twelve equal 30° arcs, so the palette
 * rotates with it: one sign, one 30° step of hue. Adjacent signs get adjacent
 * colours and opposite signs land opposite each other, which means the pairing
 * on a cusp reveal is always a real contrast rather than two accidental
 * neighbours.
 *
 * OKLCH rather than HSL because it is perceptually uniform — holding lightness
 * and chroma fixed while only hue turns gives twelve colours of genuinely equal
 * weight, with no muddy stretch through the yellows and no washed-out blues.
 * That is what keeps every sign's contrast ratio within a narrow band
 * (measured 5.19–6.69:1 on the cream surface) instead of leaving four of them
 * illegible.
 */
export const signHue = (index: number): number => (18 + (((index % 12) + 12) % 12) * 30) % 360;
