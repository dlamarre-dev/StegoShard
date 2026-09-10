# <img src="public/icons/icon-128.png" alt="" width="50" height="50" align="top" /> StegoShard

> **Store secrets in images.** Choose whether they survive anything, or whether nobody can
> tell they exist. For **small, high-value secrets**: seed phrases, private keys,
> password-manager exports, recovery codes, `.env` files, notes.

StegoShard encrypts your file on your own machine and writes it out in a form built to
last. No account, no upload, no server. It runs as a browser extension, a web app, or a
command-line tool, and all three produce the same format.

## Pick one: survive, or stay hidden

You cannot have both at once. Surviving damage means adding redundancy, and redundancy is
visible. Hiding means adding nothing visible, which makes it fragile. StegoShard makes you
choose rather than pretending one setting does both.

|                                | 🛡 **Resilient**                         | 🎭 **Deniable**                       |
| ------------------------------ | --------------------------------------- | ------------------------------------- |
| Goal                           | never lose the data                     | nobody knows it is there              |
| Looks like                     | openly coded images, or one opaque file | ordinary photos, or a dull `.db` file |
| Survives recompression + print | by design                               | no                                    |
| Hides that data exists         | no                                      | against casual inspection             |

**🔗 Hybrid** takes both. Store the encrypted archive resiliently, and hide only the
recovery key in an everyday photo:

```
Your file → 🛡 resilient images (survive loss, printing, copying)
                     └── recovery key → 🎭 hidden in an ordinary photo
```

If that photo gets posted to a social network, recompression destroys the hidden key, by
design. The deniable part is small and expendable; the archive stays intact.

> **Meet Alice.** She wants to keep her password-manager export for years without a cloud
> company, or anyone glancing at her drive, knowing it exists. She picks Hybrid: the
> encrypted archive becomes **six printed pages** in a drawer, and the **recovery key**
> hides inside a **family photo** in her Dropbox.
>
> Four years later one page is lost and coffee has ruined another. It does not matter.
> Five pages plus the photo restore everything byte for byte, and the photo looked like a
> photo the whole time.

