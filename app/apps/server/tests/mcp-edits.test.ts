import { describe, expect, it } from "vitest";
import { EditError, findAnchor, foldForMatch, planEdits, planEditsDetailed, replacementOp } from "../src/mcp/service.js";
import { revisionOf } from "../src/mcp/doc-writer.js";
import { parseEdits } from "../src/mcp/tools.js";

/**
 * The pure half of #78: how `edit_note` turns anchors into ops, and how
 * `update_note` shrinks a whole-body replacement to the part that changed. No
 * database — these are the rules an agent's edit lives or dies by.
 */

function apply(text: string, ops: ReturnType<typeof planEdits>): string {
  for (const op of ops) {
    text = text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteLength);
  }
  return text;
}

describe("planEdits", () => {
  const note = "# Title\n\n- one\n- two\n- three\n";

  it("replaces, inserts before/after and deletes at unique anchors, in order", () => {
    const ops = planEdits(note, [
      { type: "replace", find: "- two", replace: "- 2" },
      { type: "insert_after", anchor: "- 2", text: "\n- 2.5" },
      { type: "insert_before", anchor: "- one", text: "- zero\n" },
      { type: "delete", find: "- three\n" },
    ]);
    expect(apply(note, ops)).toBe("# Title\n\n- zero\n- one\n- 2\n- 2.5\n");
  });

  it("refuses a missing anchor with nothing planned", () => {
    expect(() => planEdits(note, [{ type: "replace", find: "- four", replace: "x" }])).toThrow(
      EditError,
    );
    expect(() => planEdits(note, [{ type: "replace", find: "- four", replace: "x" }])).toThrow(
      /not found/,
    );
  });

  it("refuses an ambiguous anchor unless the edit says all", () => {
    expect(() => planEdits(note, [{ type: "delete", find: "- " }])).toThrow(/matches 3 times/);
    expect(() => planEdits(note, [{ type: "insert_after", anchor: "- ", text: "x" }])).toThrow(
      /matches 3 times/,
    );
    const ops = planEdits(note, [{ type: "replace", find: "- ", replace: "* ", all: true }]);
    expect(apply(note, ops)).toBe("# Title\n\n* one\n* two\n* three\n");
  });

  it("a later edit sees the text as left by an earlier one", () => {
    // "- two" only exists after the first replace; without in-order semantics
    // the second edit would be refused.
    const ops = planEdits("- 2\n", [
      { type: "replace", find: "- 2", replace: "- two" },
      { type: "insert_after", anchor: "- two", text: "!" },
    ]);
    expect(apply("- 2\n", ops)).toBe("- two!\n");
  });

  it("rejects an empty anchor and an empty edit list", () => {
    expect(() => planEdits(note, [])).toThrow(EditError);
    expect(() => planEdits(note, [{ type: "delete", find: "" }])).toThrow(/non-empty/);
  });
});

