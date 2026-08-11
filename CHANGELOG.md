# Changelog

All notable changes to StegoShard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/) for the app/CLI version. The **on-disk
format** is versioned separately; see [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

### Added

- **Optional user-supplied entropy (expert).** Users who would rather not trust
  the platform CSPRNG alone can now type their own: mashed keys, dice rolls,
  in the expert save options or via `--entropy` / `--entropy-file` /
  `STEGOSHARD_ENTROPY` / `--entropy-prompt`. It is XORed into every random draw
  of that save _on top of_ `crypto.getRandomValues`, which is still consulted for
  every byte: the extra layer can only add uncertainty, never replace it, so a
  weak string cannot weaken a vault. Generation-side only; nothing is stored,
  the format is unchanged, and restore never asks for it.
  - The same field appears on the extension's **key-creation** form, which is the
    only moment the managed vault key itself can be covered: it is minted once,
    before any save, so entropy given later cannot reach back to it.

- **8-colour grid codec (`color-grid`, `CODEC_ID = 2`)** for digital output.
  three bits per module instead of QR byte mode's ~0.75. A disk vault now fits
  **8636 bytes per image** against QR's 2800, in a _smaller_ PNG (704 px vs
  1086 px), which moves the practical ceiling from ~415 KB to ~1.2 MB at the
  unchanged 150-image limit. Cloud carries 3644 bytes per image and is gated by a
  JPEG recompression + downscale test. See [SPEC.md](SPEC.md) §2.2.
  - Intra-image error correction reuses the project's own Reed-Solomon: every
    64-byte block carries a CRC-32, so a damaged block becomes a known erasure.
  - Adds **no dependencies** in either TypeScript or Python.
- **A codec choice in the UI and CLI.** The expert UI, the guided wizard and
  `--codec color|qr` all offer both; colour is the default for disk and cloud.
  Restore needs no choice at all: decoders detect the codec from the pixels, so
  **every image ever written with QR stays readable**. Printed pages are always
  QR: print, ink and camera white balance make colour a liability.
- **Per-codec file counts in the estimate**, updating live as you switch codec,
  so the effect of the choice is visible before you commit to a save.
- **StegoShard branding on generated images and PDFs.** Saved images carry the
  mark, the wordmark, and a recovery line naming the format version, the codec
  and the spec URL, so an image found years from now says what it is and where
  to read about it. The PDF gets the mark as a vector path on every page plus a
  masthead on the instruction sheet. Gallery covers, stego key covers and
  disguised containers stay unbranded, as deniability requires.
- **Colour-grid support in the Python reference decoder**, with new
  cross-implementation conformance fixtures. `python/requirements.txt` is
  unchanged: still common PyPI wheels, still offline-capable.
- **Sample images in the README**, one per output form, generated from the real
  pipeline by `npm run samples` (`scripts/gen-samples.ts`).
- Unused capacity in a colour grid is filled with pseudo-random colour instead of
  being zeroed. The filler is outside the encryption, so a zeroed run painted a
  flat black band whose width stated how much of the capacity the secret used.
  Content is unspecified by the format and decoders ignore it, so this changes
  nothing for reading images written either way.

### Changed

- **Expert-mode destination and key pickers** are now an icon plus a one-to-three
  word label, with the longer explanation on hover and keyboard focus. The
  descriptions were already written for the guided wizard and are reused as-is.
- **The pre-save copy says "file" rather than "images"** when the destination is
  a `.ssbn` or a decoy `.db`, which write exactly one file. The estimate line is
  hidden there too, instead of always reporting `1`.
- The CLI's `--title` / `--date` now appear on disk images. They were accepted
  and silently ignored on that path.
- **Every file drop zone can be emptied again.** Each one (expert forms and the
  guided wizard, on both surfaces) now carries a clear control, so a wrong pick
  no longer means reloading the page.
- **The save zone counts the files it holds** and says "files", matching the
  other multi-file zones; it used to name the first file and hide the rest. The
  restore zone counts its image set the same way.
- **Em dashes are gone from the UI copy**, in all eight locales and on the legal
  pages, replaced with the punctuation each sentence actually calls for.
- **File zones add up.** Picking or dropping files one at a time now appends to
  what a multi-file zone already holds instead of discarding it, with the size
  and the available formats recomputed after each addition; a file picked twice
  is kept once, and the clear control is how you start over.
- **The guided flow saves several files**, bundling them exactly as expert mode
  does. It kept one file before, so a second pick silently replaced the first.
