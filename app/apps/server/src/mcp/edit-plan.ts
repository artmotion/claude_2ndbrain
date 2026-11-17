// `edit_note`'s planner: turns an agent's edits into `TextOp`s against the
// note's CURRENT text (it runs under the doc writer's lock), plus an honest
// report of what each edit matched. Pure — no I/O — so every rule is a unit
// test (`tests/mcp-edits.test.ts`).
//
// History (2026-11-17, "2ndBrain Improvements" #1): an agent replaced every
// en dash in a note with `{"find": "–", "replace": "-", "all": true}`, got
// `applied: 1` back, and found the note damaged all over ("Studio-Tage" →
// "Studio-T-ge", table rows merged). Two faults combined:
//   1. `foldForMatch` kept one `map` entry per CODE POINT while the folded
//      string is indexed in UTF-16 units. Every emoji (a surrogate pair) before
//      a match shifted the mapped span one character to the right, so the
//      replacement landed beside the dash instead of on it.
//   2. The tolerant fallback engaged for a one-character anchor and for
//      `all: true`, where "close enough" is never safe: a folded dash also
//      matches every plain hyphen.
// Now: the map is per UTF-16 unit; folding never applies to bulk edits, short
// anchors or anchors without a letter or digit, and only to a unique match that
// starts and ends on word boundaries; the result says how each edit matched
// (`matchMode`) and how many places it changed; `dryRun` previews without
// writing; `normalize_text` and `replace_regex` cover character clean-ups and
// patterns exactly.

import vm from "node:vm";
import type { TextOp } from "./doc-writer.js";

/** One `edit_note` instruction. */
export type NoteEdit =
  | { type: "replace"; find: string; replace: string; all?: boolean }
  | { type: "insert_before"; anchor: string; text: string }
  | { type: "insert_after"; anchor: string; text: string }
  | { type: "delete"; find: string; all?: boolean }
  /** Replace exact characters / strings everywhere (`{ "–": "-", "→": "->" }`). Never fuzzy. */
  | { type: "normalize_text"; map: Record<string, string> }
  /** A JavaScript regular expression; `replace` may use `$1`, `$<name>`, `$&`, `$$`. */
  | { type: "replace_regex"; pattern: string; flags?: string; replace: string; all?: boolean };

export type EditErrorCode = "anchor_not_found" | "anchor_ambiguous" | "bad_edit" | "bad_regex";

/**
 * An edit's anchor was missing or ambiguous — nothing was written. `code` is
 * surfaced on the tool result (and counted in the sync metrics) so a refusal can
 * be told apart from a crash without reading prose.
 */
export class EditError extends Error {
  constructor(
    message: string,
    readonly code: EditErrorCode = "bad_edit",
  ) {
    super(message);
  }
}

export type MatchMode = "exact" | "fuzzy" | "normalize" | "regex";

/** What one edit did. `count` is the number of places it changed. */
export interface EditReport {
  edit: number;
  type: NoteEdit["type"];
  matchMode: MatchMode;
  count: number;
  /** For a fuzzy match: where it landed and the note's ORIGINAL text there. */
  matches?: Array<{ line: number; original: string }>;
}

/** A before/after excerpt of one change (dry runs). */
export interface EditPreview {
  edit: number;
  line: number;
  before: string;
  after: string;
}

export interface EditPlan {
  ops: TextOp[];
  reports: EditReport[];
  /** Total number of places changed across all edits. */
  applied: number;
  /** The first {@link PREVIEW_MAX} changes, with context. */
  previews: EditPreview[];
  previewsTruncated: boolean;
}

/** Shortest anchor (in characters, ignoring surrounding space) that may match tolerantly. */
export const FUZZY_MIN_CHARS = 8;
/** Changes shown in a preview. */
export const PREVIEW_MAX = 50;
const PREVIEW_CONTEXT = 30;
/** `normalize_text` map entries. */
export const NORMALIZE_MAX_KEYS = 200;
/** Regex source length, and how long one regex edit may run. */
export const REGEX_MAX_PATTERN = 2000;
export const REGEX_TIMEOUT_MS = 1000;

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + needle.length;
  }
}

