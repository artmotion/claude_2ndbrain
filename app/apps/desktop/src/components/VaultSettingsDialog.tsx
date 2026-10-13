/* The vault-settings dialog and its nine tabs — the whole settings surface of
   the app, split out of `AccountMenu.tsx` so it can load on demand. Nothing
   here is on the first screen: the sidebar footer (identity bar + popovers)
   stays eager, and this chunk lands when someone actually opens settings. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type McpToolInfo,
  type McpTokenRow,
  type UnsyncPreview,
  type VaultCheckpoint,
} from "../lib/api";
import { toast } from "../lib/toast";
import { agoFromIso, checkpointTitle, noteCountLabel } from "./versionFormat";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { MembersAccessTab, prefetchRoster } from "./MembersAccessTab";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { useResetLocalCopy } from "./useResetLocalCopy";
import { AiSettingsTab } from "./AiSettingsTab";
import { MenuIcon } from "./MenuIcon";
import { SettingsModal } from "./SettingsModal";
import { SettingsCrossLink } from "./SettingsCrossLink";
import { Switch } from "./Switch";
import { ThemeToggle } from "./ThemeToggle";
import { AppearanceRows } from "./AppearanceRows";
import {
  APPEARANCE_DEFAULTS,
  vaultAppearanceValues,
  type AppearanceKey,
  type AppearanceSettings,
  type ResolvedAppearance,
} from "../lib/appearanceSettings";
import { useLocalFolderClasses, useLocalVaults } from "./useVaultLists";
import { visibleFolders } from "../lib/vault/vaultList";
import { VaultIconSettings } from "./VaultIconSettings";
import { VaultDashboardsTab } from "./VaultDashboardsTab";
import { AccountVaultsTab } from "./AccountVaultsTab";

// Defined in `lib/settingsTabs.ts` so the store can name a tab without importing
// this component; re-exported here so every existing importer is unchanged.
export type { SettingsTab } from "../lib/settingsTabs";
import type { SettingsTab } from "../lib/settingsTabs";

// Sections that only make sense once the vault is synced to an org. On a
// local vault they're shown but locked, with a "Turn on sync" gate.
const TEAM_TABS = new Set<SettingsTab>([
  "members",
  "mcp",
  "versioning",
]);

/** General tab: name, folder, and sync state (incl. the Turn-on-sync CTA). */
const GENERAL_TAB: { id: SettingsTab; label: string; icon: React.ReactNode } = {
  id: "general",
  label: "General",
  icon: (
    <MenuIcon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </MenuIcon>
  ),
};

/** The AI (Beta) page is hidden for now; flip to bring it back. Anything that
 *  asks for the "ai" tab while it is hidden lands on General instead. */
const SHOW_AI_TAB = false;

const AI_TAB: { id: SettingsTab; label: string; icon: React.ReactNode } = {
  id: "ai", label: "AI", icon: <MenuIcon><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></MenuIcon>,
};

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  {
    id: "vaults",
    label: "Vaults",
    icon: (
      <MenuIcon>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </MenuIcon>
    ),
  },
  {
    id: "members",
    label: "Members and access",
    icon: (
      <MenuIcon>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </MenuIcon>
    ),
  },
  { id: "dashboards", label: "Dashboards", icon: <MenuIcon><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></MenuIcon> },
  {
    id: "mcp",
    label: "MCP",
    icon: (
      <MenuIcon>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </MenuIcon>
    ),
  },
  {
    id: "versioning",
    label: "Versioning",
    icon: (
      <MenuIcon>
        <path d="M3 12a9 9 0 1 0 2.6-6.4" />
        <path d="M3 4v4h4" />
        <path d="M12 8v4l3 2" />
      </MenuIcon>
    ),
  },
  {
    id: "import-export",
    label: "Import / Export",
    icon: (
      <MenuIcon>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </MenuIcon>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <MenuIcon>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a10 10 0 0 1 0 20 5 5 0 0 1 0-10 5 5 0 0 0 0-10" />
      </MenuIcon>
    ),
  },
];

/**
 * Vault settings — a centered modal over the app (sharing its shell with
 * Account settings via {@link SettingsModal}): everything about the vault lives
 * here. Members (roster + join code + invites), Permissions (RBAC locks), and
 * Appearance (the vault's appearance defaults).
 */
