# Where StegoShard fits — a competitive map

This document positions StegoShard against the real landscape of adjacent tools. It is
written to be **even-handed**, not promotional: it leads with where established tools beat
StegoShard, and it treats the honest limits of steganographic deniability as first-class.
It is meant for security-literate readers — and infosec students — evaluating or writing
about the tool.

**Methodology.** Competitor facts below are drawn from primary sources (project
documentation, specifications, and peer-reviewed papers) and were fact-checked with an
adversarial verification pass; each load-bearing claim carries a citation. StegoShard's own
properties are taken from its [format spec](../SPEC.md) and source. A few well-established
facts (e.g. specific third-party audits) are marked _reported_ where they come from
secondary sources. This is a snapshot; tools evolve.

> **The one-line product hypothesis.** This research snapshot did not identify a mainstream tool in StegoShard's exact cell:
> _error-corrected backup of a small secret spread across mixed carriers (disk, paper,
> and photos that users manage themselves), with deniability as an explicit, optional second mode._ Its proposed differentiation is that
> combination plus honesty — **not** raw deniability strength (VeraCrypt wins there), nor
> physical durability (metal seed plates win there), nor maturity and audits (age, GPG,
> VeraCrypt, restic/Borg win there).

## The adjacent categories

StegoShard touches five neighbourhoods. It is a specialist in none of them individually;
its claim is the _intersection_.

### 1. Durable seed / secret backup

Built for wallet seeds and small keys, optimizing physical survival.

- **SeedQR / SeedSigner** encode a BIP-39 mnemonic as a **plaintext** QR; the standard
  format's digit stream can be transcribed back to the seed phrase by hand, so it offers
  **zero confidentiality or deniability** [1]. Its error correction is the QR standard's
  built-in "L" level (~7% within a single code) — tolerance to smudges on _one_ carrier,
  **not** redundancy spread across multiple carriers [1].
- **Metal seed plates** (Cryptosteel, Billfodl) win outright on **physical durability**
  (fire, water, corrosion) — a dimension StegoShard's paper output cannot match. They carry
  a plaintext seed and provide no encryption or deniability.
- **SLIP-39 / Shamir backup (Trezor)** splits a wallet secret into 1–16 shares with a
  user-set threshold, giving **configurable redundancy** (a 2-of-3 tolerates losing one
  share) [2] — but redundancy of _trust/shares_, not error correction of a damaged carrier.
- **Codex32 (BIP-93)** implements Shamir's Secret Sharing that can be computed **entirely
  by hand** with dice and lookup tables, on paper worksheets [3][4]. Impressive for
  air-gapped seed splitting; not a general encrypted-backup tool, no carrier redundancy.
- **paperkey** shrinks a GPG secret key for paper printing. Plaintext-on-paper, single
  carrier, no erasure coding, no deniability.

### 2. Encrypted archives / backup

Mature, audited, general-purpose encryption — the baseline StegoShard's crypto is measured
against.

- **age** is a simple, modern encryption tool with a **frozen format spec**
  (age-encryption.org/v1) [5] — the closest philosophical cousin to StegoShard's versioned
  format-candidate + reference-decoder discipline. But age is a plain encrypt/pipe tool: **no error
  correction, no cross-carrier redundancy, no deniability** [6].
- **GnuPG / OpenPGP** is the veteran: feature-rich, ubiquitous, heavily reviewed, but
  widely considered complex.
- **restic / BorgBackup** are mature encrypted-backup systems with integrity verification;
  restic's cryptography was independently reviewed (_reported_). They target large,
  deduplicated repositories — the opposite end from StegoShard's small-secret niche — and
  offer no deniability.
- **Cryptomator** targets transparent encryption of files synced to _cloud_ providers
  (_reported_); no deniability, no erasure coding.

None of these hide _that_ a secret exists, and none produce a printable / photo carrier
that survives partial loss.

### 3. Deniable storage

The category StegoShard's Deniable model competes in — and where the incumbent is strong.

- **VeraCrypt** provides deniability via **hidden volumes** and a **hidden operating
  system** [7]. Its key strength: an encrypted VeraCrypt partition/device is designed to be
  **indistinguishable from random data** with no signature, so one cannot prove it is a
  VeraCrypt volume at all [8]. This is a _stronger_ deniability primitive than hiding a
  small payload in a photo.
