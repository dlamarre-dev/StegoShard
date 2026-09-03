# Machine interfaces

Ways to drive StegoShard from a program rather than by hand: a **JavaScript /
TypeScript library**, a **machine-readable command line**, and an **MCP server**
for AI agents.

> **Status: unstable.** These interfaces ship at 0.9.x so integrators can build
> against them and report problems. They are **not** frozen: any 0.9.z release may
> rename, reshape, or remove anything here. Pin an exact version. The freeze is a
> 1.0 gate, after the independent security audit ([ROADMAP.md](ROADMAP.md)).
>
> Exposing an interface makes **no new security claim**. The security and
> deniability properties, and their documented limits, are exactly those in
> [THREAT-MODEL.md](THREAT-MODEL.md), [CRYPTO-REVIEW.md](CRYPTO-REVIEW.md) and
> [CLAIMS.md](CLAIMS.md). The on-disk format version line is separate and governed
> by [VERSIONING.md](VERSIONING.md).

Nothing here opens a socket. The only HTTP code in StegoShard is `stegoshard ui`,
which serves static files on loopback and exposes no endpoint; see
[THREAT-MODEL.md](THREAT-MODEL.md#the-local-web-ui). The MCP server speaks stdio,
so it adds no endpoint either, but the **agent** on the other end of that pipe is
a network client: see
[Driving StegoShard from an agent](THREAT-MODEL.md#driving-stegoshard-from-an-agent-mcp).

## The JavaScript / TypeScript library

Two entry points, disjoint on purpose.

```ts
// Environment-neutral: bytes in, bytes out. Runs anywhere WebCrypto does.
import { createVaultKey, exportVault, importVault } from 'stegoshard';

// Node: files in, files out. The same orchestration the command line drives.
import { save, restore, estimate } from 'stegoshard/node';
```

`stegoshard/node` does **not** re-export `stegoshard`. There are no `node` or
`browser` resolver _conditions_ either: an environment condition would silently
hand a Node consumer the filesystem build when they asked for the neutral one, so
the choice stays visible at the import site.

```ts
import { save, restore } from 'stegoshard/node';

const saved = await save({
  inputs: ['secret.txt'],
  outDir: './vault',
  password: process.env.VAULT_PASSWORD!,
  paper: false,
  zip: false,
  keyMode: 'embedded',
});
// saved.files, saved.manifest, saved.imageCount, saved.setId

await restore({ inputs: ['./vault'], outDir: './restored', password: … });
```

### What is in it, and what is not

The published surface is **curated**, not the internal barrel. `src/core/index.ts`
re-exports 255 names; the library exports 118 across both entries. What a
consumer needs to save and restore a vault is there. What is deliberately not:

- the Galois field and the erasure coding (`gfMul`, `rsEncode`, `buildCauchyMatrix`,
  `splitIntoShards`, …);
- the low-level crypto primitives (`deriveKEK`, `hkdf`, `aeadSeal`, `wrapDEK`, …),
  which are easy to misuse and offer nothing `createVaultKey` does not;
- the whole SPEC §10 slot and region layer. Only the two **container** builders
  are public, `buildDuressDbContainer` and `buildNonPossessionDbContainer`, and
  they self-verify both regions before returning. Publishing the geometry beneath
  them would freeze it;
- the wire-format internals (`buildVaultBlob`, `buildSegmentedBlob`, `packSqlite`,
  `encodeHeader`, …), and the JPEG coefficient model, whose exports are a bare
  `decode`/`encode` pair;
- the format magic constants and salts, which are mutable module state.

Deep imports past the two entry points are not supported and are not covered by
the stability note above. The exact surface is recorded in
[`docs/api/stegoshard.api.md`](api/stegoshard.api.md) and
[`docs/api/stegoshard-node.api.md`](api/stegoshard-node.api.md), which are
generated, committed, and verified in CI, so a change to either shows up as a
reviewable diff.

### Three things to know before building on it

**Post-save verification is not optional.** `save()` decrypts what it wrote and
compares it to the original before returning, and there is no flag to skip it. If
you assemble your own pipeline from `exportVault` instead, you must call the
matching `verifyImageExport` / `verifyBinaryExport` / `verifyDisguisedExport` /
`verifyGalleryExport` yourself. A vault that never round-tripped is a vault
nobody has shown is recoverable.

**The binary path defaults to 256 MiB, not the command line's 1 GiB.** The core's
own default is the terminal figure, which suits a headless command bounded only
by RAM and not a library inside someone else's process, where a 1 GiB in-memory
buffer an untrusted caller can request is a denial-of-service surface. Raise it
per call with `maxBytes` when the caller is trusted; `DEFAULT_MAX_BINARY_BYTES`
and `MAX_FILE_BYTES_BINARY_CLI` are both exported. The image and paper paths are
hard-capped at `MAX_FILE_BYTES` (1 MiB) and are not configurable, and the duress
and non-possession `.db` paths are capped at 64 MiB per region by the §10.4
bucket ladder.

**The user-entropy layer is process-global.** `installUserEntropy` clears any
existing layer first, so a second install silently replaces the first and the
earlier caller's draws fall back to the plain CSPRNG with nothing thrown. Install
once at startup if at all; never per request, and never in a multi-tenant or
concurrent server. There is deliberately no `withUserEntropy(text, fn)` helper: it
would advertise a scoping guarantee the module-global cannot provide.

Two smaller ones. Passwords are ordinary JavaScript strings and cannot be wiped
from memory (SECURITY.md). And `save({ inputs })` treats its paths as **trusted**:
it walks directories with no symlink guard and no file-count cap, so do not hand
it a path an untrusted party controls. Output is safer, since a restored bundle's
entries are reduced to basenames and cannot escape `outDir`.

### Not published

The package is built and verified on every CI run but **is not on npm**:
`package.json` is still `private: true`, so an accidental publish is impossible.
Publishing is a separate decision, gated on the 1.0 audit. Until then the way to
use the library is a checkout, `npm run build:lib`, and a file or workspace
dependency.

Three dependencies are **bundled** into the package rather than installed
alongside it: `fast-png`, `jpeg-js` and `@pdf-lib/fontkit`. They are runtime
imports of the Node adapter that sit in `devDependencies`, and promoting them
trips two guards in `scripts/generate-notices.ts` that exist for good reasons:
`jpeg-js` is BSD-3-Clause, which is not on the approved-licence list, and
`@pdf-lib/fontkit@1.1.1` declares MIT but ships no licence file. Bundling matches
what `dist-cli` already does and leaves the notices, the SBOM and
`npm audit --omit=dev` untouched. Resolving it properly is a licensing decision
tracked on its own.

## `--json`: the command line, for programs

Add `--json` to `save`, `restore`, `estimate`, `gallery-save` or `gallery-restore`.

```bash
stegoshard estimate secret.txt --json | jq .result.images

STEGOSHARD_PASSWORD=… stegoshard save secret.txt --out ./vault --json \
  2> progress.ndjson | jq -r '.result.files[]'
```

### The stream contract

- **stdout carries exactly one JSON document**, newline-terminated, with nothing
  before or after it. That is what makes `| jq` work with no framing library.
- **stderr carries newline-delimited JSON events**: progress and warnings.
- **A failure is also a document on stdout**, so a caller parses one stream rather
  than choosing between two depending on the outcome. The message also goes to
  stderr as an `error` event, for a human tailing the log.
- Exit codes are unchanged from the human mode: `0` success, `1` failure, `2` for
  an unknown command.

### The envelope

```json
{
  "schema": "stegoshard.cli/1",
  "stability": "unstable",
  "ok": true,
  "command": "save",
  "locale": "en",
  "result": { "...": "per command, below" }
}
```

```json
{
  "schema": "stegoshard.cli/1",
  "stability": "unstable",
  "ok": false,
  "command": "restore",
  "locale": "en",
  "error": { "code": "WRONG_PASSWORD", "message": "wrong password" }
}
```

`code` is the contract and is **never** localized. `message` is the same sentence
the terminal would have printed, in the language named by `locale`, and is meant
for humans reading a log rather than for branching on. Pin `STEGOSHARD_LANG=en` if
you assert on it.

### Result per command

Paths are always absolute, so a caller need not know StegoShard's working
directory.

| Command           | `result` keys                                                                        |
| ----------------- | ------------------------------------------------------------------------------------ |
| `save`            | `files`, `manifest`, `imageCount`, `setId`, `keyMode`, `binary?`, `effectiveLocale?` |
| `restore`         | `files`, `outPath`, `filename`, `seen`, `decoded`                                    |
| `gallery-save`    | `files`, `manifest`, `k`, `m`, `decoys`, `setId`, `keyMode`                          |
| `gallery-restore` | `files`, `outPath`, `filename`, `seen`                                               |
| `estimate`        | `images`, `k`, `m`                                                                   |

`setId` is present but **empty** on the binary paths, which mint no image set: one
shape for every save, rather than a key a caller has to test for. `warnings` is
added to `result` only when there were any.

### Warnings

Non-fatal. Each appears twice: as an event on stderr when it is raised, and in
`result.warnings` with the result.

| Code                    | Raised when                                            |
| ----------------------- | ------------------------------------------------------ |
| `PASSWORD_FLAG_VISIBLE` | `--password` was used, where the shell records it      |
| `ENTROPY_FLAG_VISIBLE`  | `--entropy` was used, likewise                         |
| `WEAK_PASSWORD`         | above the length floor but weak, and acknowledged      |
| `FONT_FALLBACK`         | no CJK font found, so the PDF fell back                |
| `LARGE_SECRET`          | the image count is large enough to be worth mentioning |

`FONT_FALLBACK` and `LARGE_SECRET` carry **English-only** messages today: they are
built from literals in the orchestration layer rather than from the catalogs, and
only their wrapper was ever localized. Key on the code, treat the message as a
hint. The others are localized like any other CLI output.

### Progress

```json
{"schema":"stegoshard.cli/1","event":"progress","phase":"encrypt","done":1024,"total":65536}
{"schema":"stegoshard.cli/1","event":"warning","code":"PASSWORD_FLAG_VISIBLE","message":"…"}
{"schema":"stegoshard.cli/1","event":"error","code":"WRONG_PASSWORD","message":"…"}
```

`phase` is the raw name, never a localized label: this is the machine channel.
Events are throttled to at most one per 100 ms within a phase, and every phase
change is reported, so a 1 GiB save does not emit tens of thousands of lines.
`--quiet` suppresses progress but not warnings or errors.

The image and paper paths emit **no** progress at all: they are capped at 1 MiB
and effectively instant. Only the binary paths report phases.

### `--json` never waits for a human

The mode is non-interactive **by construction**, not by a terminal check: the
password prompt and the weak-password confirmation are withheld from the layer
that would call them, so they cannot be reached at all. This matters because piped
stdin is not a terminal, and the interactive prompt reads stdin whole: a caller
with an inherited idle pipe would otherwise hang forever on a prompt it cannot see.

So, with `--json`:

- no password from `--password`, `--password-file` or `STEGOSHARD_PASSWORD` →
  `PASSWORD_REQUIRED`, immediately, without touching stdin;
- a weak password without `--allow-weak-password` → `PASSWORD_WEAK`, rather than
  the `ALLOW` confirmation prompt;
- below the hard length floor → `PASSWORD_TOO_SHORT`, which no flag waives;
- `--entropy-prompt` → `ENTROPY_ARG`;
- `ui --json` → `USAGE`. The local web UI is interactive and long-running, so
  there is no result document it could produce.

### Error codes

One `code` field spans three code spaces. Which one an error came from is not
something a caller should need to know.

**Format and crypto** (`src/core/errors.ts`): `WRONG_PASSWORD`, `MISSING_KEY`,
`FILE_TOO_LARGE`, `TOO_MANY_IMAGES`, `TOO_MANY_FILES`, `VERIFICATION_FAILED`,
`STEGO_CAPACITY`, `STEGO_COVER_FORMAT`, `JPEG_UNSUPPORTED`,
`CREDENTIALS_NOT_INDEPENDENT`, `SHARE_CHECKSUM`, `SHARE_SET`, `BUCKET_TOO_LARGE`,
`SEGMENTED_FORMAT`, `GALLERY_TOO_FEW_IMAGES`, `GALLERY_TOO_MANY_IMAGES`,
`GALLERY_FILE_TOO_LARGE`, `GALLERY_COVER_CAPACITY`, `GALLERY_RESTORE_FAILED`.

**Unusable request** (`src/api/errors.ts`): `OUTPUT_EXISTS`, `STEGO_NEEDS_COVER`,
`DURESS_DECOY_REQUIRED`, `DURESS_PASSWORD_REQUIRED`, `THRESHOLD_REQUIRED`,
`MODE_NEEDS_DISGUISE`, `NO_INPUT_FILES`, `NO_READABLE_IMAGES`, `NO_COVERS_FOUND`,
`NO_GALLERY_IMAGES`.

**Invocation** (`src/cli/errors.ts`): `USAGE`, `PASSWORD_REQUIRED`,
`PASSWORD_TOO_SHORT`, `PASSWORD_WEAK`, `ENTROPY_ARG`, `UI_UNAVAILABLE`,
`INTERNAL`.

Some errors carry `details` with the numbers a caller would otherwise parse out of
the message, for example `{"size": 2000000, "limit": 1048576}` on
`FILE_TOO_LARGE`. Every value there already appears verbatim in the message, so
the codes disclose nothing the CLI does not already print.

**Two deliberate non-distinctions.** `GALLERY_RESTORE_FAILED` is a single code
covering both "wrong password" and "these photos hold no gallery": the format
cannot tell them apart on purpose, and a caller must not appear able to either.
And the SPEC §10 access structures surface `WRONG_PASSWORD`, never anything naming
a mode, a region or a slot.

## `stegoshard mcp`: the Model Context Protocol, for agents

```bash
stegoshard mcp --root /path/to/vault
```

stdio only: newline-delimited JSON-RPC 2.0 in and out, no socket, no port, no
HTTP. Three tools, returning the **same result objects** `--json` does, from the
same code.

| Tool                  | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `stegoshard_estimate` | How many carrier images a file needs. Read-only, no password. |
| `stegoshard_save`     | Encrypt files into carriers. Refuses to overwrite.            |
| `stegoshard_restore`  | Recover a file. **Writes plaintext the agent can then read.** |

### Passwords never travel inline

Tool arguments land in the agent's transcript and may be sent to a model
provider, so the schema has **no** password property. A call points at one
instead:

```jsonc
{ "password_source": { "env": "STEGOSHARD_PASSWORD" } }
{ "password_source": { "file": "vault/pw.txt" } }
```

Only `STEGOSHARD_*` variables are readable, enforced in the server and not just
advertised in the schema. Without that restriction an agent could name
`AWS_SECRET_ACCESS_KEY`; the value is never echoed back, but handing a model an
arbitrary-environment-read primitive by omission is not a thing to do. A password
file is confined to a root like every other path, for the same reason.

`stegoshard mcp --allow-inline-password` adds a literal `password` property whose
description says what it costs. Without the flag an inline password is **refused**
rather than ignored, since dropping it silently would surface one step later as a
baffling `PASSWORD_REQUIRED` on a request that plainly supplied one.

The schema follows the flag. Without it, `password_source` is simply required.
With it, neither is required outright and an `anyOf` asks for one of the two, so a
schema-validating client can use the inline mode on its own rather than having to
send a redundant source alongside the password it already has.

### Path confinement

`--root <dir>`, repeatable. Every path argument is resolved and then compared
against the canonical roots, with `realpath` on both sides so a symlink pointing
out is caught, and a separator in the comparison so a root of `/data/vault` does
not also admit `/data/vault-backup`.

A root that does not exist yet stays exactly the directory you named. Both sides
of the comparison resolve symlinks as far as the filesystem goes and keep the
remainder verbatim, so `--root /vault/new` means `/vault/new` whether or not it
has been created, and does not quietly become `/vault`.

**With no `--root`, the server starts and `tools/list` works, but every
`tools/call` returns `ROOT_NOT_CONFIGURED`.** Forgetting to configure it gets you
the safe outcome and a message that explains the fix.

Stated plainly: this is a policy in a server, not a sandbox. `deno compile` bakes
in blanket `--allow-read --allow-write`, so a bug in the policy is not backstopped
by the runtime. The runtime-enforced version, which the network-free design makes
possible, is to narrow the permissions when launching it:

```bash
deno run --allow-read=/path/to/vault --allow-write=/path/to/vault --allow-env \
  dist-cli/stegoshard.js mcp --root /path/to/vault
```

### What is deliberately absent

**The SPEC §10 access modes.** `mode`, `decoy`, `threshold` and the duress
password are refused with `MODE_NOT_AVAILABLE`. Duress needs a second,
independent credential that would cross into the transcript, and
`CredentialsNotIndependentError` would become a recorded oracle relating the two,
in a mode whose entire point is that no record exists of which credential is
real. Non-possession writes its n threshold shares into `out_dir`, which the
agent reads back in the same session, destroying the property before the call
returns. Both stay fully available in the library and in `--json`, where a person
is holding them. Restore-side `share_files` **is** allowed: those shares already
exist and someone chose to reference them.

**Gallery Mode**, in 0.9. It rewrites a folder of real photographs in place and is
the flow most likely to be driven badly by an agent.

**`force`.** A name collision returns `OUTPUT_EXISTS` and the agent picks another
directory; overwriting is not a call to make on an agent's judgement.

**The `--entropy*` options and the paper prose options** (`title`, `locale`,
`instructions`, …). The first needs a human choosing randomness; the rest are
printed sheets an agent should not be authoring.

### Errors

A malformed call is a JSON-RPC error (`-32602` and friends). A well-formed call
that failed is a normal result with `isError: true`, whose text is
`{"code": …, "message": …}` using the same codes as `--json`, plus the
MCP-specific `ROOT_NOT_CONFIGURED`, `PATH_OUTSIDE_ROOT`, `ENV_NOT_ALLOWED`,
`INLINE_PASSWORD_REFUSED` and `MODE_NOT_AVAILABLE`. That distinction is MCP's, and
it matters: the model sees a tool failure instead of the client swallowing it as a
transport fault.

### It is in the released binaries

Unlike `stegoshard ui`, which is excluded because it needs `--allow-net`, MCP over
stdio needs no permission the standalone binaries lack. A zero-dependency,
network-incapable binary driven over a pipe is arguably the best place for it.

## Versioning

`schema` moves independently of the on-disk format constants. Additive changes (a
new field, a new code) do not bump it; removing a field, retyping one, or changing
what a code means bumps to `/2`. The full rules are in
[VERSIONING.md](VERSIONING.md#3-machine-interface-schema-version).
