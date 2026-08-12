StegoShard, aplicação web offline
=================================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Español: README.es.txt | Italiano: README.it.txt | 日本語: README.ja.txt
繁體中文: README.zh_TW.txt

Porque é que o index.html não abre diretamente
----------------------------------------------

Fazer duplo clique no index.html não vai funcionar em nenhum navegador. A aplicação
é feita de módulos ES e executa a criptografia num module worker, e por razões de
segurança os navegadores recusam-se a carregar ambos através de file://. Não é uma
limitação do StegoShard, e não há definição que altere isso.

Por isso os ficheiros têm de ser servidos por HTTP. Isso não significa ir para a
Internet: o servidor abaixo escuta apenas na sua própria máquina, e à própria
aplicação a Content-Security-Policy proíbe qualquer pedido de rede. Nada do que
guardar ou restaurar sai deste computador.

Como executar
-------------

Com o Node.js instalado (versão 20 ou mais recente):

    Windows    faça duplo clique em serve.cmd
    macOS      ./serve.sh          (ou: node serve.mjs --open)
    Linux      ./serve.sh          (ou: node serve.mjs --open)

É apresentado um endereço http://127.0.0.1:…; abra-o. Deixe a janela em execução
enquanto o separador estiver aberto, e pare com Ctrl+C quando terminar.

    node serve.mjs --port 8137     fixar a porta em vez de escolher uma livre
    node serve.mjs                 mostrar o endereço sem abrir o navegador

Sem o Node.js, serve qualquer coisa que disponibilize ficheiros estáticos desta
pasta:

    python3 -m http.server 8137
    depois abra http://127.0.0.1:8137/

Não disponibilize isto numa rede partilhada. O endereço apresentado é de propósito
apenas local, e o caminho que inclui é um token aleatório, para que mais nada na
máquina o possa adivinhar.

A ter em conta
--------------

Usar a aplicação num navegador deixa vestígios que a ferramenta de linha de
comandos não deixa: a cache e o histórico do navegador, a sua pasta de
transferências, e uma pequena preferência com o idioma e o formato de imagem
escolhidos. Se isso importa para aquilo que está a guardar, use a linha de comandos
e leia docs/THREAT-MODEL.md no repositório do código.

A sua palavra-passe não pode ser recuperada. Se a perder, o cofre está perdido.

O StegoShard tem licença MIT; consulte LICENSE e THIRD_PARTY_NOTICES.txt junto a
este ficheiro. Código: https://github.com/dlamarre-dev/StegoShard
