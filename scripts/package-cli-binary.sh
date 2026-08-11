#!/usr/bin/env bash
#
# Package a compiled CLI binary for download.
#
# Shared by the release workflow (.github/workflows/release-cli.yml) and the
# release dry run, so the two cannot drift.
#
# Compresses the *download*, never the executable: the archive is unpacked
# before anything runs it. Packing the executable in place (UPX) refuses
# outright on Linux and, worse, silently produces a Windows binary that aborts
# inside V8 on startup; see the comment in release-cli.yml.
#
# Usage: package-cli-binary.sh <binary> <archive>
#   The archive extension selects the format: .tar.gz (Linux/macOS) or .zip
#   (Windows, via the 7z that ships on the runner image).

set -euo pipefail

bin="${1:-}"
archive="${2:-}"

if [ -z "$bin" ] || [ -z "$archive" ]; then
  echo "usage: package-cli-binary.sh <binary> <archive>" >&2
  exit 2
fi

if [ ! -f "$bin" ]; then
  echo "::error::$bin not found; did the compile step run?"
  exit 1
fi

rm -f "$archive"
case "$archive" in
  *.tar.gz) tar -czf "$archive" "$bin" ;;
  *.zip) 7z a -tzip -mx=9 "$archive" "$bin" > /dev/null ;;
  *)
    echo "::error::unsupported archive type: $archive (expected .tar.gz or .zip)"
    exit 1
    ;;
esac

# Keep the size trade-off visible in the log: these binaries embed the Deno/V8
# runtime and are 215-254 MB raw.
#
# shellcheck disable=SC2012  # both names are workflow-defined constants with no
# special characters, and `ls -lh` is the one size listing that behaves the same
# on the ubuntu, macos, and windows-bash runners.
ls -lh "$bin" "$archive" | awk 'NF>=9 {print $9, $5}'
