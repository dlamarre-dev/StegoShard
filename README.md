# StegoShard

> Encrypt a file and encode it into **robust, error-corrected images** you can store
> **anywhere** — on disk, on paper, or in the cloud. A cross-browser WebExtension
> (Chrome, Edge, Firefox) for **small, high-value secrets**: password exports, keys,
> seed phrases, configs, `.env` files, notes.

StegoShard is a **resilient, support-agnostic vault**, not a stealth steganography tool.
Your file is encrypted (zero-knowledge) and then encoded into a set of **openly
artificial images** designed to survive recompression and printing, spread across the
set with **cross-image error correction** (erasure coding). Store them where you like:
image files on disk, a printable PDF, or a cloud photo album.

## Quickstart

Three ways to use StegoShard; all run the **same `@core` format**, so a vault made with
one restores with any other (and with the [Python decoder](python/README.md)).

**1. Web app — no install, nothing leaves your device.** The fastest way to try it: the
offline core (Disk + Paper) runs entirely in your browser.

> ▶️ **[dlamarre-dev.github.io/StegoShard](https://dlamarre-dev.github.io/StegoShard/)**

**2. Browser extension.** During beta, build it and load it unpacked (store listings are
pending, see [Status](#status)):

```bash
npm install
npm run build            # → dist/chrome/  (also: npm run build:firefox, build:edge)
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/chrome/`
(Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on** → its `manifest.json`).

**3. Command-line tool.** From a clone, no global install needed:

```bash
npm install
npm run cli -- save secret.txt --out ./vault      # → PNG images
npm run cli -- restore ./vault --out ./restored    # ← images / folder / .zip / .pdf
```

See [Command-line tool](#command-line-tool) for key modes, paper, binary, and Gallery Mode.
(A published `npm i -g stegoshard` and standalone binaries land with 1.0.)

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

🧪 **Beta — feature-complete, hardening for a public 1.0.** Every piece of the product
is built, tested, and cross-validated; what remains before 1.0 is release logistics and
an external review, not features.

**Complete and tested:**

- **Crypto core** — Argon2id KEK/DEK, AES-256-GCM, opportunistic gzip, Reed-Solomon
  erasure coding, the QR-grid image codec, and the self-describing header. The layer is
  documented for auditors in a [cryptographic review dossier](docs/CRYPTO-REVIEW.md)
  (claims → where enforced → which test proves it), with frozen cross-implementation
  test vectors and exhaustive negative/fuzz testing.
- **Destinations** — **Disk** (a set of PNG images, or a single `.zip`), **Paper** (a
  printable PDF, one high-ECC QR per page, readable header + optional instruction sheet,
  restores from scans or photos), and an **optional Google Photos** album (upload +
  restore via the Picker API); the cloud is a convenience, never the only copy.
- **Key modes** — **embedded** (key block travels in the images), **keyfile** (a separate
  `.key` file), and **deniable stego** (the key hidden in an ordinary photo — a baseline
  JPEG cover stays a same-size JPEG via DCT-coefficient embedding, a PNG cover stays a
  PNG). Plus a **managed vault key** in the options page (create / unlock per session /
  change password / export / import / erase); the unlocked session is volatile and
  persists across popup reopens until the browser closes.
- **Advanced output** — a **binary (non-image) container** for larger secrets (up to
  100 MB, no image-count ceiling), optionally **disguised** with a valid SQLite header
  (SPEC §8); and **Gallery Mode** (SPEC §9), which fragments a small secret across a
  folder of ordinary photos plus decoys, Reed-Solomon-protected and decoded blindly.
- **Independent recovery** — a standalone **[Python reference decoder](python/README.md)**
  restores a vault without the extension and runs in CI as a cross-implementation
  conformance test, and a headless **CLI** (below) creates and restores the same format.
- **Localization** — the UI, privacy policy, and terms are localized into 8 languages
  (en, fr, it, de, es, pt, ja, zh_TW; see [docs/LOCALIZATION.md](docs/LOCALIZATION.md)),
  all natively proofread.

The on-image format is **frozen** in [SPEC.md](SPEC.md) (`FORMAT_VERSION = 1`). The
extension is packaged for the Chrome Web Store, Edge Add-ons, and Firefox
(`npm run package`); see [docs/STORE.md](docs/STORE.md) and the
[privacy policy](docs/PRIVACY.md).

**Remaining before a public 1.0:** localized store screenshots, Google's OAuth
verification (only for the public Google Photos destination), and an optional external
crypto review.

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

# Binary (non-image) output: one opaque file instead of QR images, for larger
# secrets (up to 100 MB, no image-count ceiling). --disguise gives it a valid
# SQLite header so file-type triage reads it as an ordinary .db (SPEC §8).
npm run cli -- save archive.zip --binary --disguise --out ./vault
npm run cli -- restore ./vault/cache.db --out ./restored

# Gallery Mode (SPEC §9): hide a small secret fragmented across a folder of
# ordinary photos (plus decoys), Reed-Solomon-protected. The output photos look
# unchanged; restore is blind — any photos that authenticate are used, and any K
# fragments rebuild the secret. Needs 5+ photos (at least 2 become decoys).
npm run cli -- gallery-save note.txt ./photos --out ./album
npm run cli -- gallery-restore ./album --out ./restored
```

Images and PDF are capped at 1 MB (a warning shows the resulting image count
past 256 KB); the binary output raises that to 100 MB.

The password is taken (in order) from `--password` (which prints a warning — it is
visible in your shell history and the process list), `--password-file`, the
`STEGOSHARD_PASSWORD` environment variable, or an interactive hidden prompt.

**Packaging.** Two ways to install, depending on whether you already have Node:

- **npm (small, recommended).** `npm i -g stegoshard` (or `npx stegoshard …`) pulls the
  minified `dist-cli/stegoshard.js` bundle plus its pure-JS/WASM deps — a few MB. Needs
  Node ≥ 20. `npm run build:cli` produces that self-contained, shebang-included bundle.
- **Standalone binary (larger, zero-dependency).** From the same bundle, `deno compile`
  produces per-OS executables (see the `Release CLI binaries` workflow). These embed the
  Deno/V8 runtime, so they are tens of MB even though the app code is tiny; the Linux and
  Windows binaries are UPX-compressed (~25-35 MB), the macOS one is shipped uncompressed
  (UPX breaks its Gatekeeper signature). They resolve nothing at run time and have baked-in
  `--allow-read --allow-write` permissions with **no network access**, so "nothing leaves
  your device" is enforced by the runtime.

Paper mode renders Latin instruction text with pdf-lib's built-in Helvetica;
CJK (`ja`/`zh`) uses a `--font <.ttf/.otf>` or a system font, falling back to English if
none is found — nothing is ever downloaded.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). All contributions
go through pull requests with required checks (lint, typecheck, tests, build). Please
report vulnerabilities privately via GitHub Security Advisories — never crypto in a
public issue.

## License

[MIT](LICENSE).
