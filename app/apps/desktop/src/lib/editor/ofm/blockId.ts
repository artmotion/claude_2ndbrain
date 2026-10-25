// ` ^block-id` — the Obsidian marker that makes a block linkable as
// `[[Note#^block-id]]` (see lib/links/anchors.ts for where it may stand).
//
// It is plumbing, not prose: off the active line the marker folds away so the
// paragraph reads as written, and it comes back (faint) the moment the caret
// is on that line — LINE scope, like other markers that belong to the whole
// block rather than to one token. Never inside code: a `^x` at the end of a
// fenced line is code.

import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { activeLineChecker, focusMoved } from "../reveal";

/** The trailing marker, leading space included (anchors.ts TRAILING_ID_RE). */
const TRAILING_ID = /(^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;
const STANDALONE_ID = /^[ \t]*\^[A-Za-z0-9-]+[ \t]*$/;

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText"]);

const hidden = Decoration.replace({});
const faint = Decoration.mark({ class: "cm-block-id" });

function inCode(view: EditorView, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const active = activeLineChecker(view.state);
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const m = TRAILING_ID.exec(line.text);
      if (m && !STANDALONE_ID.test(line.text) && !inCode(view, line.to)) {
        // `markFrom` includes the space before `^`; the faint span does not.
        const markFrom = line.from + m.index;
        if (active(line.from, line.to)) decos.push(faint.range(markFrom + m[1]!.length, line.to));
        else decos.push(hidden.range(markFrom, line.to));
      } else if (STANDALONE_ID.test(line.text) && !inCode(view, line.to)) {
        decos.push(faint.range(line.from, line.to));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}

export const blockIdMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || focusMoved(u)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
