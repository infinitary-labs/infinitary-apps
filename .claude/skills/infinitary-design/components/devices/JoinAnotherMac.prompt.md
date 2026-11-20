Joining the first mate on another computer from this app's first launch (captain's picks on FI3-681 and FI3-682, 2026-10-03): instead of connecting a subscription, this computer joins Your devices on a computer the person already has.
It then controls that first mate, and can run work it is given (`DevicesTab.prompt.md`).
The link comes from that computer's Settings → Devices (`DevicesTab.prompt.md`).
```jsx
<JoinAnotherMac state="closed"/>                                         // the chips under the provider row
<JoinAnotherMac state="set-up"/>                                         // the aside, set up from the first mate's computer
<JoinAnotherMac state="paste" value=""/>                                 // the aside, waiting for a link
<JoinAnotherMac state="address" value="kun@studio"/>                     // the aside, joining by its address
<JoinAnotherMac state="key" address="kun@studio"/>                       // the key line to compare
<JoinAnotherMac state="confirm" address="192.168.1.20"/>
<JoinAnotherMac state="refused" reason="used" address="192.168.1.20"/>
```
**The chip.**
On the first-launch stage, under the provider chips (`components/core/ConnectChips`), a second group follows a `--line-1` hairline apart: the micro label `YOUR FIRST MATE IS ON ANOTHER COMPUTER`, then on their own line three chips in the provider chips' shape, "+ Set up from your first mate's computer", "+ Paste its link" and "+ Join by its address" (captain's approval of INF-1827, and of INF-4931 for the first), each reached with Tab.
A Windows PC and a Linux computer with an Arm chip keep the last two alone, since only a Mac and an x64 Linux computer can be added by their address.
It is not a provider: it never appears on the Intelligence tab's foot, and the existing subscription chips above it remain under "Welcome aboard Infinitary, Captain".
The caption is the first mate: "I'm your first mate.
I'll help you manage the rest of the crew.
Please set me up on a computer that stays on as much as possible.
Your other computers need me awake."
The words stay visible in short windows, within the stage's scrolling band.

**Set up from your first mate's computer.**
The first chip opens the stage's sign-in aside: "Add this computer from your first mate's computer" at `--text-base --fg-1` weight 500, then the `--text-sm --fg-2` line "There, choose + A computer in Settings → Devices, or ask your first mate, and type this address.
It then keeps this computer updated and reaches it by itself."
This computer's address follows in a mono box with a small secondary "Copy": the user Infinitary runs as at this computer's private network address, such as `sam@100.86.12.40`, with the `--text-sm --fg-2` line "Its private network address, such as Tailscale's, reaches it wherever both computers are on it."
Under it, "On the same network only:" with the local name the nearby list fills on the other computer, `sam@Sams-Mac-mini.local`, and its own "Copy".
With no private network address, the box holds the local name alone; the box follows this computer's addresses while the aside is open.
The addresses show at once, before the Remote Login line, which follows when this computer's SSH server has answered.
With no address found yet, a `--warn` line says "Could not find this computer's address yet.
Check that it is on a network; Infinitary looks again in a moment."
Then one line says whether Remote Login is on here (on Linux, its SSH server), read without an administrator, on this computer itself or at the address shown first: an `ok` dot and "Remote Login is on here.", or a `warn` dot and "Remote Login is off here.
Turn it on, then add this computer.", with a small secondary "Open Sharing settings" on a Mac.
While it is on, the key line the other computer's question shows follows in mono, under "Your first mate's computer asks you to compare this line."
"Waiting for your first mate's computer to add this one.
This window then opens your first mate by itself." closes the aside, over a ghost "Cancel" that returns to the chips.
Every control is reached with Tab and draws the focus ring.

