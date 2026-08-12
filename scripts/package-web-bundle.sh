#!/usr/bin/env bash
#
# Assemble the downloadable offline web bundle from an already-built tree.
#
# Shared by the release workflow (.github/workflows/pages.yml) and the release
# dry run, so the two cannot drift; the dry run's whole purpose is to exercise
# what the release actually does, which it cannot do against a copy.
#
# Expects `npm run build:web` and `npm run build:web:offline` to have run.
#
# Usage: package-web-bundle.sh [version]
#   version defaults to $GITHUB_REF_NAME with a leading "v" stripped, and falls
#   back to the version in package.json (which is what the dry run wants, since
#   it has no tag).
#
# Writes stegoshard-npm.cdx.json, copies LICENSE/notices/SBOM into both build
# outputs, produces stegoshard-web-<version>.zip and SHA256SUMS-web.txt, prints
# the archive name, and exports WEB_ARCHIVE when running under Actions.

set -euo pipefail

version="${1:-}"

# Only trust GITHUB_REF_NAME when it is genuinely a tag. Actions sets it on
# every event, so on a pull request it holds something like "73/merge", which
# silently produced "stegoshard-web-73/merge.zip" and a zip I/O error.
if [ -z "$version" ] && [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
  version="${GITHUB_REF_NAME#v}"
fi
if [ -z "$version" ]; then
  version="$(node -p 'require("./package.json").version')"
fi

# Fail loudly on anything that is not a plain version token, rather than letting
# it become a strange path further down.
case "$version" in
  # Must also *start* alphanumeric: a mistyped flag reaching this as a
  # positional argument would otherwise become part of the archive name.
  '' | [!0-9A-Za-z]* | *[!0-9A-Za-z.+-]*)
    echo "::error::refusing to package version '$version'; expected a plain version such as 1.2.3"
    exit 1
    ;;
esac

for dir in web-dist web-dist-offline; do
  if [ ! -d "$dir" ]; then
    echo "::error::$dir is missing; run 'npm run build:web' and 'npm run build:web:offline' first"
    exit 1
  fi
done

# The bundle is unusable without its launcher: browsers refuse to load ES modules
# and module workers over file://, so index.html cannot simply be opened. It is
# built by the second half of `build:web:offline`.
if [ ! -f web-dist-offline/serve.mjs ]; then
  echo "::error::web-dist-offline/serve.mjs is missing; run 'npm run build:web:offline'"
  exit 1
fi

npm sbom --omit=dev --sbom-format=cyclonedx > stegoshard-npm.cdx.json
cp LICENSE THIRD_PARTY_NOTICES.txt stegoshard-npm.cdx.json web-dist/
cp LICENSE THIRD_PARTY_NOTICES.txt stegoshard-npm.cdx.json web-dist-offline/
# Only the offline copy: web-dist is served by Pages, which needs no launcher.
cp src/web/offline/serve.cmd src/web/offline/serve.sh src/web/offline/README.txt web-dist-offline/
chmod +x web-dist-offline/serve.sh

archive="stegoshard-web-$version.zip"
rm -f "$archive"
(cd web-dist-offline && zip -X -r "../$archive" .)
sha256sum "$archive" > SHA256SUMS-web.txt

echo "$archive"

# Not `[ -n … ] && echo …`: under `set -e` a false test as the final command
# would exit non-zero and fail the step.
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "WEB_ARCHIVE=$archive" >> "$GITHUB_ENV"
fi