- **But even VeraCrypt's deniability is bounded.** By its own documentation, **file-hosted
  containers cannot deny their existence** — a file of pure random data has no innocent
  explanation [9]. And academic work shows the **hidden-OS variant can be defeated
  forensically**: analysis of the outer volume can reveal both the existence of a hidden OS
  and that it was running, from a single drive image [10], and cross-drive analysis can
  prove a hidden OS is present and estimate its size [11].
- **Historical lineage** (Rubberhose/Marutukku, StegFS, deniable filesystems) established
  the idea decades ago; StegoShard is a modern, small-secret, carrier-agnostic point in
  that lineage rather than a whole-disk system.

**Takeaway:** for _strong_ deniability of a large encrypted store, VeraCrypt is the
reference. StegoShard is not trying to beat it there; it offers deniability for a _small_
secret, in _ordinary-file_ carriers (a photo, a `.db`) that VeraCrypt does not address.

### 4. Image steganography — and its honest ceiling

This is the most important section for calibrating expectations, and the best-cited.

- Legacy tools — **steghide, OutGuess, F5, OpenStego** — hide data in images but are
  **highly detectable by a dedicated adversary**. Peer-reviewed forensics evaluate exactly
  these tools with steganalysis suites (Aletheia, StegExpose) [12]; neural-network
  steganalysis has reported **near-100% detection** against OutGuess and Steghide payloads
  [13]; and even **J-UNIWARD — one of the most secure JPEG methods — is detectable by deep
  CNNs**, which now outperform classical rich-model steganalysis [14].
- **The crucial nuance: detection scales with payload size.** Detection accuracy of
  OutGuess ranged from ~21% to ~96% depending on image size, and a Stanford study's own
  detector exceeded 92% at DCT-coefficient saturations of 0.5–1% but fell to **poor
  accuracy for very small messages** (estimated saturation below 0.1%) [15]; feature-based
  LDA still detected OutGuess at >87% in Fridrich's 2004 work [16]. In short: **big hidden
  payloads are reliably caught; a tiny payload in a large cover sits in the hardest-to-detect
  regime.**

**What this means for StegoShard.** Its Deniable model is honest about this exact limit —
it explicitly does _not_ claim steganographic indistinguishability against a dedicated
forensic adversary (see [THREAT-MODEL.md](THREAT-MODEL.md)). And its **Hybrid** design
hides only a _recovery key_ (a few KB) in the photo, deliberately operating in the
small-payload regime where steganalysis is weakest. That is a defensible engineering choice
— not a claim of invisibility.

### 5. Secret sharing

- **ssss** and other **Shamir's Secret Sharing** tools split one secret into `n` shares
  with a `k`-of-`n` threshold (information-theoretic below threshold). This is redundancy of
  _trust_, orthogonal to StegoShard's carrier-level erasure coding — and complementary:
  you could Shamir-split a StegoShard password. SSS alone addresses neither carrier survival
  nor deniability.

## Feature-comparison matrix

Legend — **Deniability**: ❌ none · ◑ shallow (defeats file-type triage only) · ▲ strong
but fragile (dies on re-encoding) · ✅ strong (still bounded). **Redundancy** = error
correction / survival **across multiple carriers**.

