---
source: 6298f79a1d1c8bf2
title: 画面のないコンピューター
description: 誰も前に座らない Linux サーバーなどのコンピューターでコマンドから Infinitary を起動して一等航海士をそこに置き、Mac、Linux コンピューター、Windows PC から操作します。
---

一等航海士は、レンタルしている Linux サーバーや自宅に置いた Linux サーバーなど、誰も前に座らないコンピューターにいることもできます。
そこでは、Infinitary はコマンドで起動され、ウインドウなしで動きます。
一等航海士は、Mac、Linux コンピューター、Windows PC などの別のコンピューターから操作します。

画面のないコンピューターで 4 つの手順を行い、そのあともう一方のコンピューターで 2 つの手順を行います。

1. そこに Infinitary をインストールします。
2. コマンドで起動します。
3. もう一方のコンピューターからの接続を許可します。
4. リンクを作ります。
5. もう一方のコンピューターの Infinitary にリンクを貼り付けます。
6. もう一方のコンピューターからサブスクリプションを接続します。

## 必要なもの {#what-you-need}

- **x64 プロセッサーと systemd を備えた Linux コンピューター**（Ubuntu や Fedora など）。
  Ubuntu 24.04 または 26.04 と Fedora では、Infinitary がそこで必要とするほかのものはすべてパッケージに含まれています。
- **そのコンピューターの、root ではない通常のアカウント。**
  以下の各手順では、SSH でそのアカウントにログインします。
- **両方のコンピューターがつながっているネットワーク。**
  Infinitary はコンピューターをインターネットに公開しないため、同じローカルネットワークにない場合は、Tailscale などの同じプライベートネットワークに両方のコンピューターを入れてください。
