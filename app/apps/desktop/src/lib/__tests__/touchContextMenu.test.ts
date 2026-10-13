import { afterEach, describe, expect, it, vi } from "vitest";
import { installLongPressContextMenu, LONG_PRESS_MS } from "../touchContextMenu";

class FakeMouseEvent {
  constructor(public type: string, public init: Record<string, unknown>) {}
}

function setup() {
  const listeners = new Map<string, (e: Event) => void>();
  const root = {
    addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  let pending: (() => void) | null = null;
  const dispatched: FakeMouseEvent[] = [];
  const row = {
    closest: (sel: string) => (sel.includes(".cm-editor") ? null : row),
    dispatchEvent: (e: FakeMouseEvent) => dispatched.push(e),
  };
  const editor = { closest: () => editor, dispatchEvent: vi.fn() };
  installLongPressContextMenu({
    root,
    setTimer: (fn) => ((pending = fn), 1),
    clearTimer: () => (pending = null),
  });
  const touch = (type: string, target: unknown, x = 10, y = 10, n = 1) =>
    listeners.get(type)!({ target, touches: n ? [{ clientX: x, clientY: y }] : [] } as never);
  return { listeners, dispatched, row, editor, touch, fire: () => pending?.(), hasTimer: () => pending !== null };
}

describe("installLongPressContextMenu", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a held press dispatches contextmenu at the touch point and eats the next click", () => {
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    const s = setup();
    s.touch("touchstart", s.row, 40, 60);
    expect(s.hasTimer()).toBe(true);
    s.fire();
    expect(s.dispatched).toHaveLength(1);
    expect(s.dispatched[0].type).toBe("contextmenu");
    expect(s.dispatched[0].init).toMatchObject({ clientX: 40, clientY: 60 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    s.listeners.get("click")!(click as never);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(LONG_PRESS_MS).toBeGreaterThan(300);
  });

  it("moving the finger cancels it, and the editor keeps its own long press", () => {
    const s = setup();
    s.touch("touchstart", s.row, 10, 10);
    s.touch("touchmove", s.row, 40, 10);
    expect(s.hasTimer()).toBe(false);
    s.touch("touchstart", s.editor);
    expect(s.hasTimer()).toBe(false);
  });
});
