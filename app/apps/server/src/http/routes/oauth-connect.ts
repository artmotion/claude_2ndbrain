import { Hono } from "hono";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { pool } from "../../db/pool.js";
import { auth, googleEnabled } from "../../auth/auth.js";
import { config } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { setVaultBinding } from "../../mcp/oauth.js";
import { BRAND_NAME } from "../../brand.js";
import { emailEnabled } from "../../email/mailer.js";
import { esc, page } from "../pages.js";

/**
 * The human-facing pages of the MCP OAuth flow (`@better-auth/mcp` drives the
 * machinery; these are the screens it redirects a browser through):
 *
 *   GET  /oauth/login    ← provider's `loginPage`. Sign in to an existing account.
 *   GET  /oauth/consent  ← provider's `consentPage`. Pick the vault + Allow.
 *   POST /oauth/consent  → records the vault binding, completes consent,
 *                          bounces back to the client's redirect_uri.
 *
 * The provider hands both pages the whole authorization request as a SIGNED
 * query string (`sig`, `exp`). It travels back verbatim as `oauth_query`: on
 * sign-in it lets the provider resume the authorization by itself, and on the
 * consent POST it is what names the request being answered. Its signature is
 * checked before we act on the client_id inside it.
 *
 * Served by this (headless) server itself so the flow works on api.secondbrain.example
 * and any self-hoster with no separate web frontend. Page chrome + branding come
 * from ../pages.ts (shared with the account pages).
 */

const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

async function clientName(clientId: string | undefined): Promise<string> {
  if (!clientId) return "An application";
  const { rows } = await pool.query<{ name: string | null }>(
    'SELECT name FROM "oauthClient" WHERE "clientId" = $1',
    [clientId],
  );
  return rows[0]?.name?.trim() || "An application";
}

/** The signed authorization query of a provider redirect, or null when it is
 *  missing, forged or expired. */
async function verifiedQuery(raw: string): Promise<URLSearchParams | null> {
  if (!raw) return null;
  const secret = (await auth.$context).secret;
  try {
    return (await verifyOAuthQueryParams(raw, secret)) ? new URLSearchParams(raw) : null;
  } catch {
    return null;
  }
}

export const oauthConnectRoutes = new Hono();

// ── Force the vault picker on every authorize (issue #211) ──────────────────
// The provider issues a code straight away unless prompt=consent, and a
// client whose user is already signed in in the browser never passes through
// /oauth/login (where we used to add it). Its token then had no vault binding
// and every call 401'd once the user belonged to two vaults. Mounted ahead of
// Better Auth's /api/auth/* handler, so this runs first.
oauthConnectRoutes.get(AUTHORIZE_PATH, async (c, next) => {
  const url = new URL(c.req.url);
  if (url.searchParams.get("prompt") === "consent") return next();
  url.searchParams.set("prompt", "consent");
  return c.redirect(`${config.betterAuthUrl}${AUTHORIZE_PATH}?${url.searchParams.toString()}`, 302);
});

