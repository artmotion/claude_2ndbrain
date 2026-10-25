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
import { cachedAnchors } from "./anchorCache";
import { type NoteEditDeps, editNoteText, withBlockId } from "./noteEdit";

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
