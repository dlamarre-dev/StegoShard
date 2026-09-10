# Threat model

What StegoShard defends, what it deliberately does not, and against whom. This is the
reader-facing companion to the [cryptographic review dossier](CRYPTO-REVIEW.md), which
carries the primitive-level detail (claims → enforcement → tests). If you want the _why_
behind the two-model design, read [WHY.md](WHY.md).

StegoShard offers two storage models with **different security goals**, so it has two
threat models. Confusing them is the main way to misuse the tool.

## Assets

There are two distinct assets, and they are not protected by the same model:

1. **The secret's contents**, the plaintext file. Protected by **encryption** in every
   mode (zero-knowledge: an Argon2id-derived key never leaves your device).
2. **The fact that a secret exists at all**, its _observability_. Protected only by
   **Deniable Storage** (and the deniable half of Hybrid). Resilient Storage makes no
   attempt to hide it.

Confidentiality of contents rests on the cryptographic core and is out of scope for this
document beyond a pointer: see [CRYPTO-REVIEW.md](CRYPTO-REVIEW.md). This document is about
the _second_ asset, observability, which is where the two models diverge.

## Adversaries

| Adversary                | Capability                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opportunistic finder** | Stumbles on the carrier (a lost USB stick, a shared drive, a folder listing). Glances, triages by file type, moves on.                                   |
| **Cloud / platform**     | Stores or transmits the carrier and may **re-encode** it (a social network recompresses uploaded photos; a chat app strips metadata).                    |
| **Forensic examiner**    | Has the file and dedicated tools; will open it, run steganalysis, and look for statistical tells.                                                        |
| **Coercive adversary**   | Can **compel** you to produce passwords or explain files ("rubber-hose"). Deniability, not cryptography, is your only lever here.                        |
| **Upstream compromise**  | Controls what you install: the release workflow, a build dependency, or the repository itself. Reaches every user at once, before any password is typed. |

## What each model defends against

### 🛡 Resilient Storage

**Goal: never lose the data.** Defends against:

- **Data loss and media degradation.** Reed-Solomon erasure coding tolerates losing up
  to `m` of the `k+m` images (a torn page, a deleted album item, an unreadable code).
- **Single-support failure.** The same vault can live on disk, on paper, and in the cloud
  at once; no one copy is trusted.
- **Recompression and printing.** The image profiles are built to survive re-encoding and
  a print/scan round-trip.

**Does not defend against observability.** The output is _openly_ a StegoShard vault
(coded-noise images, or a `.ssbn` file). Anyone who sees it knows a secret exists. That is
deliberate: resilience and concealment are incompatible (see [WHY.md](WHY.md)).

### 🎭 Deniable Storage

**Goal: hide that the secret exists.** Its strength depends on the carrier, and the two
carriers fail in different ways:

- **Ordinary photos** (stego key / Gallery Mode). Strongest existence-hiding: the output
  looks like unremarkable photos. **Fragile:** any re-encoding (a social-network upload, a
  format conversion) destroys the payload. Defeats the opportunistic finder; is **not**
  claimed to defeat a forensic examiner running steganalysis.
- **Decoy database** (`.db`). Survives copying and byte-exact storage, and passes
  file-type triage as an ordinary SQLite database. Its deniability is **shallow**: a tool
  that actually opens and inspects the database can find tells. Defeats triage, not a
  determined examiner.

### 🔗 Hybrid

Combines the two: the bulk archive uses Resilient Storage, and **only the recovery key**
uses Deniable Storage. The key channel is **expendable by design**: if the cover photo is
recompressed, you lose the key, not the data (keep a copy of the key by another means if
that matters to you). Existence-hiding applies to the _key photo_; the resilient images
themselves are still openly a vault.

## Access structures: duress & non-possession

The Gallery and decoy-database (`.db`) carriers can hold **two independent payloads behind
independent credentials**, enabling two modes. Both are opt-in and neither is a substitute for
the honest limits above. Read this before using them.

- **Duress (Mode A, `.db` only).** A second _duress_ password opens a plausible **decoy** file;
  the real payload stays sealed and its existence is not revealed by opening the decoy. The two
  regions use independent keys, so an opener of the duress credential cannot reach the real
  region even with the bytes they recover. Optionally, a key-file or stego cover adds a further
  layer to the **real** payload only (you then need the password _and_ that artifact to open it);
  the decoy always opens on the duress password alone, so it can still be surrendered under
  coercion without producing anything extra.
