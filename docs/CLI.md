# Command-line tool

A headless **CLI** runs the exact same `@core` format as the extension and web app, so
vaults are interchangeable across all of them (and the [Python decoder](../python/README.md)).
It can both **create** and **restore** vaults, unlike the decode-only Python reference
decoder.

```bash
npm run cli -- save secret.txt --out ./vault

# Several files, or a whole directory: zipped into one bundle inside the vault
# and unpacked back to the originals on restore.
npm run cli -- save notes.txt key.pem ./photos --out ./vault           # → PNG images
npm run cli -- restore ./vault --out ./restored        # ← images / folder / .zip / .pdf
npm run cli -- estimate secret.txt                     # how many images it will take
```

Key modes and paper output mirror the apps:

```bash
# Hybrid mode (🔗): the archive is stored resiliently as images, and only the
# recovery key is hidden deniably inside an ordinary photo. A baseline JPEG
# cover stays a JPEG of the same size, metadata, and filename (the key rides in
# its DCT coefficients); a PNG cover stays a PNG. The key image is named after
# the cover, so restore points --key at that file. If the cover photo is later
# recompressed, only the key is lost; the resilient archive survives.
npm run cli -- save wallet.dat --key-mode stego --cover cat.jpg --out ./vault
npm run cli -- restore ./vault --key ./vault/cat.jpg --out ./restored

# Image code: 'color' (default) is an 8-colour grid, about 3x the bytes per
# image, so roughly a third as many files. 'qr' is a plain QR code any phone can
# read. Restore reads either automatically; printed pages always use QR.
npm run cli -- save secret.txt --codec color      # the default
npm run cli -- save secret.txt --codec qr
npm run cli -- estimate secret.txt --codec qr    # compare the file counts

# Extra entropy (optional, expert; `save` and `gallery-save` only), since they are the
# commands that generate key material). Whatever you supply is XORed into every
# random value the save generates, on top of the OS CSPRNG, which is always
# used, so a weak string can only fail to help, never weaken the vault. It
# affects generation only: nothing about it is stored, and restore never asks
# for it. --entropy is discouraged (shell history, process list), and
# --entropy-prompt needs a terminal (piped stdin belongs to the password).
npm run cli -- save secret.txt --entropy-file dice.txt --out ./vault
npm run cli -- save secret.txt --entropy-prompt --out ./vault
STEGOSHARD_ENTROPY="$(head -c 64 /dev/urandom | base64)" npm run cli -- save secret.txt
npm run cli -- restore ./vault --out ./restored   # no entropy argument needed

# Printable PDF with a localized instruction sheet.
npm run cli -- save notes.txt --paper --instructions --locale fr --out ./print

# Binary (non-image) output: one opaque file instead of QR images, for larger
# secrets (up to 1 GiB, no image-count ceiling). --disguise wraps it as a decoy
# database with a valid SQLite header so file-type triage reads it as an ordinary
# .db (SPEC §8).
npm run cli -- save archive.zip --binary --disguise --out ./vault
npm run cli -- restore ./vault/cache.db --out ./restored

# Gallery Mode (SPEC §9): hide a small secret fragmented across a folder of
# ordinary photos (plus decoys), Reed-Solomon-protected. The output photos look
# unchanged; restore is blind: any photos that authenticate are used, and any K
# fragments rebuild the secret. Needs 5+ photos (at least 2 become decoys).
npm run cli -- gallery-save note.txt ./photos --out ./album
npm run cli -- gallery-restore ./album --out ./restored

# Duress mode (SPEC §10.9, --binary --disguise only): a plausible decoy opens
# under a 2nd, independent password, while the real payload stays unreachable
# from that credential. --duress-password-file avoids the 2nd password ever
# touching shell history. Restore is the plain `restore` command in both
# cases: whichever password is given opens its own region; nothing about
# which one you used is ever revealed.
npm run cli -- save wallet.dat --binary --disguise --mode duress \
  --decoy vacation-plans.pdf --duress-password-file duress-pw.txt --out ./vault
npm run cli -- restore ./vault/cache.db --out ./restored                     # real password  → real payload
npm run cli -- restore ./vault/cache.db --password-file duress-pw.txt --out ./restored  # duress password → decoy

# Non-possession mode (SPEC §10.8, .db and Gallery): gate the real payload on
# Shamir k-of-n threshold shares that the writer never keeps. "I cannot
# decrypt this" is literally true below threshold. --threshold k-of-n writes n
# share files (recovery-1.txt …); collect any k of them to restore. Both the
# filenames and the text inside them stay neutral: these are deniable
# destinations, so nothing they write names the project.
npm run cli -- save wallet.dat --binary --disguise --mode nonpossession --threshold 2-of-3 --out ./vault
npm run cli -- restore ./vault/cache.db \
  --share ./vault/recovery-1.txt --share ./vault/recovery-2.txt --out ./restored

# Non-possession also works on Gallery Mode (duress does not, since a gallery's
# password-derived winnowing key can't host two independent credentials).
npm run cli -- gallery-save note.txt ./photos --mode nonpossession --threshold 2-of-3 --out ./album
npm run cli -- gallery-restore ./album \
  --share ./album/recovery-1.txt --share ./album/recovery-2.txt --out ./restored
```

Images and PDF are capped at 1 MiB (a warning shows the resulting image count
past 256 KiB); the binary output raises that to 1 GiB. On the binary path a live
progress indicator prints each phase (compressing / encrypting / verifying …) to
stderr; pass `--quiet` to suppress it.

