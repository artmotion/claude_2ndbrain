// SPDX-License-Identifier: Apache-2.0
// Isolated HTTP tests: every database/auth dependency is mocked. No DB connection.
import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createHousekeeperRoutes } from "./housekeeper.js";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
const state = vi.hoisted(() => ({ user: true, member: true, permission: "edit", noteQueries: 0 }));
vi.mock("../session.js", () => ({ getSession: async () => state.user ? { userId: "u" } : null }));
vi.mock("../../permissions/lookup.js", () => ({ vaultOrg: async () => "org", orgRole: async () => state.member ? "member" : null }));
vi.mock("../../permissions/resolver.js", () => ({ effectivePermission: async () => state.permission }));
vi.mock("../../permissions/vault-docs.js", () => ({ listReadableDocsInVault: async () => new Set(["source", "target"]) }));
vi.mock("../../db/pool.js", () => ({ pool: { query: vi.fn(async (sql: string, args: unknown[]) => {
  state.noteQueries++;
  if (sql.includes("ANY")) return { rows: [{ id: "source", path: "Launch.md", title: "Launch" }, { id: "target", path: "Pricing strategy.md", title: "Pricing strategy" }] };
  if (args[1] !== "vault") return { rows: [] };
  return { rows: [{ rel_path: args[0] === "source" ? "Launch.md" : "Pricing strategy.md" }] };
}) } }));
const peekContent = vi.fn(async (_vault: string, id: string) => id === "source" ? "See [[Pricing]]" : "Pricing for launch");
const editContent = vi.fn();
const writer = { peekContent, editContent } as unknown as DocWriter;
const app = createHousekeeperRoutes(writer);
beforeEach(() => {
  Object.assign(state, { user: true, member: true, permission: "edit", noteQueries: 0 });
  vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
const request = (action = "status", body?: unknown, vault = "vault") => app.request(`/vaults/${vault}/housekeeper/${action}`, {
  method: action === "status" ? "GET" : "POST", headers: { "Content-Type": "application/json" },
  ...(body === undefined || action === "status" ? {} : { body: JSON.stringify({ ...body as object, provider: { name: "openrouter", apiKey: "sk-or-test-key-for-tests", mode: "decisions", model: "typesafe/jev-1.13" } }) }),
});
it("blocks unauthenticated callers and nonmembers before note reads", async () => {
  state.user = false; expect((await request()).status).toBe(401);
  state.user = true; state.member = false; expect((await request()).status).toBe(403);
  expect(state.noteQueries).toBe(0);
});
it("serves status through the optional module", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const res = await request(); expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ available: true, provider: "OpenRouter", model: "typesafe/jev-1.13" });
  expect(res.headers.get("cache-control")).toBe("no-store");
});
it("works without ee installed and refuses oversized requests", async () => {
  vi.stubEnv("HOUSEKEEPER_MODULE", "/does-not-exist/housekeeper.mjs");
  expect((await request()).status).toBe(503);
  expect((await request("suggest", { extra: "x".repeat(5000) })).status).toBe(413);
});
it("refuses forged proposals, missing consent, cross-vault sources and read-only notes", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  expect((await request("apply", { id: "forged" })).status).toBe(409);
  expect((await request("suggest", { docId: "source" })).status).toBe(400);
  expect((await request("suggest", { docId: "source", consent: true }, "other-vault")).status).toBe(404);
  state.permission = "view";
  expect((await request("suggest", { docId: "source", consent: true })).status).toBe(403);
  expect(peekContent).not.toHaveBeenCalled();
});
it("OpenRouter SDK serializes the real Jev Decisions request and validates its response", async () => {
  const moduleUrl = new URL("../../../housekeeper/provider.mjs", import.meta.url);
  const { chooseCandidate } = await import(moduleUrl.href);
  let observed: Request | undefined;
  const router = new OpenRouter({ apiKey: "test-key", retryConfig: { strategy: "none" }, httpClient: new HTTPClient({ fetcher: async input => {
    observed = input as Request;
    return Response.json({ model: "typesafe/jev-1.13", answers: { target: { type: "choice", choice: "c0", confidence: 0.99, probabilities: { c0: 0.99, none: 0.01 } } }, usage: { input_tokens: 100, output_tokens: 10 } });
  } }) });
  const result = await chooseCandidate(router, { mode: "decisions", model: "typesafe/jev-1.13" }, { passage: "hello" }, [{ id: "a", path: "a.md", title: "A", excerpt: "hello" }]);
  expect(result.candidateId).toBe("a");
  expect(observed!.url).toBe("https://openrouter.ai/api/alpha/decisions");
  expect(observed!.headers.get("authorization")).toBe("Bearer test-key");
  expect(await observed!.json()).toMatchObject({ model: "typesafe/jev-1.13", questions: { target: { type: "choice" } } });
});
it("OpenRouter SDK serializes the chat adapter's strict schema", async () => {
  const { chooseCandidate } = await import(new URL("../../../housekeeper/provider.mjs", import.meta.url).href);
  let payload: Record<string, unknown> = {};
  const router = new OpenRouter({ apiKey: "test-key", retryConfig: { strategy: "none" }, httpClient: new HTTPClient({ fetcher: async input => {
    payload = await (input as Request).json();
    return Response.json({ id: "test", object: "chat.completion", system_fingerprint: "test", created: 1, model: "test/chat", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"choice":"c0"}' } }] });
  } }) });
  expect((await chooseCandidate(router, { mode: "chat", model: "test/chat" }, {}, [{ id: "a", path: "a.md", title: "A", excerpt: "hello" }])).candidateId).toBe("a");
  expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
});
it("complete HTTP preview/apply uses the locked revision planner", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "typesafe/jev-1.13", answers: { target: { type: "choice", choice: "c0", confidence: 0.99 } }, usage: { input_tokens: 100, output_tokens: 10 } })));
  const preview = await request("suggest", { docId: "source", consent: true });
  expect(preview.status).toBe(200);
  const { suggestions } = await preview.json();
  expect(suggestions).toHaveLength(1);
  editContent.mockImplementation(async (_vault, _doc, planner) => {
    expect(() => planner("human edit")).toThrow("The note changed");
    expect(planner("See [[Pricing]]")).toEqual([{ index: 4, deleteLength: 11, insert: "[[Pricing strategy]]" }]);
    return { revision: createHash("sha256").update("See [[Pricing strategy]]").digest("hex") };
  });
  expect((await request("apply", { id: suggestions[0].id })).status).toBe(200);
  expect(editContent).toHaveBeenCalledWith("vault", "source", expect.any(Function), { userId: "u" });
});

it("inference requires a personal key even when a server key exists", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "server-key");
  const res = await app.request("/vaults/vault/housekeeper/diagnose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true }) });
  expect(res.status).toBe(400);
  expect(peekContent).not.toHaveBeenCalled();
});

it("local rename authorization requires live edit permission without returning note content", async () => {
  let res = await request("authorize", { docId: "source" });
  expect(res.status).toBe(200); expect(await res.json()).toEqual({ allowed: true });
  expect(peekContent).not.toHaveBeenCalled();
  expect((await request("authorize", { docId: "source", path: "Moved.md" })).status).toBe(409);
  state.permission = "view";
  expect((await request("authorize", { docId: "source" })).status).toBe(403);
  state.permission = "edit";
  expect((await request("authorize", { docId: "source" }, "other-vault")).status).toBe(404);
});
