// CodeMirror 6 wiki-link support:
//  1. `[[` autocomplete in two stages (see ../links/linkCompletion.ts):
//       [[abc        notes, by file name, folder and title
//       [[Note#abc   Note's headings and blocks; `#^` = blocks only
//       [[#abc       the headings and blocks of THIS note
//     Picking a note leaves the caret before `]]`, so a `#` typed next opens
//     the second list at once; `]` or Tab steps out of the link. Picking a
//     block that has no id yet appends ` ^id` to it — in this note as part of
//     the same transaction, in another note through the host (a CRDT-safe
//     edit, see ../links/noteEdit.ts).
//  2. Decoration that styles `[[target]]` occurrences as clickable links, and
//     — off the selection — shows what you MEAN rather than what you typed:
//       [[Note]]           → Note
//       [[Note|label]]     → label
//       [[Note#Heading]]   → Note › Heading
//       [[Note#^a1b2c3]]   → Note › first words of that block
//       [[Note#H|label]]   → label
//     Put the caret on one and the raw brackets come back for editing, on the
//     same TOKEN rule as the rest of live preview (see ./reveal.ts).
//  3. Click / cmd-click on a link navigates to the target note — and to the
//     heading or block it names. A link whose target resolves to no note is
//     greyed out (`cm-wikilink-unresolved`, same rule as Rust
//     `resolve_wikilink`, see ./wikilinkResolve.ts) and a click on it does
//     nothing. A link whose NOTE exists but whose heading/block does not gets
//     `cm-wikilink-anchor-missing` (still clickable: it opens the note).

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, type Range, StateEffect, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { IndexedAnchor, NoteTitle } from "../ipc";
import {
  type BlockCandidate,
  type NoteAnchors,
  blockIdSuffix,
  extractAnchors,
  newBlockId,
  normalizeHeading,
  parseWikilinkInner,
} from "../links/anchors";
import { type AnchorOption, anchorOptions, noteOptions, parseLinkQuery } from "../links/linkCompletion";
import { focusMoved, selectionTouches } from "./reveal";
import { isWikilinkResolved, resolveTitle } from "./wikilinkResolve";

/**
 * `[[target]]`, `[[target|alias]]`, `[[target#heading]]` — a FRESH regex per
 * call. A module-level `/g` regex carries `lastIndex` between calls, so two
 * consumers (this module and livePreview.ts's "don't touch wiki-link marks"
 * scan) sharing one instance silently skip every other match. Exported so
 * livePreview.ts can ask the same question without duplicating the literal.
 */
export const wikilinkRe = (): RegExp => /\[\[([^\]\n]+)\]\]/g;

/** Another note, as the `[[Note#` list needs it. */
export interface LinkedNote {
  path: string;
  text: string;
  /** Can it take a new ` ^id`? False for a read-only or locked note. */
  editable: boolean;
}

/**
 * What the editor asks of its host about OTHER notes. Omitted (the version
 * preview, most tests) → `[[Note#` offers nothing, links never show a missing
 * anchor, and only `[[#…]]` (this note) completes.
 */
export interface LinkHost {
  /** The note being edited (so `[[ThisNote#` is answered from the live doc). */
  selfPath?: string;
  /** Read a note for the anchor list. Null when no note answers `target`. */
  loadNote(target: string): Promise<LinkedNote | null>;
  /** Append ` ^id` to a block of another note. Resolves false when refused. */
  addBlockId(path: string, candidate: BlockCandidate, id: string): Promise<boolean>;
  /** The index's anchors of a note, or undefined while not loaded yet (the host
   *  then fetches and dispatches `wikilinkTitlesChanged` when they arrive). */
  indexedAnchors(path: string): IndexedAnchor[] | undefined;
  /** A block id could not be added (read-only, the block moved, a write
   *  failed): tell the person, since the link they just wrote points nowhere. */
  onBlockIdFailed?(path: string): void;
}

export interface WikilinkOptions {
  /** Current note titles for autocomplete (read fresh on each request). */
  getTitles: () => NoteTitle[];
  /** Navigate to a link: its inner text without the alias, e.g. `Note#Heading`
   *  or `#^abc123` (resolve + open + reveal; a dangling link does nothing). */
  onNavigate: (target: string) => void;
  links?: LinkHost;
}

// ---- Anchors of the doc being edited ----------------------------------------

const docAnchors = new WeakMap<Text, NoteAnchors>();

/** `extractAnchors` of a doc, memoised per immutable `Text`. */
export function anchorsOfDoc(doc: Text): NoteAnchors {
  let a = docAnchors.get(doc);
  if (!a) {
    a = extractAnchors(doc.toString());
    docAnchors.set(doc, a);
  }
  return a;
}

