// @vitest-environment jsdom
//
// The table cell's right-click menu: Delete row with a cell still open (the
// open cell's text used to land in the row that moved up), rotated headers,
// and undo / redo from the menu and the keys inside a cell.

import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import { createEditorState } from "../index";
import { headerRotation, withHeaderRotation } from "./rotation";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const cells = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td")];
const openInput = (view: EditorView) => view.dom.querySelector<HTMLInputElement>(".cm-md-cell-input");
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const rightClick = (el: Element) =>
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".cm-md-table-menu li")].find((li) => li.textContent === label);
function typeInto(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const ctrl = (el: Element, key: string, shiftKey = false) =>
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }),
  );

const THREE = ["| h1 | h2 |", "| --- | --- |", "| a1 | a2 |", "| b1 | b2 |", "| c1 | c2 |"].join("\n");

describe("Delete row with a cell open", () => {
  it("removes the whole row; the open cell's text never lands in the row below", async () => {
    const view = mount(THREE);
    const cell = cells(view).find((c) => c.textContent === "b1")!;
    click(cell);
    await settle();
    const input = openInput(view)!;
    expect(input.value).toBe("b1");
    rightClick(input.closest("td")!);
    await settle();
    click(menuItem("Delete row")!);
    await settle();
    // Whatever the focus does next (the input is gone or blurs), nothing more is written.
    openInput(view)?.blur();
    document.body.click();
    await settle();
    expect(view.state.doc.toString()).toBe(
      ["| h1 | h2 |", "| --- | --- |", "| a1 | a2 |", "| c1 | c2 |"].join("\n"),
    );
    view.destroy();
  });

  it("keeps an edit typed into the open cell, then deletes a different row", async () => {
    const view = mount(THREE);
    click(cells(view).find((c) => c.textContent === "a1")!);
    await settle();
    typeInto(openInput(view)!, "A1");
    await settle();
    rightClick(cells(view).find((c) => c.textContent === "c1")!);
    await settle();
    click(menuItem("Delete row")!);
    await settle();
    expect(view.state.doc.toString()).toBe(
      ["| h1 | h2 |", "| --- | --- |", "| A1 | a2 |", "| b1 | b2 |"].join("\n"),
    );
    view.destroy();
  });
});

describe("rotated headers", () => {
  it("parses and writes the marker", () => {
    expect(headerRotation("<!--rotate:90--> Reps")).toEqual({ deg: 90, text: "Reps" });
    expect(headerRotation("<!-- rotate: -90 -->Sets")).toEqual({ deg: -90, text: "Sets" });
    expect(headerRotation("Plain")).toEqual({ deg: 0, text: "Plain" });
    expect(withHeaderRotation("Reps", 90)).toBe("<!--rotate:90--> Reps");
    expect(withHeaderRotation("<!--rotate:90--> Reps", -90)).toBe("<!--rotate:-90--> Reps");
    expect(withHeaderRotation("<!--rotate:90--> Reps", 0)).toBe("Reps");
  });

  it("offers rotation only on a header cell, and writes it into the .md", async () => {
    const view = mount(THREE);
    rightClick(cells(view).find((c) => c.textContent === "a1")!);
    await settle();
    expect(menuItem("Rotate header up (90°)")).toBeUndefined();
    document.body.click();
    await settle();

    rightClick(cells(view).find((c) => c.textContent === "h2")!);
    await settle();
    click(menuItem("Rotate header up (90°)")!);
    await settle();
    expect(view.state.doc.line(1).text).toBe("| h1 | <!--rotate:90--> h2 |");
    const th = view.dom.querySelectorAll("th")[1]!;
    expect(th.classList.contains("cm-md-th-rot-up")).toBe(true);
    expect(th.textContent).toBe("h2"); // the marker is never shown

    rightClick(th);
    await settle();
    click(menuItem("Rotate header down (−90°)")!);
    await settle();
    expect(view.state.doc.line(1).text).toBe("| h1 | <!--rotate:-90--> h2 |");
    expect(view.dom.querySelectorAll("th")[1]!.classList.contains("cm-md-th-rot-down")).toBe(true);

    rightClick(view.dom.querySelectorAll("th")[1]!);
    await settle();
    click(menuItem("Horizontal header")!);
    await settle();
    expect(view.state.doc.line(1).text).toBe("| h1 | h2 |");
    view.destroy();
  });

  it("edits a rotated title without the marker and keeps the rotation", async () => {
    const view = mount(["| <!--rotate:90--> Reps | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
    click(view.dom.querySelectorAll("th")[0]!);
    await settle();
    const input = openInput(view)!;
    expect(input.value).toBe("Reps");
    typeInto(input, "Repetitions");
    await settle();
    input.blur();
    await settle();
    expect(view.state.doc.line(1).text).toBe("| <!--rotate:90--> Repetitions | b |");
    view.destroy();
  });
});

describe("undo / redo in a table", () => {
  it("the menu's Undo and Redo walk the note's history", async () => {
    const view = mount(THREE);
    rightClick(cells(view).find((c) => c.textContent === "b1")!);
    await settle();
    click(menuItem("Delete row")!);
    await settle();
    expect(view.state.doc.lines).toBe(4);
    rightClick(cells(view)[0]!);
    await settle();
    click(menuItem("Undo")!);
    await settle();
    expect(view.state.doc.toString()).toBe(THREE);
    rightClick(cells(view)[0]!);
    await settle();
    click(menuItem("Redo")!);
    await settle();
    expect(view.state.doc.lines).toBe(4);
    view.destroy();
  });

  it("Ctrl+Z / Ctrl+Y in an untouched cell undo and redo the note", async () => {
    const view = mount(THREE);
    click(cells(view).find((c) => c.textContent === "a1")!);
    await settle();
    typeInto(openInput(view)!, "X");
    await settle();
    openInput(view)!.blur();
    await settle();
    expect(view.state.doc.line(3).text).toBe("| X | a2 |");

    click(cells(view).find((c) => c.textContent === "b1")!);
    await settle();
    ctrl(openInput(view)!, "z");
    await settle();
    expect(view.state.doc.line(3).text).toBe("| a1 | a2 |");
    expect(openInput(view)).toBeNull();

    click(cells(view).find((c) => c.textContent === "b1")!);
    await settle();
    ctrl(openInput(view)!, "y");
    await settle();
    expect(view.state.doc.line(3).text).toBe("| X | a2 |");
    view.destroy();
  });
});
