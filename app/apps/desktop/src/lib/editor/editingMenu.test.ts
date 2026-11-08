// @vitest-environment jsdom
//
// Find & replace in the open note, the new formatting commands (underline,
// table) and the right-click menu's model — all through a real EditorView.

import { getSearchQuery, replaceAll, searchPanelOpen, setSearchQuery, SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { editorMenuItems, placeCaretForMenu, type EditorMenuItem } from "./contextMenu";
import { findText, openFind, openReplace } from "./findReplace";
import { headingLevelAt, insertTable, toggleWrap } from "./formatting";
import { createEditorState } from "./index";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

const MOD_IS_META = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function mount(doc: string, opts: { at?: number; to?: number; readOnly?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      extraExtensions: opts.readOnly ? [EditorState.readOnly.of(true)] : [],
    } as never),
    parent,
  });
  if (opts.at != null) view.dispatch({ selection: EditorSelection.range(opts.at, opts.to ?? opts.at) });
  return view;
}

function press(view: EditorView, key: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      bubbles: true,
      cancelable: true,
      metaKey: !!mods.mod && MOD_IS_META,
      ctrlKey: !!mods.mod && !MOD_IS_META,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
    }),
  );
}

const text = (v: EditorView) => v.state.doc.toString();
const item = (items: EditorMenuItem[], key: string) => {
  for (const i of items) {
    if (i.key === key) return i;
    const c = i.children?.find((x) => x.key === key);
    if (c) return c;
  }
  throw new Error(`no item ${key}`);
};

describe("find & replace in the open note", () => {
  it("Mod-f opens the panel seeded with the selection, inside the editor", () => {
    const view = mount("alpha beta alpha", { at: 0, to: 5 });
    press(view, "f", { mod: true });
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(getSearchQuery(view.state).search).toBe("alpha");
    const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
    expect(field?.placeholder).toBe("Find in note");
    view.destroy();
  });

  it("Mod-f is handled (default prevented), so the app's vault search stays out of it", () => {
    const view = mount("x");
    const ev = new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      keyCode: 70,
      bubbles: true,
      cancelable: true,
      metaKey: MOD_IS_META,
      ctrlKey: !MOD_IS_META,
    });
    view.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // Mod-Shift-f is NOT the editor's: it reaches the app's search-all-notes.
    const all = new KeyboardEvent("keydown", {
      key: "F",
      code: "KeyF",
      keyCode: 70,
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      metaKey: MOD_IS_META,
      ctrlKey: !MOD_IS_META,
    });
    view.contentDOM.dispatchEvent(all);
    expect(all.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("Mod-h opens with the Replace field focused, and Replace all edits the note", () => {
    const view = mount("one two one", { at: 0, to: 3 });
    press(view, "h", { mod: true });
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(document.activeElement?.getAttribute("name")).toBe("replace");
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one", replace: "1" })) });
    replaceAll(view);
    expect(text(view)).toBe("1 two 1");
    view.destroy();
  });

  it("a read-only note gets find without the Replace row", () => {
    const view = mount("locked text", { readOnly: true });
    openReplace(view);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.querySelector('.cm-search input[name="replace"]')).toBeNull();
    expect(document.activeElement?.getAttribute("name")).toBe("search");
    view.destroy();
  });

  it("findText starts a literal search for the given text", () => {
    const view = mount("a.b a.b");
    findText(view, "a.b");
    expect(getSearchQuery(view.state)).toMatchObject({ search: "a.b", regexp: false });
    openFind(view);
    expect(document.activeElement?.getAttribute("name")).toBe("search");
    view.destroy();
  });
});

