// Headings that other notes link to (`[[Note#Heading]]`), seen from the note
// they live in:
//
//  1. A quiet count at the end of a heading (or an id'd block) that is linked
//     from elsewhere — "2 links" — so you know before you change it.
//  2. Renaming such a heading asks, once the caret leaves the line, whether to
//     carry the new name into those links: "3 links point to “Risks”. Update
//     them to “Open risks”?" [Update links] [Keep]. Links inside this note are
//     rewritten in one editor transaction; other notes through the host (a
//     CRDT-safe edit per note, read-only notes skipped and reported).
//
// Only the person's own edits start a prompt (a teammate's rename arrives as a
// remote change and is theirs to answer), and a prompt disappears the moment
// the heading is edited again or the answer is given.

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Backlink } from "../ipc";
import { extractAnchors, normalizeHeading, renameHeadingLinks } from "../links/anchors";
import { backlinksToHeading, referenceCounts } from "../links/backlinkAnchors";
import { minimalReplacement } from "../links/noteEdit";
import { noteLabel } from "../notePath";
import { anchorsOfDoc } from "./wikilinks";

export interface HeadingLinkHost {
  /** The open note's path. */
  selfPath: string;
  /** Every `[[…]]` pointing at this note (the store's backlinks). */
  getBacklinks(): Backlink[];
  /** Names a link may use for this note besides its stem (path, title). */
  selfNames(): string[];
  /** Rewrite `[[ThisNote#from]]` → `#to` in the OTHER notes linking here. */
  renameLinks(from: string, to: string): Promise<void>;
}

/** The store's backlinks changed: repaint counts. Dispatched by the host. */
export const backlinksChanged = StateEffect.define<null>();

// ---- 1. Reference counts -------------------------------------------------------

class RefCountWidget extends WidgetType {
  constructor(
    readonly count: number,
    readonly from: string,
  ) {
    super();
  }
  eq(o: RefCountWidget) {
    return o.count === this.count && o.from === this.from;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-heading-refs";
    s.textContent = this.count === 1 ? "1 link" : `${this.count} links`;
    s.title = `Linked from ${this.from}`;
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

function linkedFrom(rows: Backlink[]): string {
  const names = [...new Set(rows.map((r) => noteLabel(r.path)))];
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}

function buildCounts(view: EditorView, host: HeadingLinkHost): DecorationSet {
  const backlinks = host.getBacklinks();
  if (backlinks.length === 0) return Decoration.none;
  const { headings, blocks } = referenceCounts(backlinks);
  if (headings.size === 0 && blocks.size === 0) return Decoration.none;
  const anchors = anchorsOfDoc(view.state.doc);
  const decos = [];
  for (const h of anchors.headings) {
    const rows = headings.get(normalizeHeading(h.text));
    if (rows) decos.push(Decoration.widget({ widget: new RefCountWidget(rows.length, linkedFrom(rows)), side: 1 }).range(h.to));
  }
  for (const b of anchors.blocks) {
    const rows = blocks.get(b.id.toLowerCase());
    if (rows) decos.push(Decoration.widget({ widget: new RefCountWidget(rows.length, linkedFrom(rows)), side: 1 }).range(b.to));
  }
  return Decoration.set(decos, true);
}

// ---- 2. The rename prompt --------------------------------------------------------

interface Prompt {
  /** Start of the heading line. */
  pos: number;
  from: string;
  to: string;
  /** Links inside this note / in other notes. */
  local: number;
  remote: number;
}

const setPrompt = StateEffect.define<Prompt | null>();

function headingTextOf(line: string): string | null {
  return extractAnchors(line).headings[0]?.text ?? null;
}

const promptField = StateField.define<Prompt | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPrompt)) return e.value;
    if (!value || !tr.docChanged) return value;
    const pos = tr.changes.mapPos(value.pos, -1);
    if (pos > tr.state.doc.length) return null;
    const line = tr.state.doc.lineAt(pos);
    // Edited again (or gone): the question no longer matches what is there.
    return line.from === pos && headingTextOf(line.text) === value.to ? { ...value, pos } : null;
  },
});

function isSelfTarget(target: string, host: HeadingLinkHost): boolean {
  if (target === "") return true;
  const lower = target.toLowerCase().replace(/\.md$/, "");
  const stem = noteLabel(host.selfPath).toLowerCase();
  if (lower === stem || lower.slice(lower.lastIndexOf("/") + 1) === stem) return true;
  return host.selfNames().some((n) => n.toLowerCase() === lower);
}