function anchorOf(edit: NoteEdit): string {
  return edit.type === "replace" || edit.type === "delete" ? edit.find : edit.type === "insert_before" || edit.type === "insert_after" ? edit.anchor : "";
}

// ── tolerant anchor matching ────────────────────────────────────────────────
//
// An agent copies its anchor out of `read_note`'s JSON, and that copy is not
// always byte-exact: a model rewrites a non-breaking or ideographic space as a
// plain space, drops zero-width characters it cannot see, straightens curly
// quotes, turns an en/em dash into a hyphen, collapses doubled spaces, loses the
// trailing spaces before a newline, or hands back NFC where the note holds NFD.
// Exact matching runs first and wins; folding is a FALLBACK, allowed only where
// a near miss cannot hit the wrong place (see `fuzzyAllowed`), and the same
// exactly-once rule applies to the folded text.
//
// `foldForMatch` returns the folded string plus `map`, where `map[i]` is the
// original index of folded UTF-16 unit `i` and `map[folded.length]` is the
// original length. A folded span `[a, b)` therefore covers the original span
// `[map[a], map[b])`, which is what the op deletes — the agent's replacement
// text goes in verbatim; folding never rewrites the note.

const UNICODE_SPACES = new Set([
  " ", " ", " ", " ", " ", " ", " ", " ",
  " ", " ", " ", " ", " ", " ", " ", "　",
]);
const ZERO_WIDTH = new Set(["​", "‌", "‍", "⁠", "﻿", "­"]);
const FOLD_CHAR: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
};
const COMBINING = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Fold one already-NFC character (or the empty string to drop it). */
function foldChar(ch: string): string {
  if (ch === "\t" || UNICODE_SPACES.has(ch)) return " ";
  if (ZERO_WIDTH.has(ch)) return "";
  return FOLD_CHAR[ch] ?? ch;
}

export interface Folded {
  folded: string;
  map: number[];
}

/**
 * Normalise `s` for matching. Rules (all many-to-one or many-to-zero, never
 * one-to-many, so every folded index maps back to one original index):
 * CRLF/CR → LF · tabs and Unicode spaces → space · a run of spaces collapses to
 * one, and vanishes before a line break or the end · zero-width characters and
 * soft hyphens vanish · curly quotes, primes and dashes straighten · a base
 * character plus its combining marks is NFC-composed as one group.
 */
export function foldForMatch(s: string): Folded {
  let out = "";
  const map: number[] = [];
  const hasMarks = COMBINING.test(s);
  let i = 0;
  const n = s.length;
  while (i < n) {
    const start = i;
    let group = s[i];
    i++;
    // Surrogate pair → one code point.
    if (group.charCodeAt(0) >= 0xd800 && group.charCodeAt(0) <= 0xdbff && i < n) {
      group += s[i];
      i++;
    }
    if (hasMarks) {
      while (i < n && COMBINING.test(s[i])) {
        group += s[i];
        i++;
      }
      group = group.normalize("NFC");
    }
    if (group === "\r") {
      if (s[i] === "\n") i++;
      out += "\n";
      map.push(start);
      continue;
    }
    const folded = group.length === 1 ? foldChar(group) : group;
    if (folded === " ") {
      // Swallow the whole run; drop it entirely before a line break / the end.
      while (i < n && (s[i] === " " || s[i] === "\t" || UNICODE_SPACES.has(s[i]))) i++;
      const atBreak = i >= n || s[i] === "\n" || s[i] === "\r";
      if (!atBreak) {
        out += " ";
        map.push(start);
      }
      continue;
    }
    // ONE map entry per UTF-16 unit of the output: `out` is indexed in units,
    // so a surrogate pair needs two (the old per-code-point map shifted every
    // match after an emoji). An unchanged group maps unit-for-unit; a composed
    // one maps all its units to the group's start.
    const unchanged = folded === s.slice(start, i);
    for (let k = 0; k < folded.length; k++) {
      out += folded[k];
      map.push(unchanged ? start + k : start);
    }
  }
  map.push(n);
  return { folded: out, map };
}

