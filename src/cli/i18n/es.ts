/** Spanish. Flag names, environment variables and file extensions stay verbatim. */
import type { CliCatalog } from './index';

export const es: CliCatalog = {
  errThresholdShape: '--threshold debe tener la forma «2-of-3» (recibido «{spec}»)',
  errThresholdRange: '--threshold fuera de rango: {spec} (hace falta 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand: '{command}: las opciones --entropy solo valen para save y gallery-save',
  errUnknownCommand: 'comando desconocido «{command}» (prueba: stegoshard --help)',
  errSaveMissingInputs: 'save: falta <archivo|carpeta ...>',
  errSaveKeyMode: 'save: --key-mode «{value}» no válido',
  errSaveStegoCover: 'save: --key-mode stego requiere --cover <imagen>',
  errSaveBinaryPaper: 'save: --binary y --paper son mutuamente excluyentes',
  errSaveDisguise: 'save: --disguise requiere --binary',
  errSaveMode: 'save: --mode «{value}» no válido',
  errSaveModeNeedsDisguise: 'save: --mode {mode} requiere --binary --disguise',
  errSaveDuressDecoy: 'save: --mode duress requiere --decoy <archivo>',
  errSaveThreshold: 'save: --mode nonpossession requiere --threshold k-of-n',
  errRestoreMissing: 'restore: faltan las imágenes/carpeta/zip/pdf de entrada',
  errGalleryMissingFile: 'gallery-save: falta <archivo>',
  errGalleryNoCovers: 'gallery-save: indica fotos de portada o una carpeta',
  errGalleryKeyMode: 'gallery-save: --key-mode «{value}» no válido',
  errGalleryStegoCover: 'gallery-save: --key-mode stego requiere --cover <imagen>',
  errGalleryDuress:
    'gallery-save: --mode duress no existe para la galería; usa --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save: --mode «{value}» no válido',
  errGalleryThreshold: 'gallery-save: --mode nonpossession requiere --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore: faltan las fotos/carpeta',
  errCodecInvalid: '--codec «{value}» no válido',
  errCodecColorPaper: '--codec color no se puede usar con --paper (las páginas impresas usan QR)',
  errEntropyExclusive: '{flags} son mutuamente excluyentes (elige una sola fuente de entropía)',
  errEntropyFlagEmpty: '--entropy estaba vacío (omite la opción si no quieres entropía extra)',
  errEstimateMissing: 'estimate: falta <archivo>',
  errUiPort: 'ui: --port debe ser un número de puerto (recibido «{value}»)',
  errUiNoWebApp:
    'ui: esta compilación no incluye la aplicación web.\n' +
    'Los binarios independientes se compilan sin acceso a la red, así que no pueden\n' +
    'servirla. Usa «npx stegoshard ui», o descarga el paquete web sin conexión de la\n' +
    'página de versiones y ejecuta su script serve.',

  errNoPassword: 'no se indicó contraseña (una contraseña vacía no se admite)',
  errNoDuressPassword: 'no se indicó contraseña de coacción (una contraseña vacía no se admite)',
  errPasswordShort:
    'la {label} es demasiado corta: {length} carácter(es), mínimo {min}. ' +
    'Este mínimo no se puede omitir; un atacante sin conexión que tenga la caja fuerte puede probarla a su ritmo.',
  errWeakAcknowledge:
    '{warning} Vuelve a ejecutarlo con --allow-weak-password para aceptar este riesgo.',
  errWeakCancelled: 'cancelado: no se aceptó la contraseña débil',
  errEntropyFile: '--entropy-file: no se puede leer «{path}»',
  errEntropyPromptTty:
    '--entropy-prompt necesita un terminal; usa --entropy-file o STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt: no se introdujo nada',
  errEntropyEmpty: 'la entropía extra estaba vacía (omítela si no quieres esa capa adicional)',

  errWrongPassword: 'contraseña incorrecta',
  errNoGallery:
    'no se encontró ninguna galería restaurable (contraseña incorrecta, o estas fotos no son una galería)',
  errNeedsKey: 'este conjunto de imágenes necesita una clave aparte (usa --key <archivo|imagen>)',
  errDuressTooSimilar:
    'la contraseña de coacción se parece demasiado a la real ({reason}); ' +
    'elige una contraseña de coacción sin relación',
  errOverwrite: 'no se sobrescribe el archivo existente: {path} (usa --force para sobrescribir)',
  errStegoNeedsCover: 'el modo stego requiere una imagen --cover',
  errDuressNeedsPassword: 'save: --mode duress requiere una contraseña de coacción',
  errNoInputFiles: 'save: no se encontraron archivos de entrada',
  errModeNeedsDisguise: 'save: --mode {mode} solo se admite con --binary --disguise',
  errNoReadableImages: 'no hay imágenes de StegoShard legibles en las entradas',
  errNoCoversFound: 'galería: no se encontraron imágenes de portada en las rutas indicadas',
  errNoGalleryImages: 'galería: no se encontraron imágenes en las entradas',

  warnPasswordFlag:
    'Aviso: --password es visible en el historial del shell y en la lista de procesos; ' +
    'usa mejor STEGOSHARD_PASSWORD, --password-file o la petición interactiva.',
  warnEntropyFlag:
    'Aviso: --entropy es visible en el historial del shell y en la lista de procesos; ' +
    'usa mejor STEGOSHARD_ENTROPY, --entropy-file o --entropy-prompt.',
  warnWeakPassword:
    'Aviso: la {label} es débil (unos {bits} bits). ' +
    'Una caja fuerte sin conexión se puede adivinar sin contactar contigo.',
  warnPrefix: 'Aviso: {message}',
  labelPassword: 'contraseña',
  promptPassword: 'Contraseña: ',
  promptDuressPassword: 'Contraseña de coacción: ',
  promptEntropy: 'Entropía extra (teclea al azar o pega tiradas de dados): ',
  promptAllow: 'Escribe ALLOW para continuar: ',

  phaseCompress: 'Comprimiendo',
  phaseEncrypt: 'Cifrando',
  phaseDecrypt: 'Descifrando',
  phaseVerify: 'Verificando',
  phaseUnlock: 'Desbloqueando',
  phaseRender: 'Generando',

  purposeVault: 'la caja fuerte: contiene tu archivo',
  purposeArchive: 'todas las imágenes reunidas en un .zip',
  purposeDocument: 'hoja imprimible',
  purposePhotos: 'fotos fragmento: conserva el conjunto completo',
  purposeKeyfile: 'clave separada: necesaria con tu contraseña',
  purposeStegoCover: 'foto que lleva la clave oculta',
  purposeShare: 'fragmento de recuperación, para un titular',

  outSaved: 'Guardado: {what}.',
  outSavedBinary: 'caja fuerte binaria ({variant}) [{keyMode}]',
  outSavedImages: '{count} imagen(es) [{keyMode}]',
  outFilesCreated: 'Archivos creados:',
  outKeepKeyArtifact: 'Conserva la clave separada Y tu contraseña para poder restaurar.',
  outSavedGallery:
    'Galería guardada en {files} archivo(s) ({k} de datos + {m} de paridad + {decoys} señuelo) [{keyMode}].',
  outGalleryKeep: 'Conserva tu contraseña; {k} cualesquiera de las fotos fragmento la restauran.',
  outGalleryKeepKey: 'Conserva también la clave separada (restaura con --key).',
  outRestoredOne: 'Restaurado {name} -> {path}',
  outRestoredMany: '{count} archivos restaurados:',
  outDecoded: '{decoded} de {seen} imagen(es) descodificada(s)',
  outScanned: '{seen} foto(s) analizada(s)',
  outEstimate: '{images} imagen(es)  (k={k} datos + m={m} paridad)',

  helpTagline:
    'StegoShard: cifra un archivo en imágenes resilientes, un archivo opaco o una base de datos señuelo, y restáuralo.',
  helpUsageHeading: 'Uso:',
  helpUiHeading: 'Interfaz web local:',
  helpUi:
    'La misma aplicación que la versión de navegador, servida solo en este equipo. No está en los binarios independientes, compilados sin acceso a la red.',
  helpSaveHeading: 'Opciones de save:',
  helpSaveIntro:
    'Varias entradas (o una carpeta) se reúnen en un archivo comprimido dentro de la caja fuerte; al restaurar se recuperan los archivos originales. Una sola entrada se guarda tal cual.',
  helpRestoreHeading: 'Opciones de restore:',
  helpCommonHeading: 'Comunes:',
  helpPasswordHeading: 'Contraseña (para cualquier comando que la necesite), por prioridad:',
  helpEntropyHeading:
    'Entropía extra para save / gallery-save (opcional, avanzado; solo afecta a la generación, no hay que volver a introducirla al restaurar, y el CSPRNG del sistema se usa siempre), por prioridad:',
  helpEntropyNote:
    'Tu texto se mezcla (XOR) como segunda fuente: solo puede añadir incertidumbre, nunca sustituir al CSPRNG, así que una cadena débil no puede debilitar la caja fuerte.',
  helpGalleryHeading:
    'Modo galería (un secreto oculto, fragmentado, entre muchas fotos corrientes):',
  helpGalleryNoDuress: '(duress no existe para la galería; usa --binary --disguise --mode duress)',
  helpGalleryNote:
    'Todas las fotos se modifican; las mejores K+M llevan fragmentos Reed-Solomon y el resto se convierten en señuelos (mínimo 5 fotos, al menos 2 señuelos). La restauración es ciega: se usan todas las fotos que se autentican, y K fragmentos bastan para reconstruir.',
  helpExamplesHeading: 'Ejemplos:',

  helpOut: 'Carpeta de salida (por defecto: la carpeta actual)',
  helpPaper: 'Producir un PDF imprimible (ECC alto) en vez de PNG',
  helpZip: 'Reunir los PNG en un solo .zip (modo disco)',
  helpBinary: 'Un solo archivo opaco en vez de imágenes (hasta 1 GiB)',
  helpDisguise: 'Con --binary: darle una cabecera de base SQLite (.db)',
  helpMode: 'plain | duress | nonpossession   (solo .db; por defecto: plain)',
  helpModeDuress: 'duress: un señuelo que abre una 2.ª contraseña',
  helpModeNonpossession: 'nonpossession: ata la caja fuerte a fragmentos que no tienes',
  helpDecoy: '--mode duress: el archivo señuelo plausible',
  helpDuressPasswordFile: '--mode duress: la 2.ª contraseña (de coacción)',
  helpThreshold: '--mode nonpossession: p. ej. 2-of-3 (escribe n archivos)',
  helpCodec: 'color | qr   (por defecto: color; solo imágenes, no --paper)',
  helpCodecColor: 'color: rejilla de 8 colores, ~3x bytes por imagen',
  helpCodecQr: 'qr: QR normal, legible por cualquier teléfono',
  helpKeyMode: 'embedded | keyfile | stego   (por defecto: embedded)',
  helpCover: 'Foto de portada para --key-mode stego (la clave va dentro)',
  helpTitle: 'Etiqueta legible / título del PDF',
  helpDate: 'Fecha mostrada en las páginas (por defecto: hoy)',
  helpLocale: 'Idioma de la hoja de instrucciones, p. ej. fr, ja, zh_TW',
  helpInstructions: 'Incluir la hoja de instrucciones de restauración (papel)',
  helpPasswordHint: 'Pista de contraseña impresa en la hoja',
  helpKeyLocation: 'Dónde se guarda la clave, impreso en la hoja',
  helpFont: 'Un .ttf/.otf para el texto CJK de las instrucciones (papel)',
  helpAllowWeakPassword:
    'Aceptar una contraseña débil (pero de >= 12 caracteres) para una caja fuerte nueva. El mínimo de 12 caracteres no se puede omitir con esta ni con ninguna otra opción.',
  helpKey: 'Un archivo .key, una imagen estego o un contenedor de clave binario',
  helpShare: 'Un archivo de fragmento (repetible) para una caja nonpossession',
  helpForce: 'Sobrescribir los archivos de salida existentes (por defecto: no)',
  helpQuiet: 'Ocultar el indicador de progreso en stderr',
  helpPasswordFlag: 'No recomendado: visible en el historial / lista de procesos',
  helpPasswordFile: 'Leer la contraseña de un archivo (primera línea)',
  helpPasswordEnv: 'Variable de entorno',
  helpPasswordPrompt: 'Se pide (oculta) si no se indica ninguna de las anteriores',
  helpEntropyFlag: 'No recomendado: visible en el historial / lista de procesos',
  helpEntropyFile: 'Leerla de un archivo (todo el contenido, p. ej. tiradas de dados)',
  helpEntropyPrompt: 'Pedirla (oculta) en el terminal (necesita un TTY)',
  helpEntropyEnv: 'Variable de entorno',
  helpGalleryOut: 'Carpeta de salida para las fotos modificadas',
  helpGalleryKeyMode: 'embedded (por defecto) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Foto de portada para --key-mode stego (gallery-save)',
  helpGalleryKey: 'Clave externa para una galería keyfile/stego (gallery-restore)',
  helpGalleryMode: 'Atar la galería a fragmentos (con --threshold k-of-n)',
  helpGalleryShare: 'Un archivo de fragmento (repetible) para gallery-restore',
  helpUiPort: 'Servir en este puerto en vez de en uno libre',
  helpUiOpen: 'Abrir además la dirección en el navegador',
};
