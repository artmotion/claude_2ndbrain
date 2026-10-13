import { describe, expect, it, vi } from "vitest";
import { installAppLifecycle } from "../appLifecycle";
import { platformClass } from "../platform";

function fakeDoc() {
  let listener: (() => void) | null = null;
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
  };
  return { doc, fire: (state: DocumentVisibilityState) => { doc.visibilityState = state; listener?.(); }, active: () => listener !== null };
}

describe("installAppLifecycle", () => {
  it("flushes when hidden and wakes sync when visible again", () => {
    const { doc, fire } = fakeDoc();
    const flush = vi.fn(async () => {});
    const wake = vi.fn();
    installAppLifecycle({ flush, wake, doc: doc as never });
    fire("hidden");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
    fire("visible");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("uninstalls its listener", () => {
    const { doc, active } = fakeDoc();
    const off = installAppLifecycle({ flush: async () => {}, wake: () => {}, doc: doc as never });
    expect(active()).toBe(true);
    off();
    expect(active()).toBe(false);
  });
});

describe("platformClass", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  it("tells an iPad (desktop UA + touch) from a Mac", () => {
    expect(platformClass(mac, 5)).toBe("ios");
    expect(platformClass(mac, 0)).toBe("macos");
  });
  it("recognises iPhone UAs and the other desktops", () => {
    expect(platformClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe("ios");
    expect(platformClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe("windows");
    expect(platformClass("Mozilla/5.0 (X11; Linux x86_64)", 0)).toBe("linux");
  });
});
