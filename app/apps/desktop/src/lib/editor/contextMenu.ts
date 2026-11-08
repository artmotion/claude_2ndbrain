// What a right-click in the note editor offers: the clipboard, the everyday
// markdown formats, headings H1–H6, a link, a table, and find & replace.
//
// Pure model: items are plain data plus a `run(view)`, so the menu component
// (`components/EditorContextMenu.tsx`) stays a renderer and every rule here —
// what is offered, what is disabled, which heading is ticked — is a unit test.
// Each action is the same command its keyboard shortcut runs, so the menu and
// the keys can never disagree, and every edit is an ordinary editor
// transaction (it reaches the Y.Text through yCollab and undoes like typing).

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { shortcutLabel, usesCommandKey } from "../shortcutLabel";
import type { Platform } from "../platform";
import { openFind, openReplace } from "./findReplace";
import { headingLevelAt, insertLink, insertTable, setHeading, toggleInline, toggleWrap } from "./formatting";

export interface EditorMenuItem {
  key: string;
  label: string;
  /** The shortcut that does the same, as this keyboard writes it. */
  shortcut?: string;
  disabled?: boolean;
  /** Ticked (the current heading level). */
  checked?: boolean;
  /** Draw a rule above this item. */
  separated?: boolean;
  /** A submenu (headings). */
  children?: EditorMenuItem[];
  run?: (view: EditorView) => void | Promise<void>;
}

export interface EditorMenuContext {
  /** A `.txt` note: no markdown, so no formatting entries. */
  plain: boolean;
  platform?: Platform;
  /** Reads the clipboard for Paste; rejects where the webview will not. */
  readClipboard?: () => Promise<string>;
  /** Told when Paste could not read the clipboard (say: use the shortcut). */
  onPasteUnavailable?: () => void;
}

/** Run a document command (cut/copy) on the editor's own selection. */
function exec(view: EditorView, command: "cut" | "copy"): void {
  view.focus();
  document.execCommand(command);
}

async function paste(view: EditorView, ctx: EditorMenuContext): Promise<void> {
  view.focus();
  try {
    const text = await (ctx.readClipboard ?? (() => navigator.clipboard.readText()))();
    if (!text || view.state.readOnly) return;
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  } catch {
    ctx.onPasteUnavailable?.();
  }
}

/** Run an editor command after giving the editor back its focus. */
function command(fn: (view: EditorView) => boolean) {
  return (view: EditorView) => {
    view.focus();
    fn(view);
  };
}

export function editorMenuItems(view: EditorView, ctx: EditorMenuContext): EditorMenuItem[] {
  const { state } = view;
  const ro = state.readOnly;
  const empty = state.selection.ranges.every((r) => r.empty);
  const key = (mac: string) => shortcutLabel(mac, ctx.platform);
  const items: EditorMenuItem[] = [
    { key: "cut", label: "Cut", shortcut: key("⌘X"), disabled: ro || empty, run: (v) => exec(v, "cut") },
    { key: "copy", label: "Copy", shortcut: key("⌘C"), disabled: empty, run: (v) => exec(v, "copy") },
    { key: "paste", label: "Paste", shortcut: key("⌘V"), disabled: ro, run: (v) => paste(v, ctx) },
  ];

  if (!ctx.plain) {
    const level = headingLevelAt(state);
    items.push(
      { key: "bold", label: "Bold", shortcut: key("⌘B"), disabled: ro, separated: true, run: command(toggleInline("**")) },
      { key: "italic", label: "Italic", shortcut: key("⌘I"), disabled: ro, run: command(toggleInline("*")) },
      { key: "underline", label: "Underline", shortcut: key("⌘U"), disabled: ro, run: command(toggleWrap("<u>", "</u>")) },
      {
        key: "heading",
        label: "Heading",
        disabled: ro,
        children: [
          ...[1, 2, 3, 4, 5, 6].map((n) => ({
            key: `h${n}`,
            label: `Heading ${n}`,
            shortcut: key(`⌘⌥${n}`),
            checked: level === n,
            // The command toggles: the level a line already has clears it, so
            // a ticked level stays put instead of dropping to body text.
            run: level === n ? undefined : command(setHeading(n)),
          })),
          {
            key: "h0",
            label: "Normal text",
            separated: true,
            checked: level === 0,
            run: level === 0 ? undefined : command(setHeading(level)),
          },
        ],
      },
      { key: "link", label: "Insert link", shortcut: key("⌘K"), disabled: ro, separated: true, run: command(insertLink) },
      { key: "table", label: "Insert table", disabled: ro, run: command(insertTable) },
    );
  }

  items.push(
    { key: "find", label: "Find in note", shortcut: key("⌘F"), separated: true, run: command(openFind) },
    {
      key: "replace",
      label: "Find and replace",
      // ⌘H hides the app on a Mac before the webview sees it.
      shortcut: usesCommandKey(ctx.platform) ? "⌘⌥F" : "Ctrl+H",
      disabled: ro,
      run: command(openReplace),
    },
  );
  return items;
}

/**
 * Where a right-click should leave the caret: inside an existing selection it
 * stays (the menu acts on it), anywhere else it moves to the clicked spot, like
 * every text editor.
 */
export function placeCaretForMenu(view: EditorView, x: number, y: number): void {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return;
  const inside = view.state.selection.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
  if (!inside) view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: "select.pointer" });
}
