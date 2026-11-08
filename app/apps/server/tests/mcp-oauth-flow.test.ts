import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { createOrg, signUp } from "./helpers/auth.js";
import { seedVault } from "./helpers/seed.js";

/**
 * The MCP OAuth connector flow end to end, the way a Claude custom connector
 * drives it: discovery → dynamic client registration → sign in → authorize →
 * the vault picker → code → PKCE token exchange → POST /api/mcp → refresh.
 *
 * Every URL comes from the discovery documents, never from a hard-coded path,
 * so the test pins BEHAVIOUR (what a standards-following client experiences),
 * not one plugin's route layout.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);
const ORIGIN = config.betterAuthUrl.replace(/\/+$/, "");
const REDIRECT = "http://127.0.0.1:53682/callback";

/** A tiny browser: one cookie jar, manual redirects. */
class Browser {
  cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    if (init.method && init.method !== "GET") headers.set("origin", ORIGIN);
    const res = await app.fetch(new Request(new URL(url, ORIGIN), { ...init, headers, redirect: "manual" }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  /** Follow redirects that stay on the server; stop at the client's redirect_uri. */
  async follow(url: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
    let current = new URL(url, ORIGIN).toString();
    let res = await this.fetch(current, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      const next = new URL(res.headers.get("location")!, current).toString();
      if (next.startsWith(REDIRECT)) return { res, url: next };
      current = next;
      res = await this.fetch(current);
    }
    return { res, url: current };
  }
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function discovery() {
  const prm = (await (await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`))).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  const as = (await (await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    code_challenge_methods_supported?: string[];
  };
  return { prm, as };
}

async function register(as: { registration_endpoint: string }, name = "Claude") {
  const res = await app.fetch(
    new Request(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect([200, 201]).toContain(res.status);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

async function signInBrowser(email: string): Promise<Browser> {
  const b = new Browser();
  const res = await b.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password12345" }),
  });
  expect(res.status).toBe(200);
  return b;
}

/** Authorize → (consent page) → Allow with `orgId`. Returns the code. */
async function authorizeAndConsent(
  b: Browser,
  as: { authorization_endpoint: string },
  resource: string,
  clientId: string,
  challenge: string,
  orgId: string | null,
  decision: "allow" | "deny" = "allow",
): Promise<{ code: string | null; error: string | null; state: string | null; consentHtml: string }> {
  const authorize = new URL(as.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();
  const { res, url } = await b.follow(authorize.toString());
  // The flow must stop on OUR consent page (the vault picker), never hand out
  // a code straight away (issue #211).
  expect(url).not.toContain(REDIRECT);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('name="organization_id"');
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    form.set(m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
  }
  if (orgId) form.set("organization_id", orgId);
  form.set("decision", decision);
  const action = /<form method="POST" action="([^"]+)"/.exec(html)![1]!;
  const done = await b.follow(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  expect(done.url.startsWith(REDIRECT)).toBe(true);
  const cb = new URL(done.url);
  return {
    code: cb.searchParams.get("code"),
    error: cb.searchParams.get("error"),
    state: cb.searchParams.get("state"),
    consentHtml: html,
  };
}

async function token(as: { token_endpoint: string }, params: Record<string, string>) {
  const res = await app.fetch(
    new Request(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function mcp(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = res.status === 200 ? ((await res.json()) as any) : null;
  return { status: res.status, www: res.headers.get("www-authenticate"), data: body?.result?.structuredContent };
}

describe("MCP OAuth connector flow (end to end)", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("discovery names the MCP resource, PKCE S256 and a registration endpoint", async () => {
    const { prm, as } = await discovery();
    expect(prm.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(prm.authorization_servers.length).toBeGreaterThan(0);
    expect(as.authorization_endpoint).toMatch(/^http/);
    expect(as.token_endpoint).toMatch(/^http/);
    expect(as.registration_endpoint).toMatch(/^http/);
    expect(as.code_challenge_methods_supported).toContain("S256");
  });

  it("an unauthenticated MCP call answers 401 with the resource-metadata pointer", async () => {
    const r = await mcp("not-a-token", "list_vaults");
    expect(r.status).toBe(401);
    expect(r.www).toContain("resource_metadata=");
  });

  it("register → sign in → authorize → pick a vault → token → MCP works in THAT vault → refresh", async () => {
    const user = await signUp("connector@oauth.test");
    const a = await createOrg(user, "Alpha", `alpha-${Date.now()}`);
    const b = await createOrg(user, "Beta", `beta-${Date.now()}`);
    const alphaNotes = await seedVault(a.id, "Alpha notes");
    const betaNotes = await seedVault(b.id, "Beta notes");
    const { prm, as } = await discovery();
    const clientId = await register(as);
    const browser = await signInBrowser(user.email);
    const { verifier, challenge } = pkce();

    const consent = await authorizeAndConsent(browser, as, prm.resource, clientId, challenge, b.id);
    // Both vaults are offered; the client's name is shown.
    expect(consent.consentHtml).toContain("Alpha");
    expect(consent.consentHtml).toContain("Beta");
    expect(consent.consentHtml).toContain("Claude");
    expect(consent.state).toBe("st-123");
    expect(consent.code).toBeTruthy();

    // A wrong verifier is refused (PKCE).
    const bad = await token(as, {
      grant_type: "authorization_code",
      code: consent.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: pkce().verifier,
      resource: prm.resource,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    // A fresh authorization for the real exchange (the failed attempt may have
    // burned the code, as it should).
    const again = await authorizeAndConsent(browser, as, prm.resource, clientId, challenge, b.id);
    const ok = await token(as, {
      grant_type: "authorization_code",
      code: again.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: prm.resource,
    });
    expect(ok.status).toBe(200);
    const access = ok.body.access_token as string;
    const refresh = ok.body.refresh_token as string;
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();

    // The token works, and only in the vault picked on the consent screen.
    const vaults = await mcp(access, "list_vaults");
    expect(vaults.status).toBe(200);
    expect(vaults.data).toEqual({ results: [{ vaultId: betaNotes, name: "Beta notes" }] });
    expect(JSON.stringify(vaults.data)).not.toContain(alphaNotes);

    // Refresh yields a working token.
    const refreshed = await token(as, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: prm.resource,
    });
    expect(refreshed.status).toBe(200);
    expect((await mcp(refreshed.body.access_token as string, "list_vaults")).status).toBe(200);

    // Losing membership of the bound vault cuts the token off at once.
    await pool.query(`DELETE FROM member WHERE "userId" = $1 AND "organizationId" = $2`, [user.userId, b.id]);
    expect((await mcp(refreshed.body.access_token as string, "list_vaults")).status).toBe(401);
  });

  it("Deny returns access_denied to the client and issues no code", async () => {
    const user = await signUp("deny@oauth.test");
    const org = await createOrg(user, "Solo", `solo-${Date.now()}`);
    const { prm, as } = await discovery();
    const clientId = await register(as);
    const browser = await signInBrowser(user.email);
    const r = await authorizeAndConsent(browser, as, prm.resource, clientId, pkce().challenge, org.id, "deny");
    expect(r.code).toBeNull();
    expect(r.error).toBe("access_denied");
  });

  it("Allow with a vault the user does not belong to is refused and binds nothing", async () => {
    const user = await signUp("intruder@oauth.test");
    await createOrg(user, "Mine", `mine-${Date.now()}`);
    const other = await signUp("victim@oauth.test");
    const theirs = await createOrg(other, "Theirs", `theirs-${Date.now()}`);
    const { prm, as } = await discovery();
    const clientId = await register(as);
    const browser = await signInBrowser(user.email);

    const authorize = new URL(as.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "openid offline_access",
      state: "s",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: prm.resource,
    }).toString();
    const { res } = await browser.follow(authorize.toString());
    const html = await res.text();
    expect(html).not.toContain("Theirs");
    const form = new URLSearchParams();
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) form.set(m[1]!, m[2]!);
    form.set("organization_id", theirs.id);
    form.set("decision", "allow");
    const post = await browser.fetch("/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(post.status).toBe(400);
    const { rows } = await pool.query("SELECT 1 FROM mcp_oauth_vault WHERE organization_id = $1", [theirs.id]);
    expect(rows).toHaveLength(0);
  });

  it("a signed-out browser is sent to the sign-in page first", async () => {
    const { prm, as } = await discovery();
    const clientId = await register(as);
    const authorize = new URL(as.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "openid offline_access",
      state: "s",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: prm.resource,
    }).toString();
    const { res, url } = await new Browser().follow(authorize.toString());
    expect(new URL(url).pathname).toBe("/oauth/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign in to");
  });
});
