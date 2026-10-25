// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { type NoteEditDeps, editNoteText, minimalReplacement, withBlockId } from "./noteEdit";

function deps(files: Record<string, string>, overrides: Partial<NoteEditDeps> = {}): NoteEditDeps & {
  files: Record<string, string>;
} {
  return {
    files,
    liveView: () => null,
    readNote: async (p) => {
      if (!(p in files)) throw new Error("missing");
      return files[p]!;
    },
    writeNote: async (p, text, expectedSha) => {
      if (expectedSha !== `sha:${files[p]}`) return "stale";
      files[p] = text;
      return "written";
    },
    sha256: async (t) => `sha:${t}`,
    canEdit: async () => true,
    ...overrides,
  };
}

describe("minimalReplacement", () => {
  it("keeps the common prefix and suffix", () => {
    expect(minimalReplacement("abcXdef", "abcYYdef")).toEqual({ from: 3, to: 4, insert: "YY" });
    expect(minimalReplacement("same", "same")).toBeNull();
    expect(minimalReplacement("aa", "aaa")).toEqual({ from: 2, to: 2, insert: "a" });
  });
});

describe("editNoteText", () => {
  it("writes a closed note with a compare-and-swap on the bytes it planned against", async () => {
    const d = deps({ "A.md": "one" });
    expect(await editNoteText("A.md", (t) => `${t} two`, d)).toBe("written");
    expect(d.files["A.md"]).toBe("one two");
  });

  it("re-plans against the new bytes when the file moved on", async () => {
    const files: Record<string, string> = { "A.md": "v1" };
    let first = true;
    const d = deps(files, {
      writeNote: async (p, text, sha) => {
        if (first) {
          first = false;
          files[p] = "v2"; // someone else wrote in between
          return "stale";
        }
        if (sha !== `sha:${files[p]}`) return "stale";
        files[p] = text;
        return "written";
      },
    });
    expect(await editNoteText("A.md", (t) => `${t}!`, d)).toBe("written");
    expect(files["A.md"]).toBe("v2!");
  });

  it("refuses a read-only note and reports nothing to do", async () => {
    const d = deps({ "A.md": "x" }, { canEdit: async () => false });
    expect(await editNoteText("A.md", () => "y", d)).toBe("readonly");
    const d2 = deps({ "A.md": "x" });
    expect(await editNoteText("A.md", () => null, d2)).toBe("unchanged");
    expect(await editNoteText("Missing.md", () => "y", d2)).toBe("failed");
  });

  it("an open note is edited through ONE editor transaction, never the file", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "hello world" }) });
    const writeNote = vi.fn();
    const d = deps({}, { liveView: () => view, writeNote });
    expect(await editNoteText("A.md", (t) => t.replace("world", "there"), d)).toBe("written");
    expect(view.state.doc.toString()).toBe("hello there");
    expect(writeNote).not.toHaveBeenCalled();
    const ro = new EditorView({ state: EditorState.create({ doc: "x", extensions: EditorState.readOnly.of(true) }) });
    expect(await editNoteText("B.md", () => "y", deps({}, { liveView: () => ro }))).toBe("readonly");
    view.destroy();
    ro.destroy();
  });
});

describe("withBlockId", () => {
  const text = "# T\n\nfirst para\n\n- item a\n- item b\n";

  it("appends the id to the block found by line and preview", () => {
    expect(withBlockId(text, { line: 6, preview: "item b" }, "abc123")).toBe(
      "# T\n\nfirst para\n\n- item a\n- item b ^abc123\n",
    );
  });

  it("finds a block that moved by its unique preview", () => {
    const moved = `intro\n\n${text}`;
    expect(withBlockId(moved, { line: 3, preview: "first para" }, "x1")).toContain("first para ^x1");
  });

  it("refuses a vanished block or an id already in use", () => {
    expect(withBlockId(text, { line: 3, preview: "gone" }, "x1")).toBeNull();
    expect(withBlockId("p ^x1\n\nq\n", { line: 3, preview: "q" }, "x1")).toBeNull();
  });
});