Both answers in that table are narrower than they sound. [What it does not
promise](#what-it-does-not-promise) says how much narrower.

## What comes out

Four output forms. Pick the guarantee you want, then what it should look like on disk.

| Form                               |    Model    | What it is                                                                                                                          |
| ---------------------------------- | :---------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Coded images** (disk or paper)   | 🛡 Resilient | Openly artificial images built to survive recompression and printing. Colour grid by default, plain QR one click away. Up to 1 MiB. |
| **Opaque file** (`.ssbn`)          | 🛡 Resilient | One compact file, no image-count ceiling: up to 1 GiB in the CLI, 256 MiB in the browser. Clearly a StegoShard vault.               |
| **Decoy database** (`.db`)         | 🎭 Deniable | The same bytes, at the same sizes, behind a valid SQLite header, so file-type triage reads it as an ordinary database.              |
| **Ordinary photos** (Gallery Mode) | 🎭 Deniable | The secret, or just the key, hidden inside real photos. Blends in completely, dies if the photo is recompressed. A few KB.          |

The two deniable forms can add an **access structure** (SPEC §10). **Non-possession** puts
the real payload behind threshold shares you deliberately do not keep, and works on both.
**Duress**, where a second password opens a plausible decoy instead of the real thing, is
`.db` only.

**Gallery Mode** is the photo form when the carrier is a _folder_ rather than one image
(SPEC §9). The secret is erasure-coded and scattered across the photos you supply, at most
2 KB per photo, so losing or recompressing some of them still restores — the same
`k`-of-`n` bargain as the resilient paths, bought inside carriers that do not look coded.
Some of the photos are filled with random bytes instead, so the set carries no signal about
how many of them are real. Restore is **blind**: every photo is trial-decrypted, whatever
authenticates is used, and a wrong password simply yields nothing that opens, which looks
exactly like a folder with no gallery in it. It needs **at least 5 photos**, and the secret
has to compress into 64 KiB, so this is the path for a key, a seed phrase or a note — not
an archive.

The limit worth knowing before you use it: Gallery Mode modifies **every** photo it
touches, so an adversary holding your untouched originals can diff them and see that all of
them changed. Single-image stego gives that adversary one file to compare; a gallery gives
them the whole album.

### The same 40 KB file, saved three ways

Real output from the pipeline. Regenerate with `npm run samples`.

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/images/sample-color-grid.png" alt="A StegoShard colour-grid image: a dense grid of eight-colour squares under a header bearing the app mark, the wordmark, the format version and the spec URL." width="230">
    </td>
    <td align="center" width="33%">
      <img src="docs/images/sample-qr-grid.png" alt="A StegoShard QR-grid image: a black-and-white QR code under the same header." width="230">
    </td>
    <td align="center" width="33%">
      <img src="docs/images/sample-paper.png" alt="A page of a StegoShard printable PDF: a title, the date and page number, the app mark, a high-error-correction QR code, and restore instructions in the footer." width="230">
    </td>
  </tr>
  <tr>
    <td align="center"><b>Colour grid</b> · disk<br>7 images · 8636 B each</td>
    <td align="center"><b>QR code</b> · anywhere<br>20 images · 2800 B each</td>
    <td align="center"><b>Printable PDF</b> · paper<br>one high-ECC QR per page<br>(<a href="docs/images/sample-paper.pdf">sample PDF</a>)</td>
  </tr>
</table>

The colour image is the smaller picture while holding three times as much, which is why
the same secret needs 7 files instead of 20. StegoShard reads either automatically, so the
choice costs you nothing later. Every image carries the app mark, the format version and
the spec URL, so one found years from now says what it is and where to read about it.

## Try it

Every route below produces the same format, so a vault made with one restores with any
other, including the independent [Python decoder](python/README.md).

**1. Web app.** Nothing to install, nothing leaves your device.

> ▶️ **[dlamarre-dev.github.io/StegoShard](https://dlamarre-dev.github.io/StegoShard/)**

**2. Browser extension.** Store listings are pending, so build it and load it unpacked:

```bash
npm install
npm run build            # → dist/chrome/  (also build:firefox, build:edge)
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/chrome/`.
(Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on** → its `manifest.json`.)

**3. Command line.** From a clone:

```bash
npm install
npm run cli -- save secret.txt --out ./vault      # → images
npm run cli -- restore ./vault --out ./restored   # ← images, folder, .zip or .pdf
npm run cli -- ui                                 # the web app, served from your machine
```

`ui` prints a `http://127.0.0.1/…` address to open. Opening `index.html` directly will not
work: browsers block ES modules over `file://`. See the [command-line
reference](docs/CLI.md).

Or download a standalone binary from the [releases
page](https://github.com/dlamarre-dev/StegoShard/releases): no Node, nothing to install,
and compiled with no network permission at all. Before you run it, [verify the
download](docs/CLI.md#verify-your-download) — the archives carry a SHA-256 list and a
build-provenance attestation, and the binaries are unsigned, so macOS and Windows will
both stop you on first launch.

**4. From your own program.** StegoShard can be driven by software as well as by hand:

- a **JavaScript / TypeScript library** (`stegoshard`, and `stegoshard/node` for files);
- **`--json`** on any command, which replaces the human output with one JSON document, for
  scripts in any language;
- **`stegoshard mcp`**, an MCP server so an AI agent can save and restore over stdio.

These are **unstable at 0.9.x** and can change in any release. Read [machine
interfaces](docs/API.md) first, and for the agent case the [threat
model](docs/THREAT-MODEL.md#driving-stegoshard-from-an-agent-mcp): driving a restore from
an agent is a decision to show the agent your secret.

> **Not on npm yet.** The package is deliberately unpublished pre-1.0, so `npx stegoshard`
> and `npm i stegoshard` do not work today. Build from a clone. Publication is a 1.0 gate,
> and so is publishing **with `npm publish --provenance` from the release workflow**: an
> npm package without provenance would be a weaker artifact than the binaries already are,
> and shipping one first would be a step backwards.

## How it works

**Save**

```
file → unlock (password → KEK → DEK) → compress → encrypt (AES-GCM)
     → erasure code (k data + m parity shards, Reed-Solomon)
     → render each shard as an image → disk (PNG/ZIP) or paper (PDF)
```

**Restore**

```
read images (any source) → decode each (self-describing header)
     → Reed-Solomon reconstruct (tolerates up to m missing or corrupt images)
     → unlock → decrypt → decompress → your file, byte for byte
```

That middle line is the point: **losing a page, an album image or an unreadable code does
not stop a restore**, as long as `k` images survive.

Two costs are worth knowing. Every unlock runs **Argon2id at 256 MiB**, which takes a
second or two and roughly a quarter gigabyte of memory. That slowness is the feature: it
is what makes guessing your password expensive. And the large binary path does real,
visible work, so it reports progress instead of freezing, in a Web Worker in the browser
and on stderr in the CLI.

For the concepts behind all of this, explained from scratch, read
[docs/ELI15.md](docs/ELI15.md).

## What it does not promise

Writing the limits down is a habit here rather than fine print. The full register is
[CLAIMS.md](docs/CLAIMS.md); the short version:

- **"Survives recompression" is tested, not universal.** The Cloud profile is tested
  against representative recompression, the Disk profile assumes a lossless file, and the
  print-photograph-scan campaign has not closed.
- **"Deniable" means against casual inspection.** It has been measured against
  off-the-shelf detectors, which is far weaker than resisting someone who sets out to
  analyse your carrier. A `.db` is shallow cover against a tool that actually opens it.
- **A 12-character minimum is not strength.** Security rests on your password and on the
  cost of the key derivation, in that order.
- **Not audited yet.** The independent security audit is a 1.0 gate, not something already
  behind us.
- **A signature is not a warrant of good behaviour.** Releases are checksummed and carry
  a build-provenance attestation, which proves an archive came from this repository's
  release workflow at a known commit. It does not prove that commit is benign, and the
  builds are not yet reproducible, so nobody can rebuild a release and compare. [How to
  verify, and what it is worth](docs/CLI.md#verify-your-download).
- **Nothing detects a rollback on its own.** Every part of a vault is now bound to its
  container, but an older, entirely valid export put back in place of a newer one still
  decrypts correctly. `--track` catches the silent case using a local record, and that
  record is itself a trace — off by default, and refused on deniable output.
- **Not for big files.** Images carry up to 1 MiB with about 4× overhead; the binary path
  reaches 1 GiB in the CLI and 256 MiB in the browser. Multi-gigabyte files are out of
  scope.

## Status

🧪 **Beta, under security and physical-recovery validation.** Every major workflow is
built, tested and cross-validated against an independent [Python
decoder](python/README.md) that runs in CI. What is not settled is the external
validation: the format candidate ([SPEC.md](SPEC.md), `FORMAT_VERSION = 2`) is versioned
but not frozen, and pre-1.0 compatibility is not promised.

Built and tested: the crypto core (Argon2id, AES-256-GCM, Reed-Solomon, two image codecs);
disk, paper, binary and decoy-database output; embedded, keyfile and hidden-in-a-photo key
modes plus a managed vault key; Gallery Mode and the SPEC §10 access structures; a CLI and
the machine interfaces above; and a UI localized into 9 languages. The
[cryptographic review dossier](docs/CRYPTO-REVIEW.md) maps each claim to where it is
enforced and which test proves it.

**Required before 1.0:** close the independent security audit, finish the browser and
physical QA matrix, obtain the outstanding native language reviews, then freeze the format
and the release artifacts.

## Development

Node.js 20.19 or newer.

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build         # Chrome/Edge extension → dist/
npm run build:web     # standalone offline web app
```

Each target builds into its own directory. The web app doubles as a recovery tool that
works without the extension.

## Documentation

| Doc                                                                                                    | What's in it                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [How it works, from scratch](docs/ELI15.md)                                                            | Every concept explained for a reader who has never studied cryptography. **Start here.**         |
| [Why StegoShard?](docs/WHY.md)                                                                         | The problem, and the reasoning behind the two-model design.                                      |
| [Where it fits](docs/COMPARISON.md)                                                                    | Cited competitive map vs. seed backups, encrypted archives, VeraCrypt, and steganography tools.  |
| [Command-line reference](docs/CLI.md)                                                                  | Full CLI: save/restore, key modes, paper, binary, Gallery Mode, packaging.                       |
| [Machine interfaces](docs/API.md)                                                                      | Driving StegoShard from a program: the JS/TS library, the `--json` envelope, and the MCP server. |
| [Threat model](docs/THREAT-MODEL.md)                                                                   | Adversaries, what each model defends against, and the deliberate non-goals.                      |
| [Format specification](SPEC.md)                                                                        | The beta on-disk / on-image format candidate (`FORMAT_VERSION = 2`).                             |
| [Cryptographic review dossier](docs/CRYPTO-REVIEW.md)                                                  | Claims → where enforced → which test proves it, for auditors.                                    |
| [Claims register](docs/CLAIMS.md)                                                                      | Every security and resilience claim, its evidence, and the limits it does **not** cover.         |
| [Python reference decoder](python/README.md)                                                           | Restore a vault without the extension: install, CLI, and the library API.                        |
| [Release QA protocol](docs/QA.md)                                                                      | The physical capture matrix a release is signed off against (print, photo, scan).                |
| [Roadmap](docs/ROADMAP.md) · [Privacy](docs/PRIVACY.md) · [Terms](docs/TERMS.md)                       | Direction, privacy policy, terms of use.                                                         |
| [Localization](docs/LOCALIZATION.md) · [Store guide](docs/STORE.md) · [Versioning](docs/VERSIONING.md) | Translation setup, store submission, format-version policy.                                      |
| [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)                                              | How to contribute; how to report vulnerabilities.                                                |

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Everything lands
through pull requests with required checks. Report vulnerabilities privately via GitHub
Security Advisories, never crypto in a public issue.

## License

[MIT](LICENSE) for the current beta. The pre-1.0 licensing decision record is in
[docs/LICENSING.md](docs/LICENSING.md).