describe("formatting commands", () => {
  it("underline wraps with <u>…</u> and unwraps again (Mod-u)", () => {
    const view = mount("plain words", { at: 6, to: 11 });
    press(view, "u", { mod: true });
    expect(text(view)).toBe("plain <u>words</u>");
    press(view, "u", { mod: true });
    expect(text(view)).toBe("plain words");
    expect(toggleWrap("<u>", "</u>")(mount("x", { readOnly: true }))).toBe(false);
    view.destroy();
  });

  it("a table goes below a line of text with a blank line, first header cell selected", () => {
    const view = mount("Intro line\nNext para", { at: 3 });
    insertTable(view);
    expect(text(view)).toBe(
      "Intro line\n\n| Column | Column |\n| --- | --- |\n|  |  |\n\nNext para",
    );
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("Column");
    view.destroy();
  });

  it("a table on an empty line replaces it, after a blank line above", () => {
    const view = mount("Text\n\n\nMore", { at: 6 });
    insertTable(view);
    expect(text(view)).toBe("Text\n\n| Column | Column |\n| --- | --- |\n|  |  |\n\nMore");
    const empty = mount("", { at: 0 });
    insertTable(empty);
    expect(text(empty)).toBe("| Column | Column |\n| --- | --- |\n|  |  |");
    view.destroy();
    empty.destroy();
  });

  it("headingLevelAt reads the caret line", () => {
    const view = mount("### Three\nbody", { at: 2 });
    expect(headingLevelAt(view.state)).toBe(3);
    view.dispatch({ selection: EditorSelection.cursor(12) });
    expect(headingLevelAt(view.state)).toBe(0);
    view.destroy();
  });
});

describe("the right-click menu model", () => {
  it("offers clipboard, formatting, headings, link, table and find for a markdown note", () => {
    const view = mount("# Title\nbody", { at: 3 });
    const items = editorMenuItems(view, { plain: false, platform: "windows" });
    expect(items.map((i) => i.key)).toEqual([
      "cut",
      "copy",
      "paste",
      "bold",
      "italic",
      "underline",
      "heading",
      "link",
      "table",
      "find",
      "replace",
    ]);
    expect(item(items, "bold").shortcut).toBe("Ctrl+B");
    expect(item(items, "replace").shortcut).toBe("Ctrl+H");
    expect(item(items, "heading").children!.map((c) => c.label)).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Heading 4",
      "Heading 5",
      "Heading 6",
      "Normal text",
    ]);
    // The caret line is an H1: ticked, and choosing it again changes nothing.
    expect(item(items, "h1").checked).toBe(true);
    expect(item(items, "h1").run).toBeUndefined();
    // Cut/Copy need a selection.
    expect(item(items, "cut").disabled).toBe(true);
    expect(item(items, "copy").disabled).toBe(true);
    view.destroy();
  });

  it("each item runs the same command as its shortcut", () => {
    const view = mount("# Title\nsome body", { at: 8, to: 12 });
    const run = (key: string) => item(editorMenuItems(view, { plain: false }), key).run!(view);
    run("bold");
    expect(text(view)).toBe("# Title\n**some** body");
    run("h3");
    expect(text(view)).toBe("# Title\n### **some** body");
    run("h0");
    expect(text(view)).toBe("# Title\n**some** body");
    run("link");
    expect(text(view)).toBe("# Title\n**[some]()** body");
    view.destroy();
  });

  it("a read-only note keeps Copy and Find, nothing that edits", () => {
    const view = mount("text", { at: 0, to: 4, readOnly: true });
    const items = editorMenuItems(view, { plain: false });
    for (const k of ["cut", "paste", "bold", "italic", "underline", "heading", "link", "table", "replace"]) {
      expect(item(items, k).disabled, k).toBe(true);
    }
    expect(item(items, "copy").disabled).toBeFalsy();
    expect(item(items, "find").disabled).toBeFalsy();
    view.destroy();
  });

  it("a .txt note gets no markdown formatting", () => {
    const view = mount("plain");
    expect(editorMenuItems(view, { plain: true }).map((i) => i.key)).toEqual([
      "cut",
      "copy",
      "paste",
      "find",
      "replace",
    ]);
    view.destroy();
  });

  it("Paste inserts the clipboard text, or says it is unavailable", async () => {
    const view = mount("ab", { at: 1 });
    await item(editorMenuItems(view, { plain: false, readClipboard: async () => "XY" }), "paste").run!(view);
    expect(text(view)).toBe("aXYb");
    const onPasteUnavailable = vi.fn();
    await item(
      editorMenuItems(view, {
        plain: false,
        readClipboard: () => Promise.reject(new Error("denied")),
        onPasteUnavailable,
      }),
      "paste",
    ).run!(view);
    expect(onPasteUnavailable).toHaveBeenCalled();
    view.destroy();
  });

  it("right-click keeps a selection it lands in, else moves the caret there", () => {
    const view = mount("hello world", { at: 0, to: 5 });
    const spy = vi.spyOn(view, "posAtCoords");
    spy.mockReturnValue(2);
    placeCaretForMenu(view, 0, 0);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    spy.mockReturnValue(8);
    placeCaretForMenu(view, 0, 0);
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 8 });
    view.destroy();
  });
});
