// What the `[[` autocomplete offers, as pure functions over plain data so the
// editor source (`lib/editor/wikilinks.ts`) stays a thin adapter and every
// choice here is unit-tested.
//
//   [[abc            stage A: notes, by file name, folder path and title
//   [[Note#abc       stage B: Note's headings, then its blocks
//   [[Note#^abc      stage B: blocks only
//   [[#abc           stage B for the note being edited
//
// Picking a note leaves the caret INSIDE the brackets (before `]]`), so a `#`
// typed next opens stage B straight away; picking a heading or block finishes
// the link and moves the caret past `]]`.

import type { NoteTitle } from "../ipc";
import {
  type BlockAnchor,
  type BlockCandidate,
  type HeadingAnchor,
  type NoteAnchors,
  headingPath,
  normalizeHeading,
} from "./anchors";

/** What is typed between `[[` and the caret, split for the two stages. */
export type LinkQuery =
  | { stage: "note"; query: string }
  | {
      stage: "anchor";
      /** The note part (empty = the note being edited). */
      target: string;
      /** What follows the FIRST `#` (`^` included when typed). */
      rest: string;
      /** Offset of `rest` within the typed text. */
      restOffset: number;
      blocksOnly: boolean;
      /** The filter text: after `^`, or after the last `#` of a heading path. */
      query: string;
    };

/** Read the text typed after `[[`. Null once an alias (`|`) has started. */
export function parseLinkQuery(typed: string): LinkQuery | null {
  if (typed.includes("|")) return null;
  const hash = typed.indexOf("#");
  if (hash < 0) return { stage: "note", query: typed };
  const rest = typed.slice(hash + 1);
  const blocksOnly = rest.startsWith("^");
  const query = blocksOnly ? rest.slice(1) : rest.slice(rest.lastIndexOf("#") + 1);
  return {
    stage: "anchor",
    target: typed.slice(0, hash).trim(),
    rest,
    restOffset: hash + 1,
    blocksOnly,
    query: query.trim(),
  };
}

// ---- Stage A: notes ---------------------------------------------------------

export interface NoteOption {
  /** The file name shown first. */
  label: string;
  /** Folder (and title when it differs) shown beside it. */
  detail?: string;
  /** What goes between `[[` and `]]`: the stem, or the shortest unique path. */
  insert: string;
  path: string;
}

const stemOf = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const withoutMd = (path: string) => path.replace(/\.md$/i, "");

/** What to write between `[[` and `]]` so the link opens `path` and nothing
 *  else: its stem when no other note shares it, else its full path. */
export function uniqueLinkName(path: string, all: readonly NoteTitle[]): string {
  const stem = stemOf(path);
  const lower = stem.toLowerCase();
  const twins = all.filter((t) => t.path !== path && stemOf(t.path).toLowerCase() === lower);
  // A non-`.md` note (a `.txt`) resolves by its full name only, never its stem.
  if (!/\.md$/i.test(path)) return path.slice(path.lastIndexOf("/") + 1);
  if (twins.length === 0) return stem;
  // `resolve_wikilink` matches a full relative path, then a BASENAME — a
  // partial path like `B/Plan` would fall through to the basename and could
  // open the twin. So a shared name always links by its full path.
  return withoutMd(path);
}

/** Rank notes for a query: name prefix, then name substring, then folder or
 *  title substring. Every whitespace-separated word must match somewhere. */
export function noteOptions(titles: readonly NoteTitle[], query: string, limit = 50): NoteOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ t: NoteTitle; score: number }> = [];
  for (const t of titles) {
    const stem = stemOf(t.path).toLowerCase();
    const hay = `${stem} ${t.path.toLowerCase()} ${t.title.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const q = query.toLowerCase().trim();
    let score = 3;
    if (q && stem.startsWith(q)) score = 0;
    else if (q && stem.includes(q)) score = 1;
    else if (words.every((w) => stem.includes(w))) score = 2;
    scored.push({ t, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      stemOf(a.t.path).length - stemOf(b.t.path).length ||
      a.t.path.localeCompare(b.t.path),
  );
  return scored.slice(0, limit).map(({ t }) => {
    const stem = stemOf(t.path);
    const folder = folderOf(t.path);
    const parts = [folder, t.title && t.title !== stem ? t.title : ""].filter(Boolean);
    return {
      label: stem,
      ...(parts.length ? { detail: parts.join(" · ") } : {}),
      insert: uniqueLinkName(t.path, titles),
      path: t.path,
    };
  });
}

// ---- Stage B: headings and blocks --------------------------------------------

export type AnchorOption =
  | { kind: "heading"; label: string; level: number; insert: string; anchor: HeadingAnchor }
  | { kind: "block"; label: string; id: string; insert: string; anchor: BlockAnchor }
  | { kind: "candidate"; label: string; candidate: BlockCandidate }
  | { kind: "info"; label: string };

export interface AnchorOptionsInput {
  anchors: NoteAnchors;
  query: LinkQuery & { stage: "anchor" };
  /** Can this note take a new ` ^id`? (Not read-only, not locked.) */
  editable: boolean;
  /** For the note being edited: the caret, so the block it sits in is left out
   *  (a link to itself is never what you were typing). */
  caret?: number;
  limit?: number;
}

const matches = (text: string, q: string) => !q || normalizeHeading(text).includes(normalizeHeading(q));

export function anchorOptions(input: AnchorOptionsInput): AnchorOption[] {
  const { anchors, query, editable, caret, limit = 60 } = input;
  const q = query.query;
  const out: AnchorOption[] = [];
  if (!query.blocksOnly) {
    for (const h of anchors.headings) {
      if (!matches(h.text, q)) continue;
      out.push({
        kind: "heading",
        label: h.text,
        level: h.level,
        insert: headingPath(anchors.headings, h).join("#"),
        anchor: h,
      });
    }
  }
  const lowerQ = q.toLowerCase();
  const blockHit = (preview: string, id?: string) =>
    !q || matches(preview, q) || (id !== undefined && id.toLowerCase().includes(lowerQ));
  for (const b of anchors.blocks) {
    if (caret !== undefined && caret >= b.from && caret <= b.to) continue;
    if (!blockHit(b.preview, b.id)) continue;
    out.push({ kind: "block", label: b.preview || `^${b.id}`, id: b.id, insert: `^${b.id}`, anchor: b });
  }
  if (editable) {
    for (const c of anchors.candidates) {
      if (caret !== undefined && caret >= c.from && caret <= c.to) continue;
      if (!c.preview || !blockHit(c.preview)) continue;
      out.push({ kind: "candidate", label: c.preview, candidate: c });
    }
  }
  const trimmed = out.slice(0, limit);
  if (trimmed.length === 0) {
    const empty = anchors.headings.length + anchors.blocks.length + anchors.candidates.length === 0;
    trimmed.push({
      kind: "info",
      label: empty
        ? "This note has no headings or blocks yet"
        : query.blocksOnly
          ? `No block matches “${q}”`
          : `No heading or block matches “${q}”`,
    });
  } else if (!editable && anchors.candidates.length > 0) {
    trimmed.push({ kind: "info", label: "Read-only note: only blocks that already have an id can be linked" });
  }
  return trimmed;
}