| Tool                     |          Encrypts           |       Cross-carrier redundancy        |                       Plausible deniability                       | Carriers (disk/paper/cloud/photo) | Maturity / audit                                                    |
| ------------------------ | :-------------------------: | :-----------------------------------: | :---------------------------------------------------------------: | --------------------------------- | ------------------------------------------------------------------- |
| **StegoShard**           | ✅ (Argon2id + AES-256-GCM) |    ✅ (Reed-Solomon across images)    |       optional: ▲ fragile (photo) · ◑ shallow (decoy `.db`)       | disk · paper · local photo output | beta; pre-1.0 format candidate + independent decoder; audit pending |
| age                      |             ✅              |                  ❌                   |                                ❌                                 | disk                              | mature, frozen spec [5]                                             |
| GnuPG                    |             ✅              |                  ❌                   |                                ❌                                 | disk · (paper via paperkey)       | veteran, heavily reviewed                                           |
| VeraCrypt                |             ✅              |                  ❌                   | ✅ strong (volume-level) [7][8], but forensically bounded [9][10] | disk                              | mature, audited (_reported_, QuarksLab 2016)                        |
| restic / Borg            |             ✅              | partial (repo integrity, not carrier) |                                ❌                                 | disk · cloud                      | mature; restic reviewed (_reported_)                                |
| Cryptomator              |             ✅              |                  ❌                   |                                ❌                                 | disk · cloud                      | mature (_reported_)                                                 |
| SeedQR                   |             ❌              |     ❌ (QR-L within one code) [1]     |                              ❌ [1]                               | paper                             | community standard                                                  |
| Metal plates             |             ❌              |                  ❌                   |                                ❌                                 | metal                             | best physical durability                                            |
| SLIP-39 / Codex32        |        n/a (splits)         |      ✅ threshold shares [2][3]       |                                ❌                                 | paper                             | standards (BIP-93 etc.)                                             |
| steghide / OutGuess / F5 |            some             |                  ❌                   |             ▲ fragile, highly detectable [12][13][14]             | photo                             | legacy; weak vs steganalysis                                        |
| ssss (Shamir)            |        n/a (splits)         |          ✅ threshold shares          |                                ❌                                 | disk · paper                      | reference impl                                                      |

_(▲ = strong concealment that a re-encode destroys; ◑ = survives copying but only defeats
casual triage.)_

## The niche StegoShard targets

In this research snapshot, the target cell was not occupied by another listed tool: **a tool that
(a) encrypts a small secret, (b) error-corrects it across _multiple, mixed_ carriers so
losing some still restores, (c) can output to disk, paper, _or_ ordinary photos, and
(d) offers deniability as an explicit, optional second mode — under a stated
resilient-vs-deniable taxonomy.**

- Seed-backup tools nail durability of _one_ carrier but don't encrypt, don't error-correct
  across carriers, and don't deny.
- Encrypted-archive tools nail confidentiality and maturity but produce a single blob that
  _announces_ it is a secret.
- VeraCrypt nails strong deniability but only for on-disk volumes.
- Steganography tools nail concealment but are fragile and undermined by steganalysis.

StegoShard is the point where _resilient multi-carrier backup_ and _optional deniability_
meet, with a **hybrid** bridge (resilient archive + deniable key) that, to our knowledge,
the comparison did not find packaged as a first-class mode. This remains a market hypothesis,
not evidence of demand; beta user interviews and usability trials are required.

## Designed advantages to validate

1. **Cross-carrier survival.** Reed-Solomon _across_ images means losing a printed page, a
   deleted album item, or an unreadable code still restores — a property seed QRs, paperkey,
   and age lack.
2. **Multiple local output forms.** The same vault can be written to disk, paper, or photos. Competitors
   are locked to one medium.
3. **Conceptual honesty as a feature.** A versioned pre-1.0 format candidate, an independent Python decoder,
   MIT licensing, symmetric-only crypto (no Shor exposure), and a documented threat model
   that states its own limits. In a category littered with fragile "invisible" tools, that
   is a real trust differentiator — the same reputation lane `age` occupies for file
   encryption.
4. **The Hybrid idea.** Storing the bulky secret resiliently while hiding only a small,
   expendable key in an everyday photo is an elegant way to get _some_ deniability without
   betting the data on a fragile channel.

## Where established competitors beat it

- **Strong deniability → VeraCrypt.** Volume-level indistinguishable-from-random beats
  small-payload photo stego, full stop [7][8].
- **Physical durability → metal seed plates.** Fire/water resistance StegoShard's paper
  cannot match.
- **Maturity, audits, ecosystem → age, GnuPG, VeraCrypt, restic/Borg.** StegoShard is new;
  its crypto review / external audit is still pending, and it currently has a small
  maintainer base.
- **Large data → restic / Borg.** StegoShard is deliberately for small-to-medium secrets
  (~4× overhead as images, 1 MiB per image; up to 1 GiB CLI / 256 MiB browser for the
  binary form); it is not a general backup system.
- **Simplicity for one seed → SeedQR / metal.** If you only need to stamp a single seed,
  those are simpler.