/** Does a match `[at, end)` of `needle` in `hay` start and end on word boundaries? */
function onWordBoundaries(hay: string, needle: string, at: number, end: number): boolean {
  const first = needle[0] ?? "";
  const last = needle[needle.length - 1] ?? "";
  const startOk = at === 0 || !WORD_CHAR.test(first) || !WORD_CHAR.test(hay[at - 1]!);
  const endOk = end >= hay.length || !WORD_CHAR.test(last) || !WORD_CHAR.test(hay[end]!);
  return startOk && endOk;
}

/**
 * `[start, end)` original spans of `anchor` in `text`, exact first, folded as a
 * fallback (only when `fuzzy` is allowed). A folded hit must start and end on
 * word boundaries, so a tolerant match never splits a word.
 */
export function findAnchor(
  text: string,
  anchor: string,
  opts: { fuzzy?: boolean } = {},
): { spans: Array<[number, number]>; folded: boolean } {
  const exact = occurrences(text, anchor);
  if (exact.length > 0 || opts.fuzzy === false) {
    return { spans: exact.map((at) => [at, at + anchor.length]), folded: false };
  }
  const fa = foldForMatch(anchor).folded;
  if (fa.length === 0) return { spans: [], folded: true };
  const ft = foldForMatch(text);
  const hits = occurrences(ft.folded, fa).filter((at) => onWordBoundaries(ft.folded, fa, at, at + fa.length));
  return {
    spans: hits.map((at) => [ft.map[at]!, ft.map[at + fa.length]!]),
    folded: true,
  };
}

/**
 * May this edit fall back to tolerant matching? Never for a bulk edit, never
 * for a short anchor, never for one made only of punctuation, dashes and
 * space — those are exactly the anchors where "close enough" hits something
 * else. A miss there is refused instead, which is safe.
 */
export function fuzzyAllowed(anchor: string, all: boolean): boolean {
  if (all) return false;
  const core = [...anchor.trim()];
  if (core.length < FUZZY_MIN_CHARS) return false;
  return core.some((ch) => /[\p{L}\p{N}]/u.test(ch));
}

/** 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * When the whole anchor is absent, say where its first line is — an agent that
 * pasted a multi-line anchor usually got the first line right and drifted after
 * it, and a line number lets it re-read just that part instead of guessing.
 */
function notFoundHint(text: string, anchor: string): string {
  const first = anchor.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first || first === anchor.trim()) return "";
  const { spans } = findAnchor(text, first, { fuzzy: fuzzyAllowed(first, false) });
  if (spans.length !== 1) return "";
  return ` Its first line appears alone at line ${lineAt(text, spans[0]![0])}; the rest differs from the note.`;
}

// ── regex ───────────────────────────────────────────────────────────────────

interface RegexHit {
  index: number;
  length: number;
  insert: string;
}

/** Expand `$&`, `$1`…`$99`, `$<name>`, `$$` in a replacement, like String#replace. */
function expandReplacement(rep: string, match: string, groups: Array<string | undefined>, named: Record<string, string | undefined> | undefined): string {
  return rep.replace(/\$(\$|&|<([^>]*)>|\d{1,2})/g, (whole, token: string, name?: string) => {
    if (token === "$") return "$";
    if (token === "&") return match;
    if (name !== undefined) return named?.[name] ?? "";
    const n = Number(token);
    if (n >= 1 && n <= groups.length) return groups[n - 1] ?? "";
    // `$12` with 1 group: `$1` + "2", as String#replace does.
    if (token.length === 2) {
      const one = Number(token[0]);
      if (one >= 1 && one <= groups.length) return (groups[one - 1] ?? "") + token[1];
    }
    return whole;
  });
}

/**
 * Every match of `pattern` in `text`, found in a separate V8 context with a
 * hard time limit: a pattern with catastrophic backtracking stops after
 * {@link REGEX_TIMEOUT_MS} instead of freezing the server for everyone.
 */
