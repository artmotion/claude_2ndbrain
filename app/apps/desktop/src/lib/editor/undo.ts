// Undo / redo for the note editor: ONE entry point for the keys, the
// right-click menus (editor and table cell) and the fallbacks below.
//
// A CRDT note's history is the bridge's `Y.UndoManager` (yCollab registers its
// sync origin on it, so only this device's own edits are undoable — never a
// teammate's, never a disk ingest). Editors without a CRDT behind them (the
// version preview, tests) keep CodeMirror's `history()`; `editorUndo` falls
// back to it when no Yjs manager is configured.
//
// Three things used to make undo feel missing (reported 2026-11-17):
//
//  1. Granularity. `Y.UndoManager` merges every tracked change that arrives
//     within `captureTimeout` (500 ms) into ONE step, so a line typed without a
//     pause vanished whole on Ctrl+Z. `undoWordSteps` closes the current step
//     at word boundaries, at a switch between typing and deleting, when the
//     caret jumps, and around pastes/structural edits — so Ctrl+Z takes back
//     the last word, like every word processor.
//  2. Focus. A table cell or the area around a rendered table is not
//     CodeMirror's content DOM, so the editor keymap never saw Ctrl+Z / Ctrl+Y
//     there. `undoKeyFallback` (installed by `Editor.tsx`) catches them.
//  3. macOS's native Edit menu turns ⌘Z into a `historyUndo` input event the
//     editor ignored; `undoBeforeInput` maps it (and `historyRedo`) here.

