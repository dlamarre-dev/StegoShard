# Changelog

All notable changes to StegoShard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/) for the app/CLI version. The **on-disk
format** is versioned separately; see [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

### Added

- **A committed golden corpus, so the encoder and the decoders cannot drift together.**
  Everything the suite decoded was produced by the TypeScript encoder moments earlier in
  the same run: `python/tests/_fixtures` is gitignored and regenerated every time. That
  is how a wrong Galois polynomial left all 620 tests green, and how ISA-L's Cauchy
  assignment left 48 encoder tests and all 93 Python decoder tests green. Both changed
  every byte written. `tests/vectors/crypto-vectors.json` was the only committed
  artifact and it pins the crypto and blob layers only.

  `tests/golden/` now pins seven output paths, 1.1 MiB: QR-grid images, the colour grid,
  keyfile mode, the PNG and JPEG stego carriers, and both binary containers. The Python
  decoder reads them, which matters: a corpus checked only by the encoder's own stack
  would prove much less. Gallery Mode is absent because its smallest fixture is 2.4 MB,
  and `PROVENANCE.md` says so rather than leaving it to be discovered.

  The rule that gives the corpus its value is `npm run golden:check`: a diff to an
  existing artifact must come with a format version bump in the same change. Adding a
  path is free; changing one is a decision. Without that, a contributor whose change
  broke the format would see the golden tests fail, regenerate, watch them pass, and
  ship the break.

### Changed

- **Coverage thresholds are now per file rather than aggregate, and `src/ui` is
  measured.** The aggregate gate let seven files sit below the branch threshold behind
  an average that cleared it, `sqlite-container.ts` among them at 71.91%. Each floor is
  now the weakest file today, rounded down, and `vitest.config.ts` records which file
  sets which. Note that the core branch floor of 81 is _lower_ than the old aggregate
  85 and is nevertheless the stricter gate, for that exact reason.

  `src/ui` was outside coverage entirely, which is how `input-limits.ts` came to have no
  tests without anything noticing. It is measured now, minus eighteen modules that need
  a DOM, a Worker or browser storage: those are exercised by the Playwright suite, which
  collects no coverage, so reporting them at zero would mix "untested" with "tested
  where this tool cannot see". They are listed individually with the rule for adding to
  the list.

### Added

- **The reader that parses attacker-supplied bytes now has its rejection paths
  tested.** `unpackSqlite` runs on restore against a file the user was handed; of its
  ten paths that return null, three were covered. Branch coverage on that file was the
  lowest in `src/core` at 71.91% and is now 83.15%. The centrepiece is a corruption
  sweep asserting the structural invariant: an accepted result is always the stored
  length, never shorter or longer. Length rather than content, because a byte flipped
  inside a row's value legitimately changes the blob and its GCM tag catches that one
  layer up; what a tag cannot catch is misassembly that still produces a plausible
  length, since the failure would then look like a wrong password rather than a damaged
  file.
- **`src/ui/input-limits.ts` had no tests at all**, though its whole job is bounding
  untrusted input before it reaches the tab's heap, and `src/ui` sits outside the
  coverage scope so nothing measured it either. Thirteen tests now cover the four limit
  kinds, the count guard, the cumulative-total guard that fires mid-loop, and above all
  the guarantee in its own docstring: the size check happens **before** `arrayBuffer()`,
  so a rejected input is never copied. That one was verified by inverting the order and
  confirming the test goes red.
- **Eight structural refusals in the JPEG decoder**, up from two: arithmetic coding,
  non-8-bit precision, zero dimensions, a scan before any frame, a scan naming an
  undeclared component, a file that never reaches a scan, a desynchronised segment walk,
  and a scan with no Huffman tables. Branch coverage there moves from 78.12% to 82.84%.

### Fixed

- **The parser fuzzer asserted half of what it claimed, and reached almost none of
  what it tested.** Its docstring promised that the only outcomes are "a valid
  structure, or a thrown `Error`"; the success path discarded the parser's return
  value entirely, so a parser accepting random bytes and returning nonsense was
  indistinguishable from one correctly rejecting them. Every target now carries its own
  contract, and `decodeJpeg` additionally re-encodes what it decoded.

  Measured while fixing it, and worse than the missing assertions: over 20,000 random
  inputs per target, four parsers accepted **zero**, two returned only `null`, and one
  accepted 61. Random bytes exercise rejection and essentially nothing else, and only two
  of seven targets had a valid artifact to mutate. The success path of the other five was
  unreachable, which would have made the new invariants decoration. All seven now
  mutation-fuzz a valid seed artifact.

- **Two defects the repaired fuzzer found immediately.** `encode` in `jpeg-coeff.ts` used
  `!` on four Huffman lookups; a file whose tables cannot express its own decoded
  coefficients made it read `.code` off `undefined` and throw a bare `TypeError` from
  inside the bit writer. This is reachable in production: `stego.ts` re-encodes the scan
  on the restart-interval fallback path, so a camera or scanner JPEG with sparse tables
  hits it. It now refuses with a typed error. Separately, `decode` accepted a zero frame
  dimension and returned a model with no MCUs, so the stego layer would have reported
  zero capacity on such a file rather than refusing it.

- **The fuzz smoke test replayed the same 2,000 cases on every pull request**, its seed
  fixed at 1 since it was written. It now derives from the commit SHA: different cases per
  commit, still exactly reproducible, and the seed is printed on the first line of the log.
  The nightly workflow also gains a `timeout-minutes`, since `scripts/fuzz.ts` says a hang
  is "caught by the CI timeout" and the only timeout was GitHub's implicit six-hour cap.

- **The 25 cross-implementation conformance tests skipped silently without fixtures.**
  They are the only cross-implementation check in the repository. A CI run whose fixture
  generation had produced nothing would have reported green while verifying that the two
  stacks agree on nothing at all. Missing fixtures are now a hard failure under `CI=true`
  and a skip only locally, the rule already used by the other three Python suites.

### Added

- **`docs/ELI15.md`, the project explained to someone who has never studied cryptography.**
  Nothing covered password stretching, the three-key hierarchy, authenticated encryption,
  Reed-Solomon, the colour grid or QR error-correction levels for a lay reader: `WHY.md`
  carries the reasoning without a single number, `SPEC.md` carries the bytes. It opens with
  a two-minute summary and every section leads with a bold sentence, so the shape survives
  a skim even though the full read is longer. It states the limits alongside the mechanics,
  including the warning that a duress decoy can worsen legal exposure rather than reduce
  it.

- **The Galois field under Reed-Solomon is now anchored to something outside the
  project.** `tests/erasure` compares GF(2^8) in both stacks, exhaustively,
  against [reedsolo](https://github.com/tomerfiliba-org/reedsolomon) and against
  a table-free carry-less multiply: the 65,536 products against both, the 65,280
  quotients, 255 inverses and exp/log tables against reedsolo, on every pull
  request. It was needed. Every assertion the repository made about this field
  held in _any_ correctly built GF(2^8), not only the specified one: moving
  `POLY` from `0x11D` to `0x12D`, also primitive with generator 2, left all 620
  tests of the TypeScript suite green, and the 89 of the Python conformance suite
  green as well once its fixtures were regenerated the way CI regenerates them,
  while changing 96% of the parity bytes on a k=4, m=3 shard set.
  `tests/vectors/crypto-vectors.json` gained fixed field vectors, checked against
  the same reference so they are not a snapshot of the project's own output. This
  anchors the field only; Reed-Solomon itself uses a Cauchy construction no
  external library reproduces, and stays unvalidated by any third party. See
  `docs/CRYPTO-REVIEW.md` §5.5.

### Fixed

- **The nightly steganalysis gate did not fingerprint the embedder it measures.** It
  covered the test tree, the generator, the lockfile and the workflow, but the generator
  imports `src/core/stego.ts` and `src/core/crypto.ts`, and the image libraries come from
  `package.json`. A change to the actual embedding code could therefore reuse the previous
  cache and postpone measurement until the weekly bucket rolled over, which is exactly the
  case the sweep exists to catch. `src/core`, `package.json` and `package-lock.json` are
  now in the fingerprint.
- **"All 42 layouts the encoder produces" was false.** The Cauchy sweep stopped at k=40,
  while Gallery Mode reaches k=190 (`GALLERY_K_MAX`). It now runs k=1 to 190 plus the two
  colour-grid layouts, 192 in all. The matrix comparison over the full range costs 0.1
  seconds, so the old bound bought nothing and cost an overstated claim. MDS sampling is
  split by size, 400 draws to k=40 and 60 above, for 26,359 submatrices; a flat 400
  measured at 551 seconds. `docs/CLAIMS.md` and `docs/CRYPTO-REVIEW.md` §5.6 now also note
  that MDS is a theorem for a Cauchy matrix, so the sweep guards the implementation rather
  than proving the property.
- **The claims register contradicted itself.** The Galois-field row said Reed-Solomon "is
  not validated by anything external" directly below the row recording that it is. The
  field row now says only that it covers the field, and points at the row above.
- **The README mode table gave the same unqualified ticks.** It is where most readers meet
  the two models, so it now carries the same qualifiers as `docs/ELI15.md`: "by design"
  rather than yes for surviving recompression, "against triage" rather than yes for
  deniability, with a paragraph naming both limits and pointing at the claims register.
- **`docs/ELI15.md` overstated six things.** The mode table said re-compression survival
  and hiding were plain yes; both now carry the qualifier the claims register requires.
  Argon2id was said to make "the parallel attack collapse", where it raises cost per guess
  without stopping the attack. The duress section said watching over your shoulder tells
  nothing, where the project claims equal control flow rather than a side-channel proof.
  Domain separation was said to appear in seven places; the core has eight labels. And the
  password-change explanation now says that previously exported artifacts keep their old
  key block, so a change is not a revocation.

### Changed

- **Three claims tightened after an external review.** The post-quantum section headline
  said "no quantum-vulnerable cryptography", which is the shorter sentence and the wrong
  one: for a password-based system the practical ceiling is password entropy, not key
  length. It now states three specific things instead. The four places that said "I cannot
  decrypt this" of non-possession mode now describe what is technically true, that below
  threshold the holder does not possess the material required to derive the real region's
  key. The original is accurate under this system's assumptions but reads as a legal
  assertion to exactly the readers most likely to need that mode, and `docs/CLAIMS.md`
  offers no legal guarantee.
- **The claims-register rule reaches the pull-request template.** `docs/CLAIMS.md` already
  said no claim may be strengthened without evidence. The rule now appears where
  contributions actually pass.

### Fixed

- **A GF(2^8) test claimed a known-answer check and performed none.** It was named
  `matches a known AES-poly product (0x57 * 0x13 = 0xfe)`, asserted commutativity
  in its body, and cited a value belonging to the AES field `0x11B`; this project
  reduces by `0x11D`, where that product is `0xE0`. Replaced with the real vector
  and with explicit assertions on the field parameters, which nothing pinned.

- **`stegoshard ui`: the browser app, served from your own machine.** The npm/`npx`
  CLI can now serve the web build on loopback and print an address to open, so the
  guided and expert flows are available without a hosted site or an extension. It
  binds `127.0.0.1` only, mounts the app under a random path token, checks the
  `Host` header, and serves a fixed table of files read at startup, so there is no
  path outside the build to reach. Bare `stegoshard` still prints usage. A
  malformed request answers `400` and leaves the server running: nothing another
  process on the machine can send should end a session mid-save.
  - **The standalone binaries do not have it**, and gain no permission: they are
    compiled without network access, which is a stronger guarantee than the
    convenience is worth. `ui` there says where to get it.
  - **It is not the private path.** A browser records what the command line does
    not (cache, history, downloads, a preference entry); the startup notice and
    [THREAT-MODEL.md](docs/THREAT-MODEL.md#the-local-web-ui) say so plainly.
- **The whole CLI speaks the system language.** `--help`, every error, the progress
  phases and the result lines, in the same eight locales as the app, falling back to
  English. Detection is ICU's default locale (Windows sets no `LANG`); pin or change
  it with `STEGOSHARD_LANG`. Flag names, environment variables, subcommands, the
  example commands and the `ui` address are never translated, so anything scraping
  the output keeps working, and the test suite pins `STEGOSHARD_LANG=en`.
  - `--help` is now rendered from data (`src/cli/i18n/usage.ts`): the flag columns
    are aligned by code rather than hand-kept in eight copies of a 90-line text.
    Wrapping counts terminal _cells_, not characters, so the Japanese and Chinese
    help stays inside the same 88 columns as the English (a Japanese character
    takes two cells, and CJK has no spaces to break a line on).
  - The catalogs are typed against the English one, so a missing key cannot
    compile, and a test checks that placeholders survived translation and that flag
    names did not get translated.
- **The offline bundle's notes ship in all eight languages** (`README.fr.txt` and
  friends), since someone who cannot read the English one is exactly who needs them.
- **The launcher speaks the system language.** `stegoshard ui` and the offline
  bundle's `serve.mjs` print their startup notice in whichever of the eight app
  locales the system reports (regional settings on Windows, which sets no `LANG`;
  `LC_ALL`/`LANG` elsewhere), falling back to English. `STEGOSHARD_LANG` overrides
  it. The address is never translated, so anything reading the output still finds
  it. Locale resolution, which had been copied twice already, now lives once in
  `src/ui/locales.ts`.
- **The downloadable offline web bundle now ships `serve.mjs`** plus `serve.cmd` /
  `serve.sh` wrappers and a `README.txt`. Until now the zip could not be run at all
  without knowing to bring your own HTTP server: `index.html` cannot be opened
  directly, because browsers block ES modules and module workers over `file://`, and
  nothing said so. Same server as `stegoshard ui`, no dependencies beyond Node, with
  a documented `python3 -m http.server` fallback.
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

### Added

- **The erasure code itself is now checked against something outside the project.** The
  field was anchored earlier; everything built on it was not. `tests/erasure` compares the
  Cauchy matrix over all 42 layouts the encoder produces, the Gauss-Jordan inverter against
  `numpy`, the MDS property, and frozen parity bytes, against
  [galois](https://github.com/mhostetter/galois). No Reed-Solomon library could do this:
  every one imposes its own construction, so none emits these parity bytes. `galois`
  imposes none, which is why the SPEC §7.4 formula can go in and an independent engine
  compute the result. Measured need: switching both stacks to ISA-L's assignment, a
  perfectly good erasure code, left 48 encoder tests green and all 93 Python decoder tests
  green. `docs/CRYPTO-REVIEW.md` §5.6 records what this does and does not establish, and
  `docs/CLAIMS.md` §19 loses the limitation it carried.

### Changed

- **The nightly JPEG steganalysis sweep no longer runs every night.** It costs 36 to 47
  minutes and rebuilds a 7 GB container, so a guard job now skips it unless the tests, the
  sample generator, the lockfile, the workflow, or the runner image changed, with a
  seven-day floor. Stated plainly because the obvious reading is wrong: this test is **not**
  deterministic. The embedded key block draws a fresh salt, DEK and IV each run, so every
  execution is an independent draw, and gating trades roughly thirty samples a month for
  four or five. The floor exists to keep both that resampling and upstream-drift detection
  alive at a reduced rate. `docs/CRYPTO-REVIEW.md` §5.4 records the reduced density so the
  measurement is not read as denser than it is.

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
- **The two surfaces describe the same choices the same way.** The expert cards
  are "Save a secret" / "Restore a secret", reusing the guided flow's own wording;
  the guided option cards carry the expert pickers' icons (destinations, key
  delivery, image code), now defined once in `icons.ts` and held to the pages'
  inline copies by a test; and the three overt destinations show the **Overt**
  badge in expert mode, as they already did in the guided flow.
- **The guided flow checks a new password where you type it.** The 12-character
  minimum and the "this looks weak" confirmation were only applied at the final
  step, so a password typed at step 5 was refused at step 7 and had to be fixed by
  walking back. Accepting the weak-password warning is remembered for that exact
  password, so the run never asks twice.

### Fixed

- **Saved images stamp their caption where the samples show it.** The browser drew
  the label, date and sequence number in its own sans-serif strip _above_ the
  mark, while the CLI and the README samples put them in the brand strip's 5x7
  font under the recovery lines. Two products, one format. The caption is now
  composed in `@core` (`brandCaption`) for every surface, so a saved image matches
  the samples and the CLI byte for byte.
- **The date and the sequence number are always stamped.** They appeared only when
  a title had been asked for, so an unlabelled set said nothing about when it was
  made or how many pieces it had, which is precisely what someone holding one
  printed page needs. The guided flow stamps them too.
- **A title with an accent reached the image as nothing at all.** The strip's font
  is ASCII, and a caption it could not draw was dropped whole, so `--title
"Sauvegarde clé"` printed no title. Latin diacritics and typographic punctuation
  are now folded first ("SAUVEGARDE CLE"); a script with no ASCII form (Japanese,
  Cyrillic) still gets a canvas-drawn strip of its own in the browser rather than
  being discarded.
- **A title typed for the Paper destination was discarded.** The title field shows
  for paper, but whether it was used keyed off the disk-only "add a readable
  label" checkbox, so it only reached the PDF if that hidden box happened to be
  ticked.
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
