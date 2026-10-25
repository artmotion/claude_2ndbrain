import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedMember, seedOrg, seedShare, seedUser, seedVault } from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * The MCP section tools end to end: an AI reads a note's outline, creates and
 * changes sections, makes a block linkable, and a heading rename carries into
 * the links other notes hold — only where the caller may edit.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);
const mem = rec.docWriter;

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

const tokenFor = async (userId: string, orgId: string) =>
  (await createMcpToken({ userId, organizationId: orgId }, "sections")).token;

const PLAN = "# Plan\n\nIntro.\n\n## Goals\n\nShip it\n\n## Risks\n\n- cost\n";

describe("MCP section tools", () => {
  let owner: string;
  let org: string;
  let vault: string;
  let token: string;
  let planId: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await seedUser("owner@sections.test");
    org = await seedOrg("Sections", `sections-${Date.now()}`);
    await seedMember(org, owner, "owner");
    vault = await seedVault(org);
    token = await tokenFor(owner, org);
    planId = (await call(token, "create_note", { vaultId: vault, relPath: "Plan.md", content: PLAN })).data.docId;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("list_sections returns the outline with ready-made links", async () => {
    const r = await call(token, "list_sections", { docId: planId });
    expect(r.isError).toBe(false);
    expect(r.data.headings.map((h: any) => [h.level, h.path, h.link])).toEqual([
      [1, "Plan", "[[Plan#Plan]]"],
      [2, "Goals", "[[Plan#Goals]]"],
      [2, "Risks", "[[Plan#Risks]]"],
    ]);
    expect(r.data.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("read_note with a section returns only that section, with the whole note's revision", async () => {
    const full = await call(token, "read_note", { docId: planId });
    const part = await call(token, "read_note", { docId: planId, section: "Goals" });
    expect(part.data.content).toBe("## Goals\n\nShip it\n\n");
    expect(part.data.revision).toBe(full.data.revision);
    const missing = await call(token, "read_note", { docId: planId, section: "Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No heading "Nope".*Goals/);
  });

  it("create_section / update_section / delete_section edit the note in place", async () => {
    const created = await call(token, "create_section", {
      docId: planId,
      heading: "Next steps",
      content: "- call Ana",
      after: "Goals",
    });
    expect(created.isError).toBe(false);
    expect(created.data.link).toBe("[[Plan#Next steps]]");
    expect(mem.store.get(planId)).toContain("Ship it\n\n## Next steps\n\n- call Ana\n\n## Risks");

    const dup = await call(token, "create_section", { docId: planId, heading: "Next steps" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/already exists/);

    const upd = await call(token, "update_section", { docId: planId, section: "Goals", content: "Ship it twice" });
    expect(upd.isError).toBe(false);
    expect(mem.store.get(planId)).toContain("## Goals\n\nShip it twice\n\n## Next steps");

    const del = await call(token, "delete_section", { docId: planId, section: "Next steps" });
    expect(del.isError).toBe(false);
    expect(mem.store.get(planId)).not.toContain("Next steps");
  });

  it("a stale expectedRevision writes nothing", async () => {
    const read = await call(token, "list_sections", { docId: planId });
    await call(token, "append_note", { docId: planId, text: "\nmore\n" });
    const before = mem.store.get(planId);
    const r = await call(token, "create_section", {
      docId: planId,
      heading: "Late",
      expectedRevision: read.data.revision,
    });
    expect(r.isError).toBe(true);
    expect(mem.store.get(planId)).toBe(before);
  });

  it("add_block_id makes a block linkable, idempotently", async () => {
    const a = await call(token, "add_block_id", { docId: planId, text: "Ship it", id: "ship1" });
    expect(a.data).toMatchObject({ id: "ship1", created: true, link: "[[Plan#^ship1]]" });
    expect(mem.store.get(planId)).toContain("Ship it ^ship1\n");
    const b = await call(token, "add_block_id", { docId: planId, text: "Ship it" });
    expect(b.data).toMatchObject({ id: "ship1", created: false });
  });

  it("renaming a heading rewrites links to it here and in notes the caller can edit", async () => {
    const otherId = (
      await call(token, "create_note", {
        vaultId: vault,
        relPath: "Daily.md",
        content: "See [[Plan#Risks]] and [[Plan#Goals]].\n",
      })
    ).data.docId;
    // The wikilink graph is the index's job; the memory writer has no indexer.
    await pool.query("INSERT INTO note_links (vault_id, from_doc, to_title) VALUES ($1, $2, 'Plan')", [vault, otherId]);
    await call(token, "append_note", { docId: planId, text: "\nBack to [[#Risks]].\n" });

    const r = await call(token, "update_section", { docId: planId, section: "Risks", heading: "Open risks" });
    expect(r.isError).toBe(false);
    expect(r.data.renamed).toEqual({ from: "Risks", to: "Open risks" });
    expect(r.data.links.updated).toEqual([{ docId: otherId, links: 1 }]);
    expect(mem.store.get(otherId)).toBe("See [[Plan#Open risks]] and [[Plan#Goals]].\n");
    expect(mem.store.get(planId)).toContain("## Open risks");
    expect(mem.store.get(planId)).toContain("Back to [[#Open risks]].");
  });

  it("a linking note the caller cannot edit is reported, never changed", async () => {
    const member = await seedUser("member@sections.test");
    await seedMember(org, member, "member");
    const viewId = (
      await call(token, "create_note", { vaultId: vault, relPath: "Viewable.md", content: "[[Plan#Goals]]\n" })
    ).data.docId;
    const hiddenId = (
      await call(token, "create_note", { vaultId: vault, relPath: "Hidden.md", content: "[[Plan#Goals]]\n" })
    ).data.docId;
    // The member may edit Plan and only VIEW one of the two linking notes.
    await seedShare(org, "file", planId, member, "edit");
    await seedShare(org, "file", viewId, member, "view");
    await pool.query(
      "INSERT INTO note_links (vault_id, from_doc, to_title) VALUES ($1, $2, 'plan'), ($1, $3, 'Plan')",
      [vault, viewId, hiddenId],
    );
    const r = await call(await tokenFor(member, org), "update_section", {
      docId: planId,
      section: "Goals",
      heading: "Aims",
    });
    expect(r.isError).toBe(false);
    expect(mem.store.get(planId)).toContain("## Aims");
    expect(r.data.links.updated).toEqual([]);
    const reasons = Object.fromEntries(r.data.links.skipped.map((x: any) => [x.docId, x.reason]));
    expect(reasons).toEqual({ [viewId]: "read-only", [hiddenId]: "no access" });
    expect(mem.store.get(viewId)).toBe("[[Plan#Goals]]\n");
    expect(mem.store.get(hiddenId)).toBe("[[Plan#Goals]]\n");
  });
});
