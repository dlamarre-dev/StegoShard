# StegoShard privacy policy

_Last updated: 2026-08-09_

StegoShard is a local-only tool with no application backend. It does not collect,
transmit, sell, or profile personal data, and contains no analytics, telemetry, or
tracking.

## Data processed on your device

- Files, passwords, keys, filenames, and recovery shares are processed locally in
  your browser or CLI. Passwords are not intentionally persisted or transmitted.
- The extension stores a password-wrapped vault key and save preferences in
  `storage.local`. Preferences include workflow, destination, codec, and an optional
  user-entered title; a title may contain personal data if you put it there.
- While the extension is unlocked, the raw vault key is represented in
  `storage.session`. This volatile browser-managed value is cleared when you lock the
  vault or close the browser, but it cannot be reliably zeroized like native memory.
- The hosted web app has no managed key. It stores only non-secret UI preferences in
  site-local `localStorage`; selected files and passwords are not intentionally stored.

StegoShard's core features make no network requests. Public extension builds request
only the browser `storage` permission and no host access.

## Hosted web-app trust

The web app downloads executable JavaScript from its host. Although cryptographic
processing remains local, a compromised or replaced deployment could change that
code. Each release shows its version and commit; high-value use should prefer a
reviewed extension, CLI binary, or checksum/provenance-verified offline web bundle.

## Your control

- Export, re-password, lock, or erase the extension key from settings.
- Uninstalling the extension removes its extension storage under normal browser
  behavior.
- Web-app preferences remain in browser site data until you clear that site's data.
- Downloaded vaults, keys, shares, and restored files remain wherever you saved them
  and are not removed automatically.

## Contact

Questions or concerns: open an issue for general privacy questions or use a private
security report for sensitive matters: <https://github.com/dlamarre-dev/StegoShard>.
