Settings → Devices on the computer where the first mate lives (captain's picks on FI3-681 and FI3-682, 2026-10-03): one list of your devices, the link or command that adds a computer, and the address a link sends it to.
A wide tab after Usage.
How a device joins and what keeps it out are pairing's rules, in the app's `docs/devices.md`; this page is how they look and read.
Adding a computer is `AddAMac.prompt.md`, signing in on it `SignInOnAMac.prompt.md`, and giving it a project `RunsOn.prompt.md`.
```jsx
<DevicesTab devices={[THIS_MAC]} address={{value:"192.168.1.20",kind:"this network"}}/>                        // nothing added yet
<DevicesTab devices={[THIS_MAC,BUILDER,AIR,MINI]} />
<DevicesTab devices={[THIS_MAC,AIR]} panel={{kind:"command",text:COMMAND,secondsLeft:581}}/>                   // a command is open
```
**The picture.**
The first mate lives on one computer.
Every other computer the person adds can control that first mate while Infinitary is open on it, and can run the work of a project set to run on it.
Running as another user on this computer only runs work, with sign-ins of its own, and never controls the first mate.
Like every user on the computer, it can read files in the person's home folder outside private folders such as Desktop and Documents, and the tab says so (`AddAMac.prompt.md`).
Adding a computer changes nothing by itself.
Every computer on the list can act as the person, the same as this computer, so the person adds only their own computers.
The iPhone and iPad app joins the same list as a phone, never runs work, and initially reads only (`PhoneView.prompt.md`).
A computer added before every computer could do both keeps what it could do - only controlling, or only running work - until it is added again; its row reads as a computer that controls or as a computer that runs work.

**Your devices.**
A micro label `YOUR DEVICES` (captain's pick), then one `--text-sm --fg-2` line: "Your first mate lives on this computer.
Its tasks and conversation stay here.
From any computer you add you can control it, and any computer you add can run a project's work.
Running as another user on this computer only runs work.
Like every user here, it can read files in your home folder."
Then one list box (`--bg-1`, `--line-1` hairline, `--radius-m`), the Projects list's box, with a row per device in `components/machines/MachineRow`'s shape:
- This computer, first and always: the name "This computer", the mono line "MacBook Pro · your first mate lives here", the summary "Runs notes · Signed in to Codex, Claude and GitHub", its task count, and no Remove.
- Running as another user, right after This computer: the name "Running as Builder", the mono line "another user on this computer · runs work only, while Builder is logged in · seen just now".
- Each other computer by its own name, drawn as text because the computer chose it: the mono line "a computer · joined today 14:06 · seen just now", or "a computer · sam@mini.local · seen just now" when it was added by its address; a phone's reads "a phone · joined today 14:06 · seen just now".

The summary line is "Runs website and api" or "Runs no project yet", then "Signed in to Codex, Claude and GitHub" or "No sign-ins yet".
It leads with "Controlling your first mate now" while Infinitary is open on that computer.
On the right a mono state - "1 task" in `--accent`, "idle", "connecting" while its SSH connection is being made, or "out of reach" in `--warn` - then a small secondary Button "Remove".
The dot is `ok` while the device answers, `idle` while its connection is being made (its state on the right reads "connecting"), and `warn` while it is out of reach.
Out of reach, the mono line ends "out of reach since 14:02"; a user who has not logged in since a restart reads "not logged in since this computer restarted" (`RunsOn.prompt.md` has their feed lines).
The box's foot is the `ConnectChips` row shape: the micro label `ADD` and three chips, "+ A computer", "+ A phone" and "+ Running as another user".
A phone opens the scan-code panel described in `PhoneView.prompt.md`, including the current TestFlight-only availability.
Every build shows all three chips, installed and development alike.

**Bringing a computer back.**
A computer that runs work looks for this computer where its link or command said, so after this computer's address changes it stays out of reach until it hears where this computer is now (`AddAMac.prompt.md`, "Finding this computer again").
Another user on this computer looks for it at the address a computer uses for itself, which a new network never moves, so only a change of where Infinitary listens on this computer itself strands it.
When this computer's address changed since the computer was last in reach, its row adds one `--text-sm --fg-2` line under the summary, and the way back:
- another computer added by a command: "It still looks for this computer at its old address.
  A new command run there brings it back.", with a small secondary Button "Make a command", which opens the command panel for another computer.
- another user on this computer: "It still looks for this computer at its old address.
  A new command run as Builder brings it back.", with "Make a command", which opens the command panel for another user.

Back in reach, the line and the button go, and the row reads "seen just now" with what it ran before.
The line never stands while this computer is on no network: nothing reaches this computer then, wherever it looks.
A computer added by its address never takes the line: this computer's own SSH connection follows this computer wherever it is (below, "Reached over your SSH").

**Held on the local network** (captain's pick on FI3-1001).
A computer added by a command runs its work in the background, and its work dials this computer itself.
On the local network macOS holds that dial until someone at that computer allows Infinitary there, so a computer with no one at its screen joins and then never comes into reach.
While a computer a command added has not reached this computer since it joined, and it looks for this computer at an address on the local network, its row adds one `--text-sm --fg-2` line under the summary: "It has not reached this computer since it joined. macOS lets Infinitary on Mac mini use your local network only once someone there allows it.
Added by its address, this computer reaches it with your SSH key instead."
Its mono line reads "a computer · joined today 14:06 · out of reach", with no time since, because it never was in reach.
A small secondary "Add it by its address" stands before Remove.
It turns the row into one question in place, Change address's shape: "Where to reach Mac mini" over "The address you use with SSH for it, as sam.
Remote Login must be on there.", a mono `Input` with the placeholder "sam@mini.local", a small primary "Add it" and a ghost "Cancel".
Add it there is + A computer's "By its address": the row reads "Reaching sam@mini.local with your SSH key…", then "Telling Mac mini where this computer is now…", and Mac mini stays the same computer on the list, reached over this computer's own SSH from then on (`AddAMac.prompt.md`, "Finding this computer again").
Once its work reaches this computer, by either way, the line and the button go for good.
A private network's address, such as Tailscale's, is not the local network, and another user on this computer looks for it on this computer itself, so neither takes the line.
A computer whose command named an address this computer no longer has takes "Bringing a computer back" instead: the old address is the first thing to mend.

**Reached over your SSH.**
A computer added by its address is reached over this computer's own SSH connection while Infinitary runs here, and its row says where that connection stands in its mono line, after its address: "a computer · sam@mini.local · connected using SSH" only once its work said hello through it, "connecting using SSH…" before that, "reconnecting using SSH…" while this computer tries again by itself after a connection it had before, "connecting using SSH…" for every try of a computer never seen, whether a first attempt failed or it dropped before its first hello, "starts the next time sam logs in there" while nobody is logged in there as that user, and "could not start" when that user's session holds no background work, which no login mends.
Its dot is `ok` only while connected, `idle` while connecting; its state reads "connecting" while the connection is being made for the first time, after an operation held it (an update, a change of address, finding it again), or after its work moved folders, or after its work stopped answering while SSH stays up, until an attempt fails or five minutes pass from when it began, whichever comes first, and "out of reach" in `--warn` otherwise, including while it reconnects after a real drop.
When only the captain can mend it, this computer stops trying: the mono line ends "out of reach since 14:02", the reason's two lines stand under the summary as one `--text-sm` line in `--warn` - "sam@mini.local does not answer as the computer this computer reached before.
If you did not set it up again, someone may be in between.
Check it, then try again.", or a refused or locked key, a key the app that holds it did not approve ("Could not sign in to sam@mini.local.
The app that holds your SSH key did not approve it.
This computer tries again when it wakes and every few minutes.
Approve it in that app when it asks."), a key whose app is not open ("Could not sign in to sam@mini.local.
The app that holds your SSH key is not open.
Open that app, and this computer tries again when it wakes and every few minutes."), Remote Login that will not let the connection through, Infinitary gone there, or a computer that left your first mate ("sam@mini.local runs work for another first mate now.
Remove Mac mini here.
Nothing changes there for the other first mate.").
A small secondary "Try again" stands first among its buttons, except on a computer that left your first mate, which offers only Remove.
A computer that left your first mate is never said to reach another computer, or to be back later, and it has no Try again and no Change address.
A ghost "Change address" stands on every other such row before Update and Remove.
It turns the row into one question in place: "Where to reach Mac mini" over "The address you use with SSH for it now.
This computer checks it is the same computer first.", a mono `Input` holding its address, a small primary "Change it" and a ghost "Cancel".
While this computer looks there the summary reads "Reaching sam@studio.local with your SSH key…", with no state and no buttons; a refusal's two lines stand at the top of the tab, and the feed says "This computer reaches Mac mini at sam@studio.local now." once it is found.
The feed says each change of the connection once, never each try: why it stopped, in two warning lines, and "Mac mini is connected using SSH again." once it is back.
A locked key, or one whose app did not answer, reads "Unlock it, and this computer tries again when it wakes and every few minutes." as its second line: this computer tries it quietly, the row keeps its stopped state and Try again while it does, and it comes back by itself once unlocked.
A key its app did not approve is tried quietly the same way, and comes back by itself once approved there.
A key whose app is not open is tried quietly the same way, and comes back by itself once that app is open.
Command search's "Try again to reach your computers" does Try again for every computer this computer stopped trying, and opens this tab.
There is no setting for SSH, no port and no dashboard of connections: the row is the whole surface.

**+ A computer** opens an aside under the foot: "How do you want to add it?" over "Each way adds the same kind of computer.
Pick the one that suits it.", with three small secondary Buttons and a ghost "Cancel":
- "Paste a link into Infinitary there": the link panel below, for a computer the person sits at (`JoinAnotherMac.prompt.md`).
- "Run a command there": the command panel below, for a computer with no screen.
- "By its address": "The other computer's address" over "The one you use with SSH.
  Remote Login must be on there.", a mono `Input` with the placeholder "you@mini.local", a small primary "Add it" and a ghost "Cancel" (`AddAMac.prompt.md`).
  On a Linux home, where the other computer is as likely Linux, the line under the label reads "The one you use with SSH.
  Its SSH server, or Remote Login on a Mac, must be on.", and the same in place of "Remote Login must be on there." on a row's own address question.
  Under them, the computers on this network with Remote Login on, under the micro label `ON THIS NETWORK`, each filling in the field when picked (`AddAMac.prompt.md`, "Nearby").
  While it works, its row stands at the end of the list: the address as its name until the computer says its own, the mono line "a computer · sam@mini.local", an `idle` dot, and the summary "Reaching sam@mini.local with your SSH key…", then "Preparing Infinitary for Mac mini…", "Sending Infinitary to Mac mini… 42.3 MB sent" with the count moving, and "Starting Infinitary on Mac mini…" (`AddAMac.prompt.md`, "By its address").
  After the password typed once (`AddAMac.prompt.md`, "The password, once"), the summary reads "Letting Infinitary's own key in on sam@mini.local…" until "Preparing Infinitary for Mac mini…".
  A refusal keeps the address in the field and shows its two lines in that aside, in `--warn`, with a small primary "Try again" and the ghost "Cancel".
  Try again runs the same add.
  Cancel closes the aside and changes nothing.
  Success still closes the aside.
  The field, Try again and Cancel are reached with Tab.
  A computer whose user runs another first mate's work asks once in an aside of the same shape, with a danger "Leave it and add" and a focused ghost "Cancel" (`AddAMac.prompt.md`, "Another first mate's Mac").

**+ Running as another user** opens the command panel for a user on this computer at once.

**The link and the command.**
A link or a command exists only after the captain's own click, here or on the first mate's card, and it lives in its panel alone: never in a card, a thread, a feed line, a task record or a crewmate's notes.
A command carries a link inside it, with the same rules: it works once, for ten minutes.
While one is open the panel stands at the top of the tab: `--bg-1`, a 1px `--accent` hairline, `--radius-m`.
In it a micro label, one `--text-sm --fg-2` line, the link or command on one line in a mono `--text-xs` box on `--bg-0`, cut with an ellipsis, and a small primary Button:
- a link: `NEW LINK`, "Your first mate stays on this computer.
  Your other computer will show it and can run work for it.
  Paste this link into Infinitary on your other computer, at its first launch.", and "Copy link".
- a command for another computer: `NEW COMMAND · ANOTHER COMPUTER`, "Run this once in Terminal on the other computer, as the user who should run its work.
  It gets Infinitary from this computer, so both need the same network.", and "Copy command".
- a command for another user: `NEW COMMAND · RUNNING AS ANOTHER USER`, "Log in as the user who should run the work, and run this once in Terminal.
  Switch back when it says it joined.", and "Copy command".

Under them the mono `--text-xs --fg-3` count "works once · 9:41 left" beside a small ghost "Stop it".
"Copy link" and "Copy command" read "Copied" for 1.5 s after success.
When a device uses it the hairline turns `--line-2` and the panel reads, with an `ok` dot, one of "iMac joined.
It can control your first mate and run its work.
Your first mate's tasks and conversation stay on this Mac.", "Mac mini joined.
It has git and Claude Code, and no sign-ins yet." or "Running as Builder is set up.
It runs work only, and has no sign-ins yet.", over "Give it a project in Projects when you want it to run work.", with a ghost "Done".
Once that computer has a sign-in, the panel goes; Done dismisses it before then.
A computer already on the list that used the command to find this computer again reads "Mac mini found this computer again.
It runs work as before.", with no line under it (`AddAMac.prompt.md`, "Finding this computer again").
When ten minutes pass unused it reads "The link expired before any computer used it."
(or "The command expired…") over "Make a new one when the other computer is ready.", with a secondary "Make a new one".
A restart of this computer forgets an open link or command, and the panel is simply gone.
There is no code to scan beside a link until the iPhone app exists (captain's pick on FI3-681); then the code stands at the panel's left, and the line adds "Or scan the code with Infinitary on your phone."

**Remove** works for every device but This computer, as one question in place, `RemoveProject`'s shape, with a ghost "Keep it" focused so Enter never removes:
- A computer that runs no work: "Remove MacBook Air?
  It is cut off at once." over "To come back, it needs a new link.", with a danger "Remove".
- A computer or a user that runs work: "Remove Mac mini?
  Its unmerged work comes here first." over "Its task on website stops.
  Infinitary then removes what it set up there, with its sign-ins." and "website and api run on this computer after.", with a danger "Remove".
  The row then reads "Bringing website's unmerged work here…", then "Removing what Infinitary set up on Mac mini…", and leaves the list.
- Out of reach: "Remove Mac mini?
  It is out of reach."
  ("It is connecting." while its connection is being made) over "Its unmerged work on website is still there.
  Wait, and it comes here before Mac mini is removed.", with a secondary "Remove when it is back" and a danger "Remove now".
  Waiting turns the mono line to "out of reach · removed when it is back" ("connecting · removed when it is back" for a computer whose connection is being made), with a ghost "Keep it" in place of Remove.
  "Remove now" leaves that work on the other computer, and Infinitary removes what it set up there when that computer is back.
- A computer that left your first mate: "Remove Mac mini?
  It runs work for another first mate now." over "Its unmerged work on website stays there.
  Nothing changes there for the other first mate.", with only a danger "Remove now": it is not coming back, so nothing waits for it.
  The feed then says "Mac mini had nothing of your first mate's to remove.", never that it removed something there.

Only the captain's own click in this computer's window removes a device; the first mate never does.

**Another version.**
A computer that runs work, connected on another version of Infinitary than this computer's, says so on a line of its own under its summary, `--text-sm --fg-2`: "Has Infinitary 0.1.20, older than this computer's." or "Has Infinitary 0.1.31, newer than this computer's."
One too old to say its version reads "Has an older Infinitary than this computer."
(or "a newer").
While it still takes work its dot stays `ok`, its mono line reads "seen just now", and its state is its tasks or "idle".
One that takes no new work adds "It takes no new work until it is updated." and the line turns `--warn`; its dot is `warn`, its state "no new work" in `--warn`, and its mono line still reads "seen just now", because it is in reach.
A small secondary "Update" stands before Remove on every such row.
The app also raises a card for it (`UpdateNudge.prompt.md`), so the row is not the only place it is said.
It brings the computer to this computer's version (`AddAMac.prompt.md`, "Updating any other computer"): over Remote Login for a computer added by its address, and over your network for any other.
A computer whose version of Infinitary is too old to update from here makes the command for it instead: the command panel for another computer, or for running as another user, which run there once finds this computer again on this computer's version.
Out of reach, a row says nothing of its version: this computer cannot tell it.
Connected on another version, a row is in reach, so it never shows the old-address line or its way back ("Bringing a computer back").

**Updating** starts with the summary "Updating Infinitary on Mac mini…", with no version line, no state and no Update or Remove until it is done (`AddAMac.prompt.md`).
For a Mac reached by its address, Add and Update first let it download this computer's published version itself.
Its summary and the feed read "Mac mini is downloading Infinitary… 200.6 MB of 401.1 MB", or "200.6 MB so far" when the release states no size.
The count changes in place at most once a second; it has no bar, percentage or time remaining.
If the download fails or its checksum does not match, the feed explains that this computer is sending its own copy instead, and the row and feed count "Sending Infinitary to Mac mini… 42.3 MB sent".
While this computer gets the fallback build, the row returns to preparing instead of keeping the failed download's count.
A development or unpublished version sends that counted copy without trying a download.
Two minutes without bytes moving stops a download or send; a slow transfer that keeps moving can finish.
The first empty observation stays silent until bytes or a known total arrive.
After checks and unpacking, the summary reads "Starting Infinitary on Mac mini…" only when the remote script is about to run the update.
A failed check or unpack keeps its definite failure; sending the last byte alone never means the app started.
Silent start work uses its existing backstop, not the transfer's two-minute deadline.
If the outcome is lost after starting, the warning says the computer may already have updated and to check Devices before starting another update.
Another user on this computer uses its local copy and makes no public download lookup.
A stop names inactivity, not a failure to reach the computer.
The row keeps its existing type, spacing, focus and disabled controls.
Remove on a computer that takes no new work asks as for one out of reach, with its own first line: "Remove Mac mini?
It takes no new work." over "Its unmerged work on website is still there.
Update it, and its work comes here before Mac mini is removed.", with a secondary "Remove once it is updated" and a danger "Remove now".
Waiting turns its mono line to "takes no new work · removed once it is updated".

**How other devices find this computer.**
A micro label `HOW OTHER DEVICES FIND THIS COMPUTER` over one box of rows, the same box as Your devices.
On this network, On your private network and Over the internet, each with a dot, one plain line and a mono state on the right.
A way this computer has reads a green dot, its address in mono, and ready, or "1 computer" in accent when a device reached it there.
A way it lacks reads idle, with what gives it, and off.
Over the internet always reads idle: "Never.
Infinitary does not open this computer to the internet.
A private network covers that."
With no network at all, one line says a link works only on this computer, and the copy buttons stay off.
A foot line says a link or command carries every way at once, so there is nothing to choose, and Copy a link and Copy a command stand under it.
One click makes one, copies it and opens the panel at the top reading Copied.
When this computer moves to another network, the rows follow within seconds, with the tab open, and a computer that still looks at an old address takes its line ("Bringing a computer back").
The app lists only this computer's own interfaces and never reads another program's settings.

**A Linux home's firewall.**
A Linux desktop may turn on a firewall that drops a computer dialing this one, and nothing would say why it never joins.
A Linux home looks at its own firewall, reading only what any user may read and never asking for a password, and when it may keep devices out the tab says so in one place, as one `--text-sm` line in `--warn` with the way to let them in under it in a mono `--text-xs` box on `--bg-0`, the panel's own box:
- ufw on, whose rules only an administrator may read: "The firewall on this computer may keep your other computers out.
  To let them in, run this once in a terminal:" over `sudo ufw allow 47623/tcp`.
- firewalld running, unless it answers that the port is open or its zone is Fedora Workstation's own, which lets every port from 1025 in: "The firewall on this computer may keep your other computers out.
  To let them in, run this once in a terminal:" over `sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload`.
- NixOS's own firewall on: "The firewall on this computer may keep your other computers out.
  To let them in, add this to your NixOS configuration and rebuild it:" over `networking.firewall.allowedTCPPorts = [ 47623 ];`.

It stands in the open link or command panel while one for another computer is open, under the panel's line, since that is when the person adds one; otherwise under the Address row.
A command for another user on this computer never takes it: that user dials this computer itself, which no firewall stops.
Once the firewall lets devices in, or is turned off, the line goes the next time the tab reads where devices find this computer.
A Mac never shows it: macOS asks its person before a firewall keeps Infinitary out.

**Asking the first mate.**
Each card's button is the captain's own click on the card's chrome; it opens this tab and acts on arrival, the way a sign-in action opens Projects and starts that sign-in.
- "connect my MacBook Air so it can control you" yields one decision from the first mate, "Connect your MacBook Air": "Your first mate stays on this computer.
  Your MacBook Air will show it and can run work for it.", "Make a link here, then paste it into Infinitary on your MacBook Air." and "It works once, for ten minutes.
  Only your click can make it, so I never see it.", with "Make a link" and "Not now".
- "add my mini by a command" yields "Add a computer by a command": "Make the command here, then run it once in Terminal on that computer." and "It works once, for ten minutes.
  Only your click can make it, so I never see it.", with "Make the command" and "Not now".
- "run work as another user on this computer" and "add my mini at sam@mini.local" are in `AddAMac.prompt.md`.
- "remove the mini" yields "Remove Mac mini?": "Its task on website stops, and its unmerged work comes here first." and "Then I remove what I set up there, with its sign-ins.
  Only your click can remove a computer.", with a danger default "Remove Mac mini" and a ghost "Keep it".
  The click opens this tab and removes it on arrival.

The link, the command and the removal stay out of every card: a card carries only the button.

**Feed lines** at this computer: "MacBook Air joined.
It can control your first mate and run its work.
Your first mate's tasks and conversation stay on this computer.", "Mac mini joined your devices.
It has git and Claude Code, and no sign-ins yet.", "Mac mini found this computer again.
It runs work as before.", "MacBook Air left.", "Removed MacBook Air." and "Removed Mac mini. website and api run on this computer now."
Never the words pair, grant, client, server, host, primary, machine, helper, runner, socket, port, key, pin, certificate or QR code (`copy/Vocabulary.prompt.md`); an address stays in mono where it is the thing itself.
