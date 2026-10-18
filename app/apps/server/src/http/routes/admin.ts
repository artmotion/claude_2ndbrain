// SPDX-License-Identifier: Apache-2.0
//
// The admin panel: a few server-rendered pages at /admin where the server
// owner creates and manages accounts (this fork has no self sign-up). It is
// served on the public port, so it is locked down:
//   - off entirely (404) unless ADMIN_PASSWORD is set, min. 12 characters;
//   - login compares the password in constant time and is rate-limited per
//     client IP (5 failures / 15 min);
//   - the session is a signed, HttpOnly, SameSite=Strict cookie scoped to
//     /admin, valid 12 hours, signed with JWT_SECRET plus the password (so
//     changing ADMIN_PASSWORD signs every admin out);
//   - every POST must come from this origin (Origin/Referer check), which with
//     SameSite=Strict blocks cross-site form posts.
// No JavaScript, no external assets: plain forms, escape-first HTML.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../../config.js";
import { BRAND_NAME } from "../../brand.js";
import { esc } from "../pages.js";
import {
  AccountError,
  MIN_PASSWORD_LENGTH,
  addToVault,
  createUser,
  deleteUser,
  listUsers,
  listVaults,
  setDisabled,
  setPassword,
} from "../../admin/accounts.js";

export const ADMIN_MIN_PASSWORD = 12;
const COOKIE = "sb_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

/** The configured password, or null when the panel is off. Read per request so
 *  tests can toggle it. */
function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD ?? config.adminPassword ?? "";
  return p.length >= ADMIN_MIN_PASSWORD ? p : null;
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", `${config.jwtSecret}\0admin\0${password}`).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function isLoggedIn(c: Context, password: string): boolean {
  const raw = getCookie(c, COOKIE);
  if (!raw) return false;
  const [expires, mac] = raw.split(".");
  if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return safeEqual(mac, sign(expires, password));
}

function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return proto.split(",")[0].trim() === "https";
}

/** Same-origin check for state-changing requests. */
function sameOrigin(c: Context): boolean {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  const origin = c.req.header("origin") ?? c.req.header("referer");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "local"
  );
}

const failures = new Map<string, number[]>();
function tooManyFailures(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= LOGIN_MAX_FAILURES;
}
function recordFailure(ip: string): void {
  const list = failures.get(ip) ?? [];
  list.push(Date.now());
  failures.set(ip, list);
}
/** Test seam. */
export function resetAdminLoginThrottle(): void {
  failures.clear();
}

const CSS = `
  :root { color-scheme: light dark; --bg:#f6f6f4; --fg:#1b1b1f; --muted:#6b6b73; --card:#fff; --line:#e3e3e0;
          --accent:#5b4fcf; --danger:#c0392b; --ok:#2e7d32; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111114; --fg:#ececea; --muted:#9a9aa3; --card:#1a1a1f;
          --line:#2c2c33; --accent:#8b80f0; --danger:#ef6b5b; --ok:#6fcf74; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display:flex; align-items:center; justify-content:space-between; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 0 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:18px; }
  table { width:100%; border-collapse: collapse; } th, td { text-align:left; padding:10px 8px; border-top:1px solid var(--line); vertical-align: top; }
  th { color:var(--muted); font-weight:600; font-size:12px; border-top:none; }
  input, select { font: inherit; padding: 7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  button { font: inherit; padding: 7px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); }
  form.inline { display:inline-flex; gap:6px; align-items:center; margin: 2px 6px 2px 0; flex-wrap: wrap; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .muted { color:var(--muted); } .tag { font-size:12px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); }
  .msg { padding:10px 12px; border-radius:8px; margin-bottom:16px; border:1px solid var(--line); }
  .msg.ok { border-color: var(--ok); color: var(--ok); } .msg.err { border-color: var(--danger); color: var(--danger); }
  details summary { cursor:pointer; color: var(--accent); }
  .login { max-width: 340px; margin: 12vh auto; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>${esc(title)} · ${esc(BRAND_NAME)} admin</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function loginPage(error?: string): string {
  return shell(
    "Sign in",
    `<main><div class="card login"><h1>${esc(BRAND_NAME)} admin</h1>
