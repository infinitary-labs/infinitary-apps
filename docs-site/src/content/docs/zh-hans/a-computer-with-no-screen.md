---
source: 6298f79a1d1c8bf2
title: 没有屏幕的电脑
description: 在一台 Linux 服务器或另一台没人坐在前面的电脑上用命令启动 Infinitary，让你的大副住在那里，再从你的 Mac、Linux 电脑或 Windows PC 控制它。
---

你的大副可以住在一台没人坐在前面的电脑上，例如你租用或放在家里的一台 Linux 服务器。
在那里，Infinitary 没有窗口，由一条命令启动。
你从另一台电脑控制你的大副：一台 Mac、一台 Linux 电脑或一台 Windows PC。

需要在没有屏幕的电脑上做四步，然后在你的另一台电脑上做两步：

1. 在那里安装 Infinitary。
2. 用一条命令启动它。
3. 让你的另一台电脑进来。
4. 生成一条链接。
5. 把链接粘贴到你另一台电脑上的 Infinitary 中。
6. 从你的另一台电脑连接一个订阅。

## 你需要什么 {#what-you-need}

- **一台有 x64 处理器和 systemd 的 Linux 电脑**，例如 Ubuntu 或 Fedora。
  在 Ubuntu 24.04 或 26.04 以及 Fedora 上，软件包会带上 Infinitary 在那里需要的其他一切。
- **那里的一个普通账户，不是 root。**
  下面的每一步都通过 SSH 登录那个账户来做。
- **一个两台电脑都在的网络。**
  Infinitary 从不把电脑开放到互联网，所以除非两台电脑在同一个本地网络中，否则请把它们放在同一个私有网络中，例如 Tailscale。
- **你另一台电脑上还没设置过的 Infinitary。**
  你在它首次启动时加入你的大副。
  如果你已经在那里设置了一位大副，请参阅[如果你的另一台电脑已经有大副](#if-your-other-computer-already-has-a-first-mate)。
- **一个 AI 订阅。**
  最后你会从另一台电脑登录它。
  如果你使用 Claude，请先在没有屏幕的电脑上安装 Claude Code。

## 1. 安装 Infinitary {#1-install-infinitary}

在[下载页面](https://getinfinitary.com/downloads/#linux)上，复制适合那台电脑系统的软件包的链接。
然后在没有屏幕的电脑上下载并安装它。
在 Ubuntu 上：

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

在 Fedora 上，用同样的方式安装 .rpm：`sudo dnf install ./infinitary-*.rpm`。
软件包还会安装 git 和 Xvfb，Infinitary 在那里运行需要它们。

在其他 x64 Linux 系统上，下载 AppImage，并用 `chmod +x` 允许它运行。
它需要安装 git、Xvfb 和 FUSE 2，还需要桌面电脑上有、服务器上却常常没有的库，例如 GTK 3。
本页凡是写 `infinitary` 的地方，都改为输入 AppImage 文件的路径。

## 2. 启动它 {#2-start-it}

以应该运行你的大副的那个账户，运行：

```sh
infinitary start-at-boot
```

Infinitary 会立即启动，没有窗口，并在那个账户每次登录时再次启动。
命令会告诉你在哪里读它输出的内容。

为了在你退出登录后保持运行，并在电脑每次启动时启动，命令还可能打印一行，供管理员运行一次：

```sh
sudo loginctl enable-linger <your account>
```

如果出现了这一行，就运行它。
要检查 Infinitary 是否在运行，请使用 `infinitary status`。

如果 Infinitary 说它需要 Xvfb，请用你系统的软件安装 Xvfb，然后再次运行命令。
如果它说这台电脑没有给这个用户的 systemd，`infinitary help run` 会列出其他启动方式。

## 3. 让你的另一台电脑进来 {#3-let-your-other-computer-in}

你的另一台电脑通过端口 47623 连接 Infinitary。
如果那里开着防火墙，请放行这个端口一次。
用 ufw 时，例如在 Ubuntu 上：

```sh
sudo ufw allow 47623/tcp
```

用 firewalld 时，例如在 Fedora 上：

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. 生成一条链接 {#4-make-a-link}

```sh
infinitary link
```

它会打印一条链接，并附上一句“Paste this link into Infinitary on your other computer, at its first launch.”
链接只能使用一次，有效期十分钟。
要新的链接，请再次运行这条命令。

## 5. 从你的另一台电脑加入 {#5-join-from-your-other-computer}

1. 在你的另一台电脑上首次打开 Infinitary。
2. 选择 **粘贴它的链接**，粘贴链接，然后点击 **继续**。
3. Infinitary 会问一次是否要从那里控制你的大副。
   点击 **从这里控制它**。

现在你的另一台电脑会显示你的大副。
它的卡片、任务和对话仍留在没有屏幕的电脑上。

除了链接，你也可以选择 **通过地址加入**，输入你用 SSH 登录那台电脑时所用的地址，例如 `you@vps`。
Infinitary 随后会自己向在那里运行的 Infinitary 要一条链接。
从 Windows PC 加入时，那台电脑必须接受你的 SSH 密钥，因为 Windows PC 不会询问密码。

## 6. 连接一个订阅 {#6-connect-a-subscription}

随后窗口会写着“为……上的大副连接一个订阅。它会从这里登录。”，省略号处是那台电脑的名称。
在你面前的这台电脑上，选择你的服务商，并按它的要求登录。
当订阅可以回答时，消息框会打开，你的大副就准备好了。
参见[首次启动](/zh-hans/first-launch/#connect-a-subscription)。

## 如果你的另一台电脑已经有大副 {#if-your-other-computer-already-has-a-first-mate}

一台电脑上一旦有订阅回答过，它就不会再显示首次启动的界面，所以无法粘贴链接。
请改为保留那位大副，并把它搬到没有屏幕的电脑上：

1. 按[添加一台电脑](/zh-hans/your-other-computers/#add-a-computer)中的方法，把没有屏幕的电脑添加给它。
2. 在那台电脑的菜单（它那一行上的三个点）中，选择[把你的大副搬到这里](/zh-hans/your-other-computers/#move-your-first-mate)。

它的任务、卡片和对话会随它一起过去。
你需要在那里重新登录你的订阅，而[机密](/zh-hans/secrets/)会留在它离开的那台电脑上。

## 更新它 {#update-it}

用第 1 步中同样的方式安装新的软件包。
那里的 Infinitary 会注意到新版本，自己停止，然后用新版本重新启动。

## 停止它 {#stop-it}

```sh
infinitary start-at-boot --off
```

这会停止那里的 Infinitary，并让它不再启动。
你的大副保存的工作会留在那台电脑上。

## 出问题时 {#when-something-goes-wrong}

- **`infinitary link` 显示“Infinitary is not running here, as this user.”**
  按第 2 步启动它，使用同一个账户，然后重新生成链接。
- **它显示“Infinitary here controls your first mate on another computer.”**
  那台电脑已经加入了另一位大副；请改在那台电脑上生成链接。
- **你的另一台电脑连不上链接中的地址。**
  检查两台电脑是否在同一个私有网络中，以及端口 47623 是否已按第 3 步放行。
- **Infinitary 停止了，你不知道为什么。**
  `infinitary status` 会说明它上次停止的原因，`infinitary start-at-boot` 指出的日志会说明其余的情况。

另请参阅[你的其他电脑](/zh-hans/your-other-computers/)与[故障排除](/zh-hans/troubleshooting/)。
