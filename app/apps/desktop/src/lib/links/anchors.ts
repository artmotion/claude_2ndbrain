// Link targets INSIDE a note: headings and `^block-id`s (Obsidian syntax).
//
//   [[Note#Heading]]          a heading in Note
//   [[Note#Chapter#Section]]  a heading nested under another
//   [[Note#^a1b2c3]]          the block carrying ` ^a1b2c3` at its end
//   [[#Heading]]              a heading in the current note
//
// Pure and line-based, so the SAME rules run in the editor (autocomplete,
// reveal, decorations), in Rust (`parse.rs parse_anchors`, which fills the
// `note_anchors` index) and on the server (`markdown/sections.ts`, the MCP
// section tools). All three are pinned by one fixture,
// `src/lib/links/__fixtures__/anchors.json`; change a rule here and the other
// two must change with it or their tests fail.
//
// The rules, deliberately small:
//   • frontmatter (`---` … `---`/`...` at the top) and fenced code are skipped;
//   • a heading is an ATX line `#`…`######` with ≤3 leading spaces and a
//     non-empty text (a closing `###` run is dropped). Setext headings are not
//     link targets;
//   • a BLOCK is a paragraph (consecutive non-blank lines) or one list item
//     (with its continuation lines). Headings, fences and thematic breaks end
//     a block and are not blocks themselves;
//   • a block's id is a trailing ` ^id` on its LAST line (`[A-Za-z0-9-]+`), or a
//     line holding only `^id` right after it.

export interface HeadingAnchor {
  kind: "heading";
  level: number;
  /** The heading text as written (closing `#`s removed). */
  text: string;
  /** Offset of the heading line's first character. */
  from: number;
  /** Offset of the heading line's end (before its newline). */
  to: number;
  /** 1-based line number. */
  line: number;
  /** Where the section this heading opens ends: the next heading of the same or
   *  a higher level, or the end of the text. */
  sectionEnd: number;
  /** Texts of the enclosing headings, outermost first. */
  parents: string[];
}

export interface BlockAnchor {
  kind: "block";
  id: string;
  /** Offset of the block's first character. */
  from: number;
  /** End of the block's last line (before its newline). */
  to: number;
  /** 1-based line number of the block's first line. */
  line: number;
  /** Short readable text of the block (markers and the id stripped). */
  preview: string;
}

/** A block without an id yet — what autocomplete offers to make linkable. */
export interface BlockCandidate {
  kind: "candidate";
  from: number;
  to: number;
  line: number;
  preview: string;
  /** Where ` ^id` goes: the end of the last line, trailing spaces excluded. */
  insertAt: number;
}

export interface NoteAnchors {
  headings: HeadingAnchor[];
  blocks: BlockAnchor[];
  candidates: BlockCandidate[];
}

export type Subpath =
  | { kind: "heading"; path: string[] }
  | { kind: "block"; id: string };

