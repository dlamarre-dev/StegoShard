# Versioning

StegoShard has **two independent version lines**. Don't conflate them.

## 1. Application / CLI version (SemVer)

`package.json`'s `version` (and the extension manifest) follow
[Semantic Versioning](https://semver.org/). This tracks the _software_ — UI, CLI,
build — and is what [CHANGELOG.md](../CHANGELOG.md) records. Pre-1.0 (`0.x`), minor
bumps may include behavioural changes; there is no stability promise until 1.0.

## 2. On-disk format version (the real compatibility contract)

The bytes StegoShard writes are a **stable, versioned public interface** so a
vault can be recovered without this software (see [SPEC.md](../SPEC.md), frozen at
format v1). The format carries several independent version tags:

| Constant            | Where                          | Meaning                                    |
| ------------------- | ------------------------------ | ------------------------------------------ |
| `FORMAT_VERSION`    | `src/core/header.ts`           | Per-image header / overall on-image format |
| `KEY_BLOCK_VERSION` | `src/core/crypto.ts`           | Serialized wrapped-DEK key block (§5.1)    |
| `BINARY_VERSION`    | `src/core/binary-container.ts` | Branded binary container (§8)              |
| `CODEC_GALLERY`     | `src/core/header.ts`           | Gallery Mode codec id (§9)                 |

All are `1` today.

### Path-intrinsic geometry (access structures, SPEC §10)

`FORMAT_VERSION` stays `1`, but on two paths — **Gallery Mode** and the **disguised
`.db`** binary variant — a v1 container carries the mandatory multi-region access
structure (a 4-slot key array over 2 payload regions). This geometry is a function of the
**output path**, not of a version byte: every gallery / disguised-`.db` vault has it, and
the excluded paths (single image, PDF, QR, branded `.ssbn`) never do. That is deliberate —
a version bit that appeared only when a hidden alternative existed would itself be the
distinguisher (SPEC §10). Because StegoShard is pre-1.0 with no shipped vaults, this was
folded into v1 in place rather than introduced as a parallel v2; the frozen test vectors
and fixtures are regenerated accordingly.

### Rules for a format change

A change is **breaking** if an existing artifact would no longer decode, or a new
artifact would not decode on an older reader. Breaking changes MUST:

1. Bump the relevant version constant (and add a new branch to the decoders,
   keeping the old one until support is formally dropped).
2. Update [SPEC.md](../SPEC.md) — including the §11 constants table — and
   [docs/CRYPTO-REVIEW.md](../CRYPTO-REVIEW.md) where crypto is affected.
3. Update the **Python reference decoder** (`python/stegoshard/`) in the same
   change, and regenerate the frozen vectors (`npm run vectors`) and conformance
   fixtures (`npm run fixtures`). CI's cross-implementation conformance job must
   stay green.

Non-breaking, purely internal repackaging (that still decodes byte-for-byte on the
current reader) does **not** bump a format constant. Example: 0.9.0 rearranged the
_disguised SQLite container's_ internal rows but the vault blob and container
detection were unchanged, so no version bump — only the SemVer app version moved.

See also the "Format stability" section of [CONTRIBUTING.md](../CONTRIBUTING.md).
