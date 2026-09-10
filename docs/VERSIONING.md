# Versioning

StegoShard has **three independent version lines**. Don't conflate them.

## 1. Application / CLI version (SemVer)

`package.json`'s `version` (and the extension manifest) follow
[Semantic Versioning](https://semver.org/). This tracks the _software_ (UI, CLI,
build) and is what [CHANGELOG.md](../CHANGELOG.md) records. Pre-1.0 (`0.x`), minor
bumps may include behavioural changes; there is no stability promise until 1.0.

## 2. On-disk format version (the real compatibility contract)

The bytes StegoShard writes are a **versioned pre-1.0 interface** so independent
decoders can recover a vault. The current v1 candidate is documented in
[SPEC.md](../SPEC.md); its compatibility promise begins at the public 1.0 release.
The format carries several independent version tags:

| Constant            | Where                          | Meaning                                    |
| ------------------- | ------------------------------ | ------------------------------------------ |
| `FORMAT_VERSION`    | `src/core/header.ts`           | Per-image header, §6 vault blob, envelope  |
| `KEY_BLOCK_VERSION` | `src/core/crypto.ts`           | Serialized wrapped-DEK key block (§5.1)    |
| `SEG_VERSION`       | `src/core/segmented.ts`        | Segmented `.ssbn` / `.db` container (§8.1) |
| `BINARY_VERSION`    | `src/core/binary-container.ts` | Branded binary container framing (§8)      |
| `CODEC_GALLERY`     | `src/core/header.ts`           | Gallery Mode codec id (§9)                 |

`FORMAT_VERSION`, `KEY_BLOCK_VERSION` and `SEG_VERSION` are `2`; `BINARY_VERSION`
is `1` (its wrapper framing never changed) and `CODEC_GALLERY` is a codec
identity rather than a version.

`SEG_VERSION` was missing from this table, and from the `scripts/check-golden.ts`
guard, until the change that first needed it. A break in the `.db` format could
therefore have regenerated the golden corpus with no bump at all — exactly the
failure the guard exists to prevent. Both are fixed; the lesson is that a new
version constant has to be added to the guard in the same change that introduces
it.

### Path-intrinsic geometry (access structures, SPEC §10)

`FORMAT_VERSION` stays `1`, but on two paths, **Gallery Mode** and the **disguised
`.db`** binary variant, a v1 container carries the mandatory multi-region access
structure (a 4-slot key array over 2 payload regions). This geometry is a function of the
**output path**, not of a version byte: every gallery / disguised-`.db` vault has it, and
the excluded paths (single image, PDF, QR, branded `.ssbn`) never do. That is deliberate:
a version bit that appeared only when a hidden alternative existed would itself be the
distinguisher (SPEC §10). Because StegoShard is pre-1.0 with no shipped vaults, this was
folded into v1 in place rather than introduced as a parallel v2; the fixed test vectors
and fixtures are regenerated accordingly.

### Rules for a format change

A post-1.0 change is **breaking** if an existing artifact would no longer decode, or a
new artifact would not decode on an older reader. Before 1.0, audit-driven changes may
replace the candidate in place but must still:

1. Bump the relevant version constant.

   **Pre-1.0 carve-out.** Post-1.0 a bump must also add a new decode branch and
   keep the old one until support is formally dropped. Before 1.0 it must not:
   the format has no users, so a second branch would be dead code maintained
   forever and exercised never. An artifact in an older format fails the ordinary
   version check, and that is the whole of the migration story. The v2 AAD work
   was done this way deliberately, and this rule was written down rather than
   quietly bent.

2. Update [SPEC.md](../SPEC.md), including the §11 constants table, and
   [docs/CRYPTO-REVIEW.md](../CRYPTO-REVIEW.md) where crypto is affected.
3. Update the **Python reference decoder** (`python/stegoshard/`) in the same
   change, and regenerate the frozen vectors (`npm run vectors`), the conformance
   fixtures (`npm run fixtures`) and the golden corpus (`npm run golden`). CI's
   cross-implementation conformance job must stay green.

Regeneration belongs to a **deliberate** version change and never happens as a side
effect. `tests/golden/` holds committed artifacts a current decoder must keep reading,
and `npm run golden:check` refuses a diff to them that does not come with a constant
bump in the same change. That pairing is what separates a format change someone
decided on from one that happened: without it, a contributor whose change broke the
format would see the golden tests fail, regenerate, watch them pass, and ship the
break.

Non-breaking, purely internal repackaging (that still decodes byte-for-byte on the
current reader) does **not** bump a format constant. Example: 0.9.0 rearranged the
_disguised SQLite container's_ internal rows but the vault blob and container
detection were unchanged, so no version bump; only the SemVer app version moved.

See also the "Format stability" section of [CONTRIBUTING.md](../CONTRIBUTING.md).

## 3. Machine-interface schema version

The `--json` envelope and, later, the MCP tool results carry
`schema: "stegoshard.cli/N"`. It versions the **shape of the description**, never
the bytes on disk, and it moves independently of every constant in §2: a change to
the envelope must not bump `FORMAT_VERSION`, and a format change does not bump the
schema unless it changes what a caller reads.

`stegoshard.cli/1` today. The rules:

- **Additive changes do not bump it.** A new field, a new error code, a new warning
  code. A consumer that ignores unknown keys keeps working, which is the contract.
- **Breaking changes bump to `/2`.** Removing a field, retyping one, or changing
  what an existing code means. Renaming a code is removing one and adding another.
- **`stability` is a value in the payload, not the version.** It reads `"unstable"`
  until 1.0, and flipping it to `"stable"` is itself an additive change rather than
  a schema break, so a consumer can branch on it instead of on a version number.

Pre-1.0 this interface may still break inside a `0.9.z`, which is what `stability`
says out loud so no consumer has to infer it. See [API.md](API.md).
