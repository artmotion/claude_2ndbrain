// @vitest-environment jsdom
//
// Undo / redo in the CRDT note editor, as a person types: a line typed without
// a pause used to vanish whole on Ctrl+Z (Y.UndoManager merges everything
// inside its 500 ms capture window). Steps are now word-sized, Ctrl+Y redoes,
// and the keys still work when the focus is outside the editor's own text.

import { Compartment, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { yCollab } from "y-codemirror.next";
import { createEditorState } from ".";
import { NoteBridge } from "../bridge/noteBridge";
import { makeHarness } from "../bridge/__tests__/helpers";
import { historyKeyAction, undoKeyFallback, undoTarget, undoWordSteps } from "./undo";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

let view: EditorView;
let bridge: NoteBridge;
afterEach(() => {
  view?.destroy();
  bridge?.destroy();
  document.body.innerHTML = "";
});

async function open(doc: string): Promise<EditorView> {
  const { io } = makeHarness({ "n.md": doc });
  bridge = await NoteBridge.open(io, { docId: "d", path: "n.md" });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = createEditorState({
    doc: bridge.text.toString(),
    getTitles: () => [],
    onNavigate: () => {},
    collab: true,
    header: {
      path: "n.md",
      renameTo: async () => null,
      noteExists: async () => false,
      mode: "visible",
      modeCompartment: new Compartment(),
    },
    extraExtensions: [
      undoWordSteps(bridge.undoManager),
      undoTarget.of(bridge.undoManager),
      yCollab(bridge.text, null, { undoManager: bridge.undoManager }),
    ],
  } as never);
  view = new EditorView({ state, parent });
  return view;
}

/** Type `text` one key at a time at the caret, the way CM6 reports typing. */
function type(v: EditorView, text: string) {
  for (const ch of text) {
    const at = v.state.selection.main.head;
    v.dispatch({
      changes: { from: at, insert: ch },
      selection: EditorSelection.cursor(at + 1),
      userEvent: "input.type",
    });
  }
}

function backspace(v: EditorView, n: number) {
  for (let i = 0; i < n; i++) {
    const at = v.state.selection.main.head;
    v.dispatch({ changes: { from: at - 1, to: at }, selection: EditorSelection.cursor(at - 1), userEvent: "delete.backward" });
  }
}

function press(target: EventTarget, key: string, opts: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), ctrlKey: true, bubbles: true, cancelable: true, ...opts }),
  );
}

const body = (v: EditorView) => v.state.doc.toString();

describe("word-sized undo steps", () => {
  it("Ctrl+Z takes back the last word of a line typed without a pause, not the whole line", async () => {
    const v = await open("start\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "the quick brown fox");
    expect(body(v)).toBe("start\nthe quick brown fox");

    press(v.contentDOM, "z");
    expect(body(v)).toBe("start\nthe quick brown ");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("start\nthe quick ");
    press(v.contentDOM, "z");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("start\n");
  });

  it("Ctrl+Y and Ctrl+Shift+Z redo", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "one two");
    press(v.contentDOM, "z");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\n");
    press(v.contentDOM, "y");
    expect(body(v)).toBe("x\none ");
    press(v.contentDOM, "Z", { shiftKey: true });
    expect(body(v)).toBe("x\none two");
  });

  it("typing then deleting are separate steps; a Backspace run is one", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "hello");
    backspace(v, 3);
    expect(body(v)).toBe("x\nhe");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\nhello");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\n");
  });

  it("a paste is its own step", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "ab");
    const at = v.state.selection.main.head;
    v.dispatch({ changes: { from: at, insert: "PASTED" }, selection: EditorSelection.cursor(at + 6), userEvent: "input.paste" });
    type(v, "cd");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\nabPASTED");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\nab");
  });

  it("moving the caret ends the step", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "abc");
    v.dispatch({ selection: EditorSelection.cursor(1), userEvent: "select" });
    type(v, "Z");
    expect(body(v)).toBe("xZ\nabc");
    press(v.contentDOM, "z");
    expect(body(v)).toBe("x\nabc");
  });
});

describe("keys outside the editor text", () => {
  it("Ctrl+Z / Ctrl+Y on the page (after a table action) still reach the note", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "word");
    const off = undoKeyFallback(() => v, { mac: false });
    (document.activeElement as HTMLElement | null)?.blur();
    press(document.body, "z");
    expect(body(v)).toBe("x\n");
    press(document.body, "y");
    expect(body(v)).toBe("x\nword");
    off();
  });

  it("leaves a text field's own undo alone", async () => {
    const v = await open("x\n");
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    type(v, "word");
    const off = undoKeyFallback(() => v, { mac: false });
    const input = document.createElement("input");
    v.dom.appendChild(input);
    input.focus();
    press(input, "z");
    expect(body(v)).toBe("x\nword");
    off();
  });

  it("maps the platform keys", () => {
    const k = (key: string, o: Partial<KeyboardEvent> = {}) =>
      ({ key, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;
    expect(historyKeyAction(k("z", { ctrlKey: true }), false)).toBe("undo");
    expect(historyKeyAction(k("y", { ctrlKey: true }), false)).toBe("redo");
    expect(historyKeyAction(k("Z", { ctrlKey: true, shiftKey: true }), false)).toBe("redo");
    expect(historyKeyAction(k("z", { metaKey: true }), true)).toBe("undo");
    expect(historyKeyAction(k("z", { metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(historyKeyAction(k("y", { metaKey: true }), true)).toBeNull();
    expect(historyKeyAction(k("z", { ctrlKey: true }), true)).toBeNull();
    expect(historyKeyAction(k("z", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});
