# Licensing decision record

## Current decision

StegoShard 0.9 remains under the MIT License. Release artifacts must include both
`LICENSE` and `THIRD_PARTY_NOTICES.txt`; the packaging check enforces this.

This is not a promise that future versions will always use MIT. It is also not a
commercial-exclusivity strategy: MIT permits reuse and sale, and the GNU GPL likewise
permits commercial distribution while imposing copyleft obligations. Releasing a copy
under MIT cannot later revoke the rights already granted for that copy.

## Inbound licences: what we redistribute

`THIRD_PARTY_NOTICES.txt` covers **everything StegoShard distributes**, which is the
union of two sets: the packages npm installs for a consumer, and the packages each
build inlines into an artifact we hand out directly. It used to cover only the
first, taken from `package-lock.json`'s `dev` flag, which is a question about npm
rather than about distribution. The two differ in both directions: four packages
were riding inside the released binaries and the npm tarball with no notice at
all, while twenty-seven that npm installs never reach a bundle.

Detecting the second set by scanning the output is not possible, since every
shipped bundle but the library is minified. `scripts/bundled-packages.ts` asks the
bundler instead and writes `.bundled/<build>.json`, which is committed so a change
to what we distribute is a reviewable diff.

### Two decisions recorded, 2026-09-02

**BSD-3-Clause is on the approved list.** `jpeg-js` is BSD-3-Clause and is inlined
into the released binaries and the library. The licence is OSI-approved,
permissive and MIT-compatible, and less demanding than the Apache-2.0 and MPL-2.0
already accepted. Its clause 2 asks that the copyright notice accompany a binary
redistribution, which is exactly what the notices file provides; `jpeg-js` ships
its `LICENSE`, so the notice is the upstream text verbatim.

**`@pdf-lib/fontkit` is a documented exception.** Version 1.1.1 is the latest, and
it declares MIT in two places, the `license` field of its own `package.json` and
the `## License` section of its README, but ships no licence file. MIT requires
including "the above copyright notice"; upstream publishes none, so there is
literally nothing to reproduce. Rather than compose a copyright line on the
author's behalf, the notice records where the licence is declared, states that no
copyright line exists upstream, and reproduces the MIT permission text the
declaration refers to. The exception is a named entry in
`scripts/generate-notices.ts` with that reasoning beside it, in the same posture as
the three hand-verified suppressions in `.cryptoscan.yaml`. A package that loses
its licence file and has no such entry still fails the build.

Both are inbound-licence decisions about what StegoShard may redistribute. They say
nothing about StegoShard's own outbound licence, which is the section below.

## Decision gate before 1.0 or outside contributions

Before accepting a non-trivial external code contribution, or changing the license, the
maintainer must obtain appropriate legal advice and record decisions on:

1. The objective: broad adoption (MIT), reciprocal source sharing (GPLv3), network
   copyleft (AGPLv3), or a separately negotiated dual-license model.
2. Copyright ownership for future contributions. Relicensing or selling an exception is
   much simpler when the necessary rights are held centrally; use a reviewed CLA or
   another explicit contribution policy if that flexibility is required.
3. Dependency compatibility, store terms, release notices, source-offer obligations,
   and whether documentation/assets need distinct licenses.
4. The transition boundary. Existing MIT releases stay MIT; any differently licensed
   release must identify its version and applicable source clearly.

The GPL is not a way to prohibit commercial use. The GNU project explicitly confirms
that GPL-covered software may be sold and redistributed, and explains why projects that
need centralized enforcement collect copyright assignments:

- <https://www.gnu.org/licenses/gpl-faq.html.en>
- <https://www.gnu.org/licenses/why-assign.html>
- <https://opensource.org/license/mit>

This record is project planning, not legal advice.