function regexHits(text: string, pattern: string, flags: string, replace: string): RegexHit[] {
  if (pattern.length === 0) throw new EditError("replace_regex needs a non-empty pattern", "bad_regex");
  if (pattern.length > REGEX_MAX_PATTERN) {
    throw new EditError(`replace_regex pattern is longer than ${REGEX_MAX_PATTERN} characters`, "bad_regex");
  }
  if (!/^[imsuv]*$/.test(flags)) {
    throw new EditError("replace_regex flags may only contain i, m, s, u, v (g is implied)", "bad_regex");
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, `${flags}g`);
  } catch (err) {
    throw new EditError(`replace_regex pattern is invalid: ${(err as Error).message}`, "bad_regex");
  }
  let raw: Array<{ index: number; match: string; groups: Array<string | undefined>; named?: Record<string, string | undefined> }>;
  try {
    raw = vm.runInNewContext(
      `(() => { const out = []; for (const m of text.matchAll(re)) {
          if (m[0].length === 0) continue;
          out.push({ index: m.index, match: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : undefined });
          if (out.length > 100000) break;
        } return out; })()`,
      { text, re },
      { timeout: REGEX_TIMEOUT_MS },
    );
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new EditError(
        `replace_regex took longer than ${REGEX_TIMEOUT_MS} ms and was stopped (catastrophic backtracking?) — nothing was written`,
        "bad_regex",
      );
    }
    throw new EditError(`replace_regex failed: ${(err as Error).message}`, "bad_regex");
  }
  return raw.map((h) => ({
    index: h.index,
    length: h.match.length,
    insert: expandReplacement(replace, h.match, h.groups, h.named),
  }));
}

// ── normalize ───────────────────────────────────────────────────────────────

function normalizeHits(text: string, map: Record<string, string>): RegexHit[] {
  const keys = Object.keys(map).filter((k) => k.length > 0);
  if (keys.length === 0) throw new EditError("normalize_text needs a non-empty map", "bad_edit");
  if (keys.length > NORMALIZE_MAX_KEYS) {
    throw new EditError(`normalize_text map has more than ${NORMALIZE_MAX_KEYS} entries`, "bad_edit");
  }
  for (const k of keys) {
    if (typeof map[k] !== "string") throw new EditError(`normalize_text map value for ${JSON.stringify(k)} must be a string`, "bad_edit");
  }
  // Longest key first, one left-to-right scan: `"->"` never re-reads the `-`
  // a shorter key just wrote, and nothing is replaced twice.
  keys.sort((a, b) => b.length - a.length);
  const hits: RegexHit[] = [];
  let i = 0;
  while (i < text.length) {
    const key = keys.find((k) => text.startsWith(k, i));
    if (key && map[key] !== key) {
      hits.push({ index: i, length: key.length, insert: map[key]! });
      i += key.length;
    } else {
      i += key ? key.length : 1;
    }
  }
  return hits;
}

// ── the planner ─────────────────────────────────────────────────────────────

/**
 * Turn `edits` into ops against `current`, in order — each edit is matched in
 * the text as left by the previous ones, and its ops are emitted with indices
 * relative to that text (which is exactly how `TextOp`s are applied).
 *
 * Strict on purpose: an anchor must occur EXACTLY once unless the edit says
 * `all`. "Not found" and "ambiguous" are both refused with the count, so an
 * agent gets a conflict it can reason about instead of a change in the wrong
 * place. With `all`, a missing anchor is refused too — a bulk edit that found
 * nothing exact changes nothing and says so.
 */
