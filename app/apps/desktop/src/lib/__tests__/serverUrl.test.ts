import { describe, it, expect } from "vitest";
import { resolveServerUrl, DEFAULT_SERVER_URL, HAS_BUILT_IN_SERVER, LOCAL_SERVER_URL } from "../api";

// Vitest runs with import.meta.env.DEV === true and no VITE_SERVER_URL, i.e. a
// dev build: it talks to the local stack and counts as having a server.
describe("resolveServerUrl (dev build)", () => {
  it("defaults to the local stack when nothing is persisted", () => {
    expect(DEFAULT_SERVER_URL).toBe(LOCAL_SERVER_URL);
    expect(HAS_BUILT_IN_SERVER).toBe(true);
    expect(resolveServerUrl(null)).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("")).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("   ")).toBe(LOCAL_SERVER_URL);
  });

  it("honours any persisted server, without its trailing slash", () => {
    expect(resolveServerUrl("https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
    expect(resolveServerUrl("http://192.168.1.20:3010/")).toBe(
      "http://192.168.1.20:3010",
    );
    expect(resolveServerUrl("http://localhost:4000")).toBe("http://localhost:4000");
  });
});
