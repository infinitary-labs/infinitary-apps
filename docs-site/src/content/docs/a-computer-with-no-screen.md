---
title: A computer with no screen
description: Start Infinitary by a command on a Linux server or another computer nobody sits at, so your first mate lives there, and control it from your Mac, Linux computer or Windows PC.
---

Your first mate can live on a computer nobody sits at, such as a Linux server you rent or keep at home.
There, Infinitary runs with no window, started by a command.
You control your first mate from another computer: a Mac, a Linux computer or a Windows PC.

It takes four steps on the computer with no screen, then two on your other computer:

1. Install Infinitary there.
2. Start it with a command.
3. Let your other computer in.
4. Make a link.
5. Paste the link into Infinitary on your other computer.
6. Connect a subscription from your other computer.

## What you need

- **A Linux computer with an x64 processor and systemd**, such as Ubuntu or Fedora.
  On Ubuntu 24.04 or 26.04 and on Fedora, the package brings everything else Infinitary needs there.
- **An ordinary account there, not root.**
  Sign in to that account over SSH for each step below.
- **A network both computers are on.**
  Infinitary never opens a computer to the internet, so put both computers on the same private network, such as Tailscale, unless they share a local network.
- **Infinitary on your other computer, not set up yet.**
  You join your first mate from its first launch.
  If you already set up a first mate there, see [If your other computer already has a first mate](#if-your-other-computer-already-has-a-first-mate).
- **An AI subscription.**
  You sign in to it from your other computer at the end.
  If you use Claude, install Claude Code on the computer with no screen first.

## 1. Install Infinitary

On the [downloads page](https://getinfinitary.com/downloads/#linux), copy the link of the package for that computer's system.
Then, on the computer with no screen, download it and install it.
On Ubuntu:

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

On Fedora, install the .rpm the same way, with `sudo dnf install ./infinitary-*.rpm`.
The package also installs git and Xvfb, which Infinitary needs to run there.

On another x64 Linux system, download the AppImage and allow it to run with `chmod +x`.
It needs git, Xvfb and FUSE 2 installed, and libraries a desktop has and a server often lacks, such as GTK 3.
Wherever this page says `infinitary`, type the AppImage file's path instead.

## 2. Start it

As the account that should run your first mate, run:

```sh
infinitary start-at-boot
```

Infinitary starts now, with no window, and again whenever that account logs in.
The command says where to read what it says.

To keep it running after you log out, and to start it whenever the computer starts, the command may also print one line for an administrator to run once:

```sh
sudo loginctl enable-linger <your account>
```

Run that line if it appears.
To check that Infinitary runs, use `infinitary status`.

If Infinitary says it needs Xvfb, install Xvfb with your system's software, then run the command again.
If it says the computer has no systemd for this user, `infinitary help run` lists other ways to start it.

## 3. Let your other computer in

Your other computer reaches Infinitary on port 47623.
If a firewall is on there, let that port in once.
With ufw, as on Ubuntu:

```sh
sudo ufw allow 47623/tcp
```

With firewalld, as on Fedora:

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. Make a link

```sh
infinitary link
```

It prints a link, with the words "Paste this link into Infinitary on your other computer, at its first launch."
The link works once, for ten minutes.
Run the command again for a new one.

## 5. Join from your other computer

1. Open Infinitary on your other computer for the first time.
2. Choose **Paste its link**, paste the link and press **Continue**.
3. Infinitary asks once whether to control your first mate from there.
   Press **Control it from here**.

Your other computer now shows your first mate.
Its cards, tasks and conversation stay on the computer with no screen.

Instead of a link, you can choose **Join by its address** and type the address you sign in to that computer with over SSH, such as `you@vps`.
Infinitary then asks the Infinitary running there for a link by itself.
From a Windows PC, that computer must let your SSH key in, since a Windows PC asks for no password.

## 6. Connect a subscription

The window then reads "Connect one for your first mate on" that computer's name, and "It signs in from here."
Pick your provider and sign in the way it asks, on the computer you are at.
When a subscription can answer, the message box opens and your first mate is ready.
See [First launch](/first-launch/#connect-a-subscription).

## If your other computer already has a first mate

Once a subscription answers on a computer, it no longer shows its first launch, so it cannot paste a link.
Keep that first mate and move it to the computer with no screen instead:

1. Add the computer with no screen to it, as in [Add a computer](/your-other-computers/#add-a-computer).
2. In that computer's menu, the three dots on its row, choose [Move your first mate here](/your-other-computers/#move-your-first-mate).

Its tasks, cards and conversation go with it.
You sign in again there to your subscriptions, and [Secrets](/secrets/) stay on the computer it leaves.

## Update it

Install the new package the same way as in step 1.
Infinitary there notices the new version, stops, and starts again on it by itself.

## Stop it

```sh
infinitary start-at-boot --off
```

This stops Infinitary there and keeps it from starting again.
Your first mate's saved work stays on that computer.

## When something goes wrong

- **`infinitary link` says "Infinitary is not running here, as this user."**
  Start it as in step 2, as the same account, then make the link again.
- **It says "Infinitary here controls your first mate on another computer."**
  That computer already joined another first mate; make the link on that computer instead.
- **Your other computer cannot reach the address in the link.**
  Check that both computers are on the same private network, and that port 47623 is let in, as in step 3.
- **Infinitary stopped and you do not know why.**
  `infinitary status` says why it last stopped, and the log `infinitary start-at-boot` named says the rest.

See also [Your other computers](/your-other-computers/) and [Troubleshooting](/troubleshooting/).