- **まだ設定していない、もう一方のコンピューターの Infinitary。**
  一等航海士には、その初回起動時に参加します。
  そこですでに一等航海士を設定している場合は、[もう一方のコンピューターにすでに一等航海士がいる場合](#if-your-other-computer-already-has-a-first-mate)を参照してください。
- **AI のサブスクリプション。**
  最後に、もう一方のコンピューターからサインインします。
  Claude を使う場合は、先に画面のないコンピューターに Claude Code をインストールしてください。

## 1. Infinitary をインストールする {#1-install-infinitary}

[ダウンロードページ](https://getinfinitary.com/downloads/#linux)で、そのコンピューターのシステム用パッケージのリンクをコピーします。
次に、画面のないコンピューターでそれをダウンロードしてインストールします。
Ubuntu の場合：

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

Fedora では、同じように `sudo dnf install ./infinitary-*.rpm` で .rpm をインストールします。
パッケージは、Infinitary がそこで動くのに必要な git と Xvfb もインストールします。

そのほかの x64 Linux システムでは、AppImage をダウンロードし、`chmod +x` で実行を許可します。
git、Xvfb、FUSE 2 がインストールされている必要があり、GTK 3 など、デスクトップにはあってもサーバーには入っていないことが多いライブラリも必要です。
このページで `infinitary` と書かれているところでは、代わりに AppImage ファイルのパスを入力します。

## 2. 起動する {#2-start-it}

一等航海士を動かすアカウントで、次を実行します。

```sh
infinitary start-at-boot
```

Infinitary はウインドウなしですぐに起動し、そのアカウントがログインするたびにも起動します。
Infinitary が書き出す内容をどこで読めるかは、コマンドが表示します。

ログアウトしたあとも動かし続け、コンピューターの起動時にも起動するように、管理者が 1 回だけ実行する行をコマンドが表示することもあります。

```sh
sudo loginctl enable-linger <your account>
```

その行が表示されたら実行してください。
Infinitary が動いているかどうかは、`infinitary status` で確認できます。

Infinitary が Xvfb が必要だと表示した場合は、システムのソフトウェアで Xvfb をインストールしてから、もう一度コマンドを実行します。
このユーザーには systemd がないと表示された場合は、`infinitary help run` にほかの起動方法が一覧表示されます。

## 3. もう一方のコンピューターからの接続を許可する {#3-let-your-other-computer-in}

もう一方のコンピューターは、ポート 47623 で Infinitary に接続します。
そのコンピューターでファイアウォールがオンになっている場合は、このポートを 1 回だけ許可します。
Ubuntu のように ufw を使う場合：

```sh
sudo ufw allow 47623/tcp
```

Fedora のように firewalld を使う場合：

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. リンクを作る {#4-make-a-link}

```sh
infinitary link
```

リンクが、「Paste this link into Infinitary on your other computer, at its first launch.」という言葉と一緒に表示されます。
リンクは 1 回だけ、10 分間使えます。
新しいリンクが必要なときは、もう一度コマンドを実行します。

## 5. もう一方のコンピューターから参加する {#5-join-from-your-other-computer}

1. もう一方のコンピューターで、Infinitary を初めて開きます。
2. **リンクを貼り付ける** を選び、リンクを貼り付けて **続ける** を押します。
3. Infinitary が、そこから一等航海士を操作するかどうかを 1 回だけ尋ねます。
   **ここから操作する** を押します。

これで、もう一方のコンピューターに一等航海士が表示されます。
カード、タスク、会話は、画面のないコンピューターに残ります。

リンクの代わりに **アドレスで参加** を選び、そのコンピューターに SSH でログインするときのアドレス（例：`you@vps`）を入力することもできます。
すると Infinitary が、そこで動いている Infinitary に自分でリンクを求めます。
Windows PC はパスワードを尋ねないため、Windows PC から参加する場合は、そのコンピューターがあなたの SSH キーを受け入れるようになっている必要があります。

## 6. サブスクリプションを接続する {#6-connect-a-subscription}

次に、ウインドウに、そのコンピューターの名前に続けて「の一等航海士用に1つ接続してください。」、そして「サインインはここから行います。」と表示されます。
プロバイダーを選び、今使っているコンピューターで、そのプロバイダーの求める方法でサインインします。
サブスクリプションが応答できるようになると、メッセージ欄が使えるようになり、一等航海士の準備が整います。
[初回起動](/ja/first-launch/#connect-a-subscription)を参照してください。

## もう一方のコンピューターにすでに一等航海士がいる場合 {#if-your-other-computer-already-has-a-first-mate}

コンピューターでいったんサブスクリプションが応答すると、そのコンピューターには初回起動の画面が表示されなくなるため、リンクを貼り付けられません。
代わりに、その一等航海士をそのまま使い、画面のないコンピューターへ移します。

1. [コンピューターを追加する](/ja/your-other-computers/#add-a-computer)のとおりに、画面のないコンピューターをその一等航海士に追加します。
2. そのコンピューターのメニュー（行の右にある 3 つの点）で、[一等航海士をここへ移す](/ja/your-other-computers/#move-your-first-mate)を選びます。

タスク、カード、会話も一緒に移ります。
移動先ではサブスクリプションにもう一度サインインします。[シークレット](/ja/secrets/)は移動元のコンピューターに残ります。

## アップデートする {#update-it}

手順 1 と同じ方法で新しいパッケージをインストールします。
そこで動いている Infinitary が新しいバージョンに気づき、停止してから、新しいバージョンで自動的に起動し直します。

## 停止する {#stop-it}

```sh
infinitary start-at-boot --off
```

これで、そこで動いている Infinitary が停止し、再び起動しなくなります。
一等航海士の保存済みの作業は、そのコンピューターに残ります。

## うまくいかないとき {#when-something-goes-wrong}

- **`infinitary link` で「Infinitary is not running here, as this user.」と表示される。**
  手順 2 のとおりに同じアカウントで起動してから、もう一度リンクを作ります。
- **「Infinitary here controls your first mate on another computer.」と表示される。**
  そのコンピューターはすでに別の一等航海士に参加しています。代わりに、その一等航海士がいるコンピューターでリンクを作ります。
- **もう一方のコンピューターから、リンクのアドレスに接続できない。**
  手順 3 のとおりに、両方のコンピューターが同じプライベートネットワークにあること、ポート 47623 が許可されていることを確認します。
- **Infinitary が停止したが、理由がわからない。**
  `infinitary status` で前回停止した理由がわかります。それ以外のことは、`infinitary start-at-boot` が示したログでわかります。

[ほかのコンピューター](/ja/your-other-computers/)、[トラブルシューティング](/ja/troubleshooting/)も参照してください。