// ---- Autocomplete ---------------------------------------------------------

/** How long a loaded note answers repeat keystrokes before it is read again. */
const LOAD_TTL_MS = 3000;

function finishLink(view: EditorView, from: number, to: number, insert: string, extra?: { at: number; text: string }) {
  const closed = view.state.sliceDoc(to, to + 2) === "]]";
  const changes = [{ from, to, insert: closed ? insert : `${insert}]]` }];
  let caret = from + insert.length + 2;
  if (extra) {
    changes.push({ from: extra.at, to: extra.at, insert: extra.text });
    if (extra.at <= from) caret += extra.text.length;
    changes.sort((a, b) => a.from - b.from);
  }
  view.dispatch({ changes, selection: { anchor: caret }, userEvent: "input.complete", scrollIntoView: true });
}

const SECTIONS = {
  heading: { name: "Headings", rank: 0 },
  block: { name: "Blocks", rank: 1 },
} as const;

function toCompletion(
  opt: AnchorOption,
  apply: (view: EditorView, from: number, to: number) => void,
  index: number,
): Completion {
  const boost = Math.max(-99, 99 - index);
  switch (opt.kind) {
    case "heading":
      return {
        label: opt.label,
        displayLabel: `${" ".repeat(opt.level - 1)}${opt.label}`,
        detail: `H${opt.level}`,
        type: "heading",
        section: SECTIONS.heading,
        boost,
        apply: (view, _c, from, to) => apply(view, from, to),
      };
    case "block":
      return {
        label: opt.label,
        detail: `^${opt.id}`,
        type: "block",
        section: SECTIONS.block,
        boost,
        apply: (view, _c, from, to) => apply(view, from, to),
      };
    case "candidate":
      return {
        label: opt.label,
        detail: "link this block",
        type: "block",
        section: SECTIONS.block,
        boost,
        apply: (view, _c, from, to) => apply(view, from, to),
      };
    case "info":
      return { label: opt.label, type: "info", boost: -99, apply: () => {} };
  }
}

export function wikilinkCompletions(opts: WikilinkOptions) {
  const loaded = new Map<string, { at: number; value: Promise<LinkedNote | null> }>();
  const load = (target: string): Promise<LinkedNote | null> => {
    const key = target.toLowerCase();
    const hit = loaded.get(key);
    if (hit && Date.now() - hit.at < LOAD_TTL_MS) return hit.value;
    const value = opts.links ? opts.links.loadNote(target).catch(() => null) : Promise.resolve(null);
    loaded.set(key, { at: Date.now(), value });
    return value;
  };

  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // Match an open `[[` up to the cursor, without a closing `]]` yet.
    const before = context.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    if (before.from === before.to && !context.explicit) return null;
    const typed = before.text.slice(2);
    const q = parseLinkQuery(typed);
    if (!q) return null;

    if (q.stage === "note") {
      const options: Completion[] = noteOptions(opts.getTitles(), q.query).map((o, i) => ({
        label: o.label,
        ...(o.detail ? { detail: o.detail } : {}),
        type: "note",
        boost: Math.max(-99, 99 - i),
        // The name only, caret before `]]`: a `#` typed next lists the note's
        // headings and blocks; `]` or Tab steps out of the link.
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({
            changes: { from, to, insert: closed ? o.insert : `${o.insert}]]` },
            selection: { anchor: from + o.insert.length },
            userEvent: "input.complete",
          });
        },
      }));
      return { from: before.from + 2, options, filter: false };
    }

    const from = before.from + 2 + q.restOffset;
    const titles = opts.getTitles();
    const selfPath = opts.links?.selfPath?.toLowerCase();
    const local =
      q.target === "" ||
      (selfPath !== undefined && resolveTitle(q.target, titles)?.path.toLowerCase() === selfPath);

    if (local) {
      const anchors = anchorsOfDoc(context.state.doc);
      const editable = !context.state.readOnly;
      const list = anchorOptions({ anchors, query: q, editable, caret: context.pos });
      const options = list.map((opt, i) =>
        toCompletion(
          opt,
          (view, f, t) => {
            if (opt.kind === "heading" || opt.kind === "block") return finishLink(view, f, t, opt.insert);
            if (opt.kind !== "candidate") return;
            const fresh = anchorsOfDoc(view.state.doc);
            const id = newBlockId(fresh.blocks.map((b) => b.id));
            finishLink(view, f, t, `^${id}`, { at: opt.candidate.insertAt, text: blockIdSuffix(id) });
          },
          i,
        ),
      );
      return { from, options, filter: false };
    }

    const note = await load(q.target);
    if (!note) {
      return {
        from,
        options: [{ label: `No note named “${q.target}”`, type: "info", apply: () => {} }],
        filter: false,
      };
    }
    const anchors = extractAnchors(note.text);
    const list = anchorOptions({ anchors, query: q, editable: note.editable });
    if (note.text.trim() === "") {
      list.splice(0, list.length, { kind: "info", label: "This note is empty (or still syncing)" });
    }
    const options = list.map((opt, i) =>
      toCompletion(
        opt,
        (view, f, t) => {
          if (opt.kind === "heading" || opt.kind === "block") return finishLink(view, f, t, opt.insert);
          if (opt.kind !== "candidate" || !opts.links) return;
          const id = newBlockId(anchors.blocks.map((b) => b.id));
          finishLink(view, f, t, `^${id}`);
          // The note is re-read under the write; a block that moved since the
          // list was built is found again by its line and text, or refused.
          const host = opts.links;
          void host
            .addBlockId(note.path, opt.candidate, id)
            .catch(() => false)
            .then((ok) => {
              if (!ok) host.onBlockIdFailed?.(note.path);
            });
          loaded.delete(q.target.toLowerCase());
        },
        i,
      ),
    );
    return { from, options, filter: false };
  };
}

