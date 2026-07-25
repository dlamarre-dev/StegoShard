<!-- lang: fr · review: author-reviewed (langue projet) · target ≤2500 chars · store long description -->

**Verrouillez un petit fichier précieux avec un mot de passe — puis rangez-le là où il survivra vraiment, ou là où personne ne le trouvera.**

StegoShard transforme un fichier sensible — export de gestionnaire de mots de passe, phrase de récupération de portefeuille crypto, codes de secours, clés privées, note confidentielle — en quelque chose que vous pouvez conserver des années en toute sécurité. Chiffrez-le, puis choisissez : enregistrez-le sous forme d'images robustes à correction d'erreurs (ou une page imprimable, ou un seul fichier) qui survivent à l'impression, à la copie et au re-téléchargement — ou cachez-le, invisible, dans une photo d'apparence banale, pour que personne ne sache qu'il existe. Ou les deux à la fois.

Tout se passe sur votre appareil. Rien n'est envoyé en ligne, aucun compte, et ça fonctionne hors ligne.

**Ce que vous pouvez en faire**
- Sauvegarder l'export de votre gestionnaire de mots de passe et le garder des années sans dépendre d'un cloud — et l'imprimer pour survivre à un portable mort.
- Protéger une phrase de récupération de portefeuille crypto — minuscule, irremplaçable, sans « mot de passe oublié ».
- Imprimer une sauvegarde chiffrée en PDF de QR codes, puis la restaurer en scannant les pages avec la caméra du téléphone — même si une page est perdue ou tachée.
- Cacher une sauvegarde de mot de passe ou de clé dans une photo de famille laissée dans votre album, pour que son existence même reste discrète.
- Répartir un secret sur plusieurs photos ordinaires et des leurres — en perdre quelques-unes n'est pas grave.
- Conserver des codes de récupération et retrouver le fichier d'origine à l'octet près, même si des copies sont abîmées.

**Fonctions**
- Chiffrement par mot de passe ; votre clé ne quitte jamais l'appareil (Argon2id + AES-256-GCM)
- Cacher des secrets dans des photos ordinaires — un JPEG reste un JPEG, un PNG reste un PNG
- Correction d'erreurs sur plusieurs images : perdez une page ou une photo, et récupérez quand même
- Export papier / QR imprimable, restaurable par scan ou photo du téléphone
- Enregistrement sur disque en images ou en un seul .zip, ou en un fichier opaque unique
- Sortie base de données leurre (.db) et mode Galerie (réparti dans vos photos du quotidien)
- Trois façons de gérer la clé : embarquée, fichier de clé séparé, ou cachée dans une photo
- Jauge de robustesse et générateur de phrase secrète, avec guide au premier lancement
- Fonctionne dans Chrome, Edge et Firefox, plus une app web équivalente sans installation

**Privé par conception**
Gratuit et open source (MIT). Aucun compte, aucun pistage, rien ne quitte votre appareil. Vos données survivent à l'application : une app web gratuite et un décodeur indépendant peuvent toujours restaurer votre coffre, et le format de fichier est figé et versionné.

**À noter**
StegoShard est fait pour de petits secrets, pas pour sauvegarder des disques entiers. Il n'y a aucune récupération si vous perdez votre mot de passe — gardez-le en lieu sûr. Cacher un secret le rend discret face à un regard ordinaire ; ce n'est pas une garantie contre un examen forensique déterminé. Logiciel en bêta.

Code source, documentation et app web : https://github.com/dlamarre-dev/StegoShard
