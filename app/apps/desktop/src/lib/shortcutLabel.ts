// SPDX-License-Identifier: Apache-2.0

/**
 * Keyboard shortcuts written the way the user's keyboard says them.
 *
 * Shortcuts are authored once in macOS notation (`⌘N`, `⌘⇧H`, `⌘⌥1`, `⇧⏎`) and
 * shown as-is on macOS and iPad (whose keyboards carry ⌘); everywhere else they
 * become `Ctrl+N`, `Ctrl+Shift+H`, `Ctrl+Alt+1`, `Shift+Enter`. The handlers
 * already accept Ctrl wherever they accept ⌘ (`App.tsx`, CodeMirror's `Mod-`),
 * so only the labels differ.
 */
import { platformClass, type Platform } from "./platform";

/** The platform stamped on `<html>` (`initPlatform`), else read from the UA. */
export function currentPlatform(): Platform {
  const stamped = typeof document !== "undefined" ? document.documentElement?.dataset.platform : undefined;
  if (stamped) return stamped as Platform;
  return typeof navigator !== "undefined" ? platformClass() : "other";
}

/** True where the primary modifier is ⌘ rather than Ctrl. */
export function usesCommandKey(platform: Platform = currentPlatform()): boolean {
  return platform === "macos" || platform === "ios";
}

const PC_NAMES: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⏎": "Enter" };

/** `⌘⇧H` on a Mac, `Ctrl+Shift+H` elsewhere. */
export function shortcutLabel(mac: string, platform: Platform = currentPlatform()): string {
  if (usesCommandKey(platform)) return mac;
  const parts = [...mac].map((ch) => PC_NAMES[ch] ?? ch);
  // Symbols are one character each; anything after them is the key itself.
  const mods: string[] = [];
  let i = 0;
  while (i < parts.length && Object.values(PC_NAMES).includes(parts[i])) mods.push(parts[i++]);
  const key = parts.slice(i).join("");
  return (key ? [...mods, key] : mods).join("+");
}

/** Rewrites every bold `**⌘…**` shortcut in a Markdown text for the platform. */
export function localizeShortcuts(text: string, platform: Platform = currentPlatform()): string {
  if (usesCommandKey(platform)) return text;
  return text.replace(/\*\*([⌘⌥⇧⏎][^*\s]*)\*\*/g, (_, keys: string) => `**${shortcutLabel(keys, platform)}**`);
}
