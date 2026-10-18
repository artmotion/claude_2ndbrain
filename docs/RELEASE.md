---
type: guide
product: 2ndBrain
status: active
date: 2026-10-18
tags: [secondbrain, release, builds]
---

# Builds and releases

2ndBrain is a personal fork with a small circle of users, so there is no
signed release pipeline, no staging channel and no app-store listing. Two
GitHub Actions workflows build the apps; the server runs from source with
Docker Compose ([[DEPLOY]]).

## Desktop (Windows)

`.github/workflows/windows-build.yml` runs on every push to `main` (and the
working branch) that touches `app/**`, or by hand (`workflow_dispatch`). It
builds the NSIS installer (`.exe`) and the `.msi` and publishes both to the
rolling **`windows-dev`** prerelease, plus a workflow artifact per run.

- Installers are **not Authenticode-signed**: Windows SmartScreen warns on
  first launch ("More info" → "Run anyway").
- **No auto-update** yet. Updater artifacts are switched off through
  `src-tauri/tauri.ci.conf.json`, because they need a minisign key pair of our
  own. To turn auto-update on later: generate a key with
  `pnpm --filter desktop tauri signer generate`, put the private key in the
  `TAURI_SIGNING_PRIVATE_KEY` repository secret, the public key in
  `tauri.conf.json → plugins.updater.pubkey`, drop the CI override and publish
  `latest.json` with the installers.
- `SERVER_URL` (repository variable) bakes your server into the build;
  without it the app asks for the address on first sign-in.

macOS and Linux builds are not set up; the Tauri app builds there too if they
are ever wanted.

## iPad

`.github/workflows/ios-build.yml` (macOS runner, no Apple account) builds the
app for the iPad simulator, launches it and screenshots it, and builds an
unsigned `.ipa`. Everything lands on the rolling **`ios-dev`** prerelease.
Installing it on a device: [[IOS]] (Sideloadly + a free Apple ID).

## Version number

The app version lives in `app/apps/desktop/src-tauri/tauri.conf.json`,
`app/apps/desktop/package.json`, `app/apps/desktop/src-tauri/Cargo.toml` and
`Cargo.lock`; bump all four together. It is shown in Account Settings → About.

## Server

There is no server release: pull and rebuild (`docker compose up -d --build`
in `deploy/compose`). Migrations run before the server starts. The server's
`/health` answers its feature list, and the desktop shows a notice when the
server lacks a feature it needs, so update the server first.
