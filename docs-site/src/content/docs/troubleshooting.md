---
title: Troubleshooting
description: Common problems in Infinitary, the words the app shows for each, and what to do.
---

Each problem below starts with the words Infinitary shows you.

## A subscription needs you to sign in again

You may see a card titled "Your first mate needs you to sign in again", or a subscription in Settings → **Intelligence** that reads "sign in again".
Work on that subscription waits: "Work is paused until you sign in again."

1. Press **Sign in** on the card, or open Settings → **Intelligence**.
2. Sign in to that subscription the way your provider asks.
3. The waiting work goes on by itself.

A task that runs on another computer uses that computer's own sign-in, so sign in again for that computer, under its name.

## Your plan's allowance ran out

Your first mate shows a card titled "Your first mate has used up its allowance".
A reply to a crewmate on that subscription reads "Saved, not sent yet", with when the allowance resets.
The work goes on by itself once it resets.

To go on sooner:

- Press **Recheck allowance** if you changed something on your provider's side.
- Press **Move to** another provider, when the card offers one.
- Ask your first mate to move the work to another model.

Settings → **Intelligence** shows how much of each plan's allowance is left, and when it resets.
For Claude and Codex, **Keep going on credits** lets an account carry on with credits set up with your provider.

## Your first mate is not answering

If a message brought nothing back, a card reads "Your first mate has not answered your message".
Press **Ask again** to send it once more, or **Leave it**.

If the provider itself is not answering, a card reads that it "is not answering your first mate right now".
Press **Try Claude again**, or the same button with your provider's name, or **Open settings** to pick another subscription.
When a provider has a short problem, Activity says so, and the app tries again on its own.

## A crewmate is waiting

A task that reads **Waiting on you** has a card for you.
Open the task and press **Show the card**, then make the call.

Other words on a task say what holds it:

- "Waiting for checks": its crewmate waits for the checks on its pull request.
- "Retrying at its provider": the provider failed, and the app tries again on its own.
- "Stuck at its provider": the provider refused the same request three times, and your first mate is choosing what to do.
- "Blocked by another task": it starts once that task finishes.

## The checks failed on a pull request

When the checks fail, the crewmate that made the pull request fixes them and brings a new version.
A merge card then offers **Merge after fixing errors**.
If you press it, your merge is kept: "Your merge waits for a fix: its checks failed."
It runs once the fix's checks pass, or the crewmate asks you again on a new card if the fix changed the work.

## Another computer is out of reach

A window on another computer says "Changes are off until" the other computer "is back. It may be asleep, or on another network."
Or: "Infinitary is closed on" that computer.

1. Wake the computer where your first mate lives, and open Infinitary there.
2. Put both computers on the same network, or the same private network.
3. In Settings → **Devices**, press **Try again** on its row.

If a computer you added by its address has a new address, press **Change address** on its row.
On a Mac, macOS may hold Infinitary off the local network until someone at that Mac allows it.
Its row then offers **Add it by its address** instead.
See [Your other computers](/your-other-computers/).

## A computer is listed twice

Settings → **Devices** shows the same name twice: one row in reach, and one out of reach with tasks still on it.
This happens when a computer that runs work joins again after its saved work was deleted, or after Infinitary was installed fresh there.
The row in reach says "An earlier entry with this name and user is out of reach".

1. On the row in reach, press **Carry its tasks on here**.
2. Read what continues and what stays behind, then press **Carry them on**.
3. Each task continues from the last commit the computer where your first mate lives brought home.
   The earlier row comes off your list once every task has moved.

Commits after that one, edits not committed and files in the old task folders stay with the old entry.
For a row out of reach with no match, press **Move its tasks to…** and choose a computer.
See [What deletes your saved work](/update-and-remove/#what-deletes-your-saved-work).

## The window stops answering

Wait a moment first.
If it stays stuck, quit Infinitary and open it again.
Messages your first mate or a crewmate had not finished with are picked up again when it opens.

## macOS asks about other apps' data

macOS may ask "Infinitary would like to access data from other apps."
This happens when a crewmate's search reaches files another app keeps.
Infinitary's work rarely needs them, so **Don't Allow** is usually fine.
The task's record says it is "Waiting on macOS" until you answer, and the search then goes on.

## Claude Code is missing

To use a Claude subscription, install Claude Code on that computer first.
Without it, Infinitary says "Claude Code isn't installed on this computer. Install it to use Claude here."
If yours is too old, it names the version needed and says to run `claude update`.
On another computer, Claude Code signs in there itself: log in to it there once, and Infinitary uses that login.

## Still stuck

See [Get help](/get-help/).
Say what you did, what you expected, and what happened instead.
