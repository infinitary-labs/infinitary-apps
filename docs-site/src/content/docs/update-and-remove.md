---
title: Update and remove Infinitary
description: How each kind of installation gets a new stable version, and how to remove Infinitary while keeping your saved work.
---

Infinitary checks for a new stable version every few hours.
Checking downloads nothing, and nothing installs until you choose it.
An update keeps your saved work.

## When a new version is out

A round button with a down arrow appears at the top right of the window.
Rest the pointer on it to read "Update available" and the new version's number, and press it to see what to do next.
Settings → **General** shows the same, under **Version**.

To check yourself, use any of these:

- **Check for updates** under **Version** in Settings → **General**.
- **Check for updates** in command search.
- On a Mac, **Check for Updates…** in the Infinitary menu.

What to do next depends on how you installed Infinitary.

## A Mac copy from the downloads page

1. Press **Update and restart**.
2. Infinitary downloads the new version and checks its checksum and its Apple signature.
3. It saves your crew's work.
   Running work finishes what it is running first, so nothing is lost.
4. Infinitary restarts on the new version and resumes the work the update paused.

While it waits for running work, **Update later** lets the update go until you choose it again.
Your work carries on.

If Infinitary could not finish restarting, the button reads **Restart**.
Press it again once your running work stops.

Infinitary updates itself only from Applications.
If it runs from the disk image, drag it into Applications, eject the disk image and open the copy in Applications.

## A Mac copy from Homebrew

A copy you installed with Homebrew updates through Homebrew.
The notice shows the command, with **Copy command**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Run it in Terminal.
Homebrew quits Infinitary while it replaces it, so open Infinitary again when it finishes.

## Linux

- **Ubuntu, Debian and Fedora**, from the .deb or .rpm package: press **Install**.
  Infinitary downloads the new version, checks it, saves your crew's work and asks for your password, then starts again.
- **An AppImage**: press **Install**.
  Infinitary replaces the AppImage file with the new version and starts again, with no password.
  It needs to be able to change the folder the AppImage is in.
- **Arch, Omarchy and NixOS** update through their own package manager.
  The notice shows the command, with **Copy command**; run it in a terminal.

If installing cannot finish, nothing changes and your crew's work carries on.
The notice then shows a command that installs the same version by hand.

## Windows

1. Press **Update and restart**.
2. Infinitary downloads the new installer, checks its checksum and saves your crew's work.
3. Infinitary closes, the installer replaces it, and Infinitary opens again on the new version.

If installing cannot finish, nothing changes and your crew's work carries on.

## Your other computers and your phone

A computer you added updates from the computer where your first mate lives.
When it connects on an older version, it gets that computer's version by itself.
Its running work is saved first and carries on after.
When it cannot update by itself, such as when the update asks for a password there, a card asks you instead.
In Settings → **Devices**, a computer on another version shows **Match** on its row.
Press it to bring that computer to this computer's version, whether that version is newer or older.

The app open on a computer that controls your first mate follows the same version.
When it is older, it gets that version by itself, and starts again on it once nobody is using it there.
Its row in Settings → **Devices** says how far it has got, and **Update app** gets the version right away.
Words typed there and not yet sent hold the restart until they are sent or cleared.
When that app cannot update by itself, such as a copy from Homebrew, its row and a card say what to do there.

From a computer that controls your first mate, you can also update the computer where your first mate lives.
Settings → **General** has a row for Infinitary on that computer.
When that computer has an update ready, press **Update** followed by its name.
Infinitary asks first: it names the running work that finishes before the restart, and says that someone needs to be at that computer if the new version does not start.
While that work is saved, **Update later** lets the update go.
Your phone can start that update too, after it asks you first.
See [Your other computers](/your-other-computers/) and [iPhone and iPad](/iphone-and-ipad/).

## Remove Infinitary

Removing the app leaves your saved work in place, so installing Infinitary again picks up where you left off.
If this computer runs work for another, press **Leave** in Settings → **Devices** first.

- **A Mac copy from the downloads page**: quit Infinitary and move it from Applications to the Trash.
- **A Mac copy from Homebrew**: run `brew uninstall --cask infinitary` in Terminal.
  Never add `--zap`: it deletes your saved work.
- **Linux**: remove the package with the software installer or package manager you installed it with.
  For an AppImage, delete the file.
- **Windows**: in Windows Settings → **Apps** → **Installed apps**, choose **Uninstall** in Infinitary's menu.

Your saved work stays in `~/Library/Application Support/infinitary` on a Mac, in `~/.config/infinitary` on Linux, and in `%APPDATA%\infinitary` on Windows.

### What deletes your saved work

These delete that folder, and what Infinitary kept there goes with it:

- `brew uninstall --zap`.
- An uninstaller app that also removes an app's support files.
- Moving the folder itself to the Trash, or deleting it.
- **Reset Infinitary**, which is there for starting over: see [Reset Infinitary](#reset-infinitary).

On a computer that runs work for another, that folder holds the computer's own key, its working copies and its tasks' files.
Without it, the computer joins again as a new entry, and work it had not brought home stays lost.
See [A computer is listed twice](/troubleshooting/#a-computer-is-listed-twice).

## Reset Infinitary

**Reset Infinitary**, a row in Settings → **General**, takes Infinitary on this computer back to how it was just installed, and keeps the app.
It deletes everything Infinitary keeps on this computer, including tasks, sign-ins, Secrets, settings and paired devices.
Projects in your own folders keep every file and commit.
To clear tasks only, use **Purge task data**, the row above it.

1. Press **Reset**.
   Infinitary says what it deletes and how many open tasks stop.
2. Press **Reset Infinitary**, or **Keep everything** to change nothing.
3. Confirm it is you the way your computer asks, such as with Touch ID or your password.
4. Infinitary quits, then opens on the welcome screen as if just installed.

A computer that runs work for another leaves that computer as part of its reset.
On a computer that controls your first mate, the row resets Infinitary on both computers: that one, and the computer where your first mate lives.
If that computer does not answer, nothing is reset on either.

When Infinitary cannot open, you can still reset it: see [Infinitary could not start](/troubleshooting/#infinitary-could-not-start).
