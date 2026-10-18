import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetAdminLoginThrottle } from "../src/http/routes/admin.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signIn, signUp } from "./helpers/auth.js";

const app = createApp(testAppDeps());
const PASSWORD = "admin-test-password-123";
const HOST = "server.test";

function post(path: string, form: Record<string, string>, cookie?: string, origin = `https://${HOST}`) {
  return app.request(path, {
    method: "POST",
    headers: {
      host: HOST,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
}

async function login(): Promise<string> {
  const res = await post("/admin/login", { password: PASSWORD });
  expect(res.status).toBe(303);
  const set = res.headers.get("set-cookie") ?? "";
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toMatch(/SameSite=Strict/i);
  return set.split(";")[0];
}

async function userId(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  return rows[0].id;
}

async function passwordSignIn(email: string, password: string) {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

describe("admin panel", () => {
  beforeEach(async () => {
    await resetDb();
    resetAdminLoginThrottle();
    process.env.ADMIN_PASSWORD = PASSWORD;
  });
  afterAll(async () => {
    delete process.env.ADMIN_PASSWORD;
    await pool.end();
  });

  it("is off (404) without a password of at least 12 characters", async () => {
    delete process.env.ADMIN_PASSWORD;
    expect((await app.request("/admin")).status).toBe(404);
    process.env.ADMIN_PASSWORD = "short";
    expect((await app.request("/admin")).status).toBe(404);
    expect((await post("/admin/login", { password: "short" })).status).toBe(404);
  });

  it("asks for the password, refuses a wrong one, throttles, and checks the origin", async () => {
    const page = await app.request("/admin", { headers: { host: HOST } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="password"');
    expect((await post("/admin/login", { password: "wrong" })).status).toBe(401);
    expect((await post("/admin/login", { password: PASSWORD }, undefined, "https://evil.example")).status).toBe(403);
    for (let i = 0; i < 4; i++) await post("/admin/login", { password: "wrong" });
    expect((await post("/admin/login", { password: PASSWORD })).status).toBe(429);
  });

  it("creates a user who can then sign in, and refuses a duplicate", async () => {
    const cookie = await login();
    const created = await post("/admin/users", { email: "Friend@Example.com", name: "Friend", password: "friend-pass-1" }, cookie);
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toMatch(/^\/admin\?ok=/);
    expect((await passwordSignIn("friend@example.com", "friend-pass-1")).status).toBe(200);

    const dup = await post("/admin/users", { email: "friend@example.com", password: "friend-pass-2" }, cookie);
    expect(decodeURIComponent(dup.headers.get("location") ?? "")).toMatch(/already exists/);
    const short = await post("/admin/users", { email: "x@example.com", password: "short" }, cookie);
    expect(decodeURIComponent(short.headers.get("location") ?? "")).toMatch(/at least 8/);

    const list = await app.request("/admin", { headers: { host: HOST, cookie } });
    expect(await list.text()).toContain("friend@example.com");
  });

  it("refuses actions without the session cookie", async () => {
    const res = await post("/admin/users", { email: "a@example.com", password: "password-123" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const { rows } = await pool.query(`SELECT 1 FROM "user" WHERE email = 'a@example.com'`);
    expect(rows).toHaveLength(0);
  });

  it("resets a password and signs the user out everywhere", async () => {
    const cookie = await login();
    const bob = await signUp("bob@example.com", "old-password-1");
    await post(`/admin/users/${bob.userId}/password`, { password: "new-password-1" }, cookie);
    expect((await app.request("/api/auth/get-session", { headers: authHeaders(bob) })).status).toBe(200);
    expect(await (await app.request("/api/auth/get-session", { headers: authHeaders(bob) })).json()).toBeNull();
    expect((await passwordSignIn("bob@example.com", "old-password-1")).status).toBe(401);
    expect((await passwordSignIn("bob@example.com", "new-password-1")).status).toBe(200);
  });

  it("disables (no sign-in, sessions gone) and re-enables an account", async () => {
    const cookie = await login();
    const carl = await signUp("carl@example.com", "carl-password-1");
    await post(`/admin/users/${carl.userId}/disable`, {}, cookie);
    expect(await (await app.request("/api/auth/get-session", { headers: authHeaders(carl) })).json()).toBeNull();
    expect((await passwordSignIn("carl@example.com", "carl-password-1")).status).toBe(403);
    await post(`/admin/users/${carl.userId}/enable`, {}, cookie);
    expect((await passwordSignIn("carl@example.com", "carl-password-1")).status).toBe(200);
  });

  it("adds a user to a vault and deletes accounts, but never a vault owner", async () => {
    const cookie = await login();
    const owner = await signUp("owner@example.com");
    const org = await createOrg(owner, "Family", "family-admin");
    const dana = await signUp("dana@example.com");

    await post(`/admin/users/${dana.userId}/vaults`, { orgId: org.id, role: "member" }, cookie);
    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, dana.userId],
    );
    expect(rows).toEqual([{ role: "member" }]);
    const again = await post(`/admin/users/${dana.userId}/vaults`, { orgId: org.id, role: "member" }, cookie);
    expect(decodeURIComponent(again.headers.get("location") ?? "")).toMatch(/already in that vault/);

    const ownerDel = await post(`/admin/users/${owner.userId}/delete`, { confirm: "yes" }, cookie);
    expect(decodeURIComponent(ownerDel.headers.get("location") ?? "")).toMatch(/owns "Family"/);
    const unconfirmed = await post(`/admin/users/${dana.userId}/delete`, {}, cookie);
    expect(decodeURIComponent(unconfirmed.headers.get("location") ?? "")).toMatch(/really delete/);

    await post(`/admin/users/${dana.userId}/delete`, { confirm: "yes" }, cookie);
    const gone = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [dana.userId]);
    expect(gone.rows).toHaveLength(0);
    const memberRows = await pool.query(`SELECT 1 FROM member WHERE "userId" = $1`, [dana.userId]);
    expect(memberRows.rows).toHaveLength(0);
    expect((await signIn("owner@example.com")).token).toBeTruthy();
    expect(await userId("owner@example.com")).toBe(owner.userId);
  });
});
