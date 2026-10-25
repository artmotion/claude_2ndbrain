import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/anchors.json";
import {
  extractAnchors,
  findAnchor,
  formatSubpath,
  headingLinkText,
  headingPath,
  newBlockId,
  normalizeHeading,
  parseWikilinkInner,
  sectionRange,
} from "./anchors";

describe("extractAnchors — the shared fixture (Rust and server run it too)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const a = extractAnchors(c.text);
      expect(a.headings.map((h) => ({ level: h.level, text: h.text, line: h.line }))).toEqual(c.headings);
      expect(a.blocks.map((b) => ({ id: b.id, line: b.line }))).toEqual(c.blocks);
      expect(a.candidates.map((b) => b.line)).toEqual(c.candidates);
    });
  }
});

describe("extractAnchors — offsets and sections", () => {
  const text = "# A\nintro\n## B\nb body\n### C\nc body\n## D\nd body\n";

  it("ends a section at the next same-or-higher heading", () => {
    const { headings } = extractAnchors(text);
    const [a, b, c, d] = headings;
    expect(text.slice(b!.from, b!.sectionEnd)).toBe("## B\nb body\n### C\nc body\n");
    expect(text.slice(c!.from, c!.sectionEnd)).toBe("### C\nc body\n");
    expect(a!.sectionEnd).toBe(text.length);
    expect(d!.sectionEnd).toBe(text.length);
    expect(c!.parents).toEqual(["A", "B"]);
  });

  it("sectionRange splits heading line from body", () => {
    const { headings } = extractAnchors(text);
    const r = sectionRange(text, headings[1]!);
    expect(text.slice(r.bodyFrom, r.to)).toBe("b body\n### C\nc body\n");
  });

  it("a candidate inserts its id after the last line, before trailing spaces", () => {
    const t = "- one\n- two  \n";
    const { candidates } = extractAnchors(t);
    expect(candidates[1]!.insertAt).toBe(t.indexOf("two") + 3);
    expect(candidates[1]!.preview).toBe("two");
  });

  it("previews strip list, task and quote markers", () => {
    const { candidates, blocks } = extractAnchors("- [ ] buy milk\n\n> quoted words ^q1\n");
    expect(candidates[0]!.preview).toBe("buy milk");
    expect(blocks[0]!.preview).toBe("quoted words");
  });
});

describe("parseWikilinkInner", () => {
  it("splits target, heading path, block and alias", () => {
    expect(parseWikilinkInner("Note")).toEqual({ target: "Note", subpath: null, alias: null });
    expect(parseWikilinkInner("Note#H")).toEqual({
      target: "Note",
      subpath: { kind: "heading", path: ["H"] },
      alias: null,
    });
    expect(parseWikilinkInner("Note#A#B|label")).toEqual({
      target: "Note",
      subpath: { kind: "heading", path: ["A", "B"] },
      alias: "label",
    });
    expect(parseWikilinkInner("Note#^ab12")).toEqual({
      target: "Note",
      subpath: { kind: "block", id: "ab12" },
      alias: null,
    });
    expect(parseWikilinkInner("#Local")).toEqual({
      target: "",
      subpath: { kind: "heading", path: ["Local"] },
      alias: null,
    });
    expect(parseWikilinkInner("Note#").subpath).toBeNull();
    expect(parseWikilinkInner("Note#^bad id").subpath).toBeNull();
  });

  it("formatSubpath round-trips", () => {
    expect(formatSubpath({ kind: "heading", path: ["A", "B"] })).toBe("#A#B");
    expect(formatSubpath({ kind: "block", id: "x1" })).toBe("#^x1");
  });
});

describe("findAnchor", () => {
  const anchors = extractAnchors(
    "# Projekt\n## Ziele\n# Archiv\n## Ziele\n\nEin Absatz ^abc123\n## A: B\n",
  );

  it("matches headings case- and punctuation-insensitively", () => {
    expect(findAnchor(anchors, { kind: "heading", path: ["projekt"] })?.line).toBe(1);
    expect(findAnchor(anchors, { kind: "heading", path: ["A B"] })?.line).toBe(7);
    expect(findAnchor(anchors, { kind: "heading", path: ["a: b"] })?.line).toBe(7);
  });

  it("disambiguates duplicate headings by their parents", () => {
    expect(findAnchor(anchors, { kind: "heading", path: ["Ziele"] })?.line).toBe(2);
    expect(findAnchor(anchors, { kind: "heading", path: ["Archiv", "Ziele"] })?.line).toBe(4);
  });

  it("finds a block id case-insensitively, and nothing for a missing one", () => {
    expect(findAnchor(anchors, { kind: "block", id: "ABC123" })?.line).toBe(6);
    expect(findAnchor(anchors, { kind: "block", id: "nope" })).toBeNull();
    expect(findAnchor(anchors, { kind: "heading", path: ["Missing"] })).toBeNull();
  });

  it("headingPath adds parents only when the text alone is ambiguous", () => {
    const [, ziele1, , ziele2, ab] = anchors.headings;
    expect(headingPath(anchors.headings, ziele1!)).toEqual(["Ziele"]);
    expect(headingPath(anchors.headings, ziele2!)).toEqual(["Archiv", "Ziele"]);
    expect(headingPath(anchors.headings, ab!)).toEqual(["A B"]);
  });
});

describe("heading text helpers and ids", () => {
  it("normalizes and sanitizes", () => {
    expect(normalizeHeading("  Über  die | Brücke ")).toBe("über die brücke");
    expect(headingLinkText("Q3: [[Plan]] #1 ^x")).toBe("Q3 Plan 1 x");
  });

  it("newBlockId avoids taken ids", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.99, 0, 0, 0, 0, 0];
    let i = 0;
    const id = newBlockId(["AAAAAA"], () => seq[i++]!);
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(id).not.toBe("aaaaaa");
  });
});
