import type pg from "pg";
import type { JSONWebKeySet } from "jose";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import { orgRole } from "../permissions/lookup.js";
import { auth } from "../auth/auth.js";
import type { McpAuth } from "./tokens.js";

/**
 * The OAuth half of MCP auth (migration 058 + `@better-auth/mcp`).
 *
 * A minted `mcp_` token already encodes its (user, vault) scope in its DB
 * row. An OAuth access token, by contrast, only tells us WHO the caller is —
 * the vault is chosen by the user on the consent screen and recorded in
 * `mcp_oauth_vault`, keyed per
 * (client, user). This module bridges an incoming OAuth bearer to the same
 * `McpAuth` context an mcp_ token produces, so everything downstream
 * (service.ts ACL checks) is identical either way.
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * Record the vault the user granted a connector access to (upsert: a user
 * re-consenting the same client can retarget it to another vault).
 */
export async function setVaultBinding(
  clientId: string,
  userId: string,
  organizationId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  await db.query(
    `INSERT INTO mcp_oauth_vault (client_id, user_id, organization_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, user_id)
       DO UPDATE SET organization_id = EXCLUDED.organization_id, updated_at = now()`,
    [clientId, userId, organizationId],
  );
}

/** The vault bound to (client, user), or null if none was recorded. */
async function getVaultBinding(
  clientId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM mcp_oauth_vault WHERE client_id = $1 AND user_id = $2",
    [clientId, userId],
  );
  return rows[0]?.organization_id ?? null;
}

/** Fallback when no binding exists: the user's sole vault, else null. */
async function soleVault(
  userId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

/** The protected resource every MCP access token must be issued for. */
export const MCP_RESOURCE = `${config.betterAuthUrl.replace(/\/+$/, "")}/api/mcp`;

/** Stable key for verifyJwsAccessToken's JWKS cache (TTL + kid-miss refetch). */
const jwksCacheKey = {};
let issuer: Promise<string> | null = null;

/** The issuer this server stamps into its tokens, read once from its own
 *  authorization-server metadata (so it can never drift from what clients see). */
function tokenIssuer(): Promise<string> {
  issuer ??= (auth.api.getOAuthServerConfig() as Promise<{ issuer: string }>)
    .then((m) => m.issuer)
    .catch((err) => {
      issuer = null;
      throw err;
    });
  return issuer;
}

/** The bearer token of a request, or null. */
function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (!h || !/^Bearer\s+/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, "").trim() || null;
}

/**
 * Verify an OAuth access token issued by THIS server for the MCP resource:
 * signature against our own JWKS (read in-process, never over HTTP), issuer,
 * audience = /api/mcp, expiry, and the `sub` (user) and `azp` (client) claims.
 * A sender-constrained (DPoP) token is refused here: this endpoint verifies
 * bearer tokens only, and a DPoP token presented without its proof is exactly
 * what sender-constraining exists to stop.
 */
export async function verifyMcpAccessToken(
  token: string,
): Promise<{ userId: string; clientId: string } | null> {
  // An mcp_ token or anything that is not a compact JWS never is one of ours.
  if (token.split(".").length !== 3) return null;
  try {
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await auth.api.getJwks()) as unknown as JSONWebKeySet,
      jwksCacheKey,
      verifyOptions: {
        issuer: await tokenIssuer(),
        audience: MCP_RESOURCE,
        requiredClaims: ["sub", "azp", "exp"],
      },
    });
    if (payload.cnf) return null;
    if (typeof payload.sub !== "string" || typeof payload.azp !== "string") return null;
    return { userId: payload.sub, clientId: payload.azp };
  } catch {
    return null;
  }
}

/** Why an OAuth bearer did not resolve: signed in, but no vault chosen. */
export type OAuthMcpFailure = "no_vault_selected" | null;

/**
 * Resolve an incoming request carrying an OAuth `Authorization: Bearer` access
 * token to an `McpAuth`, or null if the token is missing/invalid/expired, the
 * account is disabled, no vault can be determined, or the user is no longer a
 * member of it (membership can be revoked out from under a live token —
 * re-checked here, exactly like verifyMcpToken does for mcp_ tokens).
 * `onFailure` learns when the token itself was valid but no vault was bound,
 * so the 401 can say so.
 */
export async function resolveOAuthMcpAuth(
  headers: Headers,
  db: Queryable = defaultPool,
  onFailure?: (reason: OAuthMcpFailure) => void,
): Promise<McpAuth | null> {
  const token = bearerToken(headers);
  if (!token) return null;
  const verified = await verifyMcpAccessToken(token);
  if (!verified) return null;
  const { userId, clientId } = verified;

  // A disabled account loses every route at once (auth.ts refuses its
  // sessions); a still-unexpired access token must not outlive that.
  const { rows: users } = await db.query<{ disabled_at: Date | null }>(
    'SELECT disabled_at FROM "user" WHERE id = $1',
    [userId],
  );
  if (!users[0] || users[0].disabled_at) return null;

  const organizationId =
    (await getVaultBinding(clientId, userId, db)) ?? (await soleVault(userId, db));
  if (!organizationId) {
    onFailure?.("no_vault_selected");
    return null;
  }

  if (!(await orgRole(organizationId, userId, db))) return null;

  return { userId, organizationId };
}
