/**
 * Stamp the host platform onto `<html>` so CSS can react to it.
 *
 * Drives the macOS traffic-light inset and Windows custom window chrome. The
 * macOS window runs with `titleBarStyle: "Overlay"` (see `tauri.conf.json`), which
 * hands the webview the full window height and floats the close/minimise/zoom
 * buttons *over* our own top-left corner. Windows disables decorations before
 * reveal and renders caption buttons in React; Linux keeps its system titlebar.
 *
 * Read from the user agent rather than `@tauri-apps/plugin-os` on purpose: this
 * has to run synchronously before the first paint (an async platform lookup
 * would land a frame late and visibly shove the sidebar down), and it keeps the
 * bundle free of a plugin we'd otherwise pull in for one boolean.
 */
export type Platform = "macos" | "windows" | "linux" | "ios" | "other";

export function platformClass(
  ua: string = navigator.userAgent,
  maxTouchPoints: number = navigator.maxTouchPoints ?? 0,
): Platform {
  // iPadOS's WKWebView reports a desktop Mac user agent; a Mac has no touch
  // screen, so touch points are what tell the two apart. iPhone UAs say so.
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Mac OS X|Macintosh/.test(ua) && maxTouchPoints > 1) return "ios";
  // Apple Silicon still reports "Intel Mac OS X" in WKWebView, so match loosely.
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

/** True on iPad / iPhone (the Tauri iOS build). */
export function isIos(): boolean {
  return typeof navigator !== "undefined" && platformClass() === "ios";
}

export function initPlatform(): void {
  document.documentElement.dataset.platform = platformClass();
}
