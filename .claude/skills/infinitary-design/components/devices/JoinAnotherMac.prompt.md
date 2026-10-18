Joining the first mate on another computer from this app's first launch (captain's picks on FI3-681 and FI3-682, 2026-10-03): instead of connecting a subscription, this computer joins Your devices on a computer the person already has.
It then controls that first mate, and can run work it is given (`DevicesTab.prompt.md`).
The link comes from that computer's Settings → Devices (`DevicesTab.prompt.md`).
```jsx
<JoinAnotherMac state="closed"/>                                         // the chip under the provider row
<JoinAnotherMac state="paste" value=""/>                                 // the aside, waiting for a link
<JoinAnotherMac state="confirm" address="192.168.1.20"/>
<JoinAnotherMac state="refused" reason="used" address="192.168.1.20"/>
```
**The chip.**
On the first-launch stage, under the provider chips (`components/core/ConnectChips`), a second group follows a `--line-1` hairline apart: the micro label `YOUR FIRST MATE IS ON ANOTHER COMPUTER` and one chip in the provider chips' shape, "+ Paste its link".
It is not a provider: it never appears on the Intelligence tab's foot, and the existing subscription chips above it remain under "Welcome aboard Infinitary, Captain".
The caption is the first mate: "I'm your first mate.
I'll help you manage the rest of the crew.
Please set me up on a computer that stays on as much as possible.
Your other computers need me awake."
The words stay visible in short windows, within the stage's scrolling band.

**Paste.**
The chip opens the stage's sign-in aside (framed `--line-1`, `--radius-m`, `--bg-1`, 560px): "Paste the link from Infinitary on your other computer" at `--text-base --fg-1` weight 500, then the `--text-sm --fg-2` line "You make it there, in Settings → Devices, or by asking your first mate."
A mono `Input` with the placeholder "infinitary://join?…", a small primary "Continue" that stays disabled while the field is empty, and a ghost "Cancel".
Text that is not a link from Infinitary reads, with a `warn` dot: "That is not a link from Infinitary.
Copy it again on your other computer."
A link joins only by being pasted here: nothing on either computer opens one from a web page or a document.

**Confirm.**
Pairing asks the person once before this computer sends anything.
The aside reads "Your first mate stays on the computer at `192.168.1.20`.
Control it from here?", the address in mono as the link names it.
When the link also names a private-network address it adds ", or on your private network" before the question.
Then "This computer shows your first mate.
Its cards, tasks and conversation stay on that computer." and "It can also run work you give it, with sign-ins of its own.", then "To keep your first mate on this computer instead, cancel and set it up here.", with a small primary "Control it from here" and a ghost "Cancel".
While it dials: "Reaching the computer at `192.168.1.20`…" over "This takes a moment."
There is no spinner.

**Refused.**
The aside's head reads "This computer did not join", then one sentence with a `warn` dot, a small primary "Paste another link" and a ghost "Cancel":
- used: "That link was used already.
  Make a new one on your other computer."
- expired: "That link expired.
  A link lasts ten minutes; make a new one on your other computer."
- unreachable: "Could not reach `192.168.1.20`.
  Both computers need the same network, or the same private network."
- another machine answered: "Something answered at `192.168.1.20`, but not the computer that made this link.
  Nothing was sent to it."

**Joined.**
The stage becomes that computer's first mate (`RemoteControl.prompt.md`), and that computer's feed says "MacBook Air joined.
It can control your first mate and run its work.
Your first mate's tasks and conversation stay on this computer."
This app's first-launch gate stays derived, never a flag: after Leave or a Remove it returns with one `--text-sm --fg-3` line under the chips, "This computer left MacBook Pro." or "MacBook Pro removed this computer.
Paste a new link to come back."