describe("planEdits — tolerant anchors", () => {
  function fails(text: string, edits: Parameters<typeof planEdits>[1]): EditError {
    try {
      planEdits(text, edits);
    } catch (e) {
      return e as EditError;
    }
    throw new Error("expected a refusal");
  }

  it("carries a code on every refusal", () => {
    expect(fails("a b", [{ type: "delete", find: "zzz" }]).code).toBe("anchor_not_found");
    expect(fails("a a", [{ type: "delete", find: "a" }]).code).toBe("anchor_ambiguous");
    expect(fails("a", [{ type: "delete", find: "" }]).code).toBe("bad_edit");
  });

  it("matches a plain space against a non-breaking space and deletes the original bytes", () => {
    const note = "Price:\u00a0100 EUR\n";
    const ops = planEdits(note, [{ type: "replace", find: "Price: 100", replace: "Price: 90" }]);
    expect(apply(note, ops)).toBe("Price: 90 EUR\n");
  });

  it("matches across CRLF line endings without rewriting them elsewhere", () => {
    const note = "# T\r\n\r\n- one\r\n- two\r\n";
    const ops = planEdits(note, [{ type: "replace", find: "- one\n- two", replace: "- uno" }]);
    expect(apply(note, ops)).toBe("# T\r\n\r\n- uno\r\n");
  });

  it("straightens curly quotes and dashes and ignores zero-width characters", () => {
    const note = "She said \u201chello\u201d \u2014 twice\u200b.\n";
    const ops = planEdits(note, [{ type: "replace", find: 'said "hello" - twice.', replace: "waved." }]);
    expect(apply(note, ops)).toBe("She waved.\n");
  });

  it("ignores trailing spaces before a newline and collapsed double spaces", () => {
    const note = "alpha  beta   \ngamma\n";
    const ops = planEdits(note, [{ type: "insert_after", anchor: "alpha beta\n", text: "inserted\n" }]);
    expect(apply(note, ops)).toBe("alpha  beta   \ninserted\ngamma\n");
  });

  it("matches an NFD anchor against an NFC note and the other way round", () => {
    const nfc = "caf\u00e9 au lait\n";
    const nfd = "cafe\u0301 au lait\n";
    expect(apply(nfc, planEdits(nfc, [{ type: "replace", find: nfd.trim(), replace: "tea" }]))).toBe("tea\n");
    expect(apply(nfd, planEdits(nfd, [{ type: "replace", find: nfc.trim(), replace: "tea" }]))).toBe("tea\n");
  });

  it("prefers an exact match and never folds when one exists", () => {
    const note = "a\u00a0b\na b\n";
    const ops = planEdits(note, [{ type: "delete", find: "a b\n" }]);
    expect(apply(note, ops)).toBe("a\u00a0b\n");
  });

  it("still refuses an ambiguous anchor under folding", () => {
    const note = "alpha\u00a0beta\nalpha\u2003beta\n";
    expect(fails(note, [{ type: "delete", find: "alpha beta" }]).code).toBe("anchor_ambiguous");
  });

  it("never folds a bulk (all: true) edit: nothing exact, nothing written", () => {
    const note = "alpha\u00a0beta\nalpha\u2003beta\n";
    const err = fails(note, [{ type: "delete", find: "alpha beta\n", all: true }]);
    expect(err.code).toBe("anchor_not_found");
    expect(err.message).toContain("only exact text");
  });

  it("points at the first line when a multi-line anchor drifts after it", () => {
    const note = "intro\n## Plan\n- step one\n- step two\n";
    const err = fails(note, [{ type: "replace", find: "## Plan\n- step won", replace: "x" }]);
    expect(err.code).toBe("anchor_not_found");
    expect(err.message).toContain("line 2");
  });

  it("foldForMatch maps every folded index back to the original", () => {
    const s = "x\r\n\u00a0\u00a0y\u200bz  \n";
    const { folded, map } = foldForMatch(s);
    expect(folded).toBe("x\n yz\n");
    expect(map).toHaveLength(folded.length + 1);
    expect(map[map.length - 1]).toBe(s.length);
    expect(findAnchor(s, "yz\n").spans).toEqual([[5, s.length]]);
  });
});

describe("parseEdits", () => {
  it("accepts the anchor and text fields under either name", () => {
    expect(parseEdits([{ type: "insert_after", find: "a", replace: "b" }])).toEqual([
      { type: "insert_after", anchor: "a", text: "b" },
    ]);
    expect(parseEdits([{ type: "replace", anchor: "a", text: "b", all: true }])).toEqual([
      { type: "replace", find: "a", replace: "b", all: true },
    ]);
    expect(parseEdits([{ type: "delete", anchor: "a" }])).toEqual([{ type: "delete", find: "a" }]);
  });

  it("refuses a bad shape with the bad_edit code", () => {
    expect(() => parseEdits([{ type: "replace", find: "a" }])).toThrowError(/replace must be a string/);
    expect(() => parseEdits([])).toThrowError(/non-empty/);
  });
});

describe("replacementOp", () => {
  it("touches only the changed span of a whole-body replacement", () => {
    const before = "intro\n\npara one\n\noutro\n";
    const after = "intro\n\npara ONE, edited\n\noutro\n";
    const ops = replacementOp(before, after);
    expect(ops).toEqual([
      { index: "intro\n\npara ".length, deleteLength: 3, insert: "ONE, edited" },
    ]);
    expect(apply(before, ops)).toBe(after);
  });

  it("is empty for identical text and handles pure insertions/deletions at either end", () => {
    expect(replacementOp("same", "same")).toEqual([]);
    expect(apply("abc", replacementOp("abc", "abcXYZ"))).toBe("abcXYZ");
    expect(apply("abc", replacementOp("abc", "XYZabc"))).toBe("XYZabc");
    expect(apply("abcdef", replacementOp("abcdef", "abef"))).toBe("abef");
    expect(apply("aaa", replacementOp("aaa", "aa"))).toBe("aa");
    // A shared high surrogate stays inside the replaced span (#200).
    expect(replacementOp("a\u{1F600}b", "a\u{1F601}b")).toEqual([
      { index: 1, deleteLength: 2, insert: "\u{1F601}" },
    ]);
    expect(apply("", replacementOp("", "new"))).toBe("new");
    expect(apply("gone", replacementOp("gone", ""))).toBe("");
  });
});

