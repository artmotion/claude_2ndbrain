import { describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";

/**
 * The server stays on better-auth 1.6.x for now (1.7 replaced the `mcp` plugin
 * this server's OAuth connector flow is built on). Four advisories fixed only
 * in 1.7.7 are listed in `app/pnpm-workspace.yaml auditConfig.ignoreGhsas`
 * because NONE of them is reachable with this configuration. Each one needs a
 * plugin or setting this test refuses, so turning one on fails here first —
 * and that is the moment to move to 1.7.7+ instead.
 *
 *   GHSA-965c-763c-88jm (critical) needs magicLink
 *   GHSA-r4xp-prcw-77qf (high)     needs oauthProxy
 *   GHSA-q84f-53jg-9ppm (high)     needs deviceAuthorization
 *   GHSA-44jh-23m7-hpcf (low)      needs DATABASE-backed rate limiting
 */
describe("better-auth 1.6 advisory exceptions stay unreachable", () => {
  const ids = (auth.options.plugins ?? []).map((p) => p.id);

  it("enables only the plugins the exceptions were judged against", () => {
    expect(ids.sort()).toEqual(["bearer", "mcp", "organization"]);
    for (const risky of ["magic-link", "oauth-proxy", "device-authorization"]) {
      expect(ids).not.toContain(risky);
    }
  });

  it("keeps rate-limit records out of the database", () => {
    expect(auth.options.rateLimit?.storage ?? "memory").not.toBe("database");
  });
});
