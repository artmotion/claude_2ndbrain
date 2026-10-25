---
type: spec
spec: 06-block-links
product: 2ndBrain
status: implemented
date: 2026-10-25
tags: [secondbrain, spec, links, wikilinks, headings, blocks, mcp, editor]
---

# 06 · Links to headings and blocks

A `[[wiki-link]]` can point at a **place inside a note**, not only at the note: a heading or a single
block (paragraph or list item). Syntax is Obsidian's, so a vault stays portable and the `.md` file
stays the source of truth. Builds on the editor in [[01-desktop-app]] and the index in
[[02-database-architecture]]. Index: [[2ndBrain]].

## 1. Syntax

| Written | Points at |
|---|---|
| `[[Note#Heading]]` | the heading "Heading" in Note |
| `[[Note#Chapter#Section]]` | "Section" nested under "Chapter" (only needed when two headings share a name) |
| `[[Note#^a1b2c3]]` | the block that ends with ` ^a1b2c3` |
| `[[#Heading]]`, `[[#^a1b2c3]]` | a place in the current note |
| `…|label` | any of the above with an alias |

A block id is a trailing ` ^id` on the block's **last line** (`[A-Za-z0-9-]+`), or a line holding only
`^id` directly after the block. Ids are minted as six random lowercase letters/digits.

Logseq's `((uuid))` + `id::` property was considered and rejected: it adds an invisible property line
per block and does not read as plain markdown in other tools.

## 2. One parser, three copies, one fixture

What counts as a heading, a block and a block id is defined once and pinned by the shared fixture
`app/apps/desktop/src/lib/links/__fixtures__/anchors.json`:

| Copy | Used for | Test |
|---|---|---|
| `app/apps/desktop/src/lib/links/anchors.ts` | autocomplete, jump, decorations, rename | `anchors.test.ts` |
| `app/apps/desktop/src-tauri/src/parse.rs parse_anchors` | the `note_anchors` index | `parse_anchors_matches_the_shared_fixture` |
| `app/apps/server/src/markdown/sections.ts` | MCP section tools | `tests/markdown-sections.test.ts` (also asserts the code below its header equals the desktop file) |

Rules (line-based on purpose, so all three can say the same thing): frontmatter and fenced code are
skipped; a heading is an ATX line with ≤3 leading spaces and non-empty text (closing `#`s dropped,
inner whitespace collapsed); setext headings are not link targets; a block is a paragraph or one list
item, ended by a blank line, a heading, a fence, a thematic break or the next list item. A section
runs from its heading to the next heading of the same or a higher level.

Headings compare through `normalizeHeading`: the characters a link cannot carry (`# | ^ : [ ] \ %%`)
become spaces, whitespace collapses, case folds. `headingLinkText` writes a heading into a link with
the same characters replaced. Duplicate headings resolve by path (`A#B`); a bare duplicate picks the
first (links) or is refused (MCP writes, `section_ambiguous`).

## 3. Writing a link: the context-aware dropdown

`lib/editor/wikilinks.ts wikilinkCompletions` + `lib/links/linkCompletion.ts` (pure):

1. **`[[abc`** lists notes, matching file name, folder path and title (every word must match;
   name-prefix first). A name another note shares is inserted as its full path (Rust resolves a full
   path, then a basename, so a partial path could open the twin). The caret stays **before `]]`**.
2. **`[[Note#abc`** lists Note's headings (indented by level, `H2` badge) then its blocks — id'd ones
   first, then id-less paragraphs and list items ("link this block"). `[[Note#^` lists blocks only.
   `[[#` (or `[[ThisNote#`) answers from the live doc, leaving out the block the caret is in.
3. Picking a heading or block finishes the link and steps past `]]`. Picking an **id-less block** mints
   an id and appends ` ^id` to that block: in the current note in the SAME transaction as the link;
   in another note through `lib/links/noteEdit.ts editNoteText` (below).
4. Inert info rows instead of an empty list: unknown note, empty note ("or still syncing"), nothing
   matches, and "Read-only note: only blocks that already have an id can be linked" (id-less blocks
   are not offered for a read-only or padlocked note).
5. `]` or Tab with the caret before a link's `]]` jumps past both brackets (`wikilinkStepOut`).
6. Inside an open `[[…` the `#` tag completion yields.

## 4. Editing another note safely

`editNoteText(path, plan, deps)` never overwrites a CRDT with a whole file:

