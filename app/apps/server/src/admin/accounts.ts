// SPDX-License-Identifier: Apache-2.0
//
// Account management for the admin panel (routes/admin.ts). This fork has no
// self sign-up: every account is created here by the server owner, then signs
// in from the desktop / iPad app like before. All writes go through Better
// Auth's own internal adapter and password hasher, so an account made here is
// indistinguishable from one Better Auth made itself.

import { randomUUID } from "node:crypto";
import { auth } from "../auth/auth.js";
import { pool } from "../db/pool.js";
import { announceMemberJoined, announceMemberRemoved } from "../sync/member-events.js";

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  disabledAt: Date | null;
  lastSeenAt: Date | null;
  hasPassword: boolean;
  vaults: { orgId: string; name: string; role: string }[];
}

export interface AdminVaultRow {
  orgId: string;
  name: string;
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError("weak_password", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    email: string;
    created_at: Date;
    disabled_at: Date | null;
    last_seen_at: Date | null;
    has_password: boolean;
    vaults: { orgId: string; name: string; role: string }[] | null;
  }>(
    `SELECT u.id, u.name, u.email, u."createdAt" AS created_at, u.disabled_at,
            (SELECT max(m.last_seen_at) FROM member m WHERE m."userId" = u.id) AS last_seen_at,
            EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'credential'
                     AND a.password IS NOT NULL) AS has_password,
            (SELECT json_agg(json_build_object('orgId', o.id, 'name', o.name, 'role', m.role) ORDER BY o.name)
               FROM member m JOIN organization o ON o.id = m."organizationId"
              WHERE m."userId" = u.id) AS vaults
       FROM "user" u
      ORDER BY lower(u.email)`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
    lastSeenAt: r.last_seen_at,
    hasPassword: r.has_password,
    vaults: r.vaults ?? [],
  }));
}

export async function listVaults(): Promise<AdminVaultRow[]> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organization ORDER BY lower(name)`,
  );
  return rows.map((r) => ({ orgId: r.id, name: r.name }));
}

/** Create an email + password account. The address is stored as given (Better
 *  Auth lower-cases it) and counts as verified: the owner vouches for it. */
export async function createUser(input: {
  email: string;
  name?: string;
  password: string;
}): Promise<{ id: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AccountError("invalid_email", "That is not a valid email address.");
  checkPassword(input.password);
  const name = (input.name ?? "").trim() || email.split("@")[0];

  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) {
    throw new AccountError("email_taken", `An account for ${email} already exists.`);
  }
  const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return { id: user.id, email: user.email };
}

async function requireUser(userId: string): Promise<{ id: string; email: string }> {
  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM "user" WHERE id = $1`,
    [userId],
  );
  if (!rows[0]) throw new AccountError("not_found", "No such user.");
  return rows[0];
}

/** Set a new password (adding a password login to a Google-only account) and
 *  sign the user out everywhere. */
export async function setPassword(userId: string, password: string): Promise<void> {
  await requireUser(userId);
  checkPassword(password);
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const accounts = await ctx.internalAdapter.findAccounts(userId);
  if (accounts.some((a) => a.providerId === "credential")) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
  await ctx.internalAdapter.deleteUserSessions(userId);
}

/** Disable (sign out everywhere; new sessions are refused in auth.ts) or
 *  re-enable an account. Data and memberships stay untouched. */
export async function setDisabled(userId: string, disabled: boolean): Promise<void> {
  await requireUser(userId);
  await pool.query(`UPDATE "user" SET disabled_at = $2 WHERE id = $1`, [
    userId,
    disabled ? new Date() : null,
  ]);
  if (disabled) {
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(userId);
  }
}

/** Delete an account. Refused while the user owns a vault, because the vault
 *  would be left without an owner: transfer or delete the vault first. Notes
 *  they wrote stay in their vaults (authorship becomes empty). */
export async function deleteUser(userId: string): Promise<void> {
  await requireUser(userId);
  const owned = await pool.query<{ name: string }>(
    `SELECT o.name FROM member m JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1 AND m.role = 'owner' ORDER BY o.name`,
    [userId],
  );
  if (owned.rows.length) {
    throw new AccountError(
      "owns_vaults",
      `This user owns ${owned.rows.map((r) => `"${r.name}"`).join(", ")}. Delete those vaults or make someone else the owner first.`,
    );
  }
  const memberships = await pool.query<{ organization_id: string }>(
    `SELECT "organizationId" AS organization_id FROM member WHERE "userId" = $1`,
    [userId],
  );
  await pool.query(`DELETE FROM shares WHERE principal_type = 'user' AND principal_id = $1`, [userId]);
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUser(userId); // sessions, accounts, user; member rows cascade
  for (const m of memberships.rows) {
    await announceMemberRemoved(m.organization_id, userId, "removed");
  }
}

/** Add a user to a vault as member or admin. The member row picks up the
 *  vault's "New members" access snapshot (migration 032 trigger), exactly
 *  like joining with a join code. */
export async function addToVault(userId: string, orgId: string, role: string): Promise<void> {
  const user = await requireUser(userId);
  if (role !== "member" && role !== "admin") {
    throw new AccountError("invalid_role", "The role must be member or admin.");
  }
  const org = await pool.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [orgId]);
  if (!org.rows[0]) throw new AccountError("not_found", "No such vault.");
  const existing = await pool.query(`SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
    orgId,
    userId,
  ]);
  if (existing.rows.length) throw new AccountError("already_member", `${user.email} is already in that vault.`);
  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
    [randomUUID(), orgId, userId, role],
  );
  const who = await pool.query<{ name: string | null }>(`SELECT name FROM "user" WHERE id = $1`, [userId]);
  void announceMemberJoined(orgId, who.rows[0]?.name?.trim() || user.email);
}
