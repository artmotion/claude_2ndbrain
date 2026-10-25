// Small edits to a note that is NOT necessarily the one being typed in: a new
// ` ^block-id` for a link that just picked a block, or a renamed heading
// carried into every link that pointed at it.
//
// Two roads, and neither overwrites a CRDT with a whole file:
//   • the note is open in an editor → ONE editor transaction, which reaches its
//     Y.Text through yCollab exactly like typing (and undoes like typing);
//   • it is not → a compare-and-swap file write (`write_note` with the sha of
//     the bytes we planned against). The watcher then routes it through the
//     external-writer path every AI agent's write takes (`handleLocalFileChanged`
//     → `ingestFromFile`), which diff-merges it into the CRDT as operations.
//     A file that moved on between our read and our write answers `stale` and
//     the edit is planned again against the new bytes.
// A read-only or locked note is refused up front either way.

import type { EditorView } from "@codemirror/view";
import { type BlockCandidate, blockIdSuffix, extractAnchors } from "./anchors";

export type NoteEditResult = "written" | "unchanged" | "readonly" | "failed";

export interface NoteEditDeps {
  liveView(path: string): EditorView | null;
  readNote(path: string): Promise<string>;
  writeNote(path: string, text: string, expectedSha: string): Promise<"written" | "stale">;
  sha256(text: string): Promise<string>;
  /** Not read-only, not locked for this user. */
  canEdit(path: string): Promise<boolean>;
}

const MAX_ATTEMPTS = 3;

/** The one replacement that turns `a` into `b` (common prefix/suffix kept). */
export function minimalReplacement(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/**
 * Apply `plan` (current text → new text, or null for "nothing to do") to the
 * note at `path`.
 */
export async function editNoteText(
  path: string,
  plan: (text: string) => string | null,
  deps: NoteEditDeps,
): Promise<NoteEditResult> {
  const view = deps.liveView(path);
  if (view) {
    if (view.state.readOnly) return "readonly";
    const current = view.state.doc.toString();
    const next = plan(current);
    const change = next === null ? null : minimalReplacement(current, next);
    if (!change) return "unchanged";
    view.dispatch({ changes: change, userEvent: "input.links", scrollIntoView: false });
    return "written";
  }
  if (!(await deps.canEdit(path))) return "readonly";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let current: string;
    try {
      current = await deps.readNote(path);
    } catch {
      return "failed";
    }
    const next = plan(current);
    if (next === null || next === current) return "unchanged";
    try {
      const outcome = await deps.writeNote(path, next, await deps.sha256(current));
      if (outcome === "written") return "written";
    } catch {
      return "failed";
    }
  }
  return "failed";
}

/**
 * `text` with ` ^id` appended to the block a completion list offered as
 * `candidate`, or null when that block is gone. The block is found again in the
 * CURRENT text — by its line and preview, else by a preview no other id-less
 * block shares — because the note may have changed since the list was built.
 */
export function withBlockId(
  text: string,
  candidate: Pick<BlockCandidate, "line" | "preview">,
  id: string,
): string | null {
  const { candidates, blocks } = extractAnchors(text);
  if (blocks.some((b) => b.id.toLowerCase() === id.toLowerCase())) return null;
  let hit = candidates.find((c) => c.line === candidate.line && c.preview === candidate.preview);
  if (!hit) {
    const same = candidates.filter((c) => c.preview === candidate.preview);
    if (same.length === 1) hit = same[0];
  }
  if (!hit) return null;
  return text.slice(0, hit.insertAt) + blockIdSuffix(id) + text.slice(hit.insertAt);
}