export interface ParsedWikilink {
  /** Text before any `#` or `|` (trimmed). Empty for `[[#Heading]]`. */
  target: string;
  subpath: Subpath | null;
  alias: string | null;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES_RE = /(?:^|[ \t]+)#+$/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const THEMATIC_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const STANDALONE_ID_RE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/;
const TRAILING_ID_RE = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;
/** A valid block id, as typed after `#^`. */
export const BLOCK_ID_RE = /^[A-Za-z0-9-]+$/;

const PREVIEW_MAX = 80;

interface Line {
  text: string;
  from: number;
  to: number;
  number: number;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  let n = 1;
  while (from <= text.length) {
    const nl = text.indexOf("\n", from);
    const end = nl === -1 ? text.length : nl;
    // A CRLF file keeps its `\r` out of the line text, never out of offsets.
    const visibleEnd = end > from && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    out.push({ text: text.slice(from, visibleEnd), from, to: visibleEnd, number: n });
    if (nl === -1) break;
    from = nl + 1;
    n++;
  }
  return out;
}

/** The index of the first line after the frontmatter (0 when there is none). */
function bodyStart(lines: Line[]): number {
  if (lines.length === 0 || lines[0]!.text.trimEnd() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.text.trimEnd();
    if (t === "---" || t === "...") return i + 1;
  }
  return 0;
}

/** `{char, run}` when the line opens or closes a code fence. */
function fenceOf(text: string): { ch: string; run: number; rest: string } | null {
  const trimmed = text.replace(/^ +/, "");
  if (text.length - trimmed.length > 3) return null;
  const ch = trimmed[0];
  if (ch !== "`" && ch !== "~") return null;
  let run = 0;
  while (trimmed[run] === ch) run++;
  if (run < 3) return null;
  return { ch, run, rest: trimmed.slice(run) };
}

function headingOf(text: string): { level: number; text: string } | null {
  const m = HEADING_RE.exec(text);
  if (!m) return null;
  let body = (m[2] ?? "").replace(CLOSING_HASHES_RE, "").trim();
  if (body === "") return null;
  body = body.replace(/[ \t]+/g, " ");
  return { level: m[1]!.length, text: body };
}

function previewOf(firstLine: string): string {
  let t = firstLine
    .replace(/^[ \t]*(?:>[ \t]?)+/, "")
    .replace(LIST_ITEM_RE, "")
    .replace(/^\[[ xX]\][ \t]+/, "")
    .replace(TRAILING_ID_RE, "")
    .trim();
  if (t.length > PREVIEW_MAX) t = `${t.slice(0, PREVIEW_MAX - 1).trimEnd()}…`;
  return t;
}

interface OpenBlock {
  first: Line;
  last: Line;
}

/** Every heading, id'd block and id-less block of a note. */
export function extractAnchors(text: string): NoteAnchors {
  const lines = splitLines(text);
  const headings: HeadingAnchor[] = [];
  const blocks: BlockAnchor[] = [];
  const candidates: BlockCandidate[] = [];
  const stack: HeadingAnchor[] = [];

  let fence: { ch: string; run: number } | null = null;
  let open: OpenBlock | null = null;
  // The most recently closed block, while it may still take a standalone `^id`.
  let lastClosed: { block: OpenBlock; index: number; isCandidate: boolean } | null = null;

  const close = () => {
    if (!open) return;
    const block = open;
    open = null;
    const preview = previewOf(block.first.text);
    const m = TRAILING_ID_RE.exec(block.last.text);
    if (m) {
      blocks.push({
        kind: "block",
        id: m[1]!,
        from: block.first.from,
        to: block.last.to,
        line: block.first.number,
        preview,
      });
      lastClosed = null;
      return;
    }
    const trimmedEnd = block.last.from + block.last.text.replace(/[ \t]+$/, "").length;
    candidates.push({
      kind: "candidate",
      from: block.first.from,
      to: block.last.to,
      line: block.first.number,
      preview,
      insertAt: trimmedEnd,
    });
    lastClosed = { block, index: candidates.length - 1, isCandidate: true };
  };

  for (let i = bodyStart(lines); i < lines.length; i++) {
    const line = lines[i]!;
    const f = fenceOf(line.text);
    if (fence) {
      if (f && f.ch === fence.ch && f.run >= fence.run && f.rest.trim() === "") fence = null;
      continue;
    }
    if (f && !(f.ch === "`" && f.rest.includes("`"))) {
      close();
      lastClosed = null;
      fence = { ch: f.ch, run: f.run };
      continue;
    }
    if (line.text.trim() === "") {
      close();
      continue;
    }
    const h = headingOf(line.text);
    if (h) {
      close();
      lastClosed = null;
      while (stack.length && stack[stack.length - 1]!.level >= h.level) {
        stack.pop()!.sectionEnd = line.from;
      }
      const anchor: HeadingAnchor = {
        kind: "heading",
        level: h.level,
        text: h.text,
        from: line.from,
        to: line.to,
        line: line.number,
        sectionEnd: text.length,
        parents: stack.map((s) => s.text),
      };
      headings.push(anchor);
      stack.push(anchor);
      continue;
    }
    const sid = STANDALONE_ID_RE.exec(line.text);
    if (sid) {
      close();
      const prev = lastClosed as { block: OpenBlock; index: number; isCandidate: boolean } | null;
      if (prev && prev.isCandidate) {
        candidates.splice(prev.index, 1);
        blocks.push({
          kind: "block",
          id: sid[1]!,
          from: prev.block.first.from,
          to: prev.block.last.to,
          line: prev.block.first.number,
          preview: previewOf(prev.block.first.text),
        });
      }
      lastClosed = null;
      continue;
    }
    if (THEMATIC_RE.test(line.text)) {
      close();
      lastClosed = null;
      continue;
    }
    if (LIST_ITEM_RE.test(line.text)) {
      close();
      open = { first: line, last: line };
      continue;
    }
    if (open) open.last = line;
    else open = { first: line, last: line };
  }
  close();
  return { headings, blocks, candidates };
}

/** The comparison form of a heading: link-unsafe characters as spaces,
 *  whitespace collapsed, case folded. Both a heading and a link's segment go
 *  through it, so `## A: B` answers `[[Note#A B]]` and `[[Note#a: b]]`. */
export function normalizeHeading(s: string): string {
  return s
    .replace(/%%|[#|^:[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The heading text as it is written INTO a link: the characters a wiki-link
 *  cannot carry (`# | ^ : [ ] \ %%`) become spaces. Case is kept. */
export function headingLinkText(s: string): string {
  return s
    .replace(/%%|[#|^:[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a wiki-link's inner text into target, subpath and alias. */
export function parseWikilinkInner(inner: string): ParsedWikilink {
  const pipe = inner.indexOf("|");
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() || null : null;
  const head = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = head.indexOf("#");
  const target = (hash >= 0 ? head.slice(0, hash) : head).trim();
  if (hash < 0) return { target, subpath: null, alias };
  const rest = head.slice(hash + 1).trim();
  if (rest.startsWith("^")) {
    const id = rest.slice(1).trim();
    return { target, subpath: BLOCK_ID_RE.test(id) ? { kind: "block", id } : null, alias };
  }
  const path = rest
    .split("#")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return { target, subpath: path.length ? { kind: "heading", path } : null, alias };
}

/** The `#…` suffix a subpath is written as. */
export function formatSubpath(subpath: Subpath): string {
  return subpath.kind === "block" ? `#^${subpath.id}` : `#${subpath.path.join("#")}`;
}

/** The heading a heading path names. The last segment must match; when several
 *  headings match, the one whose ancestors contain the earlier segments (in
 *  order) wins, else the first. */
export function findHeading(headings: readonly HeadingAnchor[], path: readonly string[]): HeadingAnchor | null {
  if (path.length === 0) return null;
  const want = path.map(normalizeHeading);
  const last = want[want.length - 1]!;
  const hits = headings.filter((h) => normalizeHeading(h.text) === last);
  if (hits.length <= 1 || want.length === 1) return hits[0] ?? null;
  const ancestorsMatch = (h: HeadingAnchor) => {
    const parents = h.parents.map(normalizeHeading);
    let p = 0;
    for (const seg of want.slice(0, -1)) {
      while (p < parents.length && parents[p] !== seg) p++;
      if (p === parents.length) return false;
      p++;
    }
    return true;
  };
  return hits.find(ancestorsMatch) ?? hits[0]!;
}

/** Where a subpath points in a note, or null when nothing there answers it. */
export function findAnchor(anchors: NoteAnchors, subpath: Subpath): HeadingAnchor | BlockAnchor | null {
  if (subpath.kind === "block") {
    const want = subpath.id.toLowerCase();
    return anchors.blocks.find((b) => b.id.toLowerCase() === want) ?? null;
  }
  return findHeading(anchors.headings, subpath.path);
}

/** The shortest heading path that names `h` unambiguously in `headings`:
 *  just its text, or with as many enclosing headings as it takes. */
export function headingPath(headings: readonly HeadingAnchor[], h: HeadingAnchor): string[] {
  const own = headingLinkText(h.text);
  const path = [own];
  if (findHeading(headings, path) === h) return path;
  for (let i = h.parents.length - 1; i >= 0; i--) {
    path.unshift(headingLinkText(h.parents[i]!));
    if (findHeading(headings, path) === h) return path;
  }
  return path;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh 6-character block id not already in `taken` (compared lowercased). */
export function newBlockId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!used.has(id)) return id;
  }
}

/** The text a block id is appended as. */
export function blockIdSuffix(id: string): string {
  return ` ^${id}`;
}

/** A section's parts: the heading line, the body after it, and its end. */
export interface SectionRange {
  heading: HeadingAnchor;
  /** Start of the heading line. */
  from: number;
  /** First offset after the heading line's newline (= `to` at end of text). */
  bodyFrom: number;
  /** End of the section (start of the next same-or-higher heading, or EOF). */
  to: number;
}

export function sectionRange(text: string, heading: HeadingAnchor): SectionRange {
  const nl = text.indexOf("\n", heading.to);
  const bodyFrom = nl === -1 || nl >= heading.sectionEnd ? heading.sectionEnd : nl + 1;
  return { heading, from: heading.from, bodyFrom, to: heading.sectionEnd };
}
