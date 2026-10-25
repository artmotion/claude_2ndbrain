// @vitest-environment jsdom
//
// `[[Note#Heading]]` / `[[Note#^id]]`: the two-stage completion, block ids,
// step-out, decorations and the anchor jump (spec: docs/specs/06-block-links.md).

import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { IndexedAnchor, NoteTitle } from "../ipc";
import { revealAnchor } from "./anchorReveal";
import { createEditorState } from "./index";
import { type LinkHost, type LinkedNote, wikilinkCompletions, wikilinkTitlesChanged } from "./wikilinks";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

const TITLES: NoteTitle[] = [
  { id: "p", path: "Projects/Plan.md", title: "Plan" },
  { id: "q", path: "Archive/Plan.md", title: "Old plan" },
  { id: "i", path: "Inbox.md", title: "Inbox" },
  { id: "s", path: "Self.md", title: "Self" },
];

const PLAN = "# Plan\n\n## Goals\n\nShip it ^ship1\n\n## Risks\n\n- latency spikes\n- cost\n";

function host(overrides: Partial<LinkHost> = {}, notes: Record<string, LinkedNote> = {}): LinkHost {
  return {
    selfPath: "Self.md",
    loadNote: async (target) => notes[target.toLowerCase()] ?? null,
    addBlockId: async () => true,
    indexedAnchors: () => undefined,
    ...overrides,
  };
}

