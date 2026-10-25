import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndexedAnchor } from "../ipc";
import {
  anchorsChanged,
  cachedAnchors,
  configureAnchorCache,
  onAnchorCacheChange,
  resetAnchorCache,
} from "./anchorCache";

const H = (text: string): IndexedAnchor => ({ kind: "heading", key: text.toLowerCase(), text, level: 2, line: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => resetAnchorCache());

describe("anchorCache", () => {
  it("answers undefined first, fetches once, then notifies", async () => {
    const fetch = vi.fn(async () => [H("Goals")]);
    configureAnchorCache("vault-a", fetch);
    const changed = vi.fn();
    onAnchorCacheChange(changed);
    expect(cachedAnchors("Plan.md")).toBeUndefined();
    expect(cachedAnchors("plan.md")).toBeUndefined();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(cachedAnchors("Plan.md")).toEqual([H("Goals")]);
  });

  it("refetches a path the watcher reports, and stays quiet when nothing changed", async () => {
    let answer = [H("Goals")];
    const fetch = vi.fn(async () => answer);
    configureAnchorCache("vault-a", fetch);
    const changed = vi.fn();
    onAnchorCacheChange(changed);
    cachedAnchors("Plan.md");
    await flush();
    anchorsChanged(["Plan.md"]);
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    answer = [H("Risks")];
    anchorsChanged(["PLAN.md", "Other.md"]);
    await flush();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(cachedAnchors("Plan.md")).toEqual([H("Risks")]);
  });

  it("a different vault empties it", async () => {
    configureAnchorCache("vault-a", async () => [H("A")]);
    cachedAnchors("Plan.md");
    await flush();
    configureAnchorCache("vault-b", async () => [H("B")]);
    expect(cachedAnchors("Plan.md")).toBeUndefined();
  });
});
