// The index's headings and block ids per note, for the editor's link
// decorations: is the heading a `[[Note#Heading]]` names still there, and what
// does the block behind `[[Note#^id]]` say? Decorations are synchronous, so
// this answers from memory and fetches in the background; a listener (the
// editor) repaints when an answer arrives or changes.
//
// Entries are refreshed after `STALE_MS` and dropped when the watcher reports
// the note changed, so an edit in another note shows up without a reload.

import type { IndexedAnchor } from "../ipc";

const STALE_MS = 10_000;

type Fetch = (path: string) => Promise<IndexedAnchor[]>;

interface Entry {
  anchors: IndexedAnchor[] | undefined;
  at: number;
  inflight: boolean;
}

let fetcher: Fetch | null = null;
let scope: string | null = null;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const key = (path: string) => path.toLowerCase();

const sameAnchors = (a: IndexedAnchor[] | undefined, b: IndexedAnchor[]) =>
  a !== undefined &&
  a.length === b.length &&
  a.every((x, i) => x.kind === b[i]!.kind && x.key === b[i]!.key && x.text === b[i]!.text);

function notify(): void {
  for (const l of [...listeners]) l();
}

function refresh(path: string, entry: Entry): void {
  if (!fetcher || entry.inflight) return;
  entry.inflight = true;
  const myScope = scope;
  fetcher(path)
    .then((anchors) => {
      if (scope !== myScope) return;
      const changed = !sameAnchors(entry.anchors, anchors);
      entry.anchors = anchors;
      entry.at = Date.now();
      if (changed) notify();
    })
    .catch(() => {
      entry.at = Date.now();
    })
    .finally(() => {
      entry.inflight = false;
    });
}

/** Point the cache at a vault (any change of `vaultKey` empties it). */
export function configureAnchorCache(vaultKey: string | null, fetch: Fetch): void {
  if (vaultKey !== scope) entries.clear();
  scope = vaultKey;
  fetcher = fetch;
}

/** The anchors of `path` if known (possibly a little stale), else undefined —
 *  either way a background fetch is started when one is due. */
export function cachedAnchors(path: string): IndexedAnchor[] | undefined {
  let entry = entries.get(key(path));
  if (!entry) {
    entry = { anchors: undefined, at: 0, inflight: false };
    entries.set(key(path), entry);
  }
  if (Date.now() - entry.at > STALE_MS) refresh(path, entry);
  return entry.anchors;
}

/** The watcher saw these paths change: fetch them again now. */
export function anchorsChanged(paths: readonly string[]): void {
  for (const p of paths) {
    const entry = entries.get(key(p));
    if (!entry) continue;
    entry.at = 0;
    refresh(p, entry);
  }
}

/** Repaint hook. Returns the unsubscribe. */
export function onAnchorCacheChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test helper. */
export function resetAnchorCache(): void {
  entries.clear();
  listeners.clear();
  fetcher = null;
  scope = null;
}
