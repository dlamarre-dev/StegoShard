StegoShard, aplicación web sin conexión
=======================================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Italiano: README.it.txt | Português: README.pt.txt | 日本語: README.ja.txt
繁體中文: README.zh_TW.txt

Por qué no puedes abrir index.html directamente
-----------------------------------------------

Hacer doble clic en index.html no funcionará en ningún navegador. La aplicación
está construida con módulos ES y ejecuta su criptografía en un worker de módulo, y
los navegadores se niegan a cargar ninguno de los dos por file:// por motivos de
seguridad. No es una limitación de StegoShard, y no hay ajuste que lo cambie.

Así que los archivos tienen que servirse por HTTP. Eso no significa conectarse a
Internet: el servidor de abajo escucha solo en tu propio equipo, y la propia
aplicación tiene prohibida cualquier petición de red por su
Content-Security-Policy. Nada de lo que guardes o restaures sale de este
ordenador.

Cómo ejecutarlo
---------------

Con Node.js instalado (versión 20 o posterior):

    Windows    haz doble clic en serve.cmd
    macOS      ./serve.sh          (o: node serve.mjs --open)
    Linux      ./serve.sh          (o: node serve.mjs --open)

Imprime una dirección http://127.0.0.1:…; ábrela. Deja la ventana en marcha
mientras la pestaña esté abierta, y detenla con Ctrl+C cuando termines.

    node serve.mjs --port 8137     fijar el puerto en vez de tomar uno libre
    node serve.mjs                 mostrar la dirección sin abrir el navegador

Sin Node.js, cualquier cosa que sirva archivos estáticos desde esta carpeta vale:

    python3 -m http.server 8137
    y luego abre http://127.0.0.1:8137/

No sirvas esto en una red compartida. La dirección que imprime es solo de bucle
local a propósito, y la ruta que incluye es un token aleatorio para que nada más en
la máquina pueda adivinarla.

Qué tener en cuenta
-------------------

Usar la aplicación en un navegador deja rastros que la herramienta de línea de
comandos no deja: la caché y el historial del navegador, su carpeta de descargas y
una pequeña preferencia con el idioma y el formato de imagen elegidos. Si eso
importa para lo que estás guardando, usa mejor la línea de comandos y lee
docs/THREAT-MODEL.md en el repositorio de código.

Tu contraseña no se puede recuperar. Si la pierdes, la caja fuerte se pierde.

StegoShard tiene licencia MIT; consulta LICENSE y THIRD_PARTY_NOTICES.txt junto a
este archivo. Código: https://github.com/dlamarre-dev/StegoShard
