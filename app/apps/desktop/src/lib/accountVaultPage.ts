/* Account Settings → Vaults → one vault's page: which detail rows and actions
   it shows, from what the Vaults tab already knows. Pure, so the choices are
   tested without React. */

export type VaultRole = "owner" | "admin" | "member";

export const ROLE_TEXT: Record<VaultRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * The caller's role, from what is known: the active vault's member list
 * names it; anything else is unknown.
 */
export function vaultPageRole(input: { activeRole: string | null }): VaultRole | null {
  const r = input.activeRole;
  return r === "owner" || r === "admin" || r === "member" ? r : null;
}

export interface VaultPageDetail {
  key: "role" | "folder" | "created";
  label: string;
  value: string;
}

export function vaultPageDetails(input: {
  role: VaultRole | null;
  folderPath: string | null;
  createdAt: string | null | undefined;
  formatDate: (iso: string) => string;
}): VaultPageDetail[] {
  const rows: VaultPageDetail[] = [
    { key: "role", label: "Your role", value: input.role ? ROLE_TEXT[input.role] : "—" },
  ];
  rows.push({
    key: "folder",
    label: "Folder on this device",
    value: input.folderPath ?? "Not on this device",
  });
  if (input.createdAt && !Number.isNaN(Date.parse(input.createdAt))) {
    rows.push({ key: "created", label: "Created", value: input.formatDate(input.createdAt) });
  }
  return rows;
}

/**
 * "Open Vault Settings": the open vault opens straight away, a vault with a
 * folder here is switched to first, and one never opened on this device
 * cannot be (switching needs a folder), so the action is disabled with a hint.
 */
export function vaultSettingsAction(input: {
  isOpen: boolean;
  boundPath: string | null;
}): "open" | "switch-then-open" | "unavailable" {
  if (input.isOpen) return "open";
  return input.boundPath ? "switch-then-open" : "unavailable";
}

export const VAULT_SETTINGS_UNAVAILABLE_HINT =
  "Switch to this vault first: it has no folder on this device yet.";

/** Keep the menu's order, but every destructive action goes last. */
export function orderPageActions<T extends { danger?: boolean }>(actions: T[]): T[] {
  return [...actions.filter((a) => !a.danger), ...actions.filter((a) => a.danger)];
}