// ── Sign-in page (Better Auth mcp plugin's loginPage) ───────────────────────
oauthConnectRoutes.get("/oauth/login", async (c) => {
  const url = new URL(c.req.url);
  const app = await clientName(url.searchParams.get("client_id") ?? undefined);
  // The provider's signed authorization request. Sent back with the sign-in,
  // it lets the provider resume /oauth2/authorize for the new session itself
  // (prompt=consent is already in it: the authorize redirect above added it),
  // which lands on the vault picker.
  const oauthQuery = url.search.replace(/^\?/, "");
  const google = googleEnabled
    ? `<div class="divider">or</div>
       <button type="button" id="google" class="btn ghost">
         <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C17.1 2.9 14.8 2 12 2 6.9 2 2.8 6.1 2.8 11.2S6.9 20.4 12 20.4c6 0 7.9-4.2 7.9-7.5 0-.5-.1-.9-.2-1.3H12z"/></svg>
         Continue with Google
       </button>`
    : "";

  // Only when this server can actually send the email (issue #99); a link to a
  // reset flow that never delivers is worse than none.
  const forgot = emailEnabled()
    ? `<p class="linkline"><a href="/forgot-password">Forgot password?</a></p>`
    : "";

  const body = `
    <h1>Sign in to ${esc(BRAND_NAME)}</h1>
    <p class="sub">to connect <b>${esc(app)}</b></p>
    <div id="err" class="err" style="display:none"></div>
    <form id="f" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="username" autofocus />
      <label for="password">Password</label>
      <input id="password" type="password" required autocomplete="current-password" />
      ${forgot}
      <button type="submit" class="primary">Sign in</button>
    </form>
    ${google}
    <p class="foot">Authorizing access for <b>${esc(app)}</b> to your ${esc(BRAND_NAME)} account.</p>
    <script>
      const OAUTH_QUERY = ${JSON.stringify(oauthQuery)};
      const errEl = document.getElementById('err');
      function showErr(m){ errEl.textContent = m; errEl.style.display='block'; }
      // The provider answers a sign-in that carries oauth_query with where to
      // go next ({ url }); without one (an expired page) there is nowhere.
      function next(j){
        const to = j && (j.url || j.redirect_uri);
        if (to) window.location.assign(to);
        else showErr('This sign-in link has expired. Start the connection again from your app.');
      }
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.style.display='none';
        const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent='Signing in…';
        try {
          const res = await fetch('/api/auth/sign-in/email', {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json', 'Accept':'application/json'},
            body: JSON.stringify({
              email: document.getElementById('email').value,
              password: document.getElementById('password').value,
              oauth_query: OAUTH_QUERY
            })
          });
          const j = await res.json().catch(()=>({}));
          if (!res.ok) throw new Error(j.message || 'Invalid email or password');
          next(j);
        } catch (err) {
          showErr(err.message || 'Sign in failed'); btn.disabled=false; btn.textContent='Sign in';
        }
      });
      const g = document.getElementById('google');
      if (g) g.addEventListener('click', async () => {
        g.disabled = true;
        try {
          const res = await fetch('/api/auth/sign-in/social', {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ provider:'google', callbackURL: '/oauth/login?' + OAUTH_QUERY, oauth_query: OAUTH_QUERY })
          });
          const j = await res.json();
          if (j.url) window.location.assign(j.url); else throw new Error('Could not start Google sign-in');
        } catch (err) { showErr(err.message || 'Google sign-in failed'); g.disabled=false; }
      });
    </script>`;
  return c.html(page({ title: "Sign in", body }));
});

