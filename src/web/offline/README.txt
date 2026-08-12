StegoShard, offline web app
===========================

Français : README.fr.txt | Deutsch: README.de.txt | Español: README.es.txt
Italiano: README.it.txt | Português: README.pt.txt | 日本語: README.ja.txt
繁體中文: README.zh_TW.txt

Why you cannot just open index.html
-----------------------------------

Double-clicking index.html will not work, in any browser. The app is built as ES
modules and runs its crypto in a module worker, and browsers refuse to load either
over file:// for security reasons. It is not a limitation of StegoShard, and there
is no setting that changes it.

So the files have to be served over HTTP. That does not mean going online: the
server below listens on your own machine only, and the app itself is forbidden by
its Content-Security-Policy from making any network request at all. Nothing you
save or restore leaves this computer.

Running it
----------

With Node.js installed (any version 20 or newer):

    Windows    double-click serve.cmd
    macOS      ./serve.sh          (or: node serve.mjs --open)
    Linux      ./serve.sh          (or: node serve.mjs --open)

It prints a http://127.0.0.1:… address; open that. Leave the window running while
the tab is open, and stop it with Ctrl+C when you are done.

    node serve.mjs --port 8137     pin the port instead of picking a free one
    node serve.mjs                 print the address without opening a browser

Without Node.js, anything that serves static files from this directory will do:

    python3 -m http.server 8137
    then open http://127.0.0.1:8137/

Do not serve this over a network you share. The address the script prints is
loopback-only on purpose, and the path it includes is a random token so that
nothing else on the machine can guess it.

What to keep in mind
--------------------

Running the app in a browser leaves traces the command-line tool does not: the
browser's cache and history, its download folder, and a small preference entry
for the language and image format you chose. If that matters for what you are
storing, use the command-line tool instead, and read
docs/THREAT-MODEL.md in the source repository.

Your password cannot be recovered. If you lose it, the vault is lost.

StegoShard is MIT-licensed; see LICENSE and THIRD_PARTY_NOTICES.txt beside this
file. Source: https://github.com/dlamarre-dev/StegoShard