/** Is `pos` inside an open `[[…` on its line, right before its `]]`? */
function beforeClosingBrackets(view: EditorView, pos: number): boolean {
  if (view.state.sliceDoc(pos, pos + 2) !== "]]") return false;
  const line = view.state.doc.lineAt(pos);
  return /\[\[[^\]\n]*$/.test(line.text.slice(0, pos - line.from));
}

/**
 * Step out of a link: `]` or Tab with the caret right before a wiki-link's `]]`
 * jumps past both brackets, instead of typing a third `]` (closeBrackets only
 * skips a bracket it inserted itself, and the completion inserts its own).
 */
export const wikilinkStepOut = [
  Prec.high(
    EditorView.inputHandler.of((view, from, to, text) => {
      if (text !== "]" || from !== to || !beforeClosingBrackets(view, from)) return false;
      view.dispatch({ selection: { anchor: from + 2 }, userEvent: "select" });
      return true;
    }),
  ),
  Prec.high(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty || !beforeClosingBrackets(view, sel.head)) return false;
          view.dispatch({ selection: { anchor: sel.head + 2 }, userEvent: "select" });
          return true;
        },
      },
    ]),
  ),
];

// ---- Decoration + click navigation ---------------------------------------

const wikilinkMark = Decoration.mark({ class: "cm-wikilink" });
const unresolvedMark = Decoration.mark({ class: "cm-wikilink cm-wikilink-unresolved" });
const anchorMissingMark = Decoration.mark({
  class: "cm-wikilink cm-wikilink-anchor-missing",
  attributes: { title: "This heading or block no longer exists — the link opens the note" },
});

/**
 * The link targets changed: the note-title list (a note was created, renamed or
 * removed) or a target's indexed headings/blocks arrived, so a link's resolved
 * / missing styling may have too. Dispatched by the host (`Editor.tsx`).
 */
export const wikilinkTitlesChanged = StateEffect.define<null>();
const hidden = Decoration.replace({});

/** The `›` between a note and the heading inside it. Not document text — the
 *  file still says `#`, so nothing round-trips differently. */
class HeadingSepWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-wikilink-sep";
    s.textContent = "›";
    return s;
  }
}

/** A block link's `^id`, shown as the block's first words. */
class BlockPreviewWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: BlockPreviewWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-wikilink-block";
    s.textContent = this.text.length > 48 ? `${this.text.slice(0, 47).trimEnd()}…` : this.text;
    return s;
  }
}

const headingSep = Decoration.replace({ widget: new HeadingSepWidget() });

/** What a link's subpath finds: "ok" (+ a block preview), "missing", or
 *  "unknown" while the target's anchors are not loaded. */
type AnchorState = { state: "ok"; preview?: string } | { state: "missing" } | { state: "unknown" };

