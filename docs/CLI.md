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
#
# One photo, one password, one save. The cover's CONTENT keys the hiding place, so
# saving twice into the same photo under the same password produces two key images
# that differ at exactly the bits their two keys differ at — handing anyone who
# holds both the distance between them and much of the secret layout (SPEC §5.3).
# A second save into the same cover in the same run is refused; a save tomorrow
# cannot be, so that one is yours to keep. Use another photo, or another password.
# --allow-cover-reuse overrides the refusal if you mean it.
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

## Driving it from a script

`--json` replaces the human output with one JSON document on stdout and
newline-delimited progress events on stderr, so a script in any language can call
StegoShard without parsing prose that changes with the user's locale:

```bash
stegoshard estimate secret.txt --json | jq .result.images
```

The mode is non-interactive by construction: it never prompts, and never falls
back to reading stdin, so a caller with an idle pipe gets an error rather than a
hang. The envelope, the error codes and the schema-version rules are in
[API.md](API.md).

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
  that is what you download; [Verify your download](#verify-your-download) is how to use
  them. Note that the executable itself is never compressed in place:
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

  `stegoshard mcp` **is** in them, and the contrast is the point: it speaks
  newline-delimited JSON-RPC on stdin and stdout, so it needs no permission the
  binaries lack. A zero-dependency, network-incapable executable driven over a
  pipe is arguably the best place to run it. See [API.md](API.md) and the
  [threat model](THREAT-MODEL.md#driving-stegoshard-from-an-agent-mcp), which is
  worth reading first: a restore writes plaintext the agent can then read.

## Numbering exports, to catch a rollback (`--export-number`)

Off by default. It exists because nothing inside a vault can tell you it is the
_current_ vault: an AEAD tag authenticates a message, never the absence of a newer
one, so an older but perfectly valid export put back in place of a newer one
decrypts exactly as it should.

You supply the number. The tool writes it into the encrypted envelope and prints it
on the way in and on the way out.

```bash
stegoshard save notes.txt --out ./v1 --binary --export-number 1
# → tag 3f8a1c02 · export #1

stegoshard save notes.txt --out ./v2 --binary --export-number 2
# → tag 9d41b7e5 · export #2      the tag differs: see below

stegoshard restore ./v1/stegoshard-vault.ssbn --out ./restored
# → tag 3f8a1c02 · export #1      you last wrote #2
```

**The eight hex characters change on every export, by design.** They are a _tag_ for
one artifact, not an identifier for the vault, which is why the line does not say
"vault". Two exports of the same file carry unrelated tags; only the **number** is
comparable between them. A tag that persisted across exports would be a handle
proving two artifacts are versions of one thing, readable by anyone who unlocks
either — the leak this format specifically avoids (SPEC §4.1).

**Nothing compares the number for you, and that is the design rather than a gap.**
You are the memory: if you know you last wrote #5, a restore that says #4 has told
you everything. An earlier version of this feature kept a local registry of vault
identifiers and access times so the machine could compare — and that file proved how
many vaults you had and when you touched them, which is exactly the claim
deniability rests on denying. It was built, reviewed and removed before it shipped.

Two things follow from there being no record, and both are yours to keep:

- **Nothing stops you reusing a number.** `--export-number 4` twice produces two
  artifacts that both say `#4`. Keeping count is the part you own.
- **An adversary who can rewrite the vault rewrites the number with it.** This makes
  an honest mistake legible — a stale sync, an old USB stick, a restore from the
  wrong folder. It is not an anti-tamper control.

**`--export-number` is refused on every deniable destination** — `gallery-save`,
`--binary --disguise`, `--mode duress`, `--mode nonpossession`. That is an error,
not a silent no-op, because a number is itself a link between artifacts: `#7`
asserts that six others exist, to anyone who unlocks the vault. Those paths exist
for the case where someone has the file and is asking what else there is. Read
[the threat model](THREAT-MODEL.md#numbering-exports---export-number) before using
it anywhere.

It is refused the same way in two other cases, for the same reason — a flag that
quietly did nothing would leave you believing the numbering had happened:

- **on any command but `save`**, the only one that writes an identity into an
  envelope;
- **on a value that is not an export number**: empty, zero, negative, fractional,
  or past 4294967295, which is the largest the envelope field holds.

With `--json`, a numbered restore carries `export` and `tag` alongside the usual
fields, so a script can read the number without scraping it out of the notes.

## Verify your download

Every tagged release publishes three archives, a `SHA256SUMS.txt`, an SBOM, and a
[build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
minted by the `Release CLI binaries` workflow. Two checks use them, and they answer
different questions. Do both, and do them **before the first run**: a check you perform
after executing the file is a check you have already lost.

**1. The bytes are the bytes that were published.**

```bash
# Linux
sha256sum -c --ignore-missing SHA256SUMS.txt
# macOS
shasum -a 256 -c --ignore-missing SHA256SUMS.txt
```

`--ignore-missing` is not optional. `SHA256SUMS.txt` lists all three platforms plus the
licence files, and you downloaded one of them; without it the command reports the five
files you never asked for as failures and exits non-zero.

Windows has no `sha256sum`. Compare the one line you care about:

```powershell
(Get-FileHash -Algorithm SHA256 .\stegoshard-windows-x64.zip).Hash.ToLower()
Select-String stegoshard-windows-x64.zip .\SHA256SUMS.txt
```

**On its own this is still a transfer check, and knowing why is the point.**
`SHA256SUMS.txt` is served from the same release page as the archive, so reading
both and comparing them proves only that the two agree — which they would also do
if someone replaced both. What it genuinely catches on its own is a truncated or
corrupted download, a stale mirror, and a CDN that touched one file and not the
other.

What makes it worth more than that is check 2 below: the checksum file is itself
attested, so you can establish it once and then use the cheap hash comparison for
every archive without running `gh attestation verify` on each. Verify the list
first, then trust it. Verified in the other order, it tells you nothing an
attacker could not have arranged.

**2. The archive came out of this repository's release workflow.** This is the one
that is not circular, because the signature chains to a Sigstore transparency log
rather than to a file sitting next to the download. It needs the
[GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify stegoshard-linux-x64.tar.gz \
  --repo dlamarre-dev/StegoShard \
  --signer-workflow dlamarre-dev/StegoShard/.github/workflows/release-cli.yml
```

Substitute `stegoshard-macos-arm64.tar.gz` or `stegoshard-windows-x64.zip`; the same
command works in PowerShell. Attesting the archive rather than the executable inside
it is deliberate: the archive is what you downloaded, so it is what you can check
without first unpacking something you have not yet verified. The SBOM
(`stegoshard-npm.cdx.json`) and **`SHA256SUMS.txt`** are attested on the same
terms, the latter so that the file establishing everyone else's integrity is not
the only one on the page without any of its own. `LICENSE` and
`THIRD_PARTY_NOTICES.txt` are not: they carry no integrity claim about anything,
so attesting them would only blur what an attestation means.

Verify the checksum file the same way, then check 1 becomes a real check rather
than a self-referential one:

```bash
gh attestation verify SHA256SUMS.txt \
  --repo dlamarre-dev/StegoShard \
  --signer-workflow dlamarre-dev/StegoShard/.github/workflows/release-cli.yml
```

`--signer-workflow` is worth typing. Without it, `gh` accepts an attestation from
_any_ workflow in the repository. For the offline web bundle the corresponding
workflow is `.github/workflows/pages.yml` and the checksum file is
`SHA256SUMS-web.txt`.

**What a passing attestation proves, exactly.** That these bytes were produced by a
run of that workflow, at a named commit, in this repository, and have not changed
since. It proves nothing whatsoever about whether that commit or that workflow is
benign. A maintainer who ships a weakened key derivation, and an attacker who has
taken the repository, both produce artifacts that verify perfectly. Provenance moves
the question from "did someone swap this file in transit", which it answers, to "do I
trust this repository and the people with write access to it", which it does not and
cannot. This tool holds your secrets; that second question is yours, and the sources
for it are the [claims register](CLAIMS.md), the [cryptographic review
dossier](CRYPTO-REVIEW.md), the commit history and the CI logs — not a signature.
The [threat model](THREAT-MODEL.md#the-build-and-the-download) sets out what a
compromised build could still do to you.

### The operating system will also object, and it is not wrong to

The binaries carry **no code-signing identity**: no Apple Developer ID, no
notarization, no Authenticode certificate.

On macOS, `deno compile` ad-hoc signs the `aarch64` output because the platform
refuses to execute an unsigned arm64 binary at all, but ad-hoc is not notarization.
Depending on how you unpack the archive — Archive Utility propagates the quarantine
flag, `tar` in a terminal does not — the first run may be refused with "Apple could
not verify…". After, and only after, both checks above pass:

```bash
xattr -d com.apple.quarantine ./stegoshard-macos-arm64
```

On Windows, SmartScreen shows "Windows protected your PC" for an unsigned executable
with no download reputation, and there is no download volume at which that stops
being true for a project this size. `More info` → `Run anyway`, or `Unblock-File
.\stegoshard-windows-x64.exe`.

Telling you to click past a security prompt is exactly the instruction malware
distributors give, which is why the order matters and why the checks come first.
Signing certificates are a 1.0 question: they cost money and, more to the point, an
Authenticode key or an Apple Developer identity in CI is a new secret to hold and a
new thing to lose. Today the honest position is that the attestation is stronger
evidence than a code-signing certificate would be, and that neither dialog is lying
to you.

### Builds are not reproducible, and that is a real gap

Rebuilding a tag on your own machine will not give you a byte-identical archive, and
nothing here claims otherwise. `deno compile` embeds a V8 snapshot and does not
honour `SOURCE_DATE_EPOCH`; the `.tar.gz` records an mtime in its gzip header and the
`.zip` its own timestamps. There is no rebuild-and-compare job, because there is
nothing yet for it to compare.

So the attestation is currently the _only_ link between the published binary and the
source, and that link runs through GitHub's runners: it says the workflow produced
the file, not that the file corresponds to the source you can read. A reproducible
build is what would let anyone close that gap without trusting the runner. It is on
the list; it is not done. Until it is, the strongest thing you can do beyond the two
checks above is build from a clone.

Paper mode renders Latin instruction text with pdf-lib's built-in Helvetica;
CJK (`ja`/`ko`/`zh`) uses a `--font <.ttf/.otf>` or a system font, falling back to
English if none is found; nothing is ever downloaded. The system-font candidates are
per-script, since a Japanese or Chinese face carries no Hangul.