export function VaultSettingsDialog({
  onClose,
  onRequestSignIn,
  initialTab,
}: {
  onClose: () => void;
  onRequestSignIn?: () => void;
  initialTab?: SettingsTab;
}) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locals = useLocalVaults();

  const visibleTab = (t: SettingsTab): SettingsTab =>
    (!SHOW_AI_TAB && t === "ai") || (t === "vaults" && session) ? "general" : t;
  const [tab, setTabRaw] = useState<SettingsTab>(visibleTab(initialTab ?? "general"));
  /** Bumped when the active nav item is clicked again, so a tab can return to its first page. */
  const [tabReset, setTabReset] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [tab, tabReset]);
  const setTab = (t: SettingsTab) => setTabRaw(visibleTab(t));

  // Esc, click-away, focus and the backdrop all live in `SettingsModal`.
  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  // Is the vault we're looking at actually syncing to an org? A local
  // vault (signed out, or an unsynced local folder) shows a reduced page
  // with the team sections locked behind "Turn on sync".
  const isSynced = syncEnabled && !!activeOrg;

  // The vault list lives in Account Settings → Vaults (2026-10-07). Only a
  // signed-out app with local folders keeps it here: it has no account page.
  // Signed out every stamped folder is hidden there (`visibleFolders`), so the
  // tab appears only when an unstamped local folder remains to list.
  const localClasses = useLocalFolderClasses(session ? [] : locals, []);
  const showVaults =
    !session &&
    localClasses.resolved &&
    visibleFolders(locals, localClasses.classes).length > 0;
  const tabs = useMemo(() => {
    const out = SHOW_AI_TAB ? [GENERAL_TAB, AI_TAB] : [GENERAL_TAB];
    if (showVaults) out.push(...SETTINGS_TABS);
    else out.push(...SETTINGS_TABS.filter((t) => t.id !== "vaults"));
    return out;
  }, [showVaults]);

  // Warm the Members tab's roster as the dialog opens (#307); paint only.
  useEffect(() => {
    const orgId = session?.activeOrganizationId ?? null;
    const me = members.find((m) => m.userId === session?.user.id);
    if (!orgId || !me) return;
    prefetchRoster(orgId, me.role === "owner" || me.role === "admin");
  }, [session, members]);

  if (!session && !vault) return null;
  const myMember = members.find((m) => m.userId === session?.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  // Stricter than `canManage`: making a vault local only destroys the server
  // copy for everyone, so an admin may not do it (the server agrees — 403
  // `owner_only`) and the control simply isn't drawn for them.
  const isOwner = myMember?.role === "owner";
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const lockedTab = TEAM_TABS.has(activeTab.id) && !isSynced;
  // Render what the nav shows: a requested tab that is not offered yet (the
  // signed-out Vaults list before the recents load) paints the first tab.
  const shown = activeTab.id;

  return (
    <SettingsModal
      label={isSynced ? "Vault settings" : "Local vault settings"}
      onClose={onClose}
    >
      <header className="settings-page-header">
        <div className="settings-title">
          <span className="settings-eyebrow">
            {isSynced ? "Vault settings" : "Local vault"}
          </span>
          {/* The session's active org outlives a switch to a local folder, so
              its name only titles the dialog while that vault is the synced one. */}
          <h1>{(isSynced ? activeOrg?.name : null) ?? vault?.name ?? "Vault"}</h1>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map((t) => {
            const locked = TEAM_TABS.has(t.id) && !isSynced;
            return (
              <button
                key={t.id}
                type="button"
                className={`menu-item${t.id === "ai" ? " settings-ai-item" : ""}${tab === t.id ? " active" : ""}${locked ? " locked" : ""}`}
                onClick={() => {
                  // Re-clicking the active item resets its sub-pages (#308).
                  if (tab === t.id) setTabReset((n) => n + 1);
                  else setTab(t.id);
                }}
                title={locked ? "Turn on sync to unlock" : undefined}
              >
                {t.icon}
                <span className="menu-item-label">{t.id === "ai" ? "AI (Beta)" : t.label}</span>
                {locked && (
                  <svg
                    className="nav-lock"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                )}
              </button>
            );
          })}
          {session && (
            <SettingsCrossLink
              label="Account settings"
              onOpen={() => useStore.getState().requestAccountSettings("profile")}
            />
          )}
        </nav>

        <section ref={contentRef} className="settings-content" aria-label={activeTab.label}>
          {/* Members and access swaps its title for a back link while a profile
              is open. */}
          {!(shown === "members" && !lockedTab) && <h2 className="settings-section-title">{activeTab.label}</h2>}
          {shown === "general" ? (
            <GeneralTab
              isSynced={isSynced}
              canManage={canManage}
              isOwner={isOwner}
              activeOrgName={activeOrg?.name ?? null}
              onRequestSignIn={onRequestSignIn}
            />
          ) : shown === "dashboards" ? (
            <VaultDashboardsTab onClose={onClose} resetToken={tabReset} />
          ) : shown === "ai" ? (
            <AiSettingsTab onClose={onClose} onGoToGeneral={() => setTab("general")} />
          ) : lockedTab ? (
            <SyncGate label={activeTab.label} onGoToSync={() => setTab("general")} />
          ) : shown === "vaults" ? (
            <AccountVaultsTab />
          ) : shown === "members" ? (
            <MembersAccessTab
              canManage={canManage}
              onOpenTab={setTab}
              onCloseSettings={onClose}
              resetToken={tabReset}
            />
          ) : shown === "mcp" ? (
            <McpTab />
          ) : shown === "versioning" ? (
            <VersioningTab canManage={canManage} />
          ) : shown === "import-export" ? (
            <ImportExportTab />
          ) : (
            <AppearanceTab canManage={canManage} isSynced={isSynced} />
          )}
        </section>
      </div>
    </SettingsModal>
  );
}

