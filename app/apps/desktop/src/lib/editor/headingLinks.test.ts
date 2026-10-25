// @vitest-environment jsdom
//
// Linked headings: the "N links" count, and the "update links?" prompt after a
// rename (spec: docs/specs/06-block-links.md, phase 3).

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Backlink } from "../ipc";
import { groupBacklinks, backlinksToHeading, referenceCounts } from "../links/backlinkAnchors";
import { type HeadingLinkHost, backlinksChanged } from "./headingLinks";
import { createEditorState } from "./index";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

const bl = (path: string, linkText: string): Backlink => ({ id: path, path, title: path, linkText });

function mount(doc: string, host: HeadingLinkHost) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {}, headingLinks: host } as never),
    parent,
  });
  return view;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Type into the doc as a person would (a user event), caret after it. */
function type(view: EditorView, from: number, to: number, insert: string) {
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent: "input.type",
  });
}

describe("backlinkAnchors", () => {
  const rows = [
    bl("Daily.md", "Plan#Risks"),
    bl("Daily.md", "Plan#^ship1"),
    bl("Weekly.md", "Plan#Goals#Risks|the risks"),
    bl("Inbox.md", "Plan"),
  ];

  it("counts references per heading and block", () => {
    const { headings, blocks } = referenceCounts(rows);
    expect(headings.get("risks")?.length).toBe(2);
    expect(blocks.get("ship1")?.length).toBe(1);
    expect(headings.size).toBe(1);
  });

  it("finds links into a heading, including through a parent segment", () => {
    expect(backlinksToHeading(rows, "Goals").map((b) => b.path)).toEqual(["Weekly.md"]);
    expect(backlinksToHeading(rows, "risks").length).toBe(2);
  });

  it("groups rows per note with their targets and aliases", () => {
    expect(groupBacklinks(rows, "Plan")).toEqual([
      { id: "Daily.md", path: "Daily.md", aliases: [], targets: ["Risks", "^ship1"], count: 2 },
      { id: "Weekly.md", path: "Weekly.md", aliases: ["the risks"], targets: ["Goals › Risks"], count: 1 },
      { id: "Inbox.md", path: "Inbox.md", aliases: [], targets: [], count: 1 },
    ]);
  });
});

describe("headingLinks extension", () => {
  function host(backlinks: Backlink[], renameLinks = vi.fn(async () => {})): HeadingLinkHost & {
    renameLinks: typeof renameLinks;
  } {
    return { selfPath: "Plan.md", getBacklinks: () => backlinks, selfNames: () => ["Plan"], renameLinks };
  }

  it("shows a link count on linked headings and blocks, and repaints on new backlinks", () => {
    let rows = [bl("Daily.md", "Plan#Risks"), bl("Weekly.md", "Plan#Risks")];
    const h: HeadingLinkHost = { selfPath: "Plan.md", getBacklinks: () => rows, selfNames: () => [], renameLinks: async () => {} };
    const view = mount("## Risks\n\nShip ^ship1\n\n## Goals\n", h);
    const counts = () => Array.from(view.dom.querySelectorAll(".cm-heading-refs")).map((e) => e.textContent);
    expect(counts()).toEqual(["2 links"]);
    rows = [...rows, bl("Inbox.md", "Plan#^ship1")];
    view.dispatch({ effects: backlinksChanged.of(null) });
    expect(counts()).toEqual(["2 links", "1 link"]);
    view.destroy();
  });

  it("renaming a linked heading asks once the caret leaves, and Update rewrites links", async () => {
    const h = host([bl("Daily.md", "Plan#Risks")]);
    const doc = "## Risks\n\nSee [[#Risks]].\n";
    const view = mount(doc, h);
    view.focus();
    // Rename "Risks" → "Open risks" by typing on the heading line.
    type(view, 3, 3, "Open ");
    await flush();
    expect(view.dom.querySelector(".cm-heading-rename")).toBeNull(); // still on the line
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await flush();
    const box = view.dom.querySelector(".cm-heading-rename");
    expect(box?.textContent).toContain("2 links point to “Risks”. Update them to “Open Risks”?");
    const update = Array.from(box!.querySelectorAll("button")).find((b) => b.textContent === "Update links")!;
    update.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("## Open Risks\n\nSee [[#Open Risks]].\n");
    expect(h.renameLinks).toHaveBeenCalledWith("Risks", "Open Risks");
    expect(view.dom.querySelector(".cm-heading-rename")).toBeNull();
    view.destroy();
  });

  it("Keep dismisses, an unlinked heading never asks, a remote rename never asks", async () => {
    const h = host([bl("Daily.md", "Plan#Risks")]);
    const view = mount("## Risks\n\n## Other\n\ntext\n", h);
    view.focus();
    type(view, 3, 8, "Threats");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await flush();
    const keep = Array.from(view.dom.querySelectorAll(".cm-heading-rename button")).find((b) => b.textContent === "Keep")!;
    keep.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.dom.querySelector(".cm-heading-rename")).toBeNull();
    expect(h.renameLinks).not.toHaveBeenCalled();

    // "Other" has no links: renaming it asks nothing.
    const at = view.state.doc.toString().indexOf("Other");
    type(view, at, at + 5, "Else");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await flush();
    expect(view.dom.querySelector(".cm-heading-rename")).toBeNull();

    // A change with no user event (a teammate, via yCollab) is not ours to ask about.
    view.dispatch({ changes: { from: 3, to: 10, insert: "Risks" } });
    view.dispatch({ changes: { from: 3, to: 8, insert: "Perils" } });
    await flush();
    expect(view.dom.querySelector(".cm-heading-rename")).toBeNull();
    view.destroy();
  });
});
