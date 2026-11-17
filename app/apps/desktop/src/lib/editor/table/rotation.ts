/**
 * Rotated column headers: a header cell whose text runs "up" (90°) or "down"
 * (−90°), so a column whose only wide thing is its title can be narrow.
 *
 * Markdown tables have no attributes, so the rotation lives in the header
 * cell's own source as an HTML comment in front of the text:
 *
 *     | <!--rotate:90--> Repetitions | <!--rotate:-90--> Sets | Exercise |
 *
 * Obsidian, GitHub and every other renderer hide an HTML comment, so the same
 * `.md` still reads as a plain table everywhere else; only 2ndBrain turns the
 * text. Pure string helpers, no DOM.
 */

export type HeaderRotation = 90 | -90 | 0;

const MARKER = /^<!--\s*rotate:\s*([+-]?\s*90)\s*-->\s*/i;

/** The rotation a header cell's raw source asks for, and its text without the marker. */
export function headerRotation(raw: string): { deg: HeaderRotation; text: string } {
  const m = MARKER.exec(raw);
  if (!m) return { deg: 0, text: raw };
  const deg = m[1]!.replace(/\s+/g, "").startsWith("-") ? -90 : 90;
  return { deg, text: raw.slice(m[0].length) };
}

/** `text` (no marker) with the marker for `deg` in front; `0` = plain text. */
export function withHeaderRotation(text: string, deg: HeaderRotation): string {
  const plain = headerRotation(text).text;
  if (deg === 0) return plain;
  return plain === "" ? `<!--rotate:${deg}-->` : `<!--rotate:${deg}--> ${plain}`;
}
