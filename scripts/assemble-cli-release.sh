#!/usr/bin/env bash
#
# Assemble the CLI release directory from the per-platform archives produced by
# the build matrix: add licences and an SBOM, then checksum everything.
#
# Shared by release-cli.yml's publish job and the release dry run, so the dry
# run exercises the real assembly rather than a copy. Publishing itself
# (attestation, GitHub release upload) stays in the workflow; it needs a tag
# and write permissions the dry run deliberately does not have.
#
# Usage: assemble-cli-release.sh [dir]   (default: release)

set -euo pipefail

dir="${1:-release}"

if [ ! -d "$dir" ]; then
  echo "::error::$dir does not exist; did the artifact download step run?"
  exit 1
fi

# The archive names are the artifact names, so a change to either that is not
# mirrored in the download pattern silently yields an empty release. Fail here
# instead of publishing a release with missing platforms.
for f in stegoshard-linux-x64.tar.gz stegoshard-macos-arm64.tar.gz stegoshard-windows-x64.zip; do
  if [ ! -f "$dir/$f" ]; then
    echo "::error::$f is missing from $dir; check the build matrix and the download pattern"
    exit 1
  fi
done

cp LICENSE THIRD_PARTY_NOTICES.txt "$dir/"
npm sbom --omit=dev --sbom-format=cyclonedx > "$dir/stegoshard-npm.cdx.json"

# Note the glob also covers stegoshard-npm.cdx.json, written just above.
(cd "$dir" && sha256sum stegoshard-* LICENSE THIRD_PARTY_NOTICES.txt > SHA256SUMS.txt)

cat "$dir/SHA256SUMS.txt"