## Honest caveats every reader should keep

- **Steganographic deniability is bounded.** A dedicated forensic/steganalysis adversary can
  likely detect the deniable channel [12][13][14]; StegoShard's small-payload design only
  keeps it in the _hardest-to-detect_ regime [15][16], and the project says so plainly.
- **Deniability ≠ coercion resistance.** Rubber-hose attacks — forcing a user to reveal a
  key — are often the _easiest_ way to defeat cryptography, because an authenticated user
  must hold credentials that can be extracted by force [17][18]. No steganography scheme
  fully escapes this; deniability only helps to the extent the carrier truly blends in and
  the adversary never asks the right question.
- **The decoy database is shallow.** It defeats file-type triage, not a tool that opens and
  inspects it.
- **New tool, pending audit.** Treat StegoShard as promising and honest, not battle-tested,
  until an independent cryptographic review lands.

## Bottom line

StegoShard is best understood not as "a better VeraCrypt" or "a better SeedQR," but as the
clean, honest, well-engineered option for a **narrow but real problem**: durably and
portably backing up a _small, high-value secret_, with deniability available when you need
it and understood for what it is. That is a reputation-and-mindshare position — the tool
experts might recommend for its niche — rather than a mass-market one.

---

### Sources

1. SeedQR format spec (SeedSigner) — <https://github.com/SeedSigner/seedsigner/blob/main/docs/seed_qr/README.md>
2. Trezor, "What is Shamir backup?" (SLIP-39) — <https://trezor.io/learn/advanced/standards-proposals/what-is-shamir-backup>
3. Codex32 FAQ — <https://secretcodex32.com/faq/index.html>
4. Codex32 FAQ (paper-worksheet procedure) — <https://secretcodex32.com/faq/index.html>
5. age (FiloSottile) — frozen format spec — <https://github.com/FiloSottile/age>
6. age (FiloSottile) — no error correction / redundancy / deniability — <https://github.com/FiloSottile/age>
7. VeraCrypt — Plausible Deniability (hidden volumes & hidden OS) — <https://veracrypt.io/en/Plausible%20Deniability.html>
8. VeraCrypt — partition/device indistinguishable from random data — <https://veracrypt.io/en/Plausible%20Deniability.html>
9. VeraCrypt — file containers cannot deny existence — <https://veracrypt.io/en/Plausible%20Deniability.html>
10. "Defeating Plausible Deniability of VeraCrypt Hidden Operating Systems" — <https://www.researchgate.net/publication/318155607_Defeating_Plausible_Deniability_of_VeraCrypt_Hidden_Operating_Systems>
11. Ibid. — cross-drive analysis proves a hidden OS and estimates its size.
12. "Steganography and steganalysis for digital image: enhanced forensic analysis" (J. Cyber Security Technology, 2024) — <https://www.tandfonline.com/doi/full/10.1080/23742917.2024.2304441>
13. "Detection of Steganography Inserted by OutGuess and Steghide by Means of Neural Networks" — <https://www.researchgate.net/publication/221296281_Detection_of_Steganography_Inserted_by_OutGuess_and_Steghide_by_Means_of_Neural_Networks> _(verification 2–1; treat the "near-100%" figure as indicative)_
14. "JPEG-Phase-Aware Convolutional Neural Network for Steganalysis" (detecting J-UNIWARD) — <https://arxiv.org/pdf/1704.08378>
15. Stanford EE368 project report — OutGuess detection vs. payload saturation — <http://web.stanford.edu/class/ee368/Project_Autumn_1617/Reports/report_piens_staffa.pdf>
16. Ibid. — Fridrich (2004) LDA >87% detection of OutGuess.
17. "Rubber-hose cryptanalysis is often the easiest attack" — USENIX Security 2012 — <https://www.usenix.org/system/files/conference/usenixsecurity12/sec12-final25.pdf>
18. Ibid. — credentials held by an authenticated user can be extracted by force.

_Facts marked “reported” (e.g. the VeraCrypt QuarksLab 2016 audit; restic’s independent
review; Cryptomator’s cloud focus) come from secondary sources and are widely documented,
but were not part of the adversarially verified claim set for this document._