- note open in an editor → one editor transaction (yCollab carries it to the `Y.Text`, undo works);
- otherwise → `write_note` with `expectedSha` (compare-and-swap) of the bytes the plan read. The watcher
  then takes the external-writer path every AI agent's write takes (`handleLocalFileChanged` →
  `ingestFromFile`), which diff-merges it as operations. `stale` re-plans, up to three attempts.
- read-only (`isReadOnlyDoc`) or padlocked (`effectiveLockForPath`) notes are refused up front.

## 5. Reading and following a link

- Off the caret `[[Note#Heading]]` shows `Note › Heading`; `[[Note#^id]]` shows `Note › <first words of
  the block>` (from the index). A link whose note exists but whose heading/block does not gets
  `cm-wikilink-anchor-missing` (dotted underline, still opens the note); a link to no note stays grey.
- ` ^id` markers fold away off the active line (`lib/editor/ofm/blockId.ts`, never in code or `.txt`).
- A click resolves the note through Rust, sets `store.pendingReveal`, opens it, and once its content
  is in (`Editor.tsx reveal`) `lib/editor/anchorReveal.ts revealAnchor` unfolds any fold hiding the
  target, moves the caret, scrolls it to the top and flashes the lines. A link into the open note just
  jumps. A missing target opens the note and says so in a toast.
- `#` inside a closed `[[…]]` is never a tag: Rust blanks wiki-links before `TAG_RE`, the editor's
  hashtag parser checks `insideWikilink`. (`[[#Heading]]` used to index `#Heading` as a tag.)

## 6. Index: `note_anchors` (desktop SQLite)

`note_anchors(note_id, kind 'heading'|'block', key, text, level, line)`, written beside `links` on every
index pass and dropped with the note. `key` is `normalizeHeading(text)` or the id lowercased; `text` is
the heading or the block preview. `list_note_anchors(path)` serves it (`ipc.listNoteAnchors`).
Migration: the first open that creates the table nulls `notes.sha256` and `mtime` once, so the next
pass re-parses every note (the hash gate would otherwise skip them forever).
`lib/links/anchorCache.ts` keeps answers in memory for the editor's decorations (10 s staleness,
refetched on `files-changed`, emptied on vault switch) and repaints on change.

## 7. Backlinks per section

`get_backlinks` already returns one row per `[[…]]` with its raw inner text; `lib/links/backlinkAnchors.ts`
reads the subpath out of it. The Backlinks card shows one row per linking note with
`→ Goals, ^ship1` and `×N`; headings and id'd blocks that other notes link to carry a quiet
"2 links" count at their end (`lib/editor/headingLinks.ts`, tooltip names the notes).

## 8. Renaming a linked heading

Typing a new name into a heading that has links (from other notes or `[[#Old]]` in the same note)
asks, once the caret leaves the line: "3 links point to “Risks”. Update them to “Open risks”?"
**Update links** rewrites this note's own links in one transaction and the other notes through
`editNoteText` (`renameHeadingInLinkingNotes`; read-only ones skipped and named in the toast);
**Keep** dismisses. Only the person's own edits ask (a teammate's rename arrives without a user event);
editing the heading again drops the question. Block ids never need this — that is why a block link is
the stable choice.

## 9. The AI: MCP section tools

`app/apps/server/src/markdown/section-ops.ts` (pure) + `mcp/service.ts` + `mcp/tools.ts`. Every write
plans inside the doc writer's per-doc lock and honours `expectedRevision`. A section is named by the
part after `#` in a link: `"Goals"`, `"Plan#Goals"`, `"^ship1"`.

| Tool | Does |
|---|---|
| `list_sections` | outline: headings (level, text, path, line, `[[Note#…]]` link) and id'd blocks |
| `read_note` `section` | one section (with subsections) or block; revision of the whole note |
| `create_section` | new heading section at the end (H2 under an H1 title), under `parent` (one level deeper) or `after` a sibling; `section_exists` on a twin at the same place |
| `update_section` | replace the body (up to the first subsection, or `includeSubsections`), rename, re-level; a block keeps its id. A rename rewrites `[[#Old]]` in the note and `[[Note#Old]]` in every note of the vault that links here (`note_links`) and the caller may edit, max 200; others are reported (`links.skipped`) |
| `delete_section` | remove a section with its subsections, or a block |
| `add_block_id` | give the block containing a quoted text a `^id` (idempotent) and return `[[Note#^id]]` |

Refusal codes: `section_not_found`, `section_ambiguous`, `section_exists`, `bad_section`, plus the
existing `stale_revision`. All section writes are refused for view-only or locked notes like every other
MCP write (`readonly-enforcement.test.ts`).
