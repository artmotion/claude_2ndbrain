// SPDX-License-Identifier: Apache-2.0
//
// Long-press → context menu on touch screens. iPadOS's WKWebView never fires
// `contextmenu` for a long press, so every row/tab menu in the app (which
// listen for `contextmenu`) would be unreachable. A press held still for
// LONG_PRESS_MS dispatches a synthetic `contextmenu` at the touch point and
// swallows the click that the lifting finger would otherwise produce.
// Inside the editor a long press keeps its native meaning (text selection).

export const LONG_PRESS_MS = 500;
/** Finger travel (px) that turns a press into a scroll/drag. */
export const LONG_PRESS_SLOP = 10;

type Listener = (e: Event) => void;
interface Target {
  addEventListener(type: string, fn: Listener, opts?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, fn: Listener, opts?: boolean | EventListenerOptions): void;
}

export interface LongPressDeps {
  root?: Target;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const EXCLUDE = ".cm-editor, input, textarea, [contenteditable='true']";

export function installLongPressContextMenu({
  root = document,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}: LongPressDeps = {}): () => void {
  let timer: unknown = null;
  let start: { x: number; y: number } | null = null;
  let swallowClick = false;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    start = null;
  };

  const onStart = (e: Event) => {
    const te = e as TouchEvent;
    cancel();
    if (te.touches.length !== 1) return;
    const el = te.target as Element | null;
    if (!el || typeof el.closest !== "function" || el.closest(EXCLUDE)) return;
    const t = te.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimer(() => {
      timer = null;
      if (!start) return;
      swallowClick = true;
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: start.x,
          clientY: start.y,
          button: 2,
        }),
      );
      start = null;
    }, LONG_PRESS_MS);
  };

  const onMove = (e: Event) => {
    if (!start) return;
    const t = (e as TouchEvent).touches[0];
    if (!t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > LONG_PRESS_SLOP) cancel();
  };

  const onClick = (e: Event) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const passive = { passive: true, capture: true } as const;
  root.addEventListener("touchstart", onStart, passive);
  root.addEventListener("touchmove", onMove, passive);
  root.addEventListener("touchend", cancel, passive);
  root.addEventListener("touchcancel", cancel, passive);
  root.addEventListener("click", onClick, true);
  return () => {
    cancel();
    root.removeEventListener("touchstart", onStart, passive);
    root.removeEventListener("touchmove", onMove, passive);
    root.removeEventListener("touchend", cancel, passive);
    root.removeEventListener("touchcancel", cancel, passive);
    root.removeEventListener("click", onClick, true);
  };
}
