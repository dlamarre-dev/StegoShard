StegoShard 離線網頁應用程式
===========================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Español: README.es.txt | Italiano: README.it.txt | Português: README.pt.txt
日本語: README.ja.txt

為什麼不能直接開啟 index.html
-----------------------------

直接雙擊 index.html 在任何瀏覽器都不會成功。這個應用程式以 ES 模組建置，並在
module worker 中執行加密運算，而瀏覽器出於安全考量，拒絕透過 file:// 載入這兩者。
這不是 StegoShard 的限制，也沒有任何設定可以改變。

因此這些檔案必須透過 HTTP 提供。這不代表要連上網路：下面的伺服器只在您自己的
電腦上接聽，而應用程式本身也被它的 Content-Security-Policy 禁止發出任何網路
請求。您儲存或還原的任何內容都不會離開這台電腦。

如何執行
--------

已安裝 Node.js（版本 20 或更新）時：

    Windows    雙擊 serve.cmd
    macOS      ./serve.sh          （或：node serve.mjs --open）
    Linux      ./serve.sh          （或：node serve.mjs --open）

它會印出一個 http://127.0.0.1:… 的網址，請開啟它。分頁開啟期間請保持這個視窗
執行，結束後以 Ctrl+C 停止。

    node serve.mjs --port 8137     指定通訊埠，而不是任意空閒的埠
    node serve.mjs                 只印出網址，不開啟瀏覽器

沒有 Node.js 時，任何能從這個資料夾提供靜態檔案的工具都可以：

    python3 -m http.server 8137
    然後開啟 http://127.0.0.1:8137/

請不要在共用網路上提供這個服務。印出的網址刻意只限本機回送位址，其中的路徑是
隨機權杖，因此這台電腦上的其他程式無法猜到。

需要注意的事
------------

在瀏覽器中使用這個應用程式，會留下命令列工具不會留下的痕跡：瀏覽器的快取與
瀏覽記錄、下載資料夾，以及一小筆記錄您所選語言與圖片格式的偏好設定。如果這對
您所存放的內容有影響，請改用命令列工具，並閱讀原始碼庫中的
docs/THREAT-MODEL.md。

您的密碼無法找回。一旦遺失，保險庫也就遺失了。

StegoShard 採用 MIT 授權；請參閱與本檔案同一資料夾中的 LICENSE 與
THIRD_PARTY_NOTICES.txt。原始碼：https://github.com/dlamarre-dev/StegoShard
