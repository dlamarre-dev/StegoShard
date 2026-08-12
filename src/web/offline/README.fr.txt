StegoShard, application web hors ligne
======================================

English: README.txt | Deutsch: README.de.txt | Español: README.es.txt
Italiano: README.it.txt | Português: README.pt.txt | 日本語: README.ja.txt
繁體中文: README.zh_TW.txt

Pourquoi index.html ne s'ouvre pas directement
----------------------------------------------

Double-cliquer sur index.html ne fonctionnera dans aucun navigateur. L'application
est construite en modules ES et exécute son chiffrement dans un worker de module ;
pour des raisons de sécurité, les navigateurs refusent de charger l'un comme
l'autre via file://. Ce n'est pas une limite de StegoShard, et aucun réglage ne
change cela.

Les fichiers doivent donc être servis en HTTP. Cela ne veut pas dire aller en
ligne : le serveur ci-dessous n'écoute que sur votre propre machine, et
l'application elle-même se voit interdire toute requête réseau par sa
Content-Security-Policy. Rien de ce que vous enregistrez ou restaurez ne quitte
cet ordinateur.

Comment le lancer
-----------------

Avec Node.js installé (version 20 ou plus récente) :

    Windows    double-cliquez sur serve.cmd
    macOS      ./serve.sh          (ou : node serve.mjs --open)
    Linux      ./serve.sh          (ou : node serve.mjs --open)

Une adresse http://127.0.0.1:… s'affiche ; ouvrez-la. Laissez la fenêtre ouverte
pendant que l'onglet est ouvert, et arrêtez-la avec Ctrl+C quand vous avez fini.

    node serve.mjs --port 8137     fixer le port au lieu d'en choisir un libre
    node serve.mjs                 afficher l'adresse sans ouvrir le navigateur

Sans Node.js, n'importe quoi qui sert des fichiers statiques depuis ce dossier
fera l'affaire :

    python3 -m http.server 8137
    puis ouvrez http://127.0.0.1:8137/

Ne servez pas ceci sur un réseau partagé. L'adresse affichée est volontairement
limitée à la boucle locale, et le chemin qu'elle contient est un jeton aléatoire,
afin que rien d'autre sur la machine ne puisse le deviner.

À garder en tête
----------------

Utiliser l'application dans un navigateur laisse des traces que l'outil en ligne
de commande ne laisse pas : le cache et l'historique du navigateur, son dossier de
téléchargement, et une petite préférence pour la langue et le format d'image
choisis. Si cela compte pour ce que vous stockez, utilisez plutôt l'outil en ligne
de commande, et lisez docs/THREAT-MODEL.md dans le dépôt source.

Votre mot de passe est irrécupérable. Si vous le perdez, le coffre est perdu.

StegoShard est sous licence MIT ; voir LICENSE et THIRD_PARTY_NOTICES.txt à côté de
ce fichier. Source : https://github.com/dlamarre-dev/StegoShard