// ── Consent page with vault picker (provider's consentPage) ────────────────
oauthConnectRoutes.get("/oauth/consent", async (c) => {
  const oauthQuery = new URL(c.req.url).search.replace(/^\?/, "");
  const query = await verifiedQuery(oauthQuery);
  const clientId = query?.get("client_id") ?? "";
  const session = await getSession(c);
  if (!session) {
    return c.html(
      page({
        title: "Session expired",
        body: `<h1>Session expired</h1><p class="sub">Please restart the connection from ${esc(
          BRAND_NAME,
        )} in your app.</p>`,
      }),
      400,
    );
  }
  if (!query || !clientId) {
    return c.html(
      page({
        title: "Invalid request",
        body: `<h1>Invalid request</h1><p class="sub">This authorization link is missing, expired or altered. Start the connection again from your app.</p>`,
      }),
      400,
    );
  }

  const app = await clientName(clientId);
  const { rows: vaults } = await pool.query<{ id: string; name: string; role: string }>(
    `SELECT o.id, o.name, m.role
       FROM member m JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1
      ORDER BY o."createdAt" ASC`,
    [session.userId],
  );

  if (vaults.length === 0) {
    return c.html(
      page({
        title: "No vault",
        body: `<h1>No vault found</h1><p class="sub">Your account isn't a member of any ${esc(
          BRAND_NAME,
        )} vault yet. Create or join one in the app, then try again.</p>`,
      }),
      400,
    );
  }

  const preselect = session.activeOrganizationId ?? vaults[0].id;
  const options = vaults
    .map(
      (w) => `
      <label class="ws">
        <input type="radio" name="organization_id" value="${esc(w.id)}" ${
          w.id === preselect ? "checked" : ""
        } required />
        <span class="ws-meta"><span class="ws-name">${esc(w.name)}</span><span class="ws-role">${esc(
          w.role,
        )}</span></span>
      </label>`,
    )
    .join("");

  const body = `
    <h1><b>${esc(app)}</b> wants access</h1>
    <p class="sub">Signed in as <b>${esc(session.email)}</b></p>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="oauth_query" value="${esc(oauthQuery)}" />
      <label>Choose a vault to connect</label>
      ${options}
      <div class="scopes"><ul>
        <li>Read and search notes you can access</li>
        <li>Create, edit and organize notes on your behalf</li>
        <li>Only within your existing sharing permissions</li>
      </ul></div>
      <div class="row">
        <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
        <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
      </div>
    </form>
    <p class="foot">You can revoke this anytime in ${esc(BRAND_NAME)} vault settings.</p>`;
  return c.html(page({ title: "Authorize", body }));
});

oauthConnectRoutes.post("/oauth/consent", async (c) => {
  const form = await c.req.parseBody();
  const oauthQuery = typeof form.oauth_query === "string" ? form.oauth_query : "";
  const organizationId =
    typeof form.organization_id === "string" ? form.organization_id : "";
  const accept = form.decision === "allow";

  const session = await getSession(c);
  if (!session) {
    return c.html(
      page({ title: "Session expired", body: `<h1>Session expired</h1><p class="sub">Please restart the connection.</p>` }),
      400,
    );
  }
  // The client_id comes from the provider's SIGNED query, never from a form
  // field, so a crafted POST cannot bind a vault to some other client.
  const query = await verifiedQuery(oauthQuery);
  const clientId = query?.get("client_id") ?? "";
  if (!query || !clientId) {
    return c.html(page({ title: "Invalid request", body: `<h1>Invalid request</h1>` }), 400);
  }

  // On Allow: bind the chosen vault BEFORE completing consent, and only if
  // the user is really a member of it (the picker is user-supplied input).
  if (accept) {
    if (!organizationId || !(await orgRole(organizationId, session.userId))) {
      return c.html(
        page({
          title: "Authorize",
          body: `<h1>Pick a vault</h1><p class="sub">Select a vault you belong to, then try again.</p>`,
        }),
        400,
      );
    }
    await setVaultBinding(clientId, session.userId, organizationId);
  }

  try {
    // Answered through the auth handler as a real request (the provider
    // resumes /oauth2/authorize inside it, which needs the request itself),
    // carrying the browser's own cookies and origin.
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json",
      origin: new URL(config.betterAuthUrl).origin,
    });
    const cookie = c.req.header("cookie");
    if (cookie) headers.set("cookie", cookie);
    const authorization = c.req.header("authorization");
    if (authorization) headers.set("authorization", authorization);
    const res = await auth.handler(
      new Request(`${config.betterAuthUrl.replace(/\/+$/, "")}/api/auth/oauth2/consent`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      }),
    );
    const result = (await res.json().catch(() => null)) as { url?: string } | null;
    if (res.ok && result?.url) return c.redirect(result.url);
    throw new Error(`consent answered ${res.status}`);
  } catch {
    return c.html(
      page({
        title: "Authorization failed",
        body: `<h1>Authorization failed</h1><p class="sub">Something went wrong completing the connection. Please restart it from your app.</p>`,
      }),
      400,
    );
  }
});