export function planEditsDetailed(current: string, edits: NoteEdit[]): EditPlan {
  if (edits.length === 0) throw new EditError("edit_note needs at least one edit");
  const ops: TextOp[] = [];
  const reports: EditReport[] = [];
  const previews: EditPreview[] = [];
  let previewsTruncated = false;
  let applied = 0;
  let text = current;

  /** Apply one edit's targets right-to-left, recording ops and previews. */
  const applyTargets = (n: number, targets: Array<{ at: number; end: number; insert: string }>) => {
    // Previews read the text as it is BEFORE this edit, left to right.
    for (const t of targets) {
      if (previews.length >= PREVIEW_MAX) {
        previewsTruncated = true;
        break;
      }
      const from = Math.max(0, t.at - PREVIEW_CONTEXT);
      const to = Math.min(text.length, t.end + PREVIEW_CONTEXT);
      previews.push({
        edit: n + 1,
        line: lineAt(text, t.at),
        before: text.slice(from, to),
        after: text.slice(from, t.at) + t.insert + text.slice(t.end, to),
      });
    }
    for (const t of [...targets].reverse()) {
      const op: TextOp = { index: t.at, deleteLength: t.end - t.at, insert: t.insert };
      ops.push(op);
      text = text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteLength);
    }
    applied += targets.length;
  };

  edits.forEach((edit, n) => {
    if (edit.type === "normalize_text") {
      if (!edit.map || typeof edit.map !== "object") throw new EditError(`edit ${n + 1}: normalize_text needs a map`);
      const hits = normalizeHits(text, edit.map);
      reports.push({ edit: n + 1, type: edit.type, matchMode: "normalize", count: hits.length });
      applyTargets(n, hits.map((h) => ({ at: h.index, end: h.index + h.length, insert: h.insert })));
      return;
    }
    if (edit.type === "replace_regex") {
      const hits = regexHits(text, edit.pattern, edit.flags ?? "", edit.replace);
      if (hits.length === 0) {
        throw new EditError(`edit ${n + 1} (replace_regex): the pattern matches nothing — nothing was written`, "anchor_not_found");
      }
      if (hits.length > 1 && edit.all !== true) {
        throw new EditError(
          `edit ${n + 1} (replace_regex): the pattern matches ${hits.length} times — make it unique, or set all: true`,
          "anchor_ambiguous",
        );
      }
      reports.push({ edit: n + 1, type: edit.type, matchMode: "regex", count: hits.length });
      applyTargets(n, hits.map((h) => ({ at: h.index, end: h.index + h.length, insert: h.insert })));
      return;
    }

    const anchor = anchorOf(edit);
    if (typeof anchor !== "string" || anchor.length === 0) {
      throw new EditError(`edit ${n + 1}: the anchor text must be a non-empty string`);
    }
    const all = (edit.type === "replace" || edit.type === "delete") && edit.all === true;
    const { spans, folded } = findAnchor(text, anchor, { fuzzy: fuzzyAllowed(anchor, all) });
    if (spans.length === 0) {
      const why = fuzzyAllowed(anchor, all)
        ? ""
        : all
          ? " (with all: true only exact text is replaced)"
          : " (short or punctuation-only anchors are matched exactly)";
      throw new EditError(
        `edit ${n + 1} (${edit.type}): anchor not found${why} — nothing was written; the note may have changed, read it again.` +
          notFoundHint(text, anchor),
        "anchor_not_found",
      );
    }
    if (spans.length > 1 && !all) {
      throw new EditError(
        `edit ${n + 1} (${edit.type}): anchor matches ${spans.length} times — include more surrounding text to make it unique` +
          (edit.type === "replace" || edit.type === "delete" ? ", or set all: true" : ""),
        "anchor_ambiguous",
      );
    }
    const chosen = all ? spans : [spans[0]!];
    const report: EditReport = {
      edit: n + 1,
      type: edit.type,
      matchMode: folded ? "fuzzy" : "exact",
      count: chosen.length,
    };
    if (folded) {
      report.matches = chosen.map(([at, end]) => ({ line: lineAt(text, at), original: text.slice(at, end) }));
    }
    reports.push(report);
    applyTargets(
      n,
      chosen.map(([at, end]) => {
        switch (edit.type) {
          case "replace":
            return { at, end, insert: edit.replace };
          case "delete":
            return { at, end, insert: "" };
          case "insert_before":
            return { at, end: at, insert: edit.text };
          default:
            return { at: end, end, insert: edit.text };
        }
      }),
    );
  });
  return { ops, reports, applied, previews, previewsTruncated };
}

/** The ops alone (the shape the doc writer applies). */
export function planEdits(current: string, edits: NoteEdit[]): TextOp[] {
  return planEditsDetailed(current, edits).ops;
}
