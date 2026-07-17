# ImageVault

> Encrypt a file and encode it into **robust, error-corrected images** you can store
> **anywhere** — on disk, on paper, or in the cloud. A cross-browser WebExtension
> (Chrome, Edge, Firefox) for **small, high-value secrets**: password exports, keys,
> seed phrases, configs, `.env` files, notes.

ImageVault is a **resilient, support-agnostic vault**, not a stealth steganography tool.
Your file is encrypted (zero-knowledge) and then encoded into a set of **openly
artificial images** designed to survive recompression and printing, spread across the
set with **cross-image error correction** (erasure coding). Store them where you like:
image files on disk, a printable PDF, or a cloud photo album.

## What it does

**Save (export)**

```
file → unlock (password → KEK → DEK) → compress → encrypt (AES-GCM)
     → erasure code (k data + m parity shards, Reed-Solomon)
     → render each shard as a robust image (profile per destination)
     → disk (PNG/ZIP) | paper (printable PDF) | cloud album (optional)
```

**Restore (import)**

```
import images (any source) → decode each (self-describing header → shard)
     → Reed-Solomon reconstruct (tolerates up to m missing/corrupt images)
     → unlock → decrypt → decompress → original file, byte-for-byte
```

The differentiator: **losing a page, a deleted album image, or an unreadable code does
not stop restoration** as long as at least `k` images survive.

## Design principles

- **No deniability.** The images look like coded noise, not vacation photos — this is
  deliberate; we optimize for robustness, not concealment.
- **Small secrets.** ~4× size overhead; large binaries are out of scope.
- **No single support is trusted.** Resilience (multiple destinations + erasure coding)
  is the value proposition.
- **The offline core (file → images → disk/paper) depends on no third-party service or
  network.** Google Photos is an optional destination only.
- **Auditable.** Open source (MIT), PR-gated, with a versioned format spec and a
  standalone Python reference decoder so your data survives even if the extension does not.

## Status

🚧 **Early development — Phase 2 (UX / managed key).** The offline pipeline is complete
and tested: Argon2id KEK/DEK, AES-GCM, opportunistic gzip, Reed-Solomon erasure coding,
the QR-grid image codec, the self-describing header, and the **Disk** destination (save
a file as a set of PNG images, restore it — tolerating missing images). Phase 2 adds a
**managed vault key** (create / unlock per session / change password / export / import /
erase, in the options page), **key modes** (key embedded in the images, or a separate
`.key` file), an optional **readable label band** on the images, and clear error
messages. The unlocked session persists across popup reopens (volatile, until the
browser closes), and image sets can be saved and restored as a single **.zip**. A
**Paper** destination generates a printable PDF (one high-ECC QR per page, with a
readable header and an optional instruction sheet) that restores from scans or photos.
A standalone **[Python reference decoder](python/README.md)** restores a vault without the
extension and runs in CI as a cross-implementation conformance test. An **optional Google
Photos** destination (upload to a dedicated album, restore via the Picker API, Cloud
profile) is available when a Google OAuth client id is configured in a local `.env` (see
`.env.example`); it is a convenience, never the only copy. The UI is localized into 8
languages (en, fr, it, de, es, pt, ja, zh_TW; see [docs/LOCALIZATION.md](docs/LOCALIZATION.md)).
The on-image format is frozen in [SPEC.md](SPEC.md). The extension is packaged for the
Chrome Web Store, Edge Add-ons, and Firefox (`npm run package`); see
[docs/STORE.md](docs/STORE.md) and the [privacy policy](docs/PRIVACY.md). Remaining before
a public 1.0: native proofread of the `ja`/`zh_TW` locales, localized store screenshots,
Google's OAuth verification (only for public Google Photos), and an optional external
crypto review. The optional stego key mode is a later addition.

## Development

Requires Node.js ≥ 20.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # build the Chrome/Edge extension into dist/
npm run build:firefox
```

Each target builds into its own directory. There is also a **standalone web app** (the offline core — Disk + Paper — with no
install and nothing leaving your device), built with `npm run build:web` / `npm run
dev:web` and deployed to GitHub Pages. It doubles as an extension-independent recovery
tool.

## Command-line tool

A headless **CLI** runs the exact same `@core` format as the extension and web app, so
vaults are interchangeable across all of them (and the Python decoder). It can both
**create** and **restore** vaults — unlike the decode-only Python reference decoder.

```bash
npm run cli -- save secret.txt --out ./vault           # → PNG images
npm run cli -- restore ./vault --out ./restored        # ← images / folder / .zip / .pdf
npm run cli -- estimate secret.txt                     # how many images it will take
```

Key modes and paper output mirror the apps:

```bash
# Deniable stego: the key is hidden inside an ordinary photo. A baseline JPEG
# cover stays a JPEG of the same size, metadata, and filename (the key rides in
# its DCT coefficients); a PNG cover stays a PNG. The key image is named after
# the cover, so restore points --key at that file.
npm run cli -- save wallet.dat --key-mode stego --cover cat.jpg --out ./vault
npm run cli -- restore ./vault --key ./vault/cat.jpg --out ./restored

# Printable PDF with a localized instruction sheet.
npm run cli -- save notes.txt --paper --instructions --locale fr --out ./print
```

The password is taken (in order) from `--password` (which prints a warning — it is
visible in your shell history and the process list), `--password-file`, the
`IMAGEVAULT_PASSWORD` environment variable, or an interactive hidden prompt.

**Packaging.** `npm run build:cli` bundles the CLI into a single self-contained
`dist-cli/imagevault.js` (shebang included) for `npx imagevault …`. From that bundle,
`deno compile` produces standalone per-OS executables (see the `Release CLI binaries`
workflow) — pure JS + WASM, no npm resolution, and baked-in `--allow-read --allow-write`
permissions with **no network access**, so "nothing leaves your device" is enforced by
the runtime. Paper mode renders Latin instruction text with pdf-lib's built-in Helvetica;
CJK (`ja`/`zh`) uses a `--font <.ttf/.otf>` or a system font, falling back to English if
none is found — nothing is ever downloaded.

Load `dist/chrome/` as an unpacked extension
(`chrome://extensions` → Developer mode → Load unpacked), or `dist/firefox/` in Firefox
(`about:debugging` → This Firefox → Load Temporary Add-on → pick its `manifest.json`).

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). All contributions
go through pull requests with required checks (lint, typecheck, tests, build). Please
report vulnerabilities privately via GitHub Security Advisories — never crypto in a
public issue.

## License

[MIT](LICENSE).
