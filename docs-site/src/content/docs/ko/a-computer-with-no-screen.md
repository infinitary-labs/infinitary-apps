---
source: 6298f79a1d1c8bf2
title: 화면이 없는 컴퓨터
description: Linux 서버나 아무도 앞에 앉지 않는 다른 컴퓨터에서 명령으로 Infinitary를 시작해 일등항해사가 그곳에 있게 하고, Mac, Linux 컴퓨터, Windows PC에서 제어하세요.
---

일등항해사는 빌리거나 집에 두는 Linux 서버처럼, 아무도 앞에 앉지 않는 컴퓨터에 있을 수 있어요.
그곳에서 Infinitary는 창 없이, 명령으로 시작해 실행돼요.
일등항해사는 Mac, Linux 컴퓨터, Windows PC 같은 다른 컴퓨터에서 제어해요.

화면이 없는 컴퓨터에서 네 단계, 그다음 다른 컴퓨터에서 두 단계가 필요해요:

1. 그곳에 Infinitary를 설치하세요.
2. 명령으로 시작하세요.
3. 다른 컴퓨터가 들어올 수 있게 하세요.
4. 링크를 만드세요.
5. 다른 컴퓨터의 Infinitary에 링크를 붙여 넣으세요.
6. 다른 컴퓨터에서 구독을 연결하세요.

## 필요한 것 {#what-you-need}

- **x64 프로세서와 systemd가 있는 Linux 컴퓨터**, 예를 들어 Ubuntu나 Fedora.
  Ubuntu 24.04나 26.04, 그리고 Fedora에서는 패키지가 Infinitary가 그곳에서 필요한 나머지를 모두 가져와요.
- **그곳의 root가 아닌 일반 계정.**
  아래의 각 단계마다 SSH로 그 계정에 로그인하세요.
- **두 컴퓨터가 함께 있는 네트워크.**
  Infinitary는 컴퓨터를 인터넷에 절대 열지 않으므로, 두 컴퓨터가 로컬 네트워크를 함께 쓰지 않는다면 Tailscale 같은 개인 네트워크에 함께 두세요.
