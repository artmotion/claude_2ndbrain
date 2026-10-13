import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Per-vault attachment storage accounting. There is no quota: uploads never
 * meet a storage limit, and `GET /storage` reports usage with a null limit.
 */
const app = createApp(testAppDeps());

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const LIMIT_BYTES = 1024 * 1024 * 1024;

let owner: TestUser;
let orgId = "";
let vaultId = "";

/** Occupy `bytes` of the vault's quota with a `ready` row. The `size` column is
 *  what the sum reads; no real bytes are needed to test an accounting rule. */
async function occupy(bytes: number, status: "ready" | "pending" = "ready"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data)
     VALUES ($1, $2, $3, $4, $5, 'image/png', $6, 'x.png', 'postgres', $7,
             CASE WHEN $7 = 'ready' THEN decode('000102','hex') ELSE NULL END)`,
    [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "f".repeat(32), bytes,
      `attachments/${id}.png`, status],
  );
  return id;
}

function intent(user: TestUser, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/intent`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const newUpload = () => ({
  sha256: createHash("sha256").update(randomUUID()).digest("hex"),
  size: PNG.byteLength,
  mime: "image/png",
  relPath: `attachments/${randomUUID()}.png`,
});

const storage = (user: TestUser) =>
  app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/storage`, {
      headers: { authorization: `Bearer ${user.token}` },
    }),
  );

afterAll(async () => {
  await pool.end();
});

describe("storage accounting", () => {
  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner-${randomUUID().slice(0, 8)}@quota.com`);
    orgId = await seedOrg("Quota Co", `quota-${randomUUID().slice(0, 8)}`);
    await seedMember(orgId, owner.userId, "owner");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
  });

  it("counts pending rows in reported storage", async () => {
    await occupy(LIMIT_BYTES, "pending");
    const body = (await (await storage(owner)).json()) as {
      usedBytes: number;
      pendingBytes: number;
    };
    expect(body.usedBytes).toBe(LIMIT_BYTES);
    expect(body.pendingBytes).toBe(LIMIT_BYTES);
  });

  it("never refuses an upload, however full the vault is", async () => {
    await occupy(LIMIT_BYTES * 4);
    const res = await intent(owner, newUpload());
    expect(res.status).toBe(200);
  });

  describe("GET /api/vaults/:vaultId/storage", () => {
    it("reports usage and a null limit", async () => {
      await occupy(1000);
      await occupy(500, "pending");
      const body = (await (await storage(owner)).json()) as Record<string, unknown>;
      expect(body).toEqual({
        usedBytes: 1500,
        pendingBytes: 500,
        blobCount: 2,
        // Always null (unlimited); kept for older desktops.
        limitBytes: null,
      });
    });

    it("is member-gated, not write-gated", async () => {
      const reader = await signUp(`reader-${randomUUID().slice(0, 8)}@quota.com`);
      expect((await storage(reader)).status).toBe(403);
      await seedMember(orgId, reader.userId, "member");
      expect((await storage(reader)).status).toBe(200);
    });
  });
});
