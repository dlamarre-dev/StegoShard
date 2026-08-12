StegoShard オフライン版ウェブアプリ
====================================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Español: README.es.txt | Italiano: README.it.txt | Português: README.pt.txt
繁體中文: README.zh_TW.txt

index.html を直接開けない理由
-----------------------------

index.html をダブルクリックしても、どのブラウザーでも動きません。このアプリは ES
モジュールで作られ、暗号処理をモジュールワーカーで実行しますが、ブラウザーは
セキュリティ上の理由から、そのどちらも file:// 経由での読み込みを拒否します。
StegoShard の制限ではなく、設定で変えられるものでもありません。

そのため、ファイルは HTTP で配信する必要があります。とはいえ、オンラインにする
わけではありません。下記のサーバーはこのマシン上でのみ待ち受け、アプリ自体も
Content-Security-Policy によってあらゆるネットワーク要求を禁じられています。
保存したり復元したりする内容が、このコンピューターの外に出ることはありません。

実行方法
--------

Node.js（バージョン 20 以降）がインストールされている場合:

    Windows    serve.cmd をダブルクリック
    macOS      ./serve.sh          （または: node serve.mjs --open）
    Linux      ./serve.sh          （または: node serve.mjs --open）

http://127.0.0.1:… というアドレスが表示されます。それを開いてください。タブを
開いている間はウィンドウをそのままにし、終わったら Ctrl+C で停止します。

    node serve.mjs --port 8137     空きポートではなく指定のポートを使う
    node serve.mjs                 ブラウザーを開かず、アドレスだけ表示する

Node.js がない場合は、このフォルダーの静的ファイルを配信できるものなら何でも
かまいません:

    python3 -m http.server 8137
    そのあと http://127.0.0.1:8137/ を開く

共有ネットワークで配信しないでください。表示されるアドレスは意図的にループバック
専用で、含まれるパスはランダムなトークンです。マシン上の他のものが推測すること
はできません。

留意点
------

ブラウザーでアプリを使うと、コマンドライン版では残らない痕跡が残ります:
ブラウザーのキャッシュと履歴、ダウンロードフォルダー、そして選んだ言語と画像形式
の小さな設定です。保存する内容にとってそれが問題になる場合は、コマンドライン版を
使い、ソースリポジトリの docs/THREAT-MODEL.md をお読みください。

パスワードは復元できません。失うと、保管庫も失われます。

StegoShard は MIT ライセンスです。このファイルと同じ場所にある LICENSE と
THIRD_PARTY_NOTICES.txt をご覧ください。ソース:
https://github.com/dlamarre-dev/StegoShard