- **아직 설정하지 않은, 다른 컴퓨터의 Infinitary.**
  일등항해사에는 그 컴퓨터의 처음 실행에서 참여해요.
  그곳에 이미 일등항해사를 설정했다면 [다른 컴퓨터에 이미 일등항해사가 있다면](#if-your-other-computer-already-has-a-first-mate)을 보세요.
- **AI 구독.**
  마지막에 다른 컴퓨터에서 구독에 로그인해요.
  Claude를 쓴다면 먼저 화면이 없는 컴퓨터에 Claude Code를 설치하세요.

## 1. Infinitary 설치하기 {#1-install-infinitary}

[다운로드 페이지](https://getinfinitary.com/downloads/#linux)에서 그 컴퓨터의 시스템에 맞는 패키지의 링크를 복사하세요.
그다음 화면이 없는 컴퓨터에서 받아서 설치하세요.
Ubuntu에서는:

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

Fedora에서는 같은 방법으로 `sudo dnf install ./infinitary-*.rpm`으로 .rpm을 설치하세요.
패키지는 Infinitary가 그곳에서 실행하는 데 필요한 git과 Xvfb도 설치해요.

다른 x64 Linux 시스템에서는 AppImage를 받고 `chmod +x`로 실행할 수 있게 하세요.
AppImage에는 git, Xvfb, FUSE 2가 설치되어 있어야 하고, GTK 3처럼 데스크톱에는 있지만 서버에는 흔히 없는 라이브러리도 필요해요.
이 페이지에서 `infinitary`라고 하는 곳에는 대신 AppImage 파일의 경로를 입력하세요.

## 2. 시작하기 {#2-start-it}

일등항해사를 실행할 계정으로 다음을 실행하세요:

```sh
infinitary start-at-boot
```

Infinitary가 지금 창 없이 시작하고, 그 계정이 로그인할 때마다 다시 시작해요.
명령은 자기가 하는 말을 어디서 읽을 수 있는지 알려 줘요.

로그아웃한 뒤에도 계속 실행되고 컴퓨터가 시작할 때마다 시작하도록, 명령이 관리자가 한 번 실행할 줄을 하나 더 출력할 수도 있어요:

```sh
sudo loginctl enable-linger <your account>
```

그 줄이 나타나면 실행하세요.
Infinitary가 실행 중인지 확인하려면 `infinitary status`를 쓰세요.

Infinitary가 Xvfb가 필요하다고 하면 시스템의 소프트웨어로 Xvfb를 설치한 다음 명령을 다시 실행하세요.
이 사용자에게 systemd가 없는 컴퓨터라고 하면 `infinitary help run`이 다른 시작 방법을 나열해 줘요.

## 3. 다른 컴퓨터가 들어올 수 있게 하기 {#3-let-your-other-computer-in}

다른 컴퓨터는 포트 47623으로 Infinitary에 닿아요.
그곳에 방화벽이 켜져 있다면 그 포트를 한 번 허용하세요.
Ubuntu처럼 ufw를 쓴다면:

```sh
sudo ufw allow 47623/tcp
```

Fedora처럼 firewalld를 쓴다면:

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. 링크 만들기 {#4-make-a-link}

```sh
infinitary link
```

명령은 "Paste this link into Infinitary on your other computer, at its first launch."라는 문구와 함께 링크를 출력해요.
링크는 10분 동안 한 번만 쓸 수 있어요.
새 링크가 필요하면 명령을 다시 실행하세요.

## 5. 다른 컴퓨터에서 참여하기 {#5-join-from-your-other-computer}

1. 다른 컴퓨터에서 Infinitary를 처음 여세요.
2. **링크 붙여넣기**를 고르고, 링크를 붙여 넣은 다음 **계속**을 누르세요.
3. Infinitary가 그곳에서 일등항해사를 제어할지 한 번 물어봐요.
   **여기서 제어하기**를 누르세요.

이제 다른 컴퓨터에 일등항해사가 보여요.
카드, 작업, 대화는 화면이 없는 컴퓨터에 남아요.

링크 대신 **주소로 참여**를 고르고, `you@vps`처럼 그 컴퓨터에 SSH로 로그인할 때 쓰는 주소를 입력할 수도 있어요.
그러면 Infinitary가 그곳에서 실행 중인 Infinitary에 알아서 링크를 요청해요.
Windows PC는 암호를 묻지 않으므로, Windows PC에서 참여하려면 그 컴퓨터가 SSH 키를 허용해야 해요.

## 6. 구독 연결하기 {#6-connect-a-subscription}

그러면 창에 그 컴퓨터의 이름과 함께 "…의 일등항해사를 위해 하나를 연결하세요. 로그인은 여기서 해요."라고 표시돼요.
지금 앞에 있는 컴퓨터에서 제공자를 고르고 그 제공자가 요청하는 방식으로 로그인하세요.
구독이 답할 수 있게 되면 메시지 상자가 열리고 일등항해사가 준비돼요.
[처음 실행하기](/ko/first-launch/#connect-a-subscription)를 보세요.

## 다른 컴퓨터에 이미 일등항해사가 있다면 {#if-your-other-computer-already-has-a-first-mate}

어떤 컴퓨터에서 구독이 한 번 답하면 그 컴퓨터는 더 이상 처음 실행 화면을 보여 주지 않으므로, 링크를 붙여 넣을 수 없어요.
대신 그 일등항해사를 그대로 두고 화면이 없는 컴퓨터로 옮기세요:

1. [컴퓨터 추가하기](/ko/your-other-computers/#add-a-computer)처럼 화면이 없는 컴퓨터를 일등항해사에 추가하세요.
2. 그 컴퓨터의 메뉴(그 줄의 점 세 개)에서 [일등항해사를 여기로 옮기기](/ko/your-other-computers/#move-your-first-mate)를 고르세요.

작업, 카드, 대화가 함께 옮겨 가요.
그곳에서 구독에 다시 로그인하고, [비밀 정보](/ko/secrets/)는 떠나는 컴퓨터에 남아요.

## 업데이트하기 {#update-it}

1단계와 같은 방법으로 새 패키지를 설치하세요.
그곳의 Infinitary가 새 버전을 알아차리고, 멈춘 다음 새 버전으로 알아서 다시 시작해요.

## 중지하기 {#stop-it}

```sh
infinitary start-at-boot --off
```

이 명령은 그곳의 Infinitary를 멈추고 다시 시작하지 않게 해요.
일등항해사가 저장한 일은 그 컴퓨터에 남아요.

## 문제가 생기면 {#when-something-goes-wrong}

- **`infinitary link`가 "Infinitary is not running here, as this user."라고 해요.**
  같은 계정으로 2단계처럼 시작한 다음, 링크를 다시 만드세요.
- **"Infinitary here controls your first mate on another computer."라고 해요.**
  그 컴퓨터는 이미 다른 일등항해사에 참여했어요. 대신 그 컴퓨터에서 링크를 만드세요.
- **다른 컴퓨터가 링크의 주소에 닿지 못해요.**
  두 컴퓨터가 같은 개인 네트워크에 있는지, 그리고 3단계처럼 포트 47623이 허용되어 있는지 확인하세요.
- **Infinitary가 멈췄는데 이유를 모르겠어요.**
  `infinitary status`가 마지막으로 멈춘 이유를 알려 주고, `infinitary start-at-boot`가 알려 준 로그가 나머지를 알려 줘요.

[다른 컴퓨터](/ko/your-other-computers/)와 [문제 해결](/ko/troubleshooting/)도 보세요.
