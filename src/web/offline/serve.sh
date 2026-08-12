#!/bin/sh
# Launcher for the offline StegoShard web app.
#
# index.html cannot be opened directly: browsers block ES modules and module
# workers over file://. This serves the folder on 127.0.0.1 instead. See
# README.txt.
#
# serve.mjs prints its notice in the system language; the message below stays
# English, since it appears only when there is no Node to translate it.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on this computer."
  echo
  echo "Install it from https://nodejs.org/ (version 20 or newer), then run this"
  echo "again. If you would rather not install anything and have Python, see"
  echo "README.txt for a one-line alternative."
  exit 1
fi

# Auto-open the browser: someone running this wrapper wants the app, not a URL to
# copy. `node serve.mjs` on its own just prints the address.
exec node serve.mjs --open "$@"
