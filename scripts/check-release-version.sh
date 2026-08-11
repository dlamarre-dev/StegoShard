#!/usr/bin/env bash
#
# Fail unless the pushed tag matches the version in package.json.
#
# Shared by the two release workflows and by the release dry run. It lives in a
# script rather than inline in each workflow so the dry run exercises the real
# check instead of a copy that can drift, and because the inline version was
# previously a shell syntax error that no one could run before a release.
#
# Usage: check-release-version.sh [tag]   (defaults to $GITHUB_REF_NAME)

set -euo pipefail

ref="${1:-${GITHUB_REF_NAME:-}}"

if [ -z "$ref" ]; then
  echo "usage: check-release-version.sh <tag>   (or set GITHUB_REF_NAME)" >&2
  exit 2
fi

version="$(node -p 'require("./package.json").version')"

if [ "v$version" != "$ref" ]; then
  echo "::error::tag $ref does not match package.json version $version"
  exit 1
fi

echo "tag $ref matches package.json version $version"
