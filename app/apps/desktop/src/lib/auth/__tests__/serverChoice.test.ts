import { describe, expect, it } from "vitest";
import {
  decideAuthStep,
  impliedServerChoice,
  normalizeServerUrl,
  serverHost,
} from "../serverChoice";

/**
 * The server-choice step's decision table (#91).
 *
 * There is no component-render harness in this workspace, so the rules that
 * decide WHERE the sign-in dialog opens — and what counts as a server address —
 * live in pure functions and get pinned here. The stake is not cosmetic: get
 * `decideAuthStep` wrong in the "never asked" direction and a self-hosting
 * team's members go back to signing up on the managed instance; get
 * `normalizeServerUrl` wrong and a deep link decides where a password is
 * posted.
 */
describe("normalizeServerUrl", () => {
  it("prepends https to a bare host", () => {
    expect(normalizeServerUrl("notes.example.com")).toBe("https://notes.example.com");
  });

  it("strips trailing slashes but keeps a reverse-proxy path prefix", () => {
    expect(normalizeServerUrl("https://intranet.example.com/secondbrain/")).toBe(
      "https://intranet.example.com/secondbrain",
    );
    expect(normalizeServerUrl("https://api.secondbrain.example///")).toBe("https://api.secondbrain.example");
  });

  it("keeps an explicit port and honours http for a local server", () => {
    expect(normalizeServerUrl("http://localhost:3010")).toBe("http://localhost:3010");
    expect(normalizeServerUrl(" https://notes.example.com:8443 ")).toBe(
      "https://notes.example.com:8443",
    );
  });

  it("drops the default port and lowercases the host", () => {
    expect(normalizeServerUrl("https://Notes.Example.com:443")).toBe(
      "https://notes.example.com",
    );
  });

  it("refuses anything that isn't http(s)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "javascript://alert(1)",
      "ftp://files.example.com",
      "file:///etc/passwd",
      "data:text/html,<script>",
    ]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });

  it("refuses empty and malformed input", () => {
    for (const bad of ["", "   ", "https://", "http://", "://nope"]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });
});

describe("serverHost", () => {
  it("names the host, with any path prefix that distinguishes two instances", () => {
    expect(serverHost("https://api.secondbrain.example")).toBe("api.secondbrain.example");
    expect(serverHost("http://localhost:3010")).toBe("localhost:3010");
    expect(serverHost("https://intranet.example.com/secondbrain")).toBe(
      "intranet.example.com/secondbrain",
    );
  });

  it("falls back to the raw string rather than rendering nothing", () => {
    expect(serverHost("not a url")).toBe("not a url");
  });
});

describe("impliedServerChoice", () => {
  const def = "https://api.secondbrain.example";

  it("reads a non-default URL as a self-host answer already given", () => {
    expect(impliedServerChoice("https://notes.example.com", def)).toBe("custom");
  });

  it("treats the default (however it was spelled) as no answer", () => {
    expect(impliedServerChoice(def, def)).toBeNull();
    expect(impliedServerChoice(`${def}/`, def)).toBeNull();
  });
});

describe("decideAuthStep", () => {
  const def = "http://localhost:3010";

  it("asks for the server on a first run when the build has none", () => {
    expect(
      decideAuthStep({ choice: null, serverUrl: def, defaultServerUrl: def, hasBuiltInServer: false }),
    ).toBe("choose-server");
  });

  it("opens a first run on the form when the build names a server", () => {
    expect(
      decideAuthStep({
        choice: null,
        serverUrl: "https://notes.example.com",
        defaultServerUrl: "https://notes.example.com",
        hasBuiltInServer: true,
      }),
    ).toBe("form");
  });

  it("does not ask again once the question is answered", () => {
    expect(
      decideAuthStep({ choice: "custom", serverUrl: def, defaultServerUrl: def, hasBuiltInServer: false }),
    ).toBe("form");
  });

  it("does not ask a device that already points at another server", () => {
    expect(
      decideAuthStep({
        choice: null,
        serverUrl: "https://notes.example.com",
        defaultServerUrl: def,
        hasBuiltInServer: false,
      }),
    ).toBe("form");
  });

  it("lets a pending invite link outrank every other step", () => {
    for (const choice of [null, "custom"] as const) {
      for (const hasBuiltInServer of [true, false]) {
        expect(
          decideAuthStep({
            choice,
            serverUrl: def,
            pendingServerLink: "https://notes.example.com",
            defaultServerUrl: def,
            hasBuiltInServer,
          }),
        ).toBe("confirm-link");
      }
    }
  });

  it("ignores an empty pending link", () => {
    expect(
      decideAuthStep({
        choice: "custom",
        serverUrl: def,
        pendingServerLink: "",
        defaultServerUrl: def,
      }),
    ).toBe("form");
  });
});
