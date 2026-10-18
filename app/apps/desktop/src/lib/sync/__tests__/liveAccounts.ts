// SPDX-License-Identifier: Apache-2.0
//
// Accounts for the live-server suites (CONTEXT_IT=1). There is no self
// sign-up, so a test account is created through the server's admin panel
// (CONTEXT_ADMIN_PASSWORD = the server's ADMIN_PASSWORD) and then signed in on
// the given client, which ends up holding the session token like before.

import type { ApiClient, AuthUser } from "../../api";

const ADMIN_PASSWORD = process.env.CONTEXT_ADMIN_PASSWORD ?? "";

export async function createLiveAccount(
  serverUrl: string,
  client: ApiClient,
  input: { email: string; password: string; name: string },
): Promise<{ user: AuthUser; token: string | null }> {
  if (!ADMIN_PASSWORD) throw new Error("Set CONTEXT_ADMIN_PASSWORD to the server's ADMIN_PASSWORD");
  const origin = new URL(serverUrl).origin;
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    redirect: "manual" as const,
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(fields).toString(),
  });
  const login = await fetch(`${origin}/admin/login`, form({ password: ADMIN_PASSWORD }));
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`admin login failed (${login.status})`);
  const created = await fetch(`${origin}/admin/users`, {
    ...form({ email: input.email, name: input.name, password: input.password }),
    headers: { ...form({}).headers, cookie },
  });
  const location = created.headers.get("location") ?? "";
  if (!location.includes("ok=")) throw new Error(`admin create failed: ${decodeURIComponent(location)}`);
  return client.signIn({ email: input.email, password: input.password });
}
