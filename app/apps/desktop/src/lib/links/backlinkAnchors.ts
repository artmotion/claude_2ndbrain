// Backlinks by the heading or block they point at, as plain functions over the
// index's backlink rows (`get_backlinks`: one row per `[[…]]` occurrence, its
// `linkText` the raw inner text such as `Plan#Goals|see goals`).
//
// Feeds the per-heading reference counts in the editor, the "→ Goals" detail in
// the Backlinks card, and the heading-rename prompt.

import type { Backlink } from "../ipc";
import { type Subpath, normalizeHeading, parseWikilinkInner } from "./anchors";

/** The heading/block a backlink row names, or null for a whole-note link. */
export function backlinkSubpath(b: Pick<Backlink, "linkText">): Subpath | null {
  return parseWikilinkInner(b.linkText ?? "").subpath;
}

/** Does this subpath point at the heading `text` (as its last segment)? */
export function pointsAtHeading(subpath: Subpath | null, text: string): boolean {
  if (!subpath || subpath.kind !== "heading") return false;
  return normalizeHeading(subpath.path[subpath.path.length - 1]!) === normalizeHeading(text);
}

/** Backlink rows that name heading `text` anywhere in their path (so a parent
 *  rename counts the links into its children too). */
export function backlinksToHeading(backlinks: readonly Backlink[], text: string): Backlink[] {
  const key = normalizeHeading(text);
  return backlinks.filter((b) => {
    const s = backlinkSubpath(b);
    return s?.kind === "heading" && s.path.some((seg) => normalizeHeading(seg) === key);
  });
}

/** Reference counts per normalized heading text (last segment only) and per
 *  block id (lowercased). */
export function referenceCounts(backlinks: readonly Backlink[]): {
  headings: Map<string, Backlink[]>;
  blocks: Map<string, Backlink[]>;
} {
  const headings = new Map<string, Backlink[]>();
  const blocks = new Map<string, Backlink[]>();
  for (const b of backlinks) {
    const s = backlinkSubpath(b);
    if (!s) continue;
    const map = s.kind === "heading" ? headings : blocks;
    const key = s.kind === "heading" ? normalizeHeading(s.path[s.path.length - 1]!) : s.id.toLowerCase();
    const list = map.get(key);
    if (list) list.push(b);
    else map.set(key, [b]);
  }
  return { headings, blocks };
}

/** One linking note in the Backlinks card, with the places it points at. */
export interface BacklinkGroup {
  id: string;
  path: string;
  /** The aliases its links use (other than this note's own name). */
  aliases: string[];
  /** Headings / blocks of THIS note it links to, as written (`Goals`, `^ship1`). */
  targets: string[];
  /** How many `[[…]]` occurrences. */
  count: number;
}

export function groupBacklinks(backlinks: readonly Backlink[], currentLabel: string): BacklinkGroup[] {
  const groups = new Map<string, BacklinkGroup>();
  for (const b of backlinks) {
    let g = groups.get(b.id);
    if (!g) {
      g = { id: b.id, path: b.path, aliases: [], targets: [], count: 0 };
      groups.set(b.id, g);
    }
    g.count++;
    const parsed = parseWikilinkInner(b.linkText ?? "");
    const alias = parsed.alias ?? (parsed.target && parsed.target.toLowerCase() !== currentLabel.toLowerCase() ? parsed.target : null);
    if (alias && !g.aliases.includes(alias)) g.aliases.push(alias);
    if (parsed.subpath) {
      const t = parsed.subpath.kind === "block" ? `^${parsed.subpath.id}` : parsed.subpath.path.join(" › ");
      if (!g.targets.includes(t)) g.targets.push(t);
    }
  }
  return [...groups.values()];
}