- **The header says what the app does**: the tagline names the images, the opaque
  file and the decoy database rather than just "disk or paper", and the stale
  "Google Photos requires the browser extension" note is gone from the locales
  that still carried it.

### Fixed

- **A file between ~64 KB and 1 MB broke the estimate pass.** Photo-carrier
  capacity is bounded by its bucket ladder, and the arithmetic _throws_ past the
  top rung; nothing caught it, so in expert mode the update was abandoned (the
  size line kept describing the file picked before) and the guided flow concluded
  that no format at all could hold the file. Every other destination takes a
  229 KB secret happily. The gallery now reports its own ceiling instead of
  claiming "max 1 MB".
- **The decoy `.db` was offered for files it cannot hold.** Its two padded
  regions top out at 64 MiB, but the estimate only checked the 256 MiB browser
  input cap, so a larger file failed at the very end of the save.
- In expert mode the save and restore cards no longer start on different lines:
  the adjacent-card margin applied inside the two-column grid, pushing the
  restore card 20 px down.
- The duress password field sat flush against the decoy file zone.
- **The codec file-count note failed AA contrast** (4.2:1 against the 4.5:1 its
  size needs) because it dimmed the accent colour. It only renders once a file is
  picked, so the accessibility pass over the empty page never reached it.

- The output estimate ignored the selected key mode, so changing it re-rendered a
  number that never moved.
- **Rejecting a non-StegoShard image could take over a minute.** The colour-grid
  finder search clustered candidates in a way that went quadratic on noisy input,
  so a 12 MP photo of a printed page, which every restore feeds through the
  detector on the main thread, took ~82 s to turn down. Now ~0.3 s.
- The codec and key mode both move the image count, so either can push a
  destination past the image limit; the UI only re-checked that when a new file
  was dropped. Picking a combination that no longer fitted left every control
  looking fine and failed at the very end of the save instead. Availability is
  now re-evaluated on every change, and a codec that would blow the limit greys
  out **the codec** rather than taking the destination down with it.
- Radio options in the segmented pickers and the wizard cards had **no visible
  focus indicator**: the radios are visually hidden, and no ring was drawn on the
  label. The `<fieldset>` groups also had no accessible name.

## [0.9.0] - 2026-07-23

First tagged pre-1.0 release. Consolidates a round of hardening, reliability, and
maturity work. The on-image format stays **v1** (`FORMAT_VERSION = 1`); the
disguised-container internals changed but the branded/disguised **detection** and
the vault blob are unchanged.

### Added

- **Post-save round-trip verification.** Every save now decodes its own artifacts
  and decrypts them with the in-hand key **before** reporting success, so an
  encoding or lossy-carrier fault is caught at save time, not at a future restore.
- **Recovery guidance.** After a save, both UIs show a "to restore, keep: …"
  checklist, with a prominent lossless-storage caution for the fragile LSB carriers.
- **Password strength meter + one-click strong passphrase** generator (UX only).
- **Deniable / Overt mode labels** on save destinations (guided and expert UIs).
- **Post-quantum crypto scanning** in CI (CSNP QRAMM cryptoscan + cryptodeps) with
  a documented `.cryptoscan.yaml` baseline; a CBOM is emitted as a build artifact.
- **Parser fuzzing**: `npm run fuzz` plus a nightly CI job over every
  untrusted-input parser.
- First-run onboarding explaining deniable vs. overt modes.

### Changed

- **Argon2id defaults raised to 256 MiB / t=4** (from 64 MiB / t=3).
- **Disguised SQLite container** now stores the vault _inside_ a valid database
  (rows of a `cache` table under an interior b-tree, no trailing bytes) instead of
  appended after a stub, and spreads it across several rows.
- Coverage gate raised (branches 80 → 85); dev dependencies updated (Vitest 4,
  Vite 8, ESLint 10, TypeScript toolchain, GitHub Actions).

### Security

- **Per-export content key**: content is encrypted under
  `HKDF-SHA256(DEK, salt=contentSalt)`, so the AES-GCM IV-collision bound is
  per-export even though the DEK is reused across vaults.
- **Per-cover stego nonce**: the key-block stego keystream is bound to a
  fingerprint of the cover, ending whitening/position reuse under a shared password.
- Purged leftover "ImageVault" identifiers (one was a latent Google-Photos env-var
  bug).

See [SPEC.md](SPEC.md) and [docs/CRYPTO-REVIEW.md](docs/CRYPTO-REVIEW.md) for the
frozen format and the cryptographic review dossier.

[Unreleased]: https://github.com/dlamarre-dev/StegoShard/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/dlamarre-dev/StegoShard/releases/tag/v0.9.0
