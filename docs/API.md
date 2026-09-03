# Machine interfaces

Ways to drive StegoShard from a program rather than by hand.

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
[THREAT-MODEL.md](THREAT-MODEL.md#the-local-web-ui).

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

## Versioning

`schema` moves independently of the on-disk format constants. Additive changes (a
new field, a new code) do not bump it; removing a field, retyping one, or changing
what a code means bumps to `/2`. The full rules are in
[VERSIONING.md](VERSIONING.md#3-machine-interface-schema-version).
