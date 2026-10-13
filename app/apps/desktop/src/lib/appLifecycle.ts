// SPDX-License-Identifier: Apache-2.0
//
// Foreground / background handling. iOS suspends a backgrounded app within
// seconds and may terminate it without another event, and its sockets die
// while it is suspended. So when the page is hidden we write any pending
// (debounced) edit to disk now, and when it is visible again we reconnect the
// vault channel instead of waiting out its backoff. Harmless on desktop, where
// "hidden" means minimised or on another space.

export interface LifecycleDeps {
  /** Write the open note's pending egest to disk. */
  flush: () => Promise<void>;
  /** Reconnect sync now that the app is in the foreground. */
  wake: () => void;
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

/** Install the listeners; returns the uninstaller. */
export function installAppLifecycle({ flush, wake, doc = document }: LifecycleDeps): () => void {
  const onChange = () => {
    if (doc.visibilityState === "hidden") {
      flush().catch((e) => console.warn("[lifecycle] flush on background failed", e));
    } else if (doc.visibilityState === "visible") {
      wake();
    }
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}