- **Non-possession (Mode B, Gallery + `.db`).** The real payload is gated on Shamir threshold
  material (_k_ of _n_ shares) that the holder does **not** possess. Without a quorum of shares,
  the holder does not possess the cryptographic material required to derive the real region's
  key: the container carries no _k_, no _n_, no share count, and no fingerprint, so a
  sub-threshold set is indistinguishable from a wrong password.

  Stated that way on purpose. "I cannot decrypt this" is true under this system's
  assumptions, but it reads as a legal assertion to the readers most likely to need this
  mode, and `docs/CLAIMS.md` offers no legal guarantee. What is technically true is the
  statement about possession; what happens when someone says it out loud is not something
  this project can promise anything about. See the legal-exposure warning below.

**What these modes do _not_ give you:**

1. **They do not defeat a forensic examiner.** Mode A rides on the `.db` carrier, whose
   deniability is _shallow_ (see _Deniable Storage_ above): the presence of a second encrypted
   region is not provable by triage, but is not hidden from a determined examiner either.
2. **They do not hide that the file is a StegoShard container.** The disguise is the _carrier_
   (an ordinary-looking `.db` / photo set), not the fact that encryption exists once the tool is
   identified.
3. **The writer keeps nothing that can reconstruct the gate.** For Mode B, StegoShard retains
   neither the secret _S_ nor any share after split. Losing a quorum of shares is unrecoverable
   _by design_. For Mode A, there is no record of which credential is "real."

### Duress and key-disclosure law

**Using Mode A can worsen your legal exposure, not reduce it.** In jurisdictions with
key-disclosure or compelled-decryption laws, handing over the _duress_ password when a real
payload also exists may constitute obstruction, contempt, or perjury, offences that can carry
heavier penalties than the disclosure itself. A decoy that is later shown to be a decoy converts
"I complied" into "I lied under compulsion." Deniability is a **technical** property of the
container; it is **not** a legal defence, and the two can point in opposite directions.

Before relying on a duress payload, understand the law that applies to you and the realistic
capabilities of whoever might compel you. If in doubt, do not use Mode A: an openly-encrypted
vault you _can_ decrypt, or a small deniable secret you never mention, may leave you in a better
position than a decoy that can be exposed.

## The local web UI

`stegoshard ui`, and the `serve.mjs` inside the downloadable offline bundle, serve the
browser app from your own machine. A server is the only way to run it at all: the app is
ES modules plus a module worker, and browsers block both over `file://`.

**What it costs you.** The command line is the path that leaves nothing behind but the
files you asked for. Putting the same flows in a browser reintroduces the browser: its
disk cache, its history, its download folder, and a `localStorage` entry for the language
and image format you picked. None of that is StegoShard's to clean up, and none of it is
visible to the tool. **If a session must leave no local trace, use the commands, not the
UI.** A private window and clearing the download afterwards narrow it; they do not close
it.

**What it does not cost you.** Nothing is exposed off-machine:

- the socket binds `127.0.0.1` only, never a wildcard, and no flag changes that;
- the app is mounted under a random path token, so another account on a shared machine
  cannot reach it by scanning loopback ports, and a remote page that resolves a hostname
  to 127.0.0.1 (DNS rebinding) is refused by both the token and a `Host` check;
- the server serves a fixed table of files read at startup, holds no state, reads no
  request body, and exposes no endpoint. The page's own CSP (`connect-src 'none'`) means
  it cannot call back even if one existed;
- responses are `no-store`, so nothing is invited into a disk cache (the browser may still
  keep its own copies, per above).

