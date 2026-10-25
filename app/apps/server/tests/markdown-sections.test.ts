import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractAnchors, renameHeadingLinks } from "../src/markdown/sections.js";
import {
  SectionError,
  outline,
  planAddBlockId,
  planCreateSection,
  planDeleteSection,
  planUpdateSection,
  readSection,
  parseSectionRef,
} from "../src/markdown/section-ops.js";

// The ONE anchor contract, shared with the desktop editor and the Rust index.
const fixturePath = fileURLToPath(
  new URL("../../desktop/src/lib/links/__fixtures__/anchors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  cases: Array<{
    name: string;
    text: string;
    headings: Array<{ level: number; text: string; line: number }>;
    blocks: Array<{ id: string; line: number }>;
    candidates: number[];
  }>;
};

describe("sections.ts — the shared anchor fixture", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const a = extractAnchors(c.text);
      expect(a.headings.map((h) => ({ level: h.level, text: h.text, line: h.line }))).toEqual(c.headings);
      expect(a.blocks.map((b) => ({ id: b.id, line: b.line }))).toEqual(c.blocks);
      expect(a.candidates.map((b) => b.line)).toEqual(c.candidates);
    });
  }

  it("is the same parser as the desktop's (shared code below the header)", () => {
    const desktop = readFileSync(
      fileURLToPath(new URL("../../desktop/src/lib/links/anchors.ts", import.meta.url)),
      "utf8",
    );
    const server = readFileSync(fileURLToPath(new URL("../src/markdown/sections.ts", import.meta.url)), "utf8");
    const body = (s: string) => s.slice(s.indexOf("export interface HeadingAnchor"));
    expect(body(server)).toBe(body(desktop));
  });
});

const NOTE = "# Plan\n\nIntro.\n\n## Goals\n\nShip it ^ship1\n\n### Later\n\nMaybe.\n\n## Risks\n\n- cost\n";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof SectionError ? e.code : "other";
  }
  return null;
};

describe("section refs and reads", () => {
  it("parses headings, paths and block ids, with or without a leading #", () => {
    expect(parseSectionRef("Goals")).toEqual({ kind: "heading", path: ["Goals"] });
    expect(parseSectionRef("#Plan#Goals")).toEqual({ kind: "heading", path: ["Plan", "Goals"] });
    expect(parseSectionRef("#^ship1")).toEqual({ kind: "block", id: "ship1" });
    expect(code(() => parseSectionRef("#"))).toBe("bad_section");
  });

  it("reads one section with its subsections, or one block", () => {
    expect(readSection(NOTE, parseSectionRef("Goals"))).toBe("## Goals\n\nShip it ^ship1\n\n### Later\n\nMaybe.\n\n");
    expect(readSection(NOTE, parseSectionRef("^ship1"))).toBe("Ship it ^ship1");
    expect(code(() => readSection(NOTE, parseSectionRef("Nope")))).toBe("section_not_found");
  });

  it("the outline names every heading and block", () => {
    const o = outline(NOTE);
    expect(o.headings.map((h) => [h.level, h.path, h.link])).toEqual([
      [1, "Plan", "#Plan"],
      [2, "Goals", "#Goals"],
      [3, "Later", "#Later"],
      [2, "Risks", "#Risks"],
    ]);
    expect(o.blocks).toEqual([{ id: "ship1", line: 7, preview: "Ship it", link: "#^ship1" }]);
  });

  it("refuses a bare name two headings share, and accepts a path", () => {
    const twins = "# A\n## Notes\nx\n# B\n## Notes\ny\n";
    expect(code(() => readSection(twins, parseSectionRef("Notes")))).toBe("section_ambiguous");
    expect(readSection(twins, parseSectionRef("B#Notes"))).toBe("## Notes\ny\n");
  });
});

describe("planCreateSection", () => {
  it("appends at the end as H2 under an H1 title", () => {
    const r = planCreateSection(NOTE, { heading: "Next steps", content: "- call Ana" });
    expect(r.text).toBe(`${NOTE}\n## Next steps\n\n- call Ana\n`);
    expect(r.path).toBe("Next steps");
  });

  it("nests under a parent (one level deeper) or follows a sibling", () => {
    const nested = planCreateSection(NOTE, { heading: "Soon", parent: "Goals" });
    expect(nested.text).toContain("Maybe.\n\n### Soon\n\n## Risks");
    const after = planCreateSection(NOTE, { heading: "Budget", after: "Goals", content: "100k" });
    expect(after.text).toContain("Maybe.\n\n## Budget\n\n100k\n\n## Risks");
  });

  it("refuses a duplicate at the same place, but not elsewhere", () => {
    expect(code(() => planCreateSection(NOTE, { heading: "goals" }))).toBe("section_exists");
    expect(planCreateSection(NOTE, { heading: "Goals", parent: "Risks" }).text).toContain("### Goals");
    expect(code(() => planCreateSection(NOTE, { heading: "  " }))).toBe("bad_section");
    expect(code(() => planCreateSection(NOTE, { heading: "X", level: 9 }))).toBe("bad_section");
  });

  it("works on an empty note", () => {
    expect(planCreateSection("", { heading: "First", content: "Hi" }).text).toBe("## First\n\nHi\n");
  });
});