import { redo as cmRedo, undo as cmUndo, redoDepth as cmRedoDepth, undoDepth as cmUndoDepth } from "@codemirror/commands";
import { Facet, Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";

/** The undo history a CRDT editor reports into (the bridge's `Y.UndoManager`). */
export interface UndoTarget {
  undo(): unknown;
  redo(): unknown;
  /** Close the current step: the next tracked change starts a new one. */
  stopCapturing(): void;
  readonly undoStack: readonly unknown[];
  readonly redoStack: readonly unknown[];
}

export const undoTarget = Facet.define<UndoTarget, UndoTarget | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

export function editorUndo(view: EditorView): boolean {
  const target = view.state.facet(undoTarget);
  if (target) {
    if (target.undoStack.length === 0) return false;
    target.undo();
    return true;
  }
  return cmUndo(view);
}

export function editorRedo(view: EditorView): boolean {
  const target = view.state.facet(undoTarget);
  if (target) {
    if (target.redoStack.length === 0) return false;
    target.redo();
    return true;
  }
  return cmRedo(view);
}

export function canUndo(view: EditorView): boolean {
  const target = view.state.facet(undoTarget);
  if (target) return target.undoStack.length > 0;
  try {
    return cmUndoDepth(view.state) > 0;
  } catch {
    return false;
  }
}

export function canRedo(view: EditorView): boolean {
  const target = view.state.facet(undoTarget);
  if (target) return target.redoStack.length > 0;
  try {
    return cmRedoDepth(view.state) > 0;
  } catch {
    return false;
  }
}

// ---- keys -------------------------------------------------------------------

/**
 * Which history command a key press asks for, or null. Windows/Linux: Ctrl+Z,
 * Ctrl+Y, Ctrl+Shift+Z. macOS: ⌘Z and ⌘⇧Z (⌘Y is not a redo there). Matched on
 * `key` first and on the physical `code` as a fallback, so a layout that
 * reports an odd `key` for the Z/Y position still works.
 */
export function historyKeyAction(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  mac: boolean,
): "undo" | "redo" | null {
  if (e.altKey) return null;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : "";
  const isZ = key === "z" || (key === "" && e.code === "KeyZ");
  const isY = key === "y" || (key === "" && e.code === "KeyY");
  if (isZ) return e.shiftKey ? "redo" : "undo";
  if (isY && !mac && !e.shiftKey) return "redo";
  return null;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");

/** The editor's own undo/redo keys, ahead of every other keymap. */
export const undoKeymap: Extension = Prec.high(
  keymap.of([
    { key: "Mod-z", run: editorUndo, preventDefault: true },
    { key: "Mod-y", mac: "Mod-Shift-z", run: editorRedo, preventDefault: true },
    { key: "Mod-Shift-z", run: editorRedo, preventDefault: true },
  ]),
);

/** macOS Edit menu → `historyUndo` / `historyRedo` input events. */
export const undoBeforeInput: Extension = EditorView.domEventHandlers({
  beforeinput(e, view) {
    if (e.inputType === "historyUndo") {
      e.preventDefault();
      editorUndo(view);
      return true;
    }
    if (e.inputType === "historyRedo") {
      e.preventDefault();
      editorRedo(view);
      return true;
    }
    return false;
  },
});

/**
 * Ctrl+Z / Ctrl+Y pressed while the focus is NOT in a text field of its own —
 * the body after a table action, a table's buttons, a rendered widget inside
 * the editor. Text fields (a table cell's input, the title, a property value,
 * the find panel) keep their own native undo; the editor's content DOM is
 * handled by `undoKeymap`, which marks the event `defaultPrevented`.
 *
 * Returns the listener's remover.
 */
export function undoKeyFallback(
  getView: () => EditorView | null,
  opts: { mac?: boolean; host?: () => HTMLElement | null } = {},
): () => void {
  const mac = opts.mac ?? isMac;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const action = historyKeyAction(e, mac);
    if (!action) return;
    const view = getView();
    if (!view || view.state.readOnly) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) {
      if (active.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
        // The editor's content DOM is contenteditable too, but its own keymap
        // already ran (and prevented the default) for these keys.
        if (!view.contentDOM.contains(active)) return;
      }
      // Focus somewhere else in the app (a dialog, the sidebar) is not ours.
      const host = opts.host?.() ?? view.dom;
      if (!host.contains(active)) return;
    }
    e.preventDefault();
    if (action === "undo") editorUndo(view);
    else editorRedo(view);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

// ---- step boundaries ----------------------------------------------------------

type EditKind = "insert" | "delete" | "other";

export interface StepState {
  kind: EditKind | null;
  /** Document position right after the last own edit (mapped forward). */
  pos: number;
  /** The last character this device typed, "" when unknown. */
  lastChar: string;
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Should the undo step be closed BEFORE `tr` is applied? Pure, for tests.
 * Returns the decision plus the state after `tr`.
 */
export function planStepBoundary(prev: StepState, tr: Transaction): { stop: boolean; next: StepState } {
  if (!tr.docChanged) {
    // A caret move away from where we were typing ends the step too.
    if (tr.selection && prev.kind) {
      const head = tr.newSelection.main.head;
      if (head !== prev.pos) return { stop: true, next: { kind: null, pos: head, lastChar: "" } };
    }
    return { stop: false, next: prev };
  }
  // A change without a user event is not typing: a teammate's edit arriving
  // through yCollab, an undo/redo, a disk ingest, a menu command. Whatever it
  // is, the next keystroke starts a fresh step (never one merged into a step
  // that already sits on the stack).
  if (tr.annotation(Transaction.userEvent) == null) {
    return { stop: true, next: { kind: null, pos: -1, lastChar: "" } };
  }

  let inserted = "";
  let deleted = 0;
  let from = -1;
  let toA = -1;
  let toB = -1;
  let ranges = 0;
  tr.changes.iterChanges((fA, tA, _fB, tB, text) => {
    ranges++;
    if (from < 0) from = fA;
    toA = tA;
    toB = tB;
    deleted += tA - fA;
    inserted += text.toString();
  });

  const kind: EditKind =
    tr.isUserEvent("delete") && inserted === ""
      ? "delete"
      : tr.isUserEvent("input.type") && deleted === 0 && inserted.length === 1
        ? "insert"
        : "other";
  const next: StepState = { kind, pos: toB, lastChar: kind === "insert" ? inserted : "" };

  // Pastes, drops, typing over a selection, multi-cursor edits, autocompletes,
  // Enter with indentation, table and formatting commands: a step of their own.
  if (kind === "other" || ranges > 1) return { stop: true, next: { ...next, kind: "other" } };
  // Switching between typing and deleting.
  if (prev.kind !== kind) return { stop: true, next };
  if (kind === "insert") {
    // Not where the last keystroke ended → a new place, a new step.
    if (from !== prev.pos) return { stop: true, next };
    // A new word starts: the character before it was not part of a word.
    if (WORD.test(inserted) && prev.lastChar !== "" && !WORD.test(prev.lastChar)) return { stop: true, next };
    if (inserted === "\n") return { stop: true, next };
    return { stop: false, next };
  }
  // Deleting: Backspace keeps ending where the last one began, Delete keeps
  // starting at the same place; anything else is a jump.
  if (toA !== prev.pos && from !== prev.pos) return { stop: true, next };
  return { stop: false, next };
}

/**
 * Close the Yjs undo step at word boundaries. MUST be listed before `yCollab`
 * in the extensions: view plugins update in order, and the step has to be
 * closed before y-codemirror's sync plugin writes the change into the Y.Text.
 */
export function undoWordSteps(target: Pick<UndoTarget, "stopCapturing">): Extension {
  return ViewPlugin.fromClass(
    class {
      state: StepState = { kind: null, pos: -1, lastChar: "" };
      update(u: ViewUpdate) {
        for (const tr of u.transactions) {
          const { stop, next } = planStepBoundary(this.state, tr);
          if (stop) target.stopCapturing();
          this.state = next;
        }
      }
    },
  );
}