/**
 * General tab: the identity of the current vault. Its heart is the
 * Turn-on-sync card for a local vault — which adopts the folder you're
 * already in (files and all) rather than making you set up a new one.
 */
function GeneralTab({
  isSynced,
  canManage,
  isOwner,
  activeOrgName,
  onRequestSignIn,
}: {
  isSynced: boolean;
  /** Owner/admin — the only roles that may flip a vault-wide latch. */
  canManage: boolean;
  /** Owner alone — the only role that may destroy the server copy. */
  isOwner: boolean;
  activeOrgName: string | null;
  onRequestSignIn?: () => void;
}) {
  const vault = useStore((s) => s.vault);
  const authStatus = useStore((s) => s.authStatus);
  // The sidebar paints before the session restore finishes, so this page can be
  // open while we still don't know whether anyone is signed in.
  const authPending = authStatus === "unknown";
  const activeOrgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  // Same identity the sidebar switcher keys its icons on.
  const iconIdentity =
    isSynced && activeOrgId ? `org:${activeOrgId}` : vault ? `local:${vault.path}` : null;

  const [name, setName] = useState(vault?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnOn = async () => {
    if (authStatus !== "signed-in") {
      // Not signed in yet — launch sign-in right here instead of dead-ending.
      // After sign-in the button becomes "Turn on sync" (the page stays open).
      onRequestSignIn?.();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().turnOnSyncForCurrentVault(name.trim() || undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // The inline line can be scrolled out of view, and the button simply
      // returns to idle — which reads as "nothing happened". A sticky toast is
      // always visible (#85).
      toast(`Couldn't turn on sync — ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {iconIdentity && (
        <>
          {/* One icon per vault. A synced vault's belongs to the org: members see
              the owner's picker with every action disabled. */}
          <VaultIconSettings
            identity={iconIdentity}
            name={(isSynced ? activeOrgName : null) ?? vault?.name ?? ""}
            canEdit={!isSynced || canManage}
          />
          {/* A synced vault's next row (Freeze vault root) brings its own divider. */}
          {!isSynced && <div className="menu-sep" />}
        </>
      )}
      {!isSynced && (
        <>
          <div className="muted">
            {activeOrgName
              ? "You're viewing a local folder. Turn on sync to keep this vault on your account and across devices."
              : "This vault lives only on this computer. Turn on sync to reach it from other devices — or invite people to it."}
          </div>

          <div className="sync-promo">
            <h3 className="sync-promo-title">Turn on sync &amp; sharing</h3>
            <p className="sync-promo-desc">
              Keeps the notes and folders already here — nothing to re-import.
              Enables live collaboration and lets you invite people. Everyone in the
              vault can edit by default; you choose who sees what.
            </p>
            <div className="row invite-bar">
              <input
                placeholder="Vault name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void turnOn();
                }}
              />
              {/* Disabled while the session restore runs: its answer decides
                  whether this button turns sync on or raises a sign-in card,
                  and pressing it in between would do the wrong one. */}
              <button
                className="primary"
                disabled={busy || authPending}
                onClick={() => void turnOn()}
              >
                {busy
                  ? "…"
                  : authPending
                    ? "Checking your account…"
                    : authStatus === "signed-in"
                      ? "Turn on sync"
                      : "Sign in to turn on"}
              </button>
            </div>
            {!authPending && authStatus !== "signed-in" && (
              <div className="muted">You'll need to sign in first — this button will prompt you.</div>
            )}
            {error && <div className="auth-error">{error}</div>}
          </div>
        </>
      )}

      {isSynced && canManage && <FreezeRootRow canManage={canManage} />}

      <div className="menu-sep" />
      <div className="subhead">Folder on disk</div>
      <div className="join-code-row">
        <code className="vault-root-path" title={vault?.path ?? ""}>
          {vault?.path ?? "—"}
        </code>
      </div>

      {isSynced && isOwner && <UnsyncDangerZone />}
    </>
  );
}

/**
 * The mirror of "Turn on sync": take the vault back off the server and keep the
 * folder. Owner-only, at the bottom of the page, behind a type-the-name confirm
 * — the three things that stop a mis-click on the one action in this dialog that
 * destroys other people's access.
 *
 * The counts come from the preview call rather than from anything this device
 * knows: what matters is what the SERVER is about to lose (edit history, version
 * checkpoints, public links, MCP tokens), none of which the local index can see.
 */
function UnsyncDangerZone() {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const orgName = useStore(
    (s) =>
      s.organizations.find((o) => o.id === s.session?.activeOrganizationId)?.name ?? null,
  );
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const serverUrl = useStore((s) => s.serverUrl);
  const [preview, setPreview] = useState<UnsyncPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const reset = useResetLocalCopy();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    authManager.api
      .getUnsyncPreview(orgId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      // A preview that won't load must not hide the control: the confirm asks
      // again, and the server is the gate either way.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!orgId || !orgName) return null;
  const folder = vaultPath ? (vaultPath.split("/").pop() ?? vaultPath) : null;

  return (
    <>
      <div className="menu-sep" />
      <div className="subhead">Danger zone</div>
      {reset.available && (
        <div className="vault-local-only-card">
          <span className="vault-local-only-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
          </span>
          <div className="vault-local-only-copy">
            <strong>Reset local copy</strong>
            <span className="field-hint">
              Delete {folder ? <>the <strong>{folder}</strong> folder</> : "this vault's folder"} on this
              device and download a fresh copy from {serverHost(serverUrl)}. Nothing changes for your team.
            </span>
          </div>
          <button className="vault-local-only-action" onClick={reset.start}>
            Reset
          </button>
        </div>
      )}
      <div className="vault-local-only-card">
        <span className="vault-local-only-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 2.5 20h19L12 3Z" />
            <path d="M12 9v5M12 17h.01" />
          </svg>
        </span>
        <div className="vault-local-only-copy">
          <strong>Make this vault local only</strong>
          <span className="field-hint">
            {folder ? (
              <>
                Keep the <strong>{folder}</strong> folder on this device and remove its synced copy
                from {serverHost(serverUrl)}.
              </>
            ) : (
              <>Keep the local folder on this device and remove its synced copy from {serverHost(serverUrl)}.</>
            )}{" "}
            {preview ? (
              <>
                The server copy of {preview.notes} note{plural(preview.notes)} and {preview.files} file
                {plural(preview.files)}, version history, and sharing will be deleted.{" "}
                {preview.members > 0
                  ? `${preview.members} teammate${plural(preview.members)} lose access.`
                  : "No teammates currently have access."}
              </>
            ) : (
              "Checking what will be removed…"
            )}
          </span>
        </div>
        <button className="vault-local-only-action" onClick={() => setConfirming(true)}>
          Make local only
        </button>
      </div>
      {reset.dialog}
      {confirming && (
        <UnsyncConfirmDialog
          orgId={orgId}
          orgName={orgName}
          folderName={folder}
          seed={preview}
          onCancel={() => setConfirming(false)}
          onDone={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** "1 note" / "2 notes", without reaching for a formatting library. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Just the host of the server URL — the whole URL is noise inside a sentence. */
function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/**
 * The confirm for "make local only".
 *
 * Wraps the shared `ConfirmDialog` rather than replacing it, and uses its
 * `confirmDisabled` for a type-the-vault-name gate: this is the one action in
 * the app that destroys data for people who are not at the keyboard, so there is
 * deliberately no path from a single click to done.
 *
 * On failure the dialog STAYS OPEN so the server's reason (403 `owner_only`, a
 * 409 `name_mismatch`) has
 * somewhere to show, with a sticky error toast beside it — a destructive path
 * must never look like a success (#85). Nothing was destroyed in that case: the
 * store only touches this device once the server has answered.
 */
export function UnsyncConfirmDialog({
  orgId,
  orgName,
  folderName,
  seed,
  onCancel,
  onDone,
}: {
  orgId: string;
  orgName: string;
  folderName: string | null;
  /** An already-loaded preview, so the page and the dialog don't both count. */
  seed?: UnsyncPreview | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [preview, setPreview] = useState<UnsyncPreview | null>(seed ?? null);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (seed) return;
    let cancelled = false;
    setLoading(true);
    authManager.api
      .getUnsyncPreview(orgId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, seed]);

  const run = async () => {
    setError(null);
    try {
      await useStore.getState().unsyncVault(orgId, orgName);
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(`Couldn't make the vault local only — ${message}`, "error");
    }
  };

  return (
    <ConfirmDialog
      title={`Make ${orgName} local only?`}
      confirmLabel="Make local only"
      // The name has to match exactly. The server re-checks it too (409
      // `name_mismatch`), so a slip here can't get past either gate.
      confirmDisabled={loading || typed.trim() !== orgName}
      onCancel={onCancel}
      onConfirm={run}
    >
      <p>
        Your files stay where they are.{" "}
        {folderName ? (
          <>
            <strong>{folderName}</strong> on this device keeps every note and
            attachment as ordinary files.
          </>
        ) : (
          "This device keeps every note and attachment as ordinary files."
        )}
      </p>
      <p>
        <strong>Deleted from {serverHost(serverUrl)}, permanently:</strong>
      </p>
      {loading && !preview ? (
        <p className="muted">Counting what would be deleted…</p>
      ) : preview ? (
        <ul className="confirm-list">
          <li>
            {preview.notes} note{plural(preview.notes)} and {preview.files} file
            {plural(preview.files)}, with all of their edit history
            {preview.checkpoints > 0
              ? ` and ${preview.checkpoints} version checkpoint${plural(preview.checkpoints)}`
              : ""}
          </li>
          {preview.members > 0 && (
            <li>
              {preview.members} teammate{plural(preview.members)} lose access
              immediately; their own local copies are kept
            </li>
          )}
          {preview.publicLinks > 0 && (
            <li>
              {preview.publicLinks} public share link{plural(preview.publicLinks)} stop
              working
            </li>
          )}
          {preview.mcpTokens > 0 && (
            <li>
              {preview.mcpTokens} MCP token{plural(preview.mcpTokens)} stop working — AI
              clients lose access
            </li>
          )}
        </ul>
      ) : null}
      <p>This cannot be undone. Teammates cannot get the vault back from us.</p>
      <label className="confirm-type">
        <span>
          Type <strong>{orgName}</strong> to confirm
        </span>
        <input
          autoFocus
          value={typed}
          spellCheck={false}
          placeholder={orgName}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      {error && <div className="auth-error">{error}</div>}
    </ConfirmDialog>
  );
}

/**
 * The "Freeze vault root" latch.
 *
 * A vault's top level is the one place where a stray note or folder is most
 * visible and least recoverable — everyone sees it, and nobody is sure whose it
 * is. Once a team has agreed the top-level shape, this closes it: new notes and
 * folders have to go inside an existing folder.
 *
 * Deliberately applies to EVERYONE, owners and admins included, because the
 * accidental root folder is almost always created by someone who does have
 * permission. Only an owner/admin can lift it; everyone else sees the switch in
 * its real state, disabled, so the rule is visible rather than mysterious.
 */
function FreezeRootRow({ canManage }: { canManage: boolean }) {
  const rootFrozen = useStore((s) => s.rootFrozen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().setRootFrozen(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="menu-sep" />
      <label className="menu-row toggle-row">
        <span className="menu-row-label">
          Freeze vault root
          <span className="field-hint">
            Stops anything new being created at the top level of this vault —
            new notes and folders have to go inside an existing folder. Applies
            to everyone, including you; only an owner or admin can turn it off.
            Nothing already at the root is moved, renamed, or hidden.
          </span>
        </span>
        <Switch
          checked={rootFrozen}
          disabled={!canManage || busy}
          ariaLabel="Freeze vault root"
          title={canManage ? undefined : "Only an owner or admin can change this"}
          onChange={(next) => void flip(next)}
        />
      </label>
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}

/** Locked-section gate shown for a team tab on a local vault. */
function SyncGate({ label, onGoToSync }: { label: string; onGoToSync: () => void }) {
  return (
    <div className="sync-gate">
      <svg
        className="sync-gate-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <h3>{label} unlocks with sync</h3>
      <p className="muted">
        Turn on sync for this vault to invite people, set sharing and
        permissions, and connect AI clients.
      </p>
      <button className="primary" onClick={onGoToSync}>
        Turn on sync &amp; sharing →
      </button>
    </div>
  );
}

/** Compact absolute date. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Versioning: the vault-wide safety net. Lists the vault's checkpoints (max 5 —
 * a daily automatic one plus manual ones), and lets an owner OR admin take one
 * and roll the whole vault back to it. Per-note history lives in the editor's
 * version panel; this page is for the blast-radius case ("the reorg went wrong,
 * put everything back").
 *
 * Revert used to be owner-only. It is the recovery half of an action admins
 * could already take (create/delete a checkpoint), so a team whose owner was
 * away could take checkpoints and not use them.
 */
function VersioningTab({ canManage }: { canManage: boolean }) {
  const checkpoints = useStore((s) => s.checkpoints);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<VaultCheckpoint | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useStore.getState().refreshCheckpoints();
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const create = async () => {
    setError(null);
    try {
      await useStore.getState().createCheckpoint(label);
      setLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await useStore.getState().deleteCheckpoint(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revert = async (cp: VaultCheckpoint) => {
    setError(null);
    try {
      const result = await useStore.getState().revertVaultToCheckpoint(cp.id);
      setConfirming(null);
      toast(
        `Vault reverted — ${result.docsChanged} notes changed, ` +
          `${result.docsRestored} restored, ${result.docsDeleted} removed`,
        "success",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="versioning-tab">
      <div className="muted">
        A checkpoint captures every note in this vault — content and folder
        structure. One is taken automatically each day the vault changes; the
        vault keeps its 5 most recent. Reverting rolls every member's vault back
        and broadcasts live.
      </div>
      <div className="menu-sep" />
      {canManage && (
        <>
          <div className="subhead">Create checkpoint</div>
          <div className="row invite-bar">
            <input
              type="text"
              placeholder="Label (optional) — e.g. Before the big reorg"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <AsyncButton className="primary" onClick={create}>
              Create
            </AsyncButton>
          </div>
          <div className="menu-sep" />
        </>
      )}
      <div className="subhead">Checkpoints</div>
      {error && <div className="auth-error">{error}</div>}
      {checkpoints == null ? (
        <div className="muted perm-empty">Loading…</div>
      ) : checkpoints.length === 0 ? (
        <div className="muted perm-empty">
          No checkpoints yet. One is captured automatically within a day of the
          vault changing{canManage ? ", or create one above" : ""}.
        </div>
      ) : (
        <ul className="checkpoint-list">
          {checkpoints.map((cp) => (
            <li key={cp.id} className="checkpoint-row">
              <span className="checkpoint-main">
                <span className="checkpoint-title">
                  {checkpointTitle(cp.label, cp.kind, cp.createdAt, now)}
                </span>
                <span className="checkpoint-sub">
                  {agoFromIso(cp.createdAt, now)} · {noteCountLabel(cp.noteCount)}
                  {cp.createdByName ? ` · by ${cp.createdByName}` : ""}
                </span>
              </span>
              {canManage && (
                <button className="link-btn" onClick={() => setConfirming(cp)}>
                  Revert
                </button>
              )}
              {canManage && (
                <AsyncButton className="link-btn danger" onClick={() => remove(cp.id)}>
                  Delete
                </AsyncButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canManage && (
        <div className="muted checkpoint-note">
          Only a vault owner or admin can revert to a checkpoint.
        </div>
      )}
      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Revert the entire vault?</h2>
            </div>
            <p className="muted">
              Every note goes back to{" "}
              <strong>
                {checkpointTitle(
                  confirming.label,
                  confirming.kind,
                  confirming.createdAt,
                  now,
                )}
              </strong>{" "}
              ({agoFromIso(confirming.createdAt, now)}) — content, names and
              folders — for every member, live. Notes created since then are
              moved to trash. Attachments are not reverted. A checkpoint of the
              current state is taken first, so this can be undone.
            </p>
            <div className="banner-actions">
              <button className="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <AsyncButton
                className="primary danger"
                spinnerTone="on-accent"
                onClick={() => revert(confirming)}
              >
                Revert vault
              </AsyncButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MCP: expose this vault to AI clients over the Model Context Protocol.
 * The MCP endpoint is part of the same server; a client authenticates with a
 * token minted here and then gets the SAME CRUD access to notes/folders that
 * the signed-in user has (owners/admins see everything; members see what's
 * shared with them). This is where you grab the URL + a token.
 */
function McpTab() {
  const session = useStore((s) => s.session);
  const serverUrl = useStore((s) => s.serverUrl);

  const mcpUrl = `${serverUrl.replace(/\/+$/, "")}/api/mcp`;
  const hasVault = !!session?.activeOrganizationId;

  const [tokens, setTokens] = useState<McpTokenRow[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(
    null,
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumps every 20s so "connected" dots + relative times stay live while open.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!hasVault) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = () =>
      authManager.api
        .listMcpConnections()
        .then(({ tokens, tools }) => {
          if (cancelled) return;
          setTokens(tokens);
          setTools(tools);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void load();
    // Poll so a connection that goes active/idle while the panel is open shows it.
    const poll = window.setInterval(() => void load(), 20_000);
    const tickle = window.setInterval(() => setTick((n) => n + 1), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tickle);
    };
  }, [hasVault]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await authManager.api.createMcpToken(name.trim() || "MCP token");
      setJustCreated({ name: created.name, token: created.token });
      const { token: _t, ...row } = created;
      setTokens((prev) => [row, ...prev]);
      setName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Otherwise the button just returns to idle and the user clicks again,
      // minting duplicate tokens on a server that is actually failing (#85).
      toast(`Couldn't create the MCP token — ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await authManager.api.revokeMcpToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasVault) {
    return (
      <div className="muted perm-empty">
        MCP needs an active vault — create or switch to one first.
      </div>
    );
  }

  const snippet = justCreated
    ? `claude mcp add --transport http context ${mcpUrl} \\\n  --header "Authorization: Bearer ${justCreated.token}"`
    : "";

  return (
    <>
      <div className="muted">
        Connect any MCP-compatible AI client to this vault. It gets the same
        access you do: read, search, create, edit and delete notes and folders.
        Owners and admins can also manage the team's access from the same chat —
        ask Claude or ChatGPT to share a folder with someone, make it view only,
        or set what new members see.
      </div>

      <div className="subhead">Endpoint URL</div>
      <div className="join-code-row">
        <code className="vault-root-path" title={mcpUrl}>
          {mcpUrl}
        </code>
        <button className="link-btn" onClick={() => void copy(mcpUrl, "url")}>
          {copied === "url" ? "Copied ✓" : "Copy"}
        </button>
      </div>

      <div className="menu-sep" />
      <div className="subhead">Access tokens</div>
      <div className="muted">
        A token authenticates the client and scopes it to you in this vault.
        Add it as an <code>Authorization: Bearer</code> header. Revoke any time.
      </div>

      <div className="row invite-bar">
        <input
          placeholder="Token name, e.g. Claude Desktop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <button className="primary" disabled={busy} onClick={() => void create()}>
          Create token
        </button>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {justCreated && (
        <div className="mcp-new-token">
          <div className="subhead">Copy your token now — it won't be shown again</div>
          <div className="join-code-row">
            <code className="join-code mcp-token-value" title={justCreated.token}>
              {justCreated.token}
            </code>
            <button
              className="link-btn"
              onClick={() => void copy(justCreated.token, "token")}
            >
              {copied === "token" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="muted">Example — add it to Claude Code:</div>
          <div className="join-code-row">
            <code className="mcp-snippet">{snippet}</code>
            <button className="link-btn" onClick={() => void copy(snippet, "snippet")}>
              {copied === "snippet" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <button className="link-btn" onClick={() => setJustCreated(null)}>
            Done
          </button>
        </div>
      )}

      <div className="menu-sep" />
      <div className="subhead">Connections</div>
      <div className="muted">
        Every token is a connection into this vault. Each reaches the same{" "}
        {tools.length || ""} tools, gated by your access — expand one to see them,
        how active it is, and how much it's been used.
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="muted">No connections yet.</div>
      ) : (
        <ul className="mcp-conn-list">
          {tokens.map((t) => {
            const live = isConnected(t.lastUsedAt);
            const open = expanded === t.id;
            return (
              <li key={t.id} className={`mcp-conn${open ? " open" : ""}`}>
                <div className="mcp-conn-head">
                  <span
                    className={`mcp-dot ${live ? "on" : "off"}`}
                    title={live ? "Connected" : "Disconnected"}
                    aria-hidden="true"
                  />
                  <div className="mcp-conn-main">
                    <div className="mcp-conn-title">
                      {t.name}
                      <span className={`mcp-status ${live ? "on" : "off"}`}>
                        {live ? "Connected" : "Disconnected"}
                      </span>
                    </div>
                    <div className="mcp-conn-sub muted">
                      {clientLabel(t.lastClient)}
                      {" · "}
                      {t.tokenPrefix}
                      {" · "}
                      {t.useCount} {t.useCount === 1 ? "call" : "calls"}
                      {" · "}
                      {t.lastUsedAt ? `last active ${relTime(t.lastUsedAt)}` : "never used"}
                    </div>
                  </div>
                  <button
                    className="link-btn"
                    onClick={() => setExpanded((e) => (e === t.id ? null : t.id))}
                  >
                    {open ? "Hide tools" : `Tools · ${tools.length}`}
                  </button>
                  <AsyncButton
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => revoke(t.id)}
                  >
                    Revoke
                  </AsyncButton>
                </div>
                {open && (
                  <ul className="mcp-tool-list">
                    {tools.map((tool) => (
                      <li key={tool.name} title={tool.description}>
                        <span className={`mcp-tool-badge ${tool.access}`}>
                          {tool.access === "read"
                            ? "read"
                            : tool.access === "destructive"
                              ? "delete"
                              : "write"}
                        </span>
                        <code>{tool.name}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** A connection is "active" when it made a request in the last few minutes
 *  (MCP here is stateless HTTP — there's no socket to watch, so recency is it). */
const CONNECTED_WINDOW_MS = 3 * 60 * 1000;
function isConnected(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return false;
  return Date.now() - new Date(lastUsedAt).getTime() < CONNECTED_WINDOW_MS;
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", else a date. */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Best-effort human name for a client from its User-Agent. */
function clientLabel(ua: string | null): string {
  if (!ua) return "Unknown client";
  const s = ua.toLowerCase();
  if (s.includes("claude-code") || s.includes("claude code")) return "Claude Code";
  if (s.includes("claude")) return "Claude";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("node")) return "Node client";
  // Fall back to the leading token of the UA (e.g. "MyApp/1.2" → "MyApp").
  return ua.split(/[\s/]/)[0].slice(0, 40) || "Unknown client";
}


function importSummaryText(s: ipc.ImportSummary): string {
  const parts = [`Imported ${s.files} file${s.files === 1 ? "" : "s"}`];
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  return parts.join(" · ") + ".";
}

/**
 * Import / Export — vault-level data operations on the open local vault. Imports
 * land at the vault root; exports copy out to a chosen folder. The same commands
 * back the sidebar ⋮ menu and drag-and-drop, so behavior is identical everywhere.
 */
function ImportExportTab() {
  const [busy, setBusy] = useState<null | "files" | "folder" | "export">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
  }

  async function run(
    kind: "files" | "folder" | "export",
    fn: () => Promise<string | null>,
  ) {
    setBusy(kind);
    setError(null);
    setMsg(null);
    try {
      const result = await fn();
      if (result) setMsg(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const importFiles = () =>
    run("files", async () => {
      // Captured before the native picker — a vault switch while it is open must
      // not redirect the import into the vault the user landed in.
      const epoch = useStore.getState().vault?.epoch;
      const sources = await ipc.pickFiles();
      if (!sources || sources.length === 0) return null;
      const summary = await ipc.importPaths("", sources, epoch);
      await refresh();
      return importSummaryText(summary);
    });

  const importFolder = () =>
    run("folder", async () => {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const src = await ipc.pickFolder();
      if (!src) return null;
      const summary = await ipc.importPaths("", [src], epoch);
      await refresh();
      return importSummaryText(summary);
    });

  const exportVault = () =>
    run("export", async () => {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const dest = await ipc.pickFolder();
      if (!dest) return null;
      await ipc.exportPath("", dest, epoch);
      return "Exported the vault.";
    });

  return (
    <div className="io-tab">
      <section className="io-section">
        <h3 className="io-heading">Import</h3>
        <p className="io-desc">
          Bring existing files and folders into this vault — any format. Markdown and text
          become notes; everything else is kept as-is, with its folder structure. Existing
          names are never overwritten.
        </p>
        <div className="io-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void importFiles()}>
            {busy === "files" ? "Importing…" : "Import files…"}
          </button>
          <button className="primary" disabled={busy !== null} onClick={() => void importFolder()}>
            {busy === "folder" ? "Importing…" : "Import folder…"}
          </button>
        </div>
        <p className="io-hint">
          You can also right-click any folder in the sidebar, or drag files straight onto it.
        </p>
      </section>

      <section className="io-section">
        <h3 className="io-heading">Export</h3>
        <p className="io-desc">
          Save a copy of this whole vault to a folder on your computer. The hidden{" "}
          <code>.context</code> index is skipped.
        </p>
        <div className="io-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void exportVault()}>
            {busy === "export" ? "Exporting…" : "Export entire vault…"}
          </button>
        </div>
      </section>

      {error ? (
        <div className="auth-error">{error}</div>
      ) : (
        msg && <div className="io-result">{msg}</div>
      )}
    </div>
  );
}

function AppearanceTab({ canManage, isSynced }: { canManage: boolean; isSynced: boolean }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const settings = useStore((s) => (orgId ? s.vaultAppearance[orgId] : undefined)) ?? EMPTY_APPEARANCE;
  // Sliders fire on every pixel of a drag: apply locally at once, PUT once
  // the thumb rests for 300 ms. Everything else saves on change.
  const pending = useRef<{ timer: number; settings: AppearanceSettings } | null>(null);

  useEffect(() => {
    if (orgId && isSynced) void useStore.getState().loadVaultAppearance(orgId);
  }, [orgId, isSynced]);
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function save(next: AppearanceSettings) {
    if (!orgId) return;
    useStore.getState().saveVaultAppearance(orgId, next).catch((e: unknown) => {
      // The change was applied optimistically and has just been rolled back:
      // say so, with the server's reason, so a refused save is never silent.
      const body = e instanceof ApiError ? (e.body as { error?: string; key?: string } | undefined) : undefined;
      const reason =
        body?.error === "invalid_appearance"
          ? `the server refused ${body.key ? `"${body.key}"` : "a value"}`
          : e instanceof Error
            ? e.message
            : String(e);
      toast(`Couldn't save the vault's appearance, so it was put back: ${reason}.`, "error");
    });
  }
  function flush() {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.timer);
    pending.current = null;
    save(p.settings);
  }
  // Every save is the whole, concrete object: a key an older row never saved
  // is written as the app default it was already showing.
  const change = <K extends AppearanceKey>(key: K, value: ResolvedAppearance[K]) => {
    if (!orgId) return;
    const next: AppearanceSettings = {
      ...useStore.getState().vaultAppearance[orgId],
      ...vaultAppearanceValues(useStore.getState().vaultAppearance[orgId]),
      [key]: value,
    };
    if (key === "contentWidth" || key === "textSize") {
      useStore.getState().receiveVaultAppearance(orgId, next); // optimistic
      if (pending.current) window.clearTimeout(pending.current.timer);
      pending.current = { settings: next, timer: window.setTimeout(flush, 300) };
      return;
    }
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    save(next);
  };
  const resetToDefaults = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    save({ ...APPEARANCE_DEFAULTS });
  };

  return (
    <>
      {isSynced && orgId ? (
        <>
          <div className="subhead appearance-defaults-head">
            Defaults for everyone in this vault
            {!canManage && <span className="appearance-tag">Set by the vault owner</span>}
          </div>
          <div className="muted">
            People can still override these in their own Appearance settings.
          </div>
          <AppearanceRows
            mode="vault"
            values={vaultAppearanceValues(settings)}
            onChange={change}
            readOnly={!canManage}
          />
          {canManage && (
            <button className="link-btn" onClick={resetToDefaults}>
              Reset to defaults
            </button>
          )}
        </>
      ) : (
        <div className="menu-row">
          <span className="menu-row-label">Theme</span>
          <ThemeToggle />
        </div>
      )}
    </>
  );
}

const EMPTY_APPEARANCE: AppearanceSettings = {};