describe("planUpdateSection", () => {
  it("replaces the body up to the first subsection", () => {
    const r = planUpdateSection(NOTE, "Goals", { content: "Ship it twice" });
    expect(r.text).toBe(NOTE.replace("Ship it ^ship1\n\n", "Ship it twice\n\n"));
    expect(r.renamed).toBeNull();
  });

  it("can replace the subsections too", () => {
    const r = planUpdateSection(NOTE, "Goals", { content: "All new", includeSubsections: true });
    expect(r.text).toBe("# Plan\n\nIntro.\n\n## Goals\n\nAll new\n\n## Risks\n\n- cost\n");
  });

  it("renames and re-levels the heading, keeping the body", () => {
    const r = planUpdateSection(NOTE, "Risks", { heading: "Open risks", level: 3 });
    expect(r.text).toBe(NOTE.replace("## Risks", "### Open risks"));
    expect(r.renamed).toEqual({ from: "Risks", to: "Open risks" });
  });

  it("updates a block and keeps its id", () => {
    expect(planUpdateSection(NOTE, "^ship1", { content: "Ship it now" }).text).toContain("Ship it now ^ship1\n");
    expect(code(() => planUpdateSection(NOTE, "^ship1", { heading: "x" }))).toBe("bad_section");
    expect(code(() => planUpdateSection(NOTE, "Goals", {}))).toBe("bad_section");
  });
});

describe("planDeleteSection", () => {
  it("removes a section with its subsections and the blank line after it", () => {
    expect(planDeleteSection(NOTE, "Goals").text).toBe("# Plan\n\nIntro.\n\n## Risks\n\n- cost\n");
    expect(planDeleteSection(NOTE, "^ship1").text).toBe(NOTE.replace("Ship it ^ship1\n\n", ""));
  });
});

describe("planAddBlockId", () => {
  it("adds an id to the block holding the quoted text, once", () => {
    const r = planAddBlockId(NOTE, "Maybe", "maybe1");
    expect(r).toMatchObject({ id: "maybe1", created: true });
    expect(r.text).toContain("Maybe. ^maybe1\n");
    const again = planAddBlockId(r.text, "Maybe");
    expect(again).toMatchObject({ id: "maybe1", created: false, text: r.text });
  });

  it("refuses ambiguous, missing or taken", () => {
    expect(code(() => planAddBlockId("a x\n\nb x\n", "x"))).toBe("section_ambiguous");
    expect(code(() => planAddBlockId(NOTE, "absent"))).toBe("section_not_found");
    expect(code(() => planAddBlockId(NOTE, "Maybe", "ship1"))).toBe("section_exists");
  });
});

describe("renameHeadingLinks", () => {
  it("rewrites links to the renamed heading, keeping aliases, skipping code and other notes", () => {
    const text = [
      "[[Plan#Risks]] and [[plan#risks|see risks]] and [[Plan#Risks#Sub]]",
      "[[Other#Risks]] [[Plan#^ship1]] [[#Risks]]",
      "```",
      "[[Plan#Risks]]",
      "```",
    ].join("\n");
    const r = renameHeadingLinks(text, (t) => t.toLowerCase() === "plan", "Risks", "Open: risks");
    expect(r.count).toBe(3);
    expect(r.text.split("\n")[0]).toBe("[[Plan#Open risks]] and [[plan#Open risks|see risks]] and [[Plan#Open risks#Sub]]");
    expect(r.text.split("\n")[1]).toBe("[[Other#Risks]] [[Plan#^ship1]] [[#Risks]]");
    expect(r.text.split("\n")[3]).toBe("[[Plan#Risks]]");
  });

  it("does nothing when the name did not really change", () => {
    expect(renameHeadingLinks("[[P#A b]]", () => true, "A b", "a:  B").count).toBe(0);
  });
});
