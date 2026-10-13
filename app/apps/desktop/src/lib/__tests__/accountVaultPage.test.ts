import { describe, expect, it } from "vitest";
import {
  orderPageActions,
  vaultPageDetails,
  vaultPageRole,
  vaultSettingsAction,
} from "../accountVaultPage";

describe("vaultPageRole", () => {
  it("takes the active vault's role, else unknown", () => {
    expect(vaultPageRole({ activeRole: "admin" })).toBe("admin");
    expect(vaultPageRole({ activeRole: null })).toBeNull();
    expect(vaultPageRole({ activeRole: "weird" })).toBeNull();
  });
});

describe("vaultPageDetails", () => {
  const fmt = (iso: string) => `D(${iso.slice(0, 10)})`;
  it("lists role, folder and created", () => {
    expect(
      vaultPageDetails({ role: "owner", folderPath: "/v/Acme", createdAt: "2026-01-02T00:00:00Z", formatDate: fmt }),
    ).toEqual([
      { key: "role", label: "Your role", value: "Owner" },
      { key: "folder", label: "Folder on this device", value: "/v/Acme" },
      { key: "created", label: "Created", value: "D(2026-01-02)" },
    ]);
  });

  it("drops created without a date", () => {
    const rows = vaultPageDetails({ role: null, folderPath: null, createdAt: undefined, formatDate: fmt });
    expect(rows).toEqual([
      { key: "role", label: "Your role", value: "—" },
      { key: "folder", label: "Folder on this device", value: "Not on this device" },
    ]);
  });
});

describe("vaultSettingsAction", () => {
  it("opens, switches first, or is unavailable without a folder", () => {
    expect(vaultSettingsAction({ isOpen: true, boundPath: "/a" })).toBe("open");
    expect(vaultSettingsAction({ isOpen: false, boundPath: "/a" })).toBe("switch-then-open");
    expect(vaultSettingsAction({ isOpen: false, boundPath: null })).toBe("unavailable");
  });
});

describe("orderPageActions", () => {
  it("puts destructive actions last, keeping order otherwise", () => {
    const out = orderPageActions([
      { key: "leave", danger: true },
      { key: "remove" },
      { key: "delete", danger: true },
      { key: "reset" },
    ]);
    expect(out.map((a) => a.key)).toEqual(["remove", "reset", "leave", "delete"]);
  });
});
