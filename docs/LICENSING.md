# Licensing decision record

## Current decision

StegoShard 0.9 remains under the MIT License. Release artifacts must include both
`LICENSE` and `THIRD_PARTY_NOTICES.txt`; the packaging check enforces this.

This is not a promise that future versions will always use MIT. It is also not a
commercial-exclusivity strategy: MIT permits reuse and sale, and the GNU GPL likewise
permits commercial distribution while imposing copyleft obligations. Releasing a copy
under MIT cannot later revoke the rights already granted for that copy.

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