class PromptWidget extends WidgetType {
  constructor(
    readonly prompt: Prompt,
    readonly host: HeadingLinkHost,
  ) {
    super();
  }
  eq(o: PromptWidget) {
    const a = o.prompt;
    const b = this.prompt;
    return a.from === b.from && a.to === b.to && a.local === b.local && a.remote === b.remote;
  }
  toDOM(view: EditorView) {
    const p = this.prompt;
    const total = p.local + p.remote;
    const box = document.createElement("div");
    box.className = "cm-heading-rename cm-block-inset";
    box.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "cm-heading-rename-text";
    text.textContent = `${total === 1 ? "1 link points" : `${total} links point`} to “${p.from}”. Update ${total === 1 ? "it" : "them"} to “${p.to}”?`;
    const update = document.createElement("button");
    update.type = "button";
    update.className = "cm-heading-rename-btn primary";
    update.textContent = total === 1 ? "Update link" : "Update links";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "cm-heading-rename-btn";
    keep.textContent = "Keep";
    update.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applyRename(view, this.host, p);
    });
    keep.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ effects: setPrompt.of(null) });
    });
    box.append(text, update, keep);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Carry the rename into this note's own links (one transaction) and hand the
 *  other notes to the host. */
export function applyRename(view: EditorView, host: HeadingLinkHost, p: Pick<Prompt, "from" | "to" | "remote">): void {
  const current = view.state.doc.toString();
  const local = renameHeadingLinks(current, (t) => isSelfTarget(t, host), p.from, p.to);
  const change = local.count ? minimalReplacement(current, local.text) : null;
  view.dispatch({
    ...(change && !view.state.readOnly ? { changes: change, userEvent: "input.links" } : {}),
    effects: setPrompt.of(null),
  });
  if (p.remote > 0) void host.renameLinks(p.from, p.to);
}

function promptDecorations(host: HeadingLinkHost) {
  return EditorView.decorations.compute([promptField], (state) => {
    const p = state.field(promptField);
    if (!p || p.pos > state.doc.length) return Decoration.none;
    const line = state.doc.lineAt(p.pos);
    return Decoration.set([
      Decoration.widget({ widget: new PromptWidget(p, host), block: true, side: 1 }).range(line.to),
    ]);
  });
}

interface Tracked {
  /** Start of the heading line, mapped through edits. */
  pos: number;
  /** The heading text before this round of editing. */
  original: string;
}

const USER_EDIT = ["input", "delete", "move"];

export function headingLinks(host: HeadingLinkHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      counts: DecorationSet;
      tracked: Tracked[] = [];
      settleQueued = false;
      constructor(readonly view: EditorView) {
        this.counts = buildCounts(view, host);
      }
      update(u: ViewUpdate) {
        const repaint = u.transactions.some((tr) => tr.effects.some((e) => e.is(backlinksChanged)));
        if (u.docChanged || u.viewportChanged || repaint) this.counts = buildCounts(u.view, host);
        if (u.docChanged) {
          this.tracked = this.tracked.map((t) => ({ ...t, pos: u.changes.mapPos(t.pos, -1) }));
          const byUser = u.transactions.some((tr) => USER_EDIT.some((ev) => tr.isUserEvent(ev)));
          if (byUser) {
            const start = u.startState.doc;
            u.changes.iterChangedRanges((fromA, toA) => {
              const first = start.lineAt(fromA).number;
              const last = start.lineAt(Math.min(toA, start.length)).number;
              for (let n = first; n <= last; n++) {
                const line = start.line(n);
                const text = headingTextOf(line.text);
                if (!text) continue;
                const pos = u.changes.mapPos(line.from, -1);
                if (!this.tracked.some((t) => t.pos === pos)) this.tracked.push({ pos, original: text });
              }
            });
          }
        }
        if (this.tracked.length && (u.docChanged || u.selectionSet || u.focusChanged) && !this.settleQueued) {
          this.settleQueued = true;
          // A dispatch is not allowed inside an update: settle right after.
          queueMicrotask(() => {
            this.settleQueued = false;
            this.settle();
          });
        }
      }
      settle() {
        const view = this.view;
        if (!view.dom.isConnected) return;
        const doc = view.state.doc;
        const editingLine = view.hasFocus ? doc.lineAt(view.state.selection.main.head).from : -1;
        let prompt: Prompt | null = null;
        const keep: Tracked[] = [];
        for (const t of this.tracked) {
          if (t.pos > doc.length) continue;
          const line = doc.lineAt(t.pos);
          if (line.from === editingLine) {
            keep.push(t);
            continue;
          }
          const now = headingTextOf(line.text);
          if (!now || normalizeHeading(now) === normalizeHeading(t.original)) continue;
          const local = renameHeadingLinks(doc.toString(), (x) => isSelfTarget(x, host), t.original, now).count;
          const remote = backlinksToHeading(host.getBacklinks(), t.original).filter(
            (b) => b.path.toLowerCase() !== host.selfPath.toLowerCase(),
          ).length;
          if (local + remote > 0) prompt = { pos: line.from, from: t.original, to: now, local, remote };
        }
        this.tracked = keep;
        if (prompt) view.dispatch({ effects: setPrompt.of(prompt) });
      }
    },
    { decorations: (v) => v.counts },
  );
  return [promptField, promptDecorations(host), plugin];
}
