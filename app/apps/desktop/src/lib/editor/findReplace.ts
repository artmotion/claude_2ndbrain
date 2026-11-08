// Find and replace inside the open note — CodeMirror's search panel, docked at
// the top of the editor.
//
//   Mod-f              find in this note (seeded with the selection)
//   Mod-h / Mod-Alt-f  find + replace, caret in the Replace field
//                      (Ctrl+H on Windows/Linux; ⌘⌥F on a Mac, where ⌘H hides
//                      the app before it ever reaches the webview)
//   Enter / F3         next match, Shift+Enter / Shift+F3 previous
//   Escape             close
//
// Mod-f only belongs to the editor while it has focus: the app's own handler
// (`App.tsx`) skips a key the editor already handled, so outside the editor
// ⌘F still opens the vault-wide search, and ⌘⇧F opens it from anywhere.
//
// Replacing is an ordinary editor transaction, so it reaches the note's Y.Text
// through yCollab, merges with teammates' edits and undoes in one step. A
// read-only note gets the panel without its Replace row (CodeMirror leaves it
// out when `state.readOnly`).

import {
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/** Labels on the panel, written like the rest of the app's UI. */
const PHRASES = {
  Find: "Find in note",
  Replace: "Replace with",
  next: "Next",
  previous: "Previous",
  all: "Select all",
  "match case": "Match case",
  regexp: "Regex",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
};

function focusField(view: EditorView, name: "search" | "replace"): void {
  const field = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`);
  if (!field) return;
  field.focus();
  field.select();
}

/** Open the panel (or bring it back into focus) on the Find field. */
export const openFind: Command = (view) => {
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  focusField(view, "search");
  return true;
};

/**
 * Open the panel with the caret in the Replace field — or in Find when that is
 * still empty (nothing to replace yet) or the note is read-only.
 */
export const openReplace: Command = (view) => {
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  const hasQuery = getSearchQuery(view.state).search !== "";
  focusField(view, view.state.readOnly || !hasQuery ? "search" : "replace");
  return true;
};

/** Start a search for `text` (the context menu's "Find …" on a selection). */
export function findText(view: EditorView, text: string): void {
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  const current = getSearchQuery(view.state);
  view.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({
        search: text,
        caseSensitive: current.caseSensitive,
        regexp: false,
        wholeWord: current.wholeWord,
        replace: current.replace,
      }),
    ),
  });
  focusField(view, "search");
}

export const findReplace: Extension = [
  search({ top: true }),
  EditorState.phrases.of(PHRASES),
  // Ahead of the base keymap (whose search bindings have Mod-f taken out, see
  // ./index.ts) and in the panel's own scope too, so the chord also works from
  // inside the panel's fields.
  Prec.high(
    keymap.of([
      { key: "Mod-f", run: openFind, scope: "editor search-panel", preventDefault: true },
      { key: "Mod-h", run: openReplace, scope: "editor search-panel", preventDefault: true },
      { key: "Mod-Alt-f", run: openReplace, scope: "editor search-panel", preventDefault: true },
    ]),
  ),
];