The password is taken (in order) from `--password` (which prints a warning, since it is
visible in your shell history and the process list), `--password-file`, the
`STEGOSHARD_PASSWORD` environment variable, or an interactive hidden prompt.

## The same app, in a browser, from your own machine

`stegoshard ui` serves the web build locally and prints an address to open. It is the
same guided and expert flows as [the hosted app](https://dlamarre-dev.github.io/StegoShard/),
running from your disk, with no request leaving the machine.

```bash
npx stegoshard ui                 # prints http://127.0.0.1:<free port>/s/<token>/
npx stegoshard ui --port 8137     # pin the port instead of taking a free one
npx stegoshard ui --open          # and launch the browser
```

Its notice, like everything else the CLI prints, follows the system language (see
[Language](#language)).

Running `stegoshard` with no arguments still prints usage: a browser opening itself out
of an SSH session or a cron job is the wrong kind of surprise, so this is asked for
explicitly.

What it does and does not do:

- it binds **127.0.0.1 only**, never a wildcard, and there is no `--host`;
- the app lives under a **random path token**, so nothing else on a shared machine finds
  it by scanning loopback ports, and a page that resolves a name to 127.0.0.1 gets a 404;
- it serves a fixed set of files read at startup. No request path is ever joined onto a
  directory, so there is nothing outside the build to reach;
- it holds no state and reads no request body. The page's CSP (`connect-src 'none'`)
  forbids it from calling back, so your secrets stay in the tab.

**It is not the private path.** The command line leaves nothing behind but the files you
ask for; a browser adds its cache, its history, its download folder and a small
preference entry. If that matters for what you are storing, use the commands above
instead. See [THREAT-MODEL.md](THREAT-MODEL.md#the-local-web-ui).

**Not in the standalone binaries.** They are compiled without network access (see
[Packaging](#packaging)), so they cannot listen at all; `ui` there explains where to get
it. Use `npx stegoshard ui`, or the offline web bundle from the releases page, which
ships a `serve.mjs` for exactly this (its `index.html` cannot be opened directly: ES
modules and module workers are both blocked over `file://`).

## Language

The CLI speaks the system language: `--help`, every error, the progress phases and
the result lines, in the same nine locales as the app (`en`, `fr`, `de`, `es`,
`it`, `pt`, `ja`, `ko`, `zh_TW`), falling back to English for anything else.

Detection is ICU's default locale, which is the only portable source: Windows sets
no `LANG`, and ICU there follows the regional settings, while on Unix it follows
`LC_ALL`/`LANG`.

```bash
STEGOSHARD_LANG=en stegoshard --help    # pin the language, whatever the system says
STEGOSHARD_LANG=ja stegoshard save      # or ask for another one
```

**What is never translated**, so scripts and docs keep working: flag names,
environment variable names, subcommands, the example commands in `--help`, and the
`http://127.0.0.1:…` address the `ui` command prints. Pin `STEGOSHARD_LANG=en` in
anything that greps the output; the test suite does exactly that.

The messages live in `src/cli/i18n/`, one file per locale, typed against the
English catalog so a missing key cannot compile. `--help` is rendered from those
descriptions rather than written out per language, so the flag columns are aligned
by code and no translation can drift out of structure. See
[LOCALIZATION.md](LOCALIZATION.md).

## Packaging

Two ways to install, depending on whether you already have Node:

- **npm (small, recommended).** `npm i -g stegoshard` (or `npx stegoshard …`) pulls the
  minified `dist-cli/stegoshard.js` bundle plus its pure-JS/WASM deps, a few MB. Needs
  Node ≥ 20. `npm run build:cli` produces that self-contained, shebang-included bundle.
- **Standalone binary (larger, zero-dependency).** From the same bundle, `deno compile`
  produces per-OS executables (see the `Release CLI binaries` workflow). These embed the
  Deno/V8 runtime, so they are **large** even though the app code is tiny, roughly
  215-285 MB depending on platform, compressing to roughly 65-85 MB. (Exact figures move
  with the Deno and dependency versions; the `Release dry run` workflow prints the current
  ones for every target, which is the number to trust.) They are therefore published as
  compressed archives: `stegoshard-<platform>.tar.gz` for Linux and macOS,
  `stegoshard-windows-x64.zip` for Windows. Unpack, then run the binary inside.
  `SHA256SUMS.txt` and the build-provenance attestation both cover the **archive**, since
  that is what you download. Note that the executable itself is never compressed in place:
  UPX is not usable on `deno compile` output: it breaks the macOS
  Gatekeeper signature, refuses the Linux binary outright, and, worst of all, packs the Windows
  binary successfully but leaves it aborting inside V8 on startup, because V8 re-protects
  pages for JIT and the unpacker leaves them in a state it rejects. They resolve nothing at
  run time and have baked-in
  `--allow-read --allow-write` permissions with **no network access**, so "nothing leaves
  your device" is enforced by the runtime.
  That is why `stegoshard ui` is not available in them: serving the app locally needs a
  listening socket, and a permission this claim rests on is not worth spending on a
  convenience. The npm/`npx` CLI has it instead, and the offline web bundle carries its
  own launcher.

Paper mode renders Latin instruction text with pdf-lib's built-in Helvetica;
CJK (`ja`/`ko`/`zh`) uses a `--font <.ttf/.otf>` or a system font, falling back to
English if none is found; nothing is ever downloaded. The system-font candidates are
per-script, since a Japanese or Chinese face carries no Hangul.
