import { useEffect, useRef, useState } from "react";
import { groupBacklinks } from "../lib/links/backlinkAnchors";
import { noteLabel } from "../lib/notePath";
import { useStore } from "../store";

/**
 * Backlinks as a floating pill in the note's bottom-right corner (the bottom
 * twin of the header's floating controls), opening a card of linking notes
 * above it. It used to be a full-width strip under the editor whose top rule
 * never lined up with the sidebar footer's; floating, it has no rule at all
 * and the note keeps its full height. Hidden while nothing links here.
 */
export function BacklinksPanel() {
  const backlinks = useStore((s) => s.backlinks);
  const openNote = useStore((s) => s.openNote);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const notePath = openNote?.path;

  // A different note has different backlinks: never carry an open card over.
  useEffect(() => setOpen(false), [notePath]);

  // Close on outside click or Escape (the AccountMenu popover pattern).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only markdown notes participate in wikilinks; HTML pages have no backlinks.
  if (!notePath || /\.html?$/i.test(notePath) || backlinks.length === 0) return null;

  const currentLabel = noteLabel(notePath);
  // One row per linking note; the headings/blocks of THIS note it points at
  // (`[[Note#Goals]]`, `[[Note#^id]]`) ride along as "→ Goals".
  const groups = groupBacklinks(backlinks, currentLabel);
  const count = groups.length;
  return (
    <div className="backlinks-float" ref={rootRef}>
      {open && (
        <div className="account-popover backlinks-popover" role="menu" aria-label="Backlinks">
          <div className="backlinks-popover-head">
            <span className="subhead">Linked from</span>
            <span className="backlinks-popover-count">{count.toLocaleString()}</span>
          </div>
          <ul className="backlinks-list">
            {groups.map((g) => {
              const folder = g.path.includes("/") ? g.path.slice(0, g.path.lastIndexOf("/")) : null;
              const meta = [
                folder,
                g.targets.length ? `→ ${g.targets.join(", ")}` : null,
                g.aliases.length ? `as “${g.aliases.join("”, “")}”` : null,
              ].filter(Boolean);
              return (
                <li
                  key={g.id}
                  className="backlink"
                  role="menuitem"
                  title={g.path}
                  onClick={() => {
                    setOpen(false);
                    void useStore.getState().openNoteByPath(g.path);
                  }}
                >
                  <svg className="backlink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 3v5h5M9 13h6M9 17h4" />
                  </svg>
                  <span className="backlink-copy">
                    {/* The file name, like the tab and the sidebar — `b.title`
                        is the INDEXED title, which for a note with an H1 or a
                        frontmatter `title:` names the same note differently. */}
                    <span className="backlink-title">
                      {noteLabel(g.path)}
                      {g.count > 1 && <span className="backlink-times"> ×{g.count}</span>}
                    </span>
                    {meta.length > 0 && <span className="backlink-meta">{meta.join(" · ")}</span>}
                  </span>
                  <span className="backlink-go" aria-hidden="true">
                    ›
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button
        type="button"
        className={`backlinks-pill${open ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
        {count === 1 ? "1 backlink" : `${count.toLocaleString()} backlinks`}
      </button>
    </div>
  );
}
