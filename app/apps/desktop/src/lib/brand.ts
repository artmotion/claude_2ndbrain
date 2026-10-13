// The ONLY place the brand name lives in desktop code. Everything durable
// (storage keys, identifiers, protocol names) uses the permanent neutral
// codename "context" — see docs/BRANDING.md.
//
// Self-hosters can rebrand a build without touching code: set VITE_BRAND_NAME
// when building (the Tauri window title and bundle name come from
// tauri.conf.json `productName`, overridable with `tauri build --config`).
export const BRAND_NAME: string =
  (import.meta.env.VITE_BRAND_NAME as string | undefined)?.trim() || "2ndBrain";
