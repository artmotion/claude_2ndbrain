// Section-level edits of a note's markdown, as pure "current text → new text"
// plans. The MCP tools (`mcp/service.ts` create_section / update_section /
// delete_section / add_block_id) run these INSIDE the doc writer's per-doc
// lock, so the section they find is the section they change.
//
// A section is named by a REF, the part after `#` in a wiki-link:
//   "Goals"          a heading (case and `: | # ^` insensitive)
//   "Plan#Goals"     a heading nested under another (disambiguates twins)
//   "^ship1"         a block carrying ` ^ship1`
// A leading `#` is accepted too, so `#Goals` and `#^ship1` work as written in
// a link.

import {
  type BlockAnchor,
  type HeadingAnchor,
  type NoteAnchors,
  extractAnchors,
  findHeading,
  headingLinkText,
  headingPath,
  newBlockId,
  normalizeHeading,
  renameHeadingLinks,
} from "./sections.js";

export type SectionErrorCode =
  | "section_not_found"
  | "section_ambiguous"
  | "section_exists"
  | "bad_section";

export class SectionError extends Error {
  constructor(
    message: string,
    readonly code: SectionErrorCode,
  ) {
    super(message);
  }
}

export type SectionRef = { kind: "heading"; path: string[] } | { kind: "block"; id: string };