function mount(doc: string, links?: LinkHost, cursor = doc.length, onNavigate = (_t: string) => {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = createEditorState({ doc, getTitles: () => TITLES, onNavigate, links } as never);
  const view = new EditorView({ state, parent });
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

async function complete(view: EditorView, links?: LinkHost): Promise<CompletionResult | null> {
  const source = wikilinkCompletions({ getTitles: () => TITLES, onNavigate: () => {}, links });
  return source(new CompletionContext(view.state, view.state.selection.main.head, false));
}

function apply(view: EditorView, result: CompletionResult, option: Completion) {
  const fn = option.apply as (v: EditorView, c: Completion, f: number, t: number) => void;
  fn(view, option, result.from, view.state.selection.main.head);
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

describe("stage A: notes", () => {
  it("offers notes by name and folder, full path for a shared name", async () => {
    const view = mount("See [[pla");
    const r = await complete(view);
    expect(labels(r)).toEqual(["Plan", "Plan"]);
    expect(r!.options.map((o) => o.detail)).toEqual(["Archive · Old plan", "Projects"]);
    apply(view, r!, r!.options[1]!);
    // Shared stem → full path; the caret stays INSIDE, before the `]]`.
    expect(view.state.doc.toString()).toBe("See [[Projects/Plan]]");
    expect(view.state.selection.main.head).toBe("See [[Projects/Plan".length);
    view.destroy();
  });

  it("matches the folder part of the path too", async () => {
    const view = mount("[[archive");
    expect(labels(await complete(view))).toEqual(["Plan"]);
    view.destroy();
  });

  it("keeps an existing `]]` (closeBrackets) instead of adding another", async () => {
    const view = mount("[[inb]]", undefined, 5);
    const r = await complete(view);
    apply(view, r!, r!.options[0]!);
    expect(view.state.doc.toString()).toBe("[[Inbox]]");
    expect(view.state.selection.main.head).toBe(7);
    view.destroy();
  });

  it("stops once an alias starts", async () => {
    const view = mount("[[Inbox|lab");
    expect(await complete(view)).toBeNull();
    view.destroy();
  });
});

describe("stage B: headings and blocks of another note", () => {
  const notes = { "projects/plan": { path: "Projects/Plan.md", text: PLAN, editable: true } };

  it("lists headings then blocks, filtered by what follows `#`", async () => {
    const links = host({}, notes);
    const view = mount("[[Projects/Plan#", links);
    const r = await complete(view, links);
    expect(labels(r)).toEqual(["Plan", "Goals", "Risks", "Ship it", "latency spikes", "cost"]);
    expect(r!.from).toBe("[[Projects/Plan#".length);
    view.destroy();

    const v2 = mount("[[Projects/Plan#ri", links);
    expect(labels(await complete(v2, links))).toEqual(["Risks"]);
    v2.destroy();
  });

  it("`#^` lists blocks only", async () => {
    const links = host({}, notes);
    const view = mount("[[Projects/Plan#^", links);
    expect(labels(await complete(view, links))).toEqual(["Ship it", "latency spikes", "cost"]);
    view.destroy();
  });

  it("picking a heading finishes the link and steps past `]]`", async () => {
    const links = host({}, notes);
    const view = mount("x [[Projects/Plan#go]] y", links, "x [[Projects/Plan#go".length);
    const r = await complete(view, links);
    apply(view, r!, r!.options[0]!);
    expect(view.state.doc.toString()).toBe("x [[Projects/Plan#Goals]] y");
    expect(view.state.selection.main.head).toBe("x [[Projects/Plan#Goals]]".length);
    view.destroy();
  });

  it("picking an existing block writes its id", async () => {
    const links = host({}, notes);
    const view = mount("[[Projects/Plan#^ship", links);
    const r = await complete(view, links);
    apply(view, r!, r!.options[0]!);
    expect(view.state.doc.toString()).toBe("[[Projects/Plan#^ship1]]");
    view.destroy();
  });

  it("picking an id-less block mints an id and asks the host to append it", async () => {
    const addBlockId = vi.fn(async () => true);
    const links = host({ addBlockId }, notes);
    const view = mount("[[Projects/Plan#^lat", links);
    const r = await complete(view, links);
    apply(view, r!, r!.options[0]!);
    const doc = view.state.doc.toString();
    const id = /\^([a-z0-9]{6})\]\]$/.exec(doc)?.[1];
    expect(id).toBeTruthy();
    expect(addBlockId).toHaveBeenCalledWith(
      "Projects/Plan.md",
      expect.objectContaining({ preview: "latency spikes", line: 9 }),
      id,
    );
    view.destroy();
  });

  it("a failed block id is reported", async () => {
    const onBlockIdFailed = vi.fn();
    const links = host({ addBlockId: async () => false, onBlockIdFailed }, notes);
    const view = mount("[[Projects/Plan#^cost", links);
    const r = await complete(view, links);
    apply(view, r!, r!.options[0]!);
    await new Promise((res) => setTimeout(res, 0));
    expect(onBlockIdFailed).toHaveBeenCalledWith("Projects/Plan.md");
    view.destroy();
  });

  it("a read-only note offers no id-less blocks and says why", async () => {
    const links = host({}, { "projects/plan": { ...notes["projects/plan"], editable: false } });
    const view = mount("[[Projects/Plan#^", links);
    const r = await complete(view, links);
    expect(labels(r)).toEqual(["Ship it", "Read-only note: only blocks that already have an id can be linked"]);
    view.destroy();
  });

  it("an unknown note answers with one inert row", async () => {
    const links = host();
    const view = mount("[[Nowhere#", links);
    const r = await complete(view, links);
    expect(labels(r)).toEqual(["No note named “Nowhere”"]);
    expect(r!.options[0]!.type).toBe("info");
    view.destroy();
  });

  it("an empty note says so", async () => {
    const links = host({}, { inbox: { path: "Inbox.md", text: "", editable: true } });
    const view = mount("[[Inbox#", links);
    expect(labels(await complete(view, links))).toEqual(["This note is empty (or still syncing)"]);
    view.destroy();
  });
});

describe("stage B: this note", () => {
  it("`[[#` lists this note's headings and blocks, never the caret's own block", async () => {
    const doc = "# Top\n\nFirst para\n\n## Sub\n\nsee [[#";
    const view = mount(doc);
    expect(labels(await complete(view))).toEqual(["Top", "Sub", "First para"]);
    view.destroy();
  });

  it("`[[ThisNote#` is answered from the live doc too", async () => {
    const loadNote = vi.fn(async () => null);
    const links = host({ loadNote });
    const view = mount("## Local\n\n[[Self#", links);
    expect(labels(await complete(view, links))).toEqual(["Local"]);
    expect(loadNote).not.toHaveBeenCalled();
    view.destroy();
  });

  it("an id-less local block gets its id in the SAME transaction", async () => {
    const view = mount("A thought\n\nsee [[#^tho");
    const r = await complete(view);
    apply(view, r!, r!.options[0]!);
    const doc = view.state.doc.toString();
    const m = /^A thought \^([a-z0-9]{6})\n\nsee \[\[#\^([a-z0-9]{6})\]\]$/.exec(doc);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(view.state.selection.main.head).toBe(doc.length);
    view.destroy();
  });

  it("duplicate headings link with their parent", async () => {
    const view = mount("# A\n## Notes\n# B\n## Notes\n\n[[#");
    const r = await complete(view);
    const second = r!.options.filter((o) => o.label === "Notes")[1]!;
    apply(view, r!, second);
    expect(view.state.doc.toString().endsWith("[[#B#Notes]]")).toBe(true);
    view.destroy();
  });
});

describe("tag completion yields inside a link", () => {
  it("`[[#` is never offered as a tag", async () => {
    const { tagCompletions } = await import("./ofm");
    const source = tagCompletions({ getTags: () => [{ name: "work", count: 3 }] });
    const state = EditorState.create({ doc: "[[#" });
    expect(source(new CompletionContext(state, 3, false))).toBeNull();
    const plain = EditorState.create({ doc: "see #" });
    expect(source(new CompletionContext(plain, 5, false))).not.toBeNull();
  });
});

describe("stepping out of a link", () => {
  it("`]` before `]]` jumps past both", () => {
    const view = mount("[[Inbox]] tail", undefined, 7);
    view.contentDOM.focus();
    const handled = view.state.facet(EditorView.inputHandler).some((h) =>
      h(view, 7, 7, "]", () => view.state.update({ changes: { from: 7, insert: "]" } })),
    );
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("[[Inbox]] tail");
    expect(view.state.selection.main.head).toBe(9);
    view.destroy();
  });
});

describe("decorations", () => {
  const linkEl = (view: EditorView, text: string) =>
    Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-wikilink")).find((el) =>
      el.textContent?.includes(text),
    );

  it("a local link to a missing heading is marked, an existing one is not", () => {
    const view = mount("## Here\n\n[[#Here]] and [[#Gone]]\n", undefined, 0);
    expect(linkEl(view, "Here")!.classList.contains("cm-wikilink-anchor-missing")).toBe(false);
    expect(linkEl(view, "Gone")!.classList.contains("cm-wikilink-anchor-missing")).toBe(true);
    expect(linkEl(view, "Gone")!.classList.contains("cm-wikilink-unresolved")).toBe(false);
    view.destroy();
  });

  it("another note's anchors come from the index cache; a block shows its words", () => {
    let indexed: IndexedAnchor[] | undefined;
    const links = host({ indexedAnchors: () => indexed });
    const view = mount("[[Inbox#Today]] [[Inbox#^b1]]\n", links, 0);
    // Not loaded yet: no verdict either way.
    expect(linkEl(view, "Today")!.classList.contains("cm-wikilink-anchor-missing")).toBe(false);
    indexed = [{ kind: "block", key: "b1", text: "Call the bank", level: 0, line: 3 }];
    view.dispatch({ effects: wikilinkTitlesChanged.of(null) });
    expect(linkEl(view, "Today")!.classList.contains("cm-wikilink-anchor-missing")).toBe(true);
    expect(view.contentDOM.querySelector(".cm-wikilink-block")?.textContent).toBe("Call the bank");
    view.destroy();
  });

  it("` ^id` folds away off the active line", () => {
    const view = mount("Para ^abc123\n\nother", undefined, "Para ^abc123\n\nother".length);
    expect(view.contentDOM.textContent).not.toContain("^abc123");
    view.destroy();
  });

  it("a click hands the link with its subpath to navigation", () => {
    const calls: string[] = [];
    const view = mount("[[Inbox#Today|label]]", undefined, 0, (t) => calls.push(t));
    linkEl(view, "label")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(calls).toEqual(["Inbox#Today"]);
    view.destroy();
  });
});

describe("revealAnchor", () => {
  it("moves the caret to the heading and opens a fold hiding it", () => {
    const doc = "# A\n\ntext\n\n## B\n\nmore\n\n### C\n\ndeep ^blk\n";
    const view = mount(doc, undefined, 0);
    const bLineEnd = doc.indexOf("## B") + 4;
    view.dispatch({ effects: foldEffect.of({ from: bLineEnd, to: doc.length - 1 }) });
    expect(foldedRanges(view.state).size).toBe(1);
    expect(revealAnchor(view, { kind: "heading", path: ["C"] })).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("### C"));
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.dom.querySelector(".cm-anchor-flash")).not.toBeNull();
    expect(revealAnchor(view, { kind: "block", id: "blk" })).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("deep"));
    expect(revealAnchor(view, { kind: "heading", path: ["Nope"] })).toBe(false);
    view.destroy();
  });
});