function anchorState(
  inner: string,
  view: EditorView,
  titles: readonly NoteTitle[],
  links: LinkHost | undefined,
): AnchorState {
  const { target, subpath } = parseWikilinkInner(inner);
  if (!subpath) return { state: "ok" };
  const self = links?.selfPath?.toLowerCase();
  const path = target === "" ? self : resolveTitle(target, titles)?.path;
  if (target === "" || (path && self && path.toLowerCase() === self)) {
    const a = anchorsOfDoc(view.state.doc);
    if (subpath.kind === "block") {
      const b = a.blocks.find((x) => x.id.toLowerCase() === subpath.id.toLowerCase());
      return b ? { state: "ok", preview: b.preview } : { state: "missing" };
    }
    const key = normalizeHeading(subpath.path[subpath.path.length - 1]!);
    return a.headings.some((h) => normalizeHeading(h.text) === key) ? { state: "ok" } : { state: "missing" };
  }
  if (!path || !links) return { state: "unknown" };
  const indexed = links.indexedAnchors(path);
  if (!indexed) return { state: "unknown" };
  if (subpath.kind === "block") {
    const b = indexed.find((x) => x.kind === "block" && x.key === subpath.id.toLowerCase());
    return b ? { state: "ok", preview: b.text } : { state: "missing" };
  }
  const key = normalizeHeading(subpath.path[subpath.path.length - 1]!);
  return indexed.some((x) => x.kind === "heading" && x.key === key) ? { state: "ok" } : { state: "missing" };
}

function buildDecorations(view: EditorView, opts: WikilinkOptions): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const touches = selectionTouches(view.state);
  const titles = opts.getTitles();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = wikilinkRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      const inner = m[1]!;
      const local = inner.trimStart().startsWith("#");
      const resolved = local || isWikilinkResolved(inner, titles);
      const anchor = resolved ? anchorState(inner, view, titles, opts.links) : ({ state: "unknown" } as const);
      decos.push(
        (!resolved ? unresolvedMark : anchor.state === "missing" ? anchorMissingMark : wikilinkMark).range(
          start,
          end,
        ),
      );
      if (touches(start, end)) continue;

      // Inner span, i.e. everything between the brackets.
      const innerFrom = start + 2;
      const pipe = inner.indexOf("|");
      const hash = inner.indexOf("#");
      if (pipe >= 0) {
        // An alias speaks for the whole link: show only what follows the `|`.
        decos.push(hidden.range(start, innerFrom + pipe + 1));
        decos.push(hidden.range(end - 2, end));
      } else if (hash >= 0) {
        // `Note#Heading` → `Note › Heading`; `#Heading` → `› Heading`.
        decos.push(hidden.range(start, innerFrom));
        decos.push(headingSep.range(innerFrom + hash, innerFrom + hash + 1));
        const preview = anchor.state === "ok" ? anchor.preview : undefined;
        if (preview && inner.slice(hash + 1).trimStart().startsWith("^")) {
          // `Note#^id` → `Note › first words of the block`.
          decos.push(
            Decoration.replace({ widget: new BlockPreviewWidget(preview) }).range(innerFrom + hash + 1, end - 2),
          );
        }
        decos.push(hidden.range(end - 2, end));
      } else {
        decos.push(hidden.range(start, innerFrom));
        decos.push(hidden.range(end - 2, end));
      }
    }
  }
  // `true` = sort: marks and replaces are interleaved here, and a RangeSetBuilder
  // would throw on the out-of-order pairs this emits.
  return Decoration.set(decos, true);
}

/** Extract the wiki-link at a document position, alias stripped (`Note#H`). */
function targetAtPos(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const re = wikilinkRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      const t = m[1]!.split("|")[0]!.trim();
      return t === "" || t === "#" ? null : t;
    }
  }
  return null;
}

export function wikilinks(opts: WikilinkOptions) {
  const decorationPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts);
      }
      update(u: ViewUpdate) {
        // Selection and focus matter now that the brackets fold away off the
        // caret (they did not when this only painted a colour).
        const titlesChanged = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(wikilinkTitlesChanged)),
        );
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          focusMoved(u) ||
          titlesChanged
        ) {
          this.decorations = buildDecorations(u.view, opts);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          // The syntax highlighter nests its own spans *inside* the
          // `cm-wikilink` mark, so a click usually lands on a child span that
          // doesn't carry the class — walk up to the link element (same
          // pattern as the cm-md-link handler in livePreview).
          const target = (event.target as HTMLElement).closest(
            ".cm-wikilink"
          ) as HTMLElement | null;
          if (!target) return false;
          // A link to nothing is plain text to the mouse: the click places the
          // caret like anywhere else and never creates a note.
          if (target.classList.contains("cm-wikilink-unresolved")) return false;
          const pos = view.posAtDOM(target);
          const name = targetAtPos(view, pos);
          if (name) {
            event.preventDefault();
            opts.onNavigate(name);
            return true;
          }
          return false;
        },
      },
    }
  );

  // Autocomplete is registered centrally (see editor/index.ts) so the wiki-link
  // and slash-command sources share one autocompletion config.
  return [decorationPlugin, ...wikilinkStepOut];
}