export function parseSectionRef(raw: string): SectionRef {
  const ref = raw.trim().replace(/^#/, "").trim();
  if (ref.startsWith("^")) {
    const id = ref.slice(1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new SectionError(`Not a block id: "${raw}"`, "bad_section");
    return { kind: "block", id };
  }
  const path = ref
    .split("#")
    .map((s) => s.trim())
    .filter(Boolean);
  if (path.length === 0) throw new SectionError("A section reference must name a heading or a ^block-id", "bad_section");
  return { kind: "heading", path };
}

function outlineHint(anchors: NoteAnchors): string {
  if (anchors.headings.length === 0) return " This note has no headings.";
  const list = anchors.headings
    .slice(0, 30)
    .map((h) => headingPath(anchors.headings, h).join("#"))
    .join(", ");
  return ` Headings: ${list}${anchors.headings.length > 30 ? ", …" : ""}. Use list_sections for the full outline.`;
}

export function findHeadingRef(anchors: NoteAnchors, path: string[]): HeadingAnchor {
  const hit = findHeading(anchors.headings, path);
  if (!hit) {
    throw new SectionError(`No heading "${path.join("#")}" in this note.${outlineHint(anchors)}`, "section_not_found");
  }
  // A bare name that several headings share is ambiguous unless the path
  // pinned one down: refuse rather than edit the wrong twin.
  const twins = anchors.headings.filter((h) => normalizeHeading(h.text) === normalizeHeading(hit.text));
  if (twins.length > 1 && path.length === 1) {
    const options = twins.map((h) => headingPath(anchors.headings, h).join("#")).join(", ");
    throw new SectionError(
      `"${path[0]}" names ${twins.length} headings — use a path to pick one: ${options}`,
      "section_ambiguous",
    );
  }
  return hit;
}

function findBlockRef(anchors: NoteAnchors, id: string): BlockAnchor {
  const hit = anchors.blocks.find((b) => b.id.toLowerCase() === id.toLowerCase());
  if (!hit) throw new SectionError(`No block ^${id} in this note`, "section_not_found");
  return hit;
}

/** The outline an AI navigates by: every heading with the path that names it,
 *  and every block id. */
export function outline(text: string) {
  const anchors = extractAnchors(text);
  return {
    headings: anchors.headings.map((h) => {
      const path = headingPath(anchors.headings, h).join("#");
      return { level: h.level, text: h.text, path, line: h.line, link: `#${path}` };
    }),
    blocks: anchors.blocks.map((b) => ({ id: b.id, line: b.line, preview: b.preview, link: `#^${b.id}` })),
  };
}

/** The text of one section (heading line through its end) or block. */
export function readSection(text: string, ref: SectionRef): string {
  const anchors = extractAnchors(text);
  if (ref.kind === "block") {
    const b = findBlockRef(anchors, ref.id);
    return text.slice(b.from, b.to);
  }
  const h = findHeadingRef(anchors, ref.path);
  return text.slice(h.from, h.sectionEnd);
}

function cleanHeading(raw: string): string {
  const t = raw.replace(/^\s*#+\s*/, "").replace(/\s+/g, " ").trim();
  if (!t) throw new SectionError("heading must be non-empty text", "bad_section");
  if (/[\r\n]/.test(raw.trim())) throw new SectionError("heading must be a single line", "bad_section");
  return t;
}

function checkLevel(level: number | undefined): number | undefined {
  if (level === undefined) return undefined;
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new SectionError("level must be an integer from 1 to 6", "bad_section");
  }
  return level;
}

function bodyBlock(content: string | undefined): string {
  const c = (content ?? "").replace(/\s+$/, "");
  return c ? `\n${c.replace(/^\n+/, "")}\n` : "";
}

/** Join `insert` into `text` at `at` with a blank line on each side; returns
 *  the new text and where `insert` starts in it. */
function spliceBlock(text: string, at: number, insert: string): { text: string; start: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after === "" ? "" : after.startsWith("\n") ? "" : "\n";
  return { text: before + lead + insert + trail + after, start: before.length + lead.length };
}

export interface CreateSectionInput {
  heading: string;
  content?: string;
  level?: number;
  /** Put it at the end of this section, one level deeper. */
  parent?: string;
  /** Put it right after this section, at the same level. */
  after?: string;
}

export function planCreateSection(text: string, input: CreateSectionInput) {
  const heading = cleanHeading(input.heading);
  let level = checkLevel(input.level);
  if (input.parent && input.after) throw new SectionError("Pass parent or after, not both", "bad_section");
  const anchors = extractAnchors(text);
  let at = text.length;
  if (input.after) {
    const ref = parseSectionRef(input.after);
    if (ref.kind !== "heading") throw new SectionError("after must name a heading", "bad_section");
    const h = findHeadingRef(anchors, ref.path);
    at = h.sectionEnd;
    level ??= h.level;
  } else if (input.parent) {
    const ref = parseSectionRef(input.parent);
    if (ref.kind !== "heading") throw new SectionError("parent must name a heading", "bad_section");
    const p = findHeadingRef(anchors, ref.path);
    at = p.sectionEnd;
    level ??= Math.min(p.level + 1, 6);
  } else {
    // A note with an H1 title gets H2 sections; otherwise match its top level.
    const levels = anchors.headings.map((h) => h.level);
    level ??= levels.length === 0 ? 2 : levels.includes(1) ? 2 : Math.min(...levels);
  }
  const block = `${"#".repeat(level)} ${heading}\n${bodyBlock(input.content)}`;
  const spliced = spliceBlock(text, at, block);
  const after = extractAnchors(spliced.text);
  const created = after.headings.find((h) => h.from === spliced.start)!;
  // A twin under the same enclosing headings would make links to it ambiguous.
  const key = normalizeHeading(heading);
  const parentKey = created.parents.map(normalizeHeading).join("#");
  const clash = after.headings.find(
    (h) =>
      h !== created && normalizeHeading(h.text) === key && h.parents.map(normalizeHeading).join("#") === parentKey,
  );
  if (clash) {
    const line = clash.line < created.line ? clash.line : clash.line - (spliced.text.split("\n").length - text.split("\n").length);
    throw new SectionError(
      `A section "${clash.text}" already exists at line ${line} — use update_section to change it`,
      "section_exists",
    );
  }
  return { text: spliced.text, heading, level, path: headingPath(after.headings, created).join("#") };
}

export interface UpdateSectionInput {
  /** New body (everything under the heading). Omit to keep it. */
  content?: string;
  /** Rename the heading. */
  heading?: string;
  /** Change the heading level. */
  level?: number;
  /** With `content`: replace the subsections too (default: only the text
   *  before the first subsection). */
  includeSubsections?: boolean;
}

export function planUpdateSection(text: string, rawRef: string, input: UpdateSectionInput) {
  const ref = parseSectionRef(rawRef);
  const anchors = extractAnchors(text);
  if (ref.kind === "block") {
    if (input.heading !== undefined || input.level !== undefined) {
      throw new SectionError("A block has no heading or level; pass content only", "bad_section");
    }
    if (input.content === undefined) throw new SectionError("Pass content for a block", "bad_section");
    const b = findBlockRef(anchors, ref.id);
    let body = input.content.replace(/\s+$/, "");
    if (!body) throw new SectionError("A block's content must not be empty (use delete_section)", "bad_section");
    if (!new RegExp(`\\^${b.id}\\s*$`).test(body)) body += ` ^${b.id}`;
    return { text: text.slice(0, b.from) + body + text.slice(b.to), renamed: null };
  }
  if (input.content === undefined && input.heading === undefined && input.level === undefined) {
    throw new SectionError("Nothing to change: pass content, heading or level", "bad_section");
  }
  const h = findHeadingRef(anchors, ref.path);
  const newHeading = input.heading !== undefined ? cleanHeading(input.heading) : h.text;
  const level = checkLevel(input.level) ?? h.level;
  const headingLine = `${"#".repeat(level)} ${newHeading}`;
  let next: string;
  if (input.content === undefined) {
    next = text.slice(0, h.from) + headingLine + text.slice(h.to);
  } else {
    const firstChild = anchors.headings.find((o) => o.from > h.from && o.from < h.sectionEnd);
    const bodyEnd = !input.includeSubsections && firstChild ? firstChild.from : h.sectionEnd;
    const body = bodyBlock(input.content) + (bodyEnd < text.length ? "\n" : "");
    next = text.slice(0, h.from) + headingLine + "\n" + body + text.slice(bodyEnd);
  }
  const renamed = normalizeHeading(newHeading) !== normalizeHeading(h.text) ? { from: h.text, to: newHeading } : null;
  return { text: next, renamed };
}

export function planDeleteSection(text: string, rawRef: string) {
  const ref = parseSectionRef(rawRef);
  const anchors = extractAnchors(text);
  let from: number;
  let to: number;
  if (ref.kind === "block") {
    const b = findBlockRef(anchors, ref.id);
    from = b.from;
    to = b.to;
  } else {
    const h = findHeadingRef(anchors, ref.path);
    from = h.from;
    to = h.sectionEnd;
  }
  // Take the line break and one following blank line with it.
  if (text[to] === "\n") to++;
  if (text[to] === "\n" && (from === 0 || text[from - 1] === "\n") && (from < 2 || text[from - 2] === "\n")) to++;
  return { text: text.slice(0, from) + text.slice(to) };
}

/**
 * Give the block containing `snippet` (exact text, found once) a ` ^id` and
 * return it. A block that already carries one keeps it: the call is then a
 * read, so retrying is safe.
 */
export function planAddBlockId(text: string, snippet: string, wantId?: string) {
  if (!snippet.trim()) throw new SectionError("text must name part of the block", "bad_section");
  if (wantId !== undefined && !/^[A-Za-z0-9-]+$/.test(wantId)) {
    throw new SectionError("id may contain only letters, digits and '-'", "bad_section");
  }
  const anchors = extractAnchors(text);
  const holds = (from: number, to: number) => text.slice(from, to).includes(snippet);
  const ided = anchors.blocks.filter((b) => holds(b.from, b.to));
  const bare = anchors.candidates.filter((c) => holds(c.from, c.to));
  const total = ided.length + bare.length;
  if (total === 0) {
    throw new SectionError("No block contains that text (headings and code are not blocks)", "section_not_found");
  }
  if (total > 1) throw new SectionError(`That text appears in ${total} blocks — quote more of it`, "section_ambiguous");
  if (ided.length === 1) return { text, id: ided[0]!.id, created: false };
  const taken = anchors.blocks.map((b) => b.id);
  if (wantId && taken.some((t) => t.toLowerCase() === wantId.toLowerCase())) {
    throw new SectionError(`The id ^${wantId} is already used in this note`, "section_exists");
  }
  const id = wantId ?? newBlockId(taken);
  const c = bare[0]!;
  return { text: text.slice(0, c.insertAt) + ` ^${id}` + text.slice(c.insertAt), id, created: true };
}

/** Rewrite `[[target#Old]]` links for a renamed heading (see sections.ts). */
export { renameHeadingLinks, headingLinkText };