**Following along.**
Once the first mate's computer adds this one by its address, this window becomes a view of that first mate without a relaunch, while the stage still carries the first-launch gate and nobody has given this computer's own first mate a task.
The empty first mate this window started stops, as a pasted link's join stops it; a window opened again while that one still runs becomes the view the same way.
A computer whose own first mate has a subscription, a connection, a project or a turn stays as it is, and the wait line says instead "Something is already set up here, so this window keeps its own first mate once your first mate's computer adds this one.
Then join it with Paste its link or Join by its address."
A window beside a first mate started by hand with a command stays beside it; only one its own run agent started follows along.

**Paste.**
The chip opens the stage's sign-in aside (framed `--line-1`, `--radius-m`, `--bg-1`, 560px): "Paste the link from Infinitary on your other computer" at `--text-base --fg-1` weight 500, then the `--text-sm --fg-2` line "You make it there, in Settings → Devices, or by asking your first mate."
A mono `Input` with the placeholder "infinitary://join?…", a small primary "Continue" that stays disabled while the field is empty, and a ghost "Cancel".
Text that is not a link from Infinitary reads, with a `warn` dot: "That is not a link from Infinitary.
Copy it again on your other computer."
A link joins only by being pasted here: nothing on either computer opens one from a web page or a document.

**By its address.**
"+ Join by its address" opens the same aside: "Join by its address" at `--text-base --fg-1` weight 500, then the `--text-sm --fg-2` line "The account and computer, as you sign in to it with SSH.", followed by Devices' own "Remote Login must be on there."
(on Linux, "Its SSH server, or Remote Login on a Mac, must be on.").
A mono `Input` with the placeholder "kun@studio", beside it the narrow mono "Port" field from Devices' "By its address" (`DevicesTab.prompt.md`), a small primary "Continue" that stays disabled while the address is empty, and a ghost "Cancel".
A Mac and a Linux computer join alike.
While it works, the aside reads "Reaching kun@studio with your SSH key…" over "This takes a moment.", with no spinner; while it lets Infinitary's own key in, "Letting Infinitary's own key in on kun@studio…".

When computers on this network with Remote Login on are heard, a "Your account" field stands above the list, as on the phone (`PhoneView.prompt.md`), prefilled with this computer's own user name, with the `--text-sm --fg-2` line "Type your account, then pick your computer to fill its address."
Then the micro label `ON THIS NETWORK` and the rows of Devices' list (`AddAMac.prompt.md`, "Picking a computer on this network"): ↓ from either field reaches the first row, the arrows move along them, and a click or Enter fills the address as "account@that computer", empties the port and puts the caret in the address.

The first time this computer reaches that address, it asks Devices' key-line question in the aside (`AddAMac.prompt.md`): "Is this kun@studio?" over "Compare this line with the one that computer shows.", the key line in mono, "This is the computer" as a small primary and a ghost "Cancel", which has the focus.
The yes is kept by the address with its port, so a later join there does not ask again.
When that computer does not let the person's SSH key in and takes a password, the aside asks for it once, as Devices does, and lets Infinitary's own key in: the password goes to that computer's SSH only, and is kept nowhere.

Then that computer's open Infinitary makes a one-use link, the one its Settings → Devices makes, and this computer holds it: the link is never shown, written or logged.
The aside asks the paste path's question below, naming the computer the typed address names (`studio` for `kun@studio`), and "Control it from here" joins exactly as a pasted link does, dialing first the address SSH reached.

Each stop is one `warn` line in the aside, with the address kept in its field and "Try again":
- Infinitary is closed there: "Infinitary is not open on kun@studio.
  Open it there, then try again."
  Nothing is started there.
- too old: "Infinitary on kun@studio is too old to make a link this way.
  Update it there, or paste a link from it instead."
- it controls another computer: "Infinitary on kun@studio controls your first mate on another computer.
  Join that computer instead."
- this computer's own: "kun@studio is this computer.
  Type the address of the computer your first mate is on."
- a Linux computer with no curl: "kun@studio has no curl, which this computer asks Infinitary there for a link with.
  Install curl there, then try again."
- Remote Login off, no answer, or a refused key with no password allowed: Devices' own two lines, joined in one (`AddAMac.prompt.md`).

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
