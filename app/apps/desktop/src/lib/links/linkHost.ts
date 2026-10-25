// Production wiring for the editor's `LinkHost` and for `editNoteText`:
// IPC, the live editor registry, locks and the read-only doc set. Kept apart
// from the pure modules beside it so those stay testable without Tauri.

import { liveView } from "../../components/liveEditorViews";
import { isReadOnlyDoc } from "../bridge/readOnlyDocs";
import { sha256Hex } from "../bridge/adapter";
import type { LinkHost } from "../editor/wikilinks";
import { viewerFor } from "../formats";
import * as ipc from "../ipc";
import { effectiveLockForPath, lockScopesByPath } from "../locks";
import { noteLabel } from "../notePath";
import { toast } from "../toast";
import { useStore } from "../../store";
import { renameHeadingLinks } from "./anchors";
import { cachedAnchors } from "./anchorCache";
import { backlinksToHeading } from "./backlinkAnchors";
import { type NoteEditDeps, editNoteText, withBlockId } from "./noteEdit";
import type { HeadingLinkHost } from "../editor/headingLinks";

/** Not padlocked for this user and not known read-only. */
export async function canEditNotePath(path: string): Promise<boolean> {
  const st = useStore.getState();
  if (
    st.syncEnabled &&
    effectiveLockForPath(lockScopesByPath(st.tree, st.locks, st.session?.user.id, st.lifts), path) != null
  ) {
    return false;
  }
  const meta = await ipc.getNoteMeta(path).catch(() => null);
  return !(meta && isReadOnlyDoc(meta.id));
}

export function noteEditDeps(epoch?: ipc.VaultEpoch): NoteEditDeps {
  return {
    liveView,
    readNote: (path) => ipc.readNote(path, epoch),
    writeNote: (path, text, expectedSha) => ipc.writeNote(path, text, epoch, undefined, expectedSha),
    sha256: sha256Hex,
    canEdit: canEditNotePath,
  };
}

export function createLinkHost(selfPath: string, epoch?: ipc.VaultEpoch): LinkHost {
  const deps = noteEditDeps(epoch);
  return {
    selfPath,
    async loadNote(target) {
      const resolved = await ipc.resolveWikilink(target).catch(() => null);
      if (!resolved || viewerFor(resolved.path) !== "editor") return null;
      const live = liveView(resolved.path);
      if (live) {
        return { path: resolved.path, text: live.state.doc.toString(), editable: !live.state.readOnly };
      }
      const [text, editable] = await Promise.all([
        ipc.readNote(resolved.path, epoch),
        canEditNotePath(resolved.path),
      ]);
      return { path: resolved.path, text, editable };
    },
    async addBlockId(path, candidate, id) {
      const result = await editNoteText(path, (text) => withBlockId(text, candidate, id), deps);
      return result === "written";
    },
    indexedAnchors: cachedAnchors,
    onBlockIdFailed(path) {
      toast(`Couldn't add a block id in “${noteLabel(path)}” — that link points nowhere yet`, "error");
    },
  };
}

/** The names a `[[…]]` may use for the note at `path`: its path without `.md`
 *  and its indexed title (its stem is checked by the caller). */
function namesFor(path: string): string[] {
  const title = useStore.getState().titles.find((t) => t.path.toLowerCase() === path.toLowerCase())?.title;
  return [path.replace(/\.md$/i, ""), ...(title ? [title] : [])];
}

/**
 * Carry a renamed heading of `selfPath` into every OTHER note whose backlinks
 * point at it, one CRDT-safe edit per note; read-only notes are skipped. Says
 * what happened in one toast.
 */
export async function renameHeadingInLinkingNotes(
  selfPath: string,
  from: string,
  to: string,
  epoch?: ipc.VaultEpoch,
): Promise<{ links: number; notes: number; skipped: number }> {
  const deps = noteEditDeps(epoch);
  const stem = noteLabel(selfPath).toLowerCase();
  const names = new Set(namesFor(selfPath).map((n) => n.toLowerCase()));
  const isTarget = (t: string) => {
    const lower = t.toLowerCase().replace(/\.md$/, "");
    return lower === stem || lower.slice(lower.lastIndexOf("/") + 1) === stem || names.has(lower);
  };
  const paths = [
    ...new Set(
      backlinksToHeading(useStore.getState().backlinks, from)
        .map((b) => b.path)
        .filter((p) => p.toLowerCase() !== selfPath.toLowerCase()),
    ),
  ];
  let links = 0;
  let notes = 0;
  let skipped = 0;
  for (const path of paths) {
    let count = 0;
    const result = await editNoteText(
      path,
      (text) => {
        const r = renameHeadingLinks(text, isTarget, from, to);
        count = r.count;
        return r.count ? r.text : null;
      },
      deps,
    );
    if (result === "written") {
      links += count;
      notes++;
    } else if (result === "readonly" || result === "failed") {
      skipped++;
    }
  }
  if (notes > 0 || skipped > 0) {
    const done = `Updated ${links === 1 ? "1 link" : `${links} links`} in ${notes === 1 ? "1 note" : `${notes} notes`}`;
    const rest = skipped ? ` · ${skipped === 1 ? "1 note" : `${skipped} notes`} could not be changed (read-only)` : "";
    toast(`${done}${rest}`, skipped && notes === 0 ? "error" : "success");
  }
  return { links, notes, skipped };
}

export function createHeadingLinkHost(selfPath: string, epoch?: ipc.VaultEpoch): HeadingLinkHost {
  return {
    selfPath,
    getBacklinks: () => useStore.getState().backlinks,
    selfNames: () => namesFor(selfPath),
    renameLinks: async (from, to) => {
      await renameHeadingInLinkingNotes(selfPath, from, to, epoch);
    },
  };
}
