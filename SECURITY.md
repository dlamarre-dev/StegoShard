# Security Policy

ImageVault is a cryptographic tool. We take security reports seriously and appreciate
responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Security Advisories](https://github.com/dlamarre-dev/ImageVault/security/advisories/new)**
("Report a vulnerability"). This keeps the report confidential until a fix is available.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version / commit.

We aim to acknowledge reports within a few days and to keep you updated on remediation.
Once a fix is released, we're happy to credit you (unless you prefer to stay anonymous).

## Scope

Security-relevant areas include, but are not limited to:

- The cryptographic layer (Argon2id KDF, AES-GCM, KEK/DEK wrapping, key export/import).
- Handling of secret material in memory (leaks, failure to zeroize).
- The self-describing image header and format parsing (malformed-input handling).
- The erasure-coding reconstruction path.
- Anything that could leak plaintext, filenames, or metadata.

## Supported versions

The project is in early development (pre-1.0). Only the latest `main` is supported until
a stable release is tagged.

## Threat model (summary)

The vault key is stored locally, wrapped by a password-derived key. A compromised support
(a public album, a found page) reveals only fragmented ciphertext. Security rests on
**password quality** plus the **KDF cost** (Argon2id). Human-readable annotations (image
title band, instruction sheet) are cleartext by design and must never contain secrets;
the UI warns about this. See the format specification (`SPEC.md`, from Phase 1) for
details.

Notes and limitations:

- **In-memory secrets.** Transient key buffers (the derived KEK and the unwrapped
  DEK) are zeroized after use. Passwords are handled as JavaScript strings, which
  are immutable and cannot be reliably wiped from memory.
- **Session key scope.** While the vault is unlocked, a single DEK is held in
  `chrome.storage.session` (volatile, cleared on lock and on browser close) and is
  reused across all vaults, so a compromise of that in-memory session would expose
  every vault, not just one.
- **Untrusted input.** On restore, the images / `.key` / `.zip` are untrusted: the
  decoders validate header and key-block parameters (including Argon2id cost) and
  cap decompression (gzip and zip) before doing significant work.
