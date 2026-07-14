# ImageVault privacy policy

_Last updated: 2026-07-13_

ImageVault is a zero-knowledge, offline-first tool. **It does not collect,
transmit, or sell any personal data.**

## What data ImageVault handles

- **Your files and password** are processed **entirely on your device**. Files
  are encrypted locally (Argon2id + AES-256-GCM) before being turned into
  images. Your password is never stored and never leaves your device.
- **At rest**, only a *password-wrapped* key and non-sensitive preferences are
  stored locally in the browser (`storage.local`). The wrapped key is useless
  without your password. Nothing is synced to any server.
- ImageVault contains **no analytics, no telemetry, and no tracking** of any
  kind, and makes **no network requests** for its core features (Disk and Paper).

## Google Photos (optional)

The Google Photos destination is **opt-in** and off unless you enable it:

- It requests Google authorization only when you first use it, via Google's
  standard OAuth consent screen.
- Encrypted images are uploaded to **your own Google account**, into an album
  the extension creates. Restoring downloads images **you select** with Google's
  Picker. All of this happens directly between your browser and Google.
- **ImageVault operates no servers and receives none of this data.** Your use of
  Google Photos is governed by Google's own privacy policy.
- The extension only ever handles opaque, already-encrypted images — it cannot
  read your other photos.

## Permissions

- `storage` — save the wrapped key and preferences locally.
- `offscreen` (Chrome/Edge) — render and decode images off the service worker.
- `identity` and the Google host permissions — **optional**, requested only if
  you use Google Photos.

## Your control

- Export, re-password, or **erase** your key at any time from the settings.
- Uninstalling the extension removes all local data.

## Contact

Questions or concerns: open an issue or a private report on the project page —
<https://github.com/dlamarre-dev/ImageVault>.
