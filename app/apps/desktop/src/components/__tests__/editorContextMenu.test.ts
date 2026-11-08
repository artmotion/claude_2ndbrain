// @vitest-environment jsdom
//
// The editor's right-click menu as a person uses it: it lists the actions with
// their shortcuts, the heading flyout opens on hover or →, a click edits the
// note, and Escape closes everything and gives the editor its focus back.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { editorMenuItems } from "../../lib/editor/contextMenu";
import { createEditorState } from "../../lib/editor";
import { EditorContextMenu } from "../EditorContextMenu";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

let host: HTMLDivElement;
let root: Root;
let view: EditorView;
let closed = 0;

function open(doc: string, from: number, to = from) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
  view.dispatch({ selection: EditorSelection.range(from, to) });
  const items = editorMenuItems(view, { plain: false, platform: "windows" });
  act(() =>
    root.render(
      createElement(EditorContextMenu, {
        view,
        x: 20,
        y: 20,
        items,
        onClose: () => {
          closed++;
          act(() => root.render(createElement("div")));
        },
      }),
    ),
  );
}

const menus = () => [...document.querySelectorAll<HTMLElement>(".editor-context-menu")];
const row = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".editor-context-menu li")].find(
    (li) => li.querySelector(".editor-menu-label")?.textContent === label,
  )!;

beforeEach(() => {
  closed = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  view?.destroy();
  document.body.innerHTML = "";
});

describe("EditorContextMenu", () => {
  it("lists the actions with their shortcuts, and greys out what does not apply", () => {
    open("hello world", 0);
    const labels = [...menus()[0]!.querySelectorAll(".editor-menu-label")].map((e) => e.textContent);
    expect(labels).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "Bold",
      "Italic",
      "Underline",
      "Heading",
      "Insert link",
      "Insert table",
      "Find in note",
      "Find and replace",
    ]);
    expect(row("Bold").querySelector(".editor-menu-shortcut")?.textContent).toBe("Ctrl+B");
    expect(row("Cut").getAttribute("aria-disabled")).toBe("true");
    // The first live item takes focus for the keyboard.
    expect(document.activeElement).toBe(row("Paste"));
  });

  it("a click on Bold formats the word under the caret and closes the menu", () => {
    open("hello world", 7);
    act(() => row("Bold").click());
    expect(view.state.doc.toString()).toBe("hello **world**");
    expect(closed).toBe(1);
  });

  it("the heading flyout opens on hover and sets the level", () => {
    open("A line", 2);
    act(() => row("Heading").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(menus()).toHaveLength(2);
    expect([...menus()[1]!.querySelectorAll(".editor-menu-label")].map((e) => e.textContent)).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Heading 4",
      "Heading 5",
      "Heading 6",
      "Normal text",
    ]);
    expect(row("Normal text").getAttribute("aria-checked")).toBe("true");
    act(() => row("Heading 2").click());
    expect(view.state.doc.toString()).toBe("## A line");
  });

  it("keyboard: arrows move, → opens the flyout, ← returns, Escape closes and refocuses", async () => {
    open("text", 1);
    const key = (el: Element, k: string) =>
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    const heading = row("Heading");
    act(() => heading.focus());
    key(heading, "ArrowRight");
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(row("Heading 1"));
    key(row("Heading 1"), "ArrowDown");
    expect(document.activeElement).toBe(row("Heading 2"));
    key(row("Heading 2"), "ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(row("Heading"));
    key(document.body, "Escape");
    expect(closed).toBe(1);
    expect(view.hasFocus || document.activeElement === view.contentDOM).toBe(true);
  });

  it("Insert table drops a table under the line", () => {
    open("Intro", 5);
    act(() => row("Insert table").click());
    expect(view.state.doc.toString()).toBe("Intro\n\n| Column | Column |\n| --- | --- |\n|  |  |");
  });
});
