---
type: guide
product: 2ndBrain
status: active
date: 2026-10-13
tags: [secondbrain, ios, ipad, sideload]
---

# 2ndBrain on iPad

The iPad app is the same Tauri app as the desktop build (`app/apps/desktop`),
compiled for iOS. There is no App Store listing and no billing: you build it in
GitHub Actions and install it yourself.

## Get a build

Every push to `main` or the working branch runs `.github/workflows/ios-build.yml`
on a GitHub-hosted Mac (free for a public repository). It publishes to the
rolling **`ios-dev`** prerelease:

- `2ndBrain-unsigned.ipa`: the device build, unsigned;
- `ios-sim-screenshot*.png` and `ios-sim-app.log`: the app launched in an iPad
  simulator, as a smoke test.

To bake your server into the build, set the repository variable `SERVER_URL`
(Settings → Secrets and variables → Actions → Variables). Without it, the app
asks for the server address on first sign-in.

## Install it without a developer account (Windows)

1. Install [Sideloadly](https://sideloadly.io) and Apple's device drivers
   (the Apple Devices app or iTunes) on the Windows PC.
2. Connect the iPad by USB and trust the computer.
3. Drag `2ndBrain-unsigned.ipa` into Sideloadly, enter an Apple ID (a free one
   works) and start. Sideloadly signs the app for that Apple ID and installs it.
4. On the iPad: Settings → General → VPN & Device Management → trust your
   Apple ID. Developer Mode may need to be enabled (Settings → Privacy &
   Security → Developer Mode).

A free Apple ID's signature expires after **7 days**: re-run Sideloadly with
the latest `.ipa` once a week (your vaults stay; they live in the app's data).
A paid Apple Developer account extends that to a year and allows TestFlight.

## How it behaves on iPad

- **Vaults live inside the app.** New vaults and synced vaults go to the app's
  Documents folder (`2ndBrain Vaults`), which is visible in the Files app under
  "On My iPad → 2ndBrain". "Open existing" lists the vault folders there. There
  is no picker for folders elsewhere (iCloud Drive, other apps) yet.
- **Sync** works like the desktop: sign in to your server and the vault
  downloads, most recently edited notes first, 100 per page.
- **Backgrounding.** When the app leaves the foreground it writes any pending
  edit to disk at once; when it comes back it reconnects without waiting out
  the reconnect backoff.
- **Touch.** A long press opens the same context menus a right-click opens on
  the desktop (outside the editor, where a long press still selects text).
  Rows, tabs and icon buttons are finger-sized, and hover-only buttons are
  always shown.
- **Not available on iPad:** running local AI agents (Claude/Codex CLIs), linked
  Claude/ChatGPT dashboard tabs, the native clipboard command, folder pickers
  and in-app updates (install a newer `.ipa` instead).
