// Inline formatting shortcuts — the muscle-memory keys every markdown editor
// has. Each command wraps/unwraps the selection with markdown markers as an
// idempotent toggle, and works across multiple selections. Changes are plain
// CodeMirror transactions, so the Yjs binding (yCollab) picks them up and syncs
// them exactly like typed text.
//
//   Mod-b        **bold**
//   Mod-i        *italic*
//   Mod-e        `inline code`
//   Mod-Shift-x  ~~strikethrough~~
//   Mod-Shift-h  ==highlight==
//   Mod-u        <u>underline</u> — markdown has no underline of its own; the
//                HTML tag is what Obsidian and most renderers show
//   Mod-k        [text](url)  — selection becomes the link text; caret lands
//                in the empty () so you can type/paste the URL immediately.
//                A selected URL goes the other way round: `[](url)`, caret in
//                the empty label.
//   Mod-Alt-1…6  heading level (pressing the level a line already has clears it)
//   Shift-Enter  a markdown hard break ("  \n"), not a new paragraph
//
// Two conveniences that make the toggles feel hand-made rather than mechanical:
// a selection that swept up a trailing space wraps only the WORDS (`**word **`
// renders as literal asterisks in markdown, so the naive version silently
// produces nothing), and an empty selection wraps the word under the caret
// instead of leaving two markers and an empty middle.

import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/**
 * Narrow a range to what should actually be wrapped: whitespace at either end
 * is left outside, and an empty range grows to the word under the caret. Both
 * fall back to the original range when there is nothing better to say (a caret
 * in open space still gets the two markers and a cursor between them).
 */
function wrapTarget(state: EditorState, range: SelectionRange): { from: number; to: number } {
  if (range.empty) {
    const word = state.wordAt(range.head);
    return word ? { from: word.from, to: word.to } : { from: range.from, to: range.to };
  }
  const text = state.sliceDoc(range.from, range.to);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  // All whitespace — nothing to wrap; keep the caret behaviour.
  if (lead + trail >= text.length) return { from: range.from, to: range.to };
  return { from: range.from + lead, to: range.to - trail };
}

/** Toggle a symmetric inline marker (`**`, `*`, `` ` ``, `~~`, `==`). */
export function toggleInline(marker: string): Command {
  return toggleWrap(marker, marker);
}

/**
 * Toggle a pair of inline markers around the selection — symmetric (`**`) or
 * not (`<u>` … `</u>`). Same unwrap rules either way: the markers just outside
 * the selection, or bracketing the selection itself, are removed instead.
 */