describe("revisionOf", () => {
  it("is a stable content hash", () => {
    expect(revisionOf("x")).toBe(revisionOf("x"));
    expect(revisionOf("x")).not.toBe(revisionOf("y"));
    expect(revisionOf("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planEdits — the 2026-10-28 damage report (2ndBrain Improvements #1)", () => {
  function fails(text: string, edits: Parameters<typeof planEdits>[1]): EditError {
    try {
      planEdits(text, edits);
    } catch (e) {
      return e as EditError;
    }
    throw new Error("expected a refusal");
  }
  // The real shape: emojis earlier in the note, en dashes and plain hyphens
  // mixed, tables, bold list items. Replacing a dash that was no longer there
  // used to fold onto plain hyphens AND land one character off per emoji.
  const note = [
    "# 🏋️ HYROX Plan 💪",
    "",
    "- **Knie:** Studio-Tage – Google-Kalender",
    "",
    "| Übung | Sätze |",
    "|---|---|",
    "| Seil-RDL | 40-45 |",
    "",
  ].join("\n");

  it("foldForMatch maps a surrogate pair to two units (no drift after an emoji)", () => {
    const { folded, map } = foldForMatch("💪a");
    expect(folded).toBe("💪a");
    expect(map).toEqual([0, 1, 2, 3]);
  });

  it("an exact all: true replace changes only that character", () => {
    const plan = planEditsDetailed(note, [{ type: "replace", find: "–", replace: "-", all: true }]);
    expect(apply(note, plan.ops)).toBe(note.replace("–", "-"));
    expect(plan.applied).toBe(1);
    expect(plan.reports).toEqual([{ edit: 1, type: "replace", matchMode: "exact", count: 1 }]);
  });

  it("replacing a dash that is no longer there writes NOTHING and says so", () => {
    const cleaned = note.replace("–", "-");
    const err = fails(cleaned, [{ type: "replace", find: "–", replace: "-", all: true }]);
    expect(err.code).toBe("anchor_not_found");
    // Single, short and punctuation-only anchors never fold either.
    expect(fails(cleaned, [{ type: "replace", find: "—", replace: "-" }]).code).toBe("anchor_not_found");
  });

  it("a fuzzy match is reported, with the original text it hit, and never splits a word", () => {
    const plan = planEditsDetailed(note, [{ type: "replace", find: "Studio-Tage - Google", replace: "Studio-Tage: Google" }]);
    expect(apply(note, plan.ops)).toContain("Studio-Tage: Google-Kalender");
    expect(plan.reports[0]).toMatchObject({ matchMode: "fuzzy", count: 1, matches: [{ line: 3, original: "Studio-Tage – Google" }] });
    // "tudio-Tage – Goo" would only match inside words: refused.
    expect(fails(note, [{ type: "replace", find: "tudio-Tage - Goo", replace: "x" }]).code).toBe("anchor_not_found");
  });

  it("normalize_text swaps exact characters everywhere, longest key first", () => {
    const text = "a – b — c → d × e −1 ->";
    const plan = planEditsDetailed(text, [
      { type: "normalize_text", map: { "–": "-", "—": "-", "→": "->", "×": "x", "−": "-", "->": "→" } },
    ]);
    expect(apply(text, plan.ops)).toBe("a - b - c -> d x e -1 →");
    expect(plan.reports[0]).toMatchObject({ matchMode: "normalize", count: 6 });
    // Leaves the damage-report note intact apart from the one dash.
    expect(apply(note, planEdits(note, [{ type: "normalize_text", map: { "–": "-", "—": "-" } }]))).toBe(
      note.replace("–", "-"),
    );
  });

  it("replace_regex: groups, all, ambiguity and a hard time limit", () => {
    const text = "( a) ( b) (c)";
    expect(apply(text, planEdits(text, [{ type: "replace_regex", pattern: "\\(\\s+", replace: "(", all: true }]))).toBe(
      "(a) (b) (c)",
    );
    expect(apply("x=1, y=2", planEdits("x=1, y=2", [{ type: "replace_regex", pattern: "(?<k>y)=(\\d)", replace: "$<k>:$2$$" }]))).toBe(
      "x=1, y:2$",
    );
    expect(fails(text, [{ type: "replace_regex", pattern: "\\(", replace: "[" }]).code).toBe("anchor_ambiguous");
    expect(fails(text, [{ type: "replace_regex", pattern: "zzz", replace: "" }]).code).toBe("anchor_not_found");
    expect(fails(text, [{ type: "replace_regex", pattern: "(", replace: "" }]).code).toBe("bad_regex");
    expect(fails(text, [{ type: "replace_regex", pattern: "a", flags: "g", replace: "" }]).code).toBe("bad_regex");
    const slow = Date.now();
    expect(fails("a".repeat(40) + "b", [{ type: "replace_regex", pattern: "^(a+)+$", replace: "" }]).code).toBe("bad_regex");
    expect(Date.now() - slow).toBeLessThan(5000);
  });

  it("previews each change with context for a dry run", () => {
    const plan = planEditsDetailed(note, [{ type: "replace", find: "40-45", replace: "40–45" }]);
    expect(plan.previews).toEqual([{ edit: 1, line: 7, before: expect.stringContaining("| Seil-RDL | 40-45 |"), after: expect.stringContaining("| Seil-RDL | 40–45 |") }]);
  });
});