**The standalone binaries do not have it.** They are compiled with no network permission
at all, which is a guarantee worth more than the convenience; see
[CLI.md](CLI.md#the-same-app-in-a-browser-from-your-own-machine).

## The build and the download

Every adversary above meets StegoShard _after_ it is installed. This one arrives
before, and neither storage model helps: encryption you did not receive intact
protects nothing.

**What is done.** Third-party actions are pinned to full commit SHAs, with a
weekly job checking each one still resolves upstream. `npm ci` and hash-pinned
Python lockfiles fix the dependency tree; `npm audit` is gated by a wrapper that
tells a real advisory from a registry outage without loosening the gate. CodeQL
runs on every push, and a CBOM scan fails on any new HIGH crypto. `check-pack.ts`
asserts the exact published file set against an allowlist and a denylist, and
`.bundled/` is a committed manifest so a change to what a build inlines cannot
land without regenerating the third-party notices. Every released archive carries
a SHA-256 list and a Sigstore build-provenance attestation. The binaries hold no
network permission at all.

**What that is worth.** Each of those raises the cost of a _silent_ change. None
of them establishes that the code is good. Together they mean a compromise has to
be visible in the repository — as a commit, a lockfile change, a workflow edit —
rather than injected between the repository and you.

**What it costs you: you are trusting this repository and GitHub's runners.**
Write access to the repository is sufficient to weaken the cryptography and ship a
release that passes every check on this page. Provenance answers "did someone swap
this file in transit"; it does not answer "is this commit benign", and it cannot.

And **"no network permission" bounds exfiltration, not damage.** A compromised
build needs no socket to hurt you: it can weaken the key derivation, bias the
random draw, or encode key material into the output files. That last one is the
specific risk for this tool, because a StegoShard output is a file you
_deliberately_ hand to a cloud, a printer, or a photo album. The carrier is the
channel.

**What reduces it, for you.** Verify the download before you run it
([CLI.md](CLI.md#verify-your-download)). Build from a clone and read the diff
since the last tag. And restore with the [Python decoder](../python/README.md):
it is an independent implementation on a separate dependency tree, running in CI
against the same fixtures, so a compromised TypeScript build cannot make its
output decode correctly under a decoder it did not produce. That cross-check is
the closest thing this project has to a second opinion, and it is a large part of
why the Python decoder exists.

None of that is reproducible builds, and none of it is a second signer. Neither
is promised before 1.0.

## Driving StegoShard from an agent (MCP)

`stegoshard mcp` lets an AI agent call save, restore and estimate as tools. It is
off unless you invoke it, and it is a different bargain from every other surface.

**What it does not cost you.** stdio only: newline-delimited JSON-RPC on stdin and
stdout. The server opens no socket, binds no port and speaks no HTTP, so the
property stated above for the local web UI, that the server exposes no endpoint,
is not weakened; MCP adds no endpoint of any kind. The standalone binaries still
hold no network permission, and this needs none.

**What it costs you: the agent is the network client.** Everything you pass and
everything you get back may be transmitted to a model provider and retained
there. That is why passwords travel by reference rather than by value, and why
only `STEGOSHARD_*` environment variables are readable. It is also why the
duress and non-possession modes are not available over MCP at all: duress needs a
second, independent credential that would land in the transcript, and its
independence check would become a recorded oracle relating the two, in a mode
whose entire point is that no record exists of which credential is real;
non-possession writes its threshold shares into a directory the agent reads back
in the same session. Both remain fully available from the command line, where a
person is holding them.

**And a restore shows the agent your secret.** It writes the recovered plaintext
into `out_dir`, where the agent's own filesystem tools can read it. There is no
way around that: it is what a restore does. Driving a restore from an agent is a
decision to show the agent the file. If that is not what you want, restore from
the command line.

**Confinement is a policy, not a sandbox.** `--root` is enforced in the server,
with symlinks resolved on both sides, and with no `--root` every tool call is
refused. But `deno compile` bakes blanket read and write permission into the
released binaries, so a bug in that policy is not backstopped by the runtime. The
runtime-enforced version, which the network-free design makes possible, is to
narrow the permissions when you launch it:

```bash
deno run --allow-read=/path/to/vault --allow-write=/path/to/vault --allow-env \
  dist-cli/stegoshard.js mcp --root /path/to/vault
```

See [API.md](API.md) for the tool schemas and the error codes.

## Rollback tracking (`--track`)

Off by default, and the only feature here that writes a durable file of its own.

**What it does.** A tracked save numbers each export of a vault you name, and a
restore warns when the copy in front of you is older than the newest one this
machine recorded. It catches a _silent_ replacement: a botched sync, a stale USB
stick, an adversary with write access to the vault but not to your home
directory. The restore still succeeds — the old copy may be the only one that
survived, and refusing it would turn a detection into a denial of service.

**What it does not do.** It stops nothing. And it stops nothing at all against an
adversary who can also write to the registry: they lower the number, or delete the
file, and the check reports an unknown vault or says nothing. It does not create
trust; it moves it from the vault file to a local JSON file.

**What it costs you, which is the part to read twice.** The registry is a durable,
cleartext list of vault identifiers and access timestamps in your home directory,
and it is the **first persistent state the command line has ever kept** — a real
exception to "the command line leaves nothing behind but the files you asked for".
Against the coercive adversary it is the most damaging artifact this tool can
produce. It does not say where a vault is or what is in it. It proves **how many
exist and when they were touched**, which is precisely the claim deniability rests
on denying. That is the same category as an instruction sheet or a recovery
label, one step worse.

So it is opt-in, off by default, and **refused outright** on every deniable
destination: `--track` with `gallery-save`, `--binary --disguise`, `--mode
duress` or `--mode nonpossession` is an error, not a silent no-op. A no-op would
be worse, because you would carry on believing the protection was there on the one
path where believing anything extra is the mistake.

**The version worth using needs no file.** Whenever an export carries an identity,
both save and restore print `vault 3f8a1c02 · export #4`. If you know you last
wrote #5, a restore that says #4 has told you everything the registry would have,
and left nothing on disk. That is the same role a recovery sheet plays for
resilient storage: the person is the trusted external state.

## Deliberate non-goals

StegoShard does **not** claim, and you should not rely on:

- **Steganographic indistinguishability against a dedicated forensic adversary.** Deniable
  Storage defeats triage and casual inspection, not targeted steganalysis. The triage half
  is now measured rather than asserted (`tests/steganalysis`, and
  [CRYPTO-REVIEW.md](CRYPTO-REVIEW.md) §5.3), and the JPEG carrier has a narrow measurement
  of its own (§5.4). The targeted-steganalysis half remains unmeasured. The content-tell
  of the decoy database is a known, documented limitation (see
  [ROADMAP.md](ROADMAP.md) → _Later / exploratory_).
- **Protection once you are compelled and the resilient vault is found.** Resilient Storage
  is openly a secret; against coercion, only the deniable models help, and only to the
  extent the carrier truly blends in.
- **Anti-rollback guarantees.** Every AEAD site now binds its context, so key
  blocks, salts, region blocks and slot arrays cannot be spliced between
  containers ([CRYPTO-REVIEW.md §7.3](CRYPTO-REVIEW.md)). What that does **not**
  reach is replacement of a vault by an older, entirely legitimate export of
  itself: a tag authenticates a message, never the absence of a newer one. An
  attacker with write access can still destroy or replace a vault wholesale.
  `--track` detects the silent case and is honest about the rest, below.
- **Protection against a compromised build of StegoShard itself.** Releases are
  attested and checksummed, which binds an artifact to a workflow and a commit;
  that is an integrity property of the _distribution_, not a statement about the
  commit. Builds are not reproducible and no second party signs them. If the
  repository is compromised, nothing in this document helps you. See _The build
  and the download_ above.
- **Hiding metadata you supply.** Human-readable labels, PDF titles, and instruction
  sheets are conveniences for Resilient Storage; they are the opposite of deniable. Do not
  use them in Deniable mode. **`--track` belongs in this category**, and is the
  strongest example of it: see _Rollback tracking_ below.
- **Inventing cryptography.** The core is standard symmetric primitives only (Argon2id,
  AES-256-GCM, HKDF-SHA256); no asymmetric crypto, hence no Shor exposure. See
  [CRYPTO-REVIEW.md §9](CRYPTO-REVIEW.md).

## Choosing correctly

- Need it to **survive**? Resilient Storage. Accept that its existence is visible.
- Need **nobody to know it exists**? Deniable Storage. Accept that it is fragile (photos)
  or shallowly deniable (decoy database), and keep secrets small.
- Need **both**, for a large secret? Hybrid: a resilient archive with a deniable key, and treat
  the key channel as disposable.

See also: [WHY.md](WHY.md) · [README](../README.md) · [SPEC.md](../SPEC.md) ·
[CRYPTO-REVIEW.md](CRYPTO-REVIEW.md).