export function toggleWrap(open: string, close: string): Command {
  const ol = open.length;
  const cl = close.length;
  return (view: EditorView) => {
    if (view.state.readOnly) return false;
    const tr = view.state.changeByRange((range) => {
      const { from, to } = wrapTarget(view.state, range);
      const before = view.state.sliceDoc(Math.max(0, from - ol), from);
      const after = view.state.sliceDoc(to, to + cl);
      const inside = view.state.sliceDoc(from, to);

      // Markers sit just outside the selection → strip them (unwrap).
      if (before === open && after === close) {
        return {
          changes: [
            { from: from - ol, to: from },
            { from: to, to: to + cl },
          ],
          range: EditorSelection.range(from - ol, to - ol),
        };
      }
      // Selection already brackets itself with the markers → strip them.
      if (inside.length >= ol + cl && inside.startsWith(open) && inside.endsWith(close)) {
        return {
          changes: [
            { from, to: from + ol },
            { from: to - cl, to },
          ],
          range: EditorSelection.range(from, to - ol - cl),
        };
      }
      // Otherwise wrap. Empty target → caret lands between the markers.
      return {
        changes: [
          { from, insert: open },
          { from: to, insert: close },
        ],
        range:
          from === to
            ? EditorSelection.cursor(from + ol)
            : EditorSelection.range(from + ol, to + ol),
      };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

/** Anything that looks like a destination rather than like prose. */
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)\S+$/i;

/**
 * `[selection](url)` with the caret dropped inside the empty URL parens — or,
 * when what you selected IS a URL (the overwhelmingly common case: paste a link,
 * select it, hit ⌘K), `[](url)` with the caret in the empty label, because the
 * one thing still missing is the words.
 */
export const insertLink: Command = (view) => {
  if (view.state.readOnly) return false;
  const tr = view.state.changeByRange((range) => {
    const target = wrapTarget(view.state, range);
    const text = view.state.sliceDoc(target.from, target.to);
    if (URL_RE.test(text)) {
      return {
        changes: { from: target.from, to: target.to, insert: `[](${text})` },
        // Caret between the brackets: after `[`.
        range: EditorSelection.cursor(target.from + 1),
      };
    }
    const insert = `[${text}]()`;
    // Caret between the parens: after `[text](`.
    return {
      changes: { from: target.from, to: target.to, insert },
      range: EditorSelection.cursor(target.from + text.length + 3),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
  return true;
};

/** A markdown hard break: two spaces then the newline. */
const hardBreak: Command = (view) => {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.replaceSelection("  \n"), {
    scrollIntoView: true,
    userEvent: "input.hardbreak",
  });
  return true;
};

/** A two-column table with the first header cell selected, on its own
 *  paragraph: a blank line is added before and after where text touches it. */
export const TABLE_TEMPLATE = "| Column | Column |\n| --- | --- |\n|  |  |";

export const insertTable: Command = (view) => {
  if (view.state.readOnly) return false;
  const { doc } = view.state;
  const line = doc.lineAt(view.state.selection.main.to);
  const blank = (n: number) => n < 1 || n > doc.lines || doc.line(n).text.trim() === "";
  const nextHasText = line.number < doc.lines && !blank(line.number + 1);
  let from: number;
  let to: number;
  let lead: string;
  if (blank(line.number)) {
    // An empty line becomes the table; a blank line above it is kept or made.
    from = line.from;
    to = line.to;
    lead = blank(line.number - 1) ? "" : "\n";
  } else {
    // After a line of text: below it, never splitting the sentence.
    from = to = line.to;
    lead = "\n\n";
  }
  // Keep a blank line between the table and text that follows it.
  const trail = nextHasText ? "\n" : "";
  const cell = from + lead.length + 2;
  view.dispatch({
    changes: { from, to, insert: `${lead}${TABLE_TEMPLATE}${trail}` },
    selection: EditorSelection.range(cell, cell + "Column".length),
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
};

const HEADING_RE = /^#{1,6}[ \t]+/;

/** The heading level (1–6) of the line holding the main selection, else 0. */
export function headingLevelAt(state: EditorState): number {
  const line = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})[ \t]+/.exec(line.text);
  return m ? m[1]!.length : 0;
}

/**
 * Set every selected line to heading level `level`; a line that is already at
 * that level drops back to body text, so the same chord toggles.
 */
export function setHeading(level: number): Command {
  const hashes = "#".repeat(level);
  return (view: EditorView) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const seen = new Set<number>();
    const changes: { from: number; to: number; insert: string }[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        // Replace only the marker run, so the line's text is kept verbatim.
        const existing = HEADING_RE.exec(line.text)?.[0] ?? "";
        const same = existing.trimEnd() === hashes;
        changes.push({
          from: line.from,
          to: line.from + existing.length,
          insert: same ? "" : `${hashes} `,
        });
      }
    }
    if (!changes.length) return false;
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

export function formattingKeymap() {
  return keymap.of([
    { key: "Mod-b", run: toggleInline("**"), preventDefault: true },
    { key: "Mod-i", run: toggleInline("*"), preventDefault: true },
    { key: "Mod-e", run: toggleInline("`"), preventDefault: true },
    { key: "Mod-Shift-x", run: toggleInline("~~"), preventDefault: true },
    { key: "Mod-Shift-h", run: toggleInline("=="), preventDefault: true },
    { key: "Mod-u", run: toggleWrap("<u>", "</u>"), preventDefault: true },
    { key: "Mod-k", run: insertLink, preventDefault: true },
    // Shift-Enter is a distinct key name from Enter, so lang-markdown's
    // `Prec.high` Enter binding (list continuation) never sees it — but the
    // default keymap DOES bind Enter's `shift` slot, which is why this must be
    // registered ahead of `keymap.of(defaultKeymap)` in `lib/editor/index.ts`.
    { key: "Shift-Enter", run: hardBreak, preventDefault: true },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      key: `Mod-Alt-${n}`,
      run: setHeading(n),
      preventDefault: true,
    })),
  ]);
}
