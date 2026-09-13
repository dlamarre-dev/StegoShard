# Versioning

StegoShard has **three independent version lines**. Don't conflate them.

## 1. Application / CLI version (SemVer)

`package.json`'s `version` (and the extension manifest) follow
[Semantic Versioning](https://semver.org/). This tracks the _software_ (UI, CLI,
build) and is what [CHANGELOG.md](../CHANGELOG.md) records. Pre-1.0 (`0.x`), minor
bumps may include behavioural changes; there is no stability promise until 1.0.

## 2. On-disk format version (the real compatibility contract)

The bytes StegoShard writes are a **versioned pre-1.0 interface** so independent
decoders can recover a vault. The current candidate, format version 2, is documented
in [SPEC.md](../SPEC.md); its compatibility promise begins at the public 1.0 release.
The format carries several independent version tags:

| Constant            | Where                          | Meaning                                                                        |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `FORMAT_VERSION`    | `src/core/header.ts`           | Per-image header, §6 vault blob, envelope                                      |
| `KEY_BLOCK_VERSION` | `src/core/crypto.ts`           | Serialized wrapped-DEK key block (§5.1)                                        |
| `SEG_VERSION`       | `src/core/segmented.ts`        | Segmented `.ssbn` / `.db` container (§8.1)                                     |
| `BINARY_VERSION`    | `src/core/binary-container.ts` | Branded binary container framing (§8)                                          |
| `CODEC_GALLERY`     | `src/core/header.ts`           | Gallery Mode codec id (§9)                                                     |
| `DEFAULT_ARGON2`    | `src/core/crypto.ts`           | Argon2id cost; **unstored and therefore format-defining** on §5.3, §9.1, §10.2 |

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

The access structure has **no version tag at all**. On two paths, **Gallery Mode** and
the **disguised `.db`** binary variant, every container carries the mandatory
multi-region geometry (a 4-slot key array over 2 payload regions). That geometry is a
function of the **output path**, not of a version byte: every gallery / disguised-`.db`
vault has it, and the excluded paths (single image, PDF, QR, branded `.ssbn`) never do.
That is deliberate: a version bit that appeared only when a hidden alternative existed
would itself be the distinguisher (SPEC §10).

Because StegoShard is pre-1.0 with no shipped vaults, it was folded into the format
version current at the time rather than introduced alongside it, and the fixed test
vectors and fixtures were regenerated accordingly. Note that this is **not** what later
moved `FORMAT_VERSION` to `2` — that was the AAD binding and the identity block (SPEC
§4.1, §11.1), which do change how a decoder parses. The geometry above still announces
itself nowhere, under version 2 as under version 1.

### Argon2 cost is a format constant on three paths (SPEC §5.3, §9.1, §10.2)

`DEFAULT_ARGON2` (`src/core/crypto.ts`: `iterations 4`, `memoryKiB 262144`,
`parallelism 1`) is frozen, mirrored in `python/stegoshard/`, and looks like a tuning
knob. On three paths it is not one. It is **part of the format**, with no version tag and
nowhere to put one.

The §5.1 key block **stores** its Argon2 parameters, so changing the default there affects
only vaults written afterwards and old ones keep opening. The **stego key factor**
(§5.3/§5.4), **Gallery Mode** (§9.1) and the **slot KEK** (§10.2) store nothing: the stego
path stores no header, no magic and no length at all, and the slot geometry carries no cost
field. On those three the decoder can only assume the same frozen cost the encoder used.

**What a cost change does there is worse than breaking.** It does not raise "unsupported
version". It derives a _different seed_, which is indistinguishable from a wrong password:
gallery winnowing finds no fragment, no slot opens, stego extraction de-whitens to noise
that fails Reed–Solomon. The vault is intact and unreadable and the tool cannot say why.
That is not a defect to be fixed — deniability **requires** a wrong password and an empty
carrier to look identical — which is exactly why the property that makes the format safe
is the property that makes this failure silent.

Note what that does to the pre-1.0 carve-out below: "an artifact in an older format fails
the ordinary version check" is true on §5.1 and false on these three, because there is no
version check to fail.

**Therefore: changing `DEFAULT_ARGON2` is a breaking format change**, and follows every
rule in _Rules for a format change_ — bump `FORMAT_VERSION`, update SPEC §5.1, §5.3, §9.1,
§10.2 and the §11 constants table, update the Python defaults in `format.py`, `stego.py`
and `gallery.py`, and regenerate vectors, fixtures and the golden corpus.
`scripts/check-golden.ts` refuses a cost change that arrives without the bump, and
`src/core/crypto.hardening.test.ts` pins the three values so it cannot be made in one place
quietly.

There is a **second trap on the path this section calls safe.** `python/stegoshard/format.py`
pins `iterations` to `(1, 4)` and `memory_kib` to `(8, 256 * 1024)` — ceilings numerically
equal to the current defaults, coupled to them by nothing. Raising either default without
raising both ceilings makes the reference decoder reject every key block the TypeScript
encoder writes, on the one path that stores its parameters. `scripts/check-spec.ts` checks
that pairing.

**Post-1.0 this is not solved, and this section does not pretend otherwise.** Once vaults
exist in the wild, none of the three available moves is acceptable as written:

- _Store the parameters._ There is nowhere to put them. The stego path's whole guarantee is
  that nothing is stored; the slot geometry has no free field; and the only reserved space,
  `slot_plaintext.reserved[15]` (§10.1), sits **inside the ciphertext** and is therefore
  unreadable until the KEK — the thing whose cost you needed to know — already exists.
- _Add a version byte._ Refused for the same reason the access structure carries no version
  tag: a byte that appears only where a hidden alternative might exist is itself the
  distinguisher (SPEC §10).
- _Trial-decode over a list of historical profiles._ The only move needing no format change,
  and the most expensive. Argon2id at 256 MiB is roughly a second and 256 MiB resident per
  attempt, so trying _p_ profiles multiplies both by _p_. It also breaks the **"Argon2 runs
  exactly once per unlock, whatever the outcome"** invariant that CI counts on every pull
  request ([CRYPTO-REVIEW.md](CRYPTO-REVIEW.md) §5.7) — a property held deliberately so
  unlock cost does not vary with what the inputs turn out to be. Making the attempt count
  depend on which profile a vault was written under introduces a new observable, on the
  paths least able to afford one.

The pre-1.0 answer is that there are no vaults to migrate, so the cost is frozen and a
change is a version bump. **The post-1.0 answer does not exist yet.** It should be settled
before 1.0 rather than at the first time someone wants to raise the memory cost, and it is
recorded here so that decision is taken deliberately instead of discovered.

### Rules for a format change

A post-1.0 change is **breaking** if an existing artifact would no longer decode, or a
new artifact would not decode on an older reader. Before 1.0, audit-driven changes may
replace the candidate in place but must still:

1. Bump the relevant version constant. A change to `DEFAULT_ARGON2` bumps
   `FORMAT_VERSION` — see _Argon2 cost is a format constant_ above for why a KDF cost
   is a format constant at all.

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
