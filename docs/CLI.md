# Command-line tool

A headless **CLI** runs the exact same `@core` format as the extension and web app, so
vaults are interchangeable across all of them (and the [Python decoder](../python/README.md)).
It can both **create** and **restore** vaults — unlike the decode-only Python reference
decoder.

```bash
npm run cli -- save secret.txt --out ./vault           # → PNG images
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
# recompressed, only the key is lost — the resilient archive survives.
npm run cli -- save wallet.dat --key-mode stego --cover cat.jpg --out ./vault
npm run cli -- restore ./vault --key ./vault/cat.jpg --out ./restored

# Image code: 'color' (default) is an 8-colour grid — about 3x the bytes per
# image, so roughly a third as many files. 'qr' is a plain QR code any phone can
# read. Restore reads either automatically; printed pages always use QR.
npm run cli -- save secret.txt --codec color      # the default
npm run cli -- save secret.txt --codec qr
npm run cli -- estimate secret.txt --codec qr    # compare the file counts

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
# unchanged; restore is blind — any photos that authenticate are used, and any K
# fragments rebuild the secret. Needs 5+ photos (at least 2 become decoys).
npm run cli -- gallery-save note.txt ./photos --out ./album
npm run cli -- gallery-restore ./album --out ./restored

# Duress mode (SPEC §10.9, --binary --disguise only): a plausible decoy opens
# under a 2nd, independent password, while the real payload stays unreachable
# from that credential. --duress-password-file avoids the 2nd password ever
# touching shell history. Restore is the plain `restore` command in both
# cases — whichever password is given opens its own region; nothing about
# which one you used is ever revealed.
npm run cli -- save wallet.dat --binary --disguise --mode duress \
  --decoy vacation-plans.pdf --duress-password-file duress-pw.txt --out ./vault
npm run cli -- restore ./vault/cache.db --out ./restored                     # real password  → real payload
npm run cli -- restore ./vault/cache.db --password-file duress-pw.txt --out ./restored  # duress password → decoy

# Non-possession mode (SPEC §10.8, .db and Gallery): gate the real payload on
# Shamir k-of-n threshold shares that the writer never keeps — "I cannot
# decrypt this" is literally true below threshold. --threshold k-of-n writes n
# share files; collect any k of them to restore.
npm run cli -- save wallet.dat --binary --disguise --mode nonpossession --threshold 2-of-3 --out ./vault
npm run cli -- restore ./vault/cache.db \
  --share ./vault/stegoshard-share-1.txt --share ./vault/stegoshard-share-2.txt --out ./restored

# Non-possession also works on Gallery Mode (duress does not — a gallery's
# password-derived winnowing key can't host two independent credentials).
npm run cli -- gallery-save note.txt ./photos --mode nonpossession --threshold 2-of-3 --out ./album
npm run cli -- gallery-restore ./album \
  --share ./album/stegoshard-share-1.txt --share ./album/stegoshard-share-2.txt --out ./restored
```

Images and PDF are capped at 1 MiB (a warning shows the resulting image count
past 256 KiB); the binary output raises that to 1 GiB. On the binary path a live
progress indicator prints each phase (compressing / encrypting / verifying …) to
stderr; pass `--quiet` to suppress it.

The password is taken (in order) from `--password` (which prints a warning — it is
visible in your shell history and the process list), `--password-file`, the
`STEGOSHARD_PASSWORD` environment variable, or an interactive hidden prompt.

## Packaging

Two ways to install, depending on whether you already have Node:

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