<p class="muted">Enter the ADMIN_PASSWORD from the server's environment.</p>
${error ? `<div class="msg err">${esc(error)}</div>` : ""}
<form method="post" action="/admin/login" class="row">
<input type="password" name="password" autocomplete="current-password" autofocus required style="flex:1" />
<button class="primary" type="submit">Sign in</button></form></div></main>`,
  );
}

function fmt(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
}

async function dashboard(flash: { ok?: string; err?: string }): Promise<string> {
  const [users, vaults] = await Promise.all([listUsers(), listVaults()]);
  const vaultOptions = vaults.map((v) => `<option value="${esc(v.orgId)}">${esc(v.name)}</option>`).join("");
  const rows = users
    .map((u) => {
      const id = esc(u.id);
      const vaultList = u.vaults.length
        ? u.vaults.map((v) => `${esc(v.name)} <span class="tag">${esc(v.role)}</span>`).join("<br>")
        : `<span class="muted">none</span>`;
      const status = u.disabledAt ? `<span class="tag" style="color:var(--danger)">disabled</span>` : `<span class="tag">active</span>`;
      return `<tr>
<td><b>${esc(u.name)}</b><br><span class="muted">${esc(u.email)}</span><br>${status}${u.hasPassword ? "" : ` <span class="tag">no password</span>`}</td>
<td>${vaultList}</td>
<td class="muted">created ${fmt(u.createdAt)}<br>last active ${fmt(u.lastSeenAt)}</td>
<td>
<details><summary>Manage</summary>
<form class="inline" method="post" action="/admin/users/${id}/password">
<input type="password" name="password" placeholder="New password" minlength="${MIN_PASSWORD_LENGTH}" required autocomplete="new-password" />
<button type="submit">Set password</button></form>
${
  vaults.length
    ? `<form class="inline" method="post" action="/admin/users/${id}/vaults">
<select name="orgId">${vaultOptions}</select><select name="role"><option value="member">member</option><option value="admin">admin</option></select>
<button type="submit">Add to vault</button></form>`
    : ""
}
<form class="inline" method="post" action="/admin/users/${id}/${u.disabledAt ? "enable" : "disable"}">
<button type="submit">${u.disabledAt ? "Enable" : "Disable"}</button></form>
<form class="inline" method="post" action="/admin/users/${id}/delete">
<label class="muted"><input type="checkbox" name="confirm" value="yes" required /> really delete</label>
<button class="danger" type="submit">Delete</button></form>
</details></td></tr>`;
    })
    .join("");
  return shell(
    "Users",
    `<main><header><h1>${esc(BRAND_NAME)} admin</h1>
