# Roadmap

Direction and open work, grouped by theme. This is intentionally high-level;
tracked issues carry the detail. "Impact/Effort" are rough planning aids.

## Recently shipped (0.9.0)

- Post-quantum crypto scanning in CI (QRAMM) — the codebase is symmetric-only, so
  no Shor exposure; AES-256/SHA-256 keep an adequate Grover margin.
- Confidentiality hardening: Argon2id 256 MiB / t=4; per-export content key; per-
  cover stego nonce.
- Deniability: disguised SQLite stores the vault _inside_ a valid multi-row
  database (no trailing bytes); Deniable/Overt UI labels.
- Reliability/UX: post-save round-trip verification; recovery guidance; password
  strength meter + passphrase generator; first-run onboarding.
- Quality: error-path coverage (branches ≥ 85); parser fuzzing (nightly).

## Near term

- **Independent security audit** (mandatory 1.0 gate). The dossier is ready
  ([docs/CRYPTO-REVIEW.md](CRYPTO-REVIEW.md)) — needs scoping + an auditor. _Impact:
  high · Effort: high (external)._
- **1.0 readiness**: complete `docs/QA.md`, native review, store listings, and only then
  freeze the public API and format promise. _Impact: high · Effort: medium._
- **Licensing decision**: keep 0.9 under MIT, then obtain legal advice and resolve the
  GPL/AGPL/dual-license and contribution-rights questions in `docs/LICENSING.md` before
  1.0 or the first non-trivial external contribution. _Impact: high · Effort: medium._

## Later / exploratory

- Reduce the deniability content-tell further (e.g. cache values that better mimic
  a real application's data), acknowledging its limits.
- Broaden fuzzing (structure-aware / longer nightly budgets).
- Grow the contributor base (reduce bus factor; a second crypto reviewer).

## Non-goals

- Inventing cryptography (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- Overselling deniability. StegoShard's Deniable Storage is a real, first-class
  model, but its deniability has honest, documented limits — notably no claim of
  steganographic indistinguishability against a dedicated forensic adversary, and a
  channel that is fragile by design (recompression destroys it). Those limits are
  documented in [docs/CRYPTO-REVIEW.md](CRYPTO-REVIEW.md).
