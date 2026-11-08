import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import type { EditorMenuItem } from "../lib/editor/contextMenu";
import { placeMenu, type Placement } from "../lib/menuPlacement";

/**
 * The note editor's right-click menu (items from `lib/editor/contextMenu.ts`).
 * Same anatomy as the app's other menus (`.context-menu`, portalled, placed on
 * screen by `placeMenu`, dismissed on outside mousedown / Escape / scroll /
 * resize), plus one flyout for the heading levels. Keyboard: arrows move,
 * Enter/Space choose, → opens the flyout and ← closes it, Escape closes all and
 * hands focus back to the editor.
 */
export function EditorContextMenu({
  view,
  x,
  y,
  items,
  onClose,
}: {
  view: EditorView;
  x: number;
  y: number;
  items: EditorMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLUListElement | null>(null);
  const subRef = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const [sub, setSub] = useState<{ key: string; top: number; left: number } | null>(null);

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) view.focus();
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setPos(
      placeMenu(
        { x, y },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y]);

  // The flyout sits beside its row, flipped to the left at the window's edge.
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!el || !sub) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const row = menuRef.current?.querySelector<HTMLElement>(`[data-key="${sub.key}"]`);
    const r = row?.getBoundingClientRect();
    if (!r) return;
    const left = r.right + width + 8 <= window.innerWidth ? r.right + 2 : Math.max(8, r.left - width - 2);
    const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - height - 8));
    if (left !== sub.left || top !== sub.top) setSub({ ...sub, left, top });
  }, [sub]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || subRef.current?.contains(t)) return;
      close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    const dismiss = (e: Event) => {
      if (e.type === "scroll" && e.target instanceof Node && (menuRef.current?.contains(e.target) || subRef.current?.contains(e.target))) return;
      close(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the first live item once placed, so the keyboard works at once.
  useEffect(() => {
    if (!pos) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [pos]);

  const openSub = (item: EditorMenuItem, focus: boolean) => {
    if (item.disabled || !item.children) return;
    setSub({ key: item.key, top: 0, left: 0 });
    if (focus) {
      requestAnimationFrame(() =>
        subRef.current?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')?.focus(),
      );
    }
  };

  const choose = (item: EditorMenuItem) => {
    if (item.disabled) return;
    if (item.children) return openSub(item, true);
    onClose();
    if (item.run) void item.run(view);
    else view.focus();
  };

  const moveFocus = (list: HTMLElement | null, e: React.KeyboardEvent) => {
    const rows = [...(list?.querySelectorAll<HTMLElement>("li[tabindex]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
      return true;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      rows[e.key === "Home" ? 0 : rows.length - 1]?.focus();
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      close(true);
      return true;
    }
    return false;
  };

  const row = (item: EditorMenuItem, inSub: boolean) => {
    const cls = [
      item.separated ? "menu-sep-item" : "",
      item.disabled ? "disabled" : "",
      item.checked ? "is-on" : "",
      item.children ? "has-sub" : "",
      sub?.key === item.key ? "sub-open" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li
        key={item.key}
        data-key={item.key}
        role={inSub ? "menuitemradio" : "menuitem"}
        aria-checked={inSub ? Boolean(item.checked) : undefined}
        aria-disabled={item.disabled || undefined}
        aria-haspopup={item.children ? "menu" : undefined}
        aria-expanded={item.children ? sub?.key === item.key : undefined}
        tabIndex={-1}
        className={`editor-menu-row${cls ? ` ${cls}` : ""}`}
        onMouseEnter={() => {
          if (inSub) return;
          if (item.children) openSub(item, false);
          else if (sub) setSub(null);
        }}
        onClick={() => choose(item)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choose(item);
          } else if (!inSub && e.key === "ArrowRight" && item.children) {
            e.preventDefault();
            openSub(item, true);
          } else if (inSub && e.key === "ArrowLeft") {
            e.preventDefault();
            const key = sub?.key;
            setSub(null);
            menuRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
          }
        }}
      >
        <span className="menu-tick" aria-hidden="true">
          {item.checked ? "✓" : ""}
        </span>
        <span className="editor-menu-label">{item.label}</span>
        {item.shortcut && <span className="editor-menu-shortcut">{item.shortcut}</span>}
        {item.children && (
          <span className="editor-menu-chevron" aria-hidden="true">
            ›
          </span>
        )}
      </li>
    );
  };

  const subItem = sub ? items.find((i) => i.key === sub.key) : undefined;

  return createPortal(
    <>
      <ul
        ref={menuRef}
        className="context-menu menu-portal editor-context-menu"
        role="menu"
        aria-label="Edit"
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (moveFocus(menuRef.current, e)) return;
        }}
        style={
          pos
            ? { position: "fixed", left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
            : { position: "fixed", left: 0, top: 0, visibility: "hidden" }
        }
      >
        {items.map((item) => row(item, false))}
      </ul>
      {subItem?.children && (
        <ul
          ref={subRef}
          className="context-menu menu-portal editor-context-menu editor-context-submenu"
          role="menu"
          aria-label={subItem.label}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (moveFocus(subRef.current, e)) return;
          }}
          style={{
            position: "fixed",
            left: sub!.left,
            top: sub!.top,
            visibility: sub!.left || sub!.top ? "visible" : "hidden",
          }}
        >
          {subItem.children.map((item) => row(item, true))}
        </ul>
      )}
    </>,
    document.body,
  );
}
