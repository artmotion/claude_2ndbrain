// Jump to a heading or `^block` inside the open note — what a click on
// `[[Note#Heading]]` / `[[Note#^id]]` ends with once the note is open.
//
// The target is found with the same rules as everything else
// (`lib/links/anchors.ts`), any fold hiding it is opened, the caret moves to
// its start, the view scrolls it to the top, and the lines briefly flash so the
// eye lands on them. Purely a view operation: nothing here edits the doc.

import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { type Subpath, extractAnchors, findAnchor } from "../links/anchors";

const FLASH_MS = 1600;

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const flashLine = Decoration.line({ class: "cm-anchor-flash" });

/** The flashed lines, mapped through edits until the timer clears them. */
export const anchorFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFlash)) continue;
      if (!e.value) {
        next = Decoration.none;
        continue;
      }
      const decos: Range<Decoration>[] = [];
      const doc = tr.state.doc;
      const first = doc.lineAt(Math.min(e.value.from, doc.length)).number;
      const last = doc.lineAt(Math.min(e.value.to, doc.length)).number;
      for (let n = first; n <= last; n++) decos.push(flashLine.range(doc.line(n).from));
      next = Decoration.set(decos);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Reveal `subpath` in `view`. Returns false (and changes nothing) when the note
 * has no such heading or block — the caller says so.
 */
export function revealAnchor(view: EditorView, subpath: Subpath): boolean {
  const state = view.state;
  const target = findAnchor(extractAnchors(state.doc.toString()), subpath);
  if (!target) return false;
  const from = target.from;
  // A heading flashes its own line; a block all of its lines.
  const to = target.to;

  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(0, state.doc.length, (fFrom, fTo) => {
    // A fold that swallows the target (a collapsed parent section).
    if (fFrom <= from && fTo >= from) effects.push(unfoldEffect.of({ from: fFrom, to: fTo }));
  });
  effects.push(EditorView.scrollIntoView(from, { y: "start", yMargin: 48 }));
  if (state.field(anchorFlash, false) !== undefined) effects.push(setFlash.of({ from, to }));

  view.dispatch({ selection: { anchor: from }, effects, userEvent: "select" });
  if (state.field(anchorFlash, false) !== undefined) {
    window.setTimeout(() => {
      // The view may be gone (note switched) — dispatching into it would throw.
      if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS);
  }
  return true;
}
