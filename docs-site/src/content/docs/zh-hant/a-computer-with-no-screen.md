---
source: 6298f79a1d1c8bf2
title: 沒有螢幕的電腦
description: 在 Linux 伺服器或其他沒人坐在前面的電腦上用指令啟動 Infinitary，讓大副住在那裡，再從你的 Mac、Linux 電腦或 Windows PC 控制它。
---

你的大副可以住在一台沒人坐在前面的電腦上，例如你租用或放在家裡的 Linux 伺服器。
在那裡，Infinitary 沒有視窗，是用指令啟動的。
你從另一台電腦控制大副：一台 Mac、一台 Linux 電腦或一台 Windows PC。

在沒有螢幕的電腦上要做四個步驟，接著在你的另一台電腦上做兩個：

1. 在那裡安裝 Infinitary。
2. 用指令啟動它。
3. 讓你的另一台電腦進來。
4. 產生一個連結。
5. 把連結貼到另一台電腦上的 Infinitary。
6. 從另一台電腦連結訂閱方案。

## 你需要什麼 {#what-you-need}

- **一台有 x64 處理器和 systemd 的 Linux 電腦**，例如 Ubuntu 或 Fedora。
  在 Ubuntu 24.04 或 26.04 以及 Fedora 上，套件會帶來 Infinitary 在那裡需要的其他所有東西。
- **那裡的一個一般帳號，不是 root。**
  下面的每個步驟都要透過 SSH 登入那個帳號來做。
- **一個兩台電腦都在的網路。**
  Infinitary 絕不會把電腦開放到網際網路上，所以除非兩台電腦在同一個區域網路上，否則請讓它們連上同一個私人網路，例如 Tailscale。
- **另一台電腦上還沒設定的 Infinitary。**
  你會在它第一次啟動時加入大副。
  如果你已經在那裡設定了大副，請參閱[如果你的另一台電腦已經有大副](#if-your-other-computer-already-has-a-first-mate)。
- **一個 AI 訂閱方案。**
  最後你會從另一台電腦登入它。
  如果你使用 Claude，請先在沒有螢幕的電腦上安裝 Claude Code。

## 1. 安裝 Infinitary {#1-install-infinitary}

在[下載頁面](https://getinfinitary.com/downloads/#linux)上，複製適合那台電腦系統的套件連結。
然後在沒有螢幕的電腦上下載並安裝。
在 Ubuntu 上：

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

在 Fedora 上，用同樣的方式安裝 .rpm：`sudo dnf install ./infinitary-*.rpm`。
套件也會安裝 git 和 Xvfb，Infinitary 在那裡執行需要它們。

在其他 x64 Linux 系統上，下載 AppImage，並用 `chmod +x` 讓它可以執行。
它需要安裝 git、Xvfb 和 FUSE 2，還需要桌上型電腦有、伺服器卻常常缺少的程式庫，例如 GTK 3。
這一頁寫著 `infinitary` 的地方，都改為輸入 AppImage 檔案的路徑。

## 2. 啟動它 {#2-start-it}

以應該執行大副的帳號，執行：

```sh
infinitary start-at-boot
```

Infinitary 會立刻啟動，沒有視窗，而且每次那個帳號登入時都會再啟動。
指令會告訴你去哪裡讀它輸出的內容。

為了在你登出後繼續執行，並在電腦每次開機時啟動，指令也可能印出一行，讓管理員執行一次：

```sh
sudo loginctl enable-linger <your account>
```

如果出現了那一行，就執行它。
想確認 Infinitary 正在執行，請使用 `infinitary status`。

如果 Infinitary 說它需要 Xvfb，請用系統的軟體安裝 Xvfb，然後再執行一次指令。
如果它說這台電腦沒有給這個使用者的 systemd，`infinitary help run` 會列出其他啟動方式。

## 3. 讓你的另一台電腦進來 {#3-let-your-other-computer-in}

你的另一台電腦透過連接埠 47623 連到 Infinitary。
如果那裡開著防火牆，請允許這個連接埠一次。
使用 ufw 時，例如在 Ubuntu 上：

```sh
sudo ufw allow 47623/tcp
```

使用 firewalld 時，例如在 Fedora 上：

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. 產生連結 {#4-make-a-link}

```sh
infinitary link
```

它會印出一個連結，並附上一句「Paste this link into Infinitary on your other computer, at its first launch.」
連結只能用一次，效期十分鐘。
想要新的連結，就再執行一次這個指令。

## 5. 從另一台電腦加入 {#5-join-from-your-other-computer}

1. 在另一台電腦上第一次打開 Infinitary。
2. 選擇 **貼上它的連結**，貼上連結，然後按 **繼續**。
3. Infinitary 會問一次是否要從那裡控制大副。
   按 **從這裡控制它**。

現在你的另一台電腦會顯示你的大副。
它的卡片、任務和對話都留在沒有螢幕的電腦上。

你也可以不用連結，改選 **用位址加入**，輸入你以 SSH 登入那台電腦時用的位址，例如 `you@vps`。
接著 Infinitary 會自己向在那裡執行的 Infinitary 要一個連結。
從 Windows PC 加入時，那台電腦必須接受你的 SSH 金鑰，因為 Windows PC 不會詢問密碼。

## 6. 連結訂閱方案 {#6-connect-a-subscription}

接著視窗會顯示「在……上為你的大副連結一個方案。登入會從這裡進行。」，「……」是那台電腦的名稱。
在你面前的這台電腦上選擇你的供應商，並依照它的要求登入。
訂閱方案可以回應後，訊息框會開啟，你的大副也就準備好了。
請參閱[第一次啟動](/zh-hant/first-launch/#connect-a-subscription)。

## 如果你的另一台電腦已經有大副 {#if-your-other-computer-already-has-a-first-mate}

一台電腦上只要有訂閱方案回應過，它就不會再顯示第一次啟動的畫面，所以無法貼上連結。
請改為保留那位大副，把它搬到沒有螢幕的電腦上：

1. 依照[加入電腦](/zh-hant/your-other-computers/#add-a-computer)的方式，把沒有螢幕的電腦加入給它。
2. 在那台電腦的選單裡（在它那一列的三個點裡），選擇[把你的大副搬到這裡](/zh-hant/your-other-computers/#move-your-first-mate)。

它的任務、卡片和對話都會跟著過去。
你要在那裡重新登入你的訂閱方案，而[機密](/zh-hant/secrets/)會留在它離開的那台電腦上。

## 更新 {#update-it}

用和第 1 步相同的方式安裝新的套件。
那裡的 Infinitary 會注意到新版本，自己停止，再用新版本重新啟動。

## 停止 {#stop-it}

```sh
infinitary start-at-boot --off
```

這會停止那裡的 Infinitary，並讓它不再啟動。
大副保存的工作會留在那台電腦上。

## 出問題時 {#when-something-goes-wrong}

- **`infinitary link` 顯示「Infinitary is not running here, as this user.」**
  以同一個帳號照第 2 步啟動它，然後再產生一次連結。
- **它顯示「Infinitary here controls your first mate on another computer.」**
  那台電腦已經加入了另一位大副；請改在那台電腦上產生連結。
- **你的另一台電腦連不到連結裡的位址。**
  確認兩台電腦連上同一個私人網路，而且連接埠 47623 已照第 3 步允許。
- **Infinitary 停止了，你不知道原因。**
  `infinitary status` 會說明它上次停止的原因，`infinitary start-at-boot` 指出的日誌會說明其餘的部分。

另請參閱[你的其他電腦](/zh-hant/your-other-computers/)和[疑難排解](/zh-hant/troubleshooting/)。