<form method="post" action="/admin/logout"><button type="submit">Sign out</button></form></header>
${flash.ok ? `<div class="msg ok">${esc(flash.ok)}</div>` : ""}${flash.err ? `<div class="msg err">${esc(flash.err)}</div>` : ""}
<div class="card"><h2>Create a user</h2>
<form method="post" action="/admin/users" class="row">
<input type="email" name="email" placeholder="Email" required autocomplete="off" />
<input type="text" name="name" placeholder="Name (optional)" autocomplete="off" />
<input type="password" name="password" placeholder="Password (min. ${MIN_PASSWORD_LENGTH})" minlength="${MIN_PASSWORD_LENGTH}" required autocomplete="new-password" />
<button class="primary" type="submit">Create</button></form>
<p class="muted">They sign in from the desktop or iPad app with this email and password. Vaults they create are theirs; to share an existing vault, add them below or invite them from the app.</p></div>
<div class="card"><h2>Users (${users.length})</h2>
${users.length ? `<table><thead><tr><th>User</th><th>Vaults</th><th>Activity</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No users yet.</p>`}
</div></main>`,
  );
}

function redirectWith(c: Context, kind: "ok" | "err", text: string) {
  return c.redirect(`/admin?${kind}=${encodeURIComponent(text)}`, 303);
}

async function formField(c: Context, name: string): Promise<string> {
  const body = await c.req.parseBody();
  const v = body[name];
  return typeof v === "string" ? v : "";
}

export const adminRoutes = new Hono();

adminRoutes.use("/admin", async (c, next) => {
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  await next();
});
adminRoutes.use("/admin/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  await next();
});

adminRoutes.get("/admin", async (c) => {
  const password = adminPassword();
  if (!password) return c.text("Not found", 404);
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  if (!isLoggedIn(c, password)) return c.html(loginPage());
  return c.html(await dashboard({ ok: c.req.query("ok"), err: c.req.query("err") }));
});

adminRoutes.post("/admin/login", async (c) => {
  const password = adminPassword();
  if (!password) return c.text("Not found", 404);
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const ip = clientIp(c);
  if (tooManyFailures(ip)) {
    return c.html(loginPage("Too many failed attempts. Try again in 15 minutes."), 429);
  }
  const given = await formField(c, "password");
  if (!safeEqual(given, password)) {
    recordFailure(ip);
    return c.html(loginPage("Wrong password."), 401);
  }
  const expires = String(Date.now() + SESSION_MS);
  setCookie(c, COOKIE, `${expires}.${sign(expires, password)}`, {
    path: "/admin",
    httpOnly: true,
    sameSite: "Strict",
    secure: isHttps(c),
    maxAge: SESSION_MS / 1000,
  });
  return c.redirect("/admin", 303);
});

adminRoutes.post("/admin/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/admin" });
  return c.redirect("/admin", 303);
});

/** Guard + error mapping shared by every action. */
function action(handler: (c: Context, userId: string) => Promise<string>) {
  return async (c: Context) => {
    const password = adminPassword();
    if (!password) return c.text("Not found", 404);
    if (!sameOrigin(c)) return c.text("Forbidden", 403);
    if (!isLoggedIn(c, password)) return c.redirect("/admin", 303);
    try {
      return redirectWith(c, "ok", await handler(c, c.req.param("id") ?? ""));
    } catch (e) {
      if (e instanceof AccountError) return redirectWith(c, "err", e.message);
      console.error("[admin] action failed:", (e as Error).message);
      return redirectWith(c, "err", "Something went wrong; see the server log.");
    }
  };
}

adminRoutes.post(
  "/admin/users",
  action(async (c) => {
    const body = await c.req.parseBody();
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const user = await createUser({ email: str("email"), name: str("name"), password: str("password") });
    return `Created ${user.email}.`;
  }),
);
adminRoutes.post(
  "/admin/users/:id/password",
  action(async (c, id) => {
    await setPassword(id, await formField(c, "password"));
    return "Password set; the user was signed out everywhere.";
  }),
);
adminRoutes.post(
  "/admin/users/:id/disable",
  action(async (_c, id) => {
    await setDisabled(id, true);
    return "User disabled and signed out.";
  }),
);
adminRoutes.post(
  "/admin/users/:id/enable",
  action(async (_c, id) => {
    await setDisabled(id, false);
    return "User enabled.";
  }),
);
adminRoutes.post(
  "/admin/users/:id/delete",
  action(async (c, id) => {
    if ((await formField(c, "confirm")) !== "yes") {
      throw new AccountError("unconfirmed", "Tick “really delete” to delete a user.");
    }
    await deleteUser(id);
    return "User deleted.";
  }),
);
adminRoutes.post(
  "/admin/users/:id/vaults",
  action(async (c, id) => {
    const body = await c.req.parseBody();
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    const role = typeof body.role === "string" ? body.role : "member";
    await addToVault(id, orgId, role);
    return "Added to the vault.";
  }),
);
