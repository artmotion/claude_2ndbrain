// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { localizeShortcuts, shortcutLabel } from "../shortcutLabel";

describe("shortcutLabel", () => {
  it("keeps macOS notation on macOS and iPad", () => {
    expect(shortcutLabel("⌘⇧H", "macos")).toBe("⌘⇧H");
    expect(shortcutLabel("⌘N", "ios")).toBe("⌘N");
  });

  it("spells shortcuts out with Ctrl elsewhere", () => {
    expect(shortcutLabel("⌘N", "windows")).toBe("Ctrl+N");
    expect(shortcutLabel("⌘⇧H", "windows")).toBe("Ctrl+Shift+H");
    expect(shortcutLabel("⌘⌥1", "linux")).toBe("Ctrl+Alt+1");
    expect(shortcutLabel("⌘;", "windows")).toBe("Ctrl+;");
    expect(shortcutLabel("⇧⏎", "windows")).toBe("Shift+Enter");
  });
});

describe("localizeShortcuts", () => {
  const text = "Press **⌘G** to open it. | **⌘B** / **⌘I** | **⌘⌥1** … **⌘⌥6** | **Ctrl-Tab** | **bold**";

  it("rewrites only bold shortcuts", () => {
    expect(localizeShortcuts(text, "windows")).toBe(
      "Press **Ctrl+G** to open it. | **Ctrl+B** / **Ctrl+I** | **Ctrl+Alt+1** … **Ctrl+Alt+6** | **Ctrl-Tab** | **bold**",
    );
  });

  it("leaves macOS text untouched", () => {
    expect(localizeShortcuts(text, "macos")).toBe(text);
  });
});
