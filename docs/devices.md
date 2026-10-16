# Devices and pairing

## Who has it

Every build offers multi-machine support, stable, alpha and development alike.
Settings → Devices, the first mate's device cards, first-launch joining, a Mac controlling another, windowless work, a project's Runs on and a computer's own sign-ins are on in an installed build as they are in a checkout.
`tests/e2e/installed-devices.spec.ts` holds that an installed build offers them, and `src/core/core.test.ts`, "every build offers every device channel and card", holds the same for a packaged core.

How a device joins the home and how the home keeps the list of what joined: the link, the keys each side proves itself with, the saved list, Remove, and the threat each rule meets.
The connection that carries a paired device's requests and pushes is `docs/connection.md`; this page is pairing's.

## The shape

- **A device** is one of three kinds, set at the home and never by the device (`deviceKindSchema`, `src/shared/devices.ts`):
  - `mac`: another Mac, however it was added - a link pasted at its first launch, a command, or its address.
    It can control this first mate while Infinitary is open there (`docs/view.md`), and it can run work: there the app itself runs the work, started with no window (`docs/helper.md`).
  - `work`: runs work only - another macOS user on this Mac, which never controls, or another Mac added before a Mac could do both.
    Its work asks only the work requests about a conversation its home opened there, and is asked only its home's orders (`docs/helper.md`, "Holding a conversation").
  - `view`: only controls - a Mac that joined with a link before a Mac could do both, or a second app on this Mac (below, "Joining").
    A device keeps its kind until it is added again: a list saved before `mac` existed loads as it was, an old `view` keeps controlling and an old `work` keeps running work, and neither gains the other ability (`deviceControls`, `deviceRunsWork`).
    A Mac still runs nothing until a project is set to run on it (`docs/helper.md`, "Runs on").
- **What a device is** - the system it runs (`macos`, `linux`, `windows`, or `ios` for a phone) and its chip (`arm64` or `x64`, `deviceSystemSchema` and `deviceChipSchema`) - is the device's own word, said in every hello (`docs/connection.md`, "The handshake and the numbering") from the platform profile (`thisDeviceSystem`, `src/core/platform.ts`).
  The home keeps it beside the device's kind, never as a kind of its own, and Settings -> Devices and every other reader see it on the device as `system` and `chip`: a phone is a `view` whose system is `ios`.
  A device that has not said it since the home began keeping it has neither, and a device keeps what it said last until it says something new.
  The words a person reads name a device by it (`deviceNoun`, `src/shared/deviceNames.ts`): a phone is "a phone", and every computer - a Mac, a Linux computer, later a Windows one - is "a computer", as is a device that never said.
  The saved kinds keep their ids: `mac` names the kind that both controls and runs work, whatever system it runs.
- **`DevicePairing`** (`src/core/devices/pairing.ts`) is the one writer over `userData/devices/`.
  It is also the connection's pairing seam (`PairedDevices`, `docs/connection.md`): what is paired, who a connection request proves to be, and the home's own key.
- **The device's side** - checking the home's key, showing its own, using a link, dialing - is `src/core/devices/dial.ts`, written against the wire alone (`src/shared/connection.ts`, `src/shared/devices.ts`), so the app as a view and the helper share it.
- **`Computers`** (`src/core/devices/computers.ts`) is the list as Settings -> Devices shows it - pairing's list, with what the home reads of each computer that runs work right now - and Remove for a computer that runs work, which brings its unmerged work here first (below, "Remove").

## Keys

Each side has an ECDSA P-256 key and a self-signed certificate that carries it (`src/core/devices/identity.ts`), and each shows its certificate in the TLS 1.3 handshake: the home as the server, the device as the client.
A key's pin is SHA-256 over its SubjectPublicKeyInfo, base64url.

- **The home's key** is made with the first link, as `devices/home-key.pem` and `devices/home-cert.pem`, and kept for as long as the folder is.
  A device trusts the home because its key hashes to the pin the device holds; it reads no name or date in the certificate, which is only the envelope TLS carries the key in.
  Deleting the folder makes a new key, and every device must be paired again.
- **A device's key** is made by the device when it uses a link, and never leaves it.
  The home keeps only its pin.
  On every connection TLS has the device sign the handshake with that key, so what an eavesdropper or an impostor sees proves nothing on any other connection.

No session is resumed: the home issues no ticket it can resume and keeps no session, and the device offers none, so every connection shows both keys again.

## The link

```
infinitary://join?as=mac&at=192.168.1.20:47623&key=<pin>&code=<code>
```

A pasted link reads in either scheme: `infinitary://join?` (what a home builds) or `firstmate3000://join?`, which a computer from before the rename built, with the same parts.
Firstmate 3000's computers from before the bridge release read only the old scheme (`docs/infinitary-rename.md`).

| Part | What it is |
| --- | --- |
| `as` | The kind the home made the link for: `mac` for another Mac, by a link, a command or its address, and `work` for another user on this Mac, by its command. A device that cannot be that kind refuses the link before using it. The home makes no new link for a `view` (`inf:devices:invite` refuses one), and still reads one an older home made. |
| `at` | Where the device dials first, as `host:port`: an address, or a name the device resolves. An older Infinitary reads only this part. |
| `also` | The other addresses to try after `at`, comma-separated in one optional part. Absent when the link names one address. |
| `key` | The home's pin, 43 characters. |
| `code` | 32 random bytes, base64url, 43 characters. Good for one use, for ten minutes. |
| `via` | Only `ssh`, and only on a link for a computer that reaches this Mac through this Mac's own SSH connection (below, "Through the home's SSH"). Its `at` is then this Mac's loopback, where that connection delivers it, and the device never dials it. |

The home keeps only the code's SHA-256, its kind, when it expires and a handle for it, in memory.
Using it once spends it, ten minutes after it was made it expires, Stop it closes it sooner (`inf:devices:stop`, by the handle the invite answered), and a home restart forgets every open link.
A device that uses a closed link is refused as `unknown`.

`inf:devices:invite` answers the link to this Mac's own window and to nothing else.
Its catalog action is the captain's own (`device-invite`, tier `hands`): the first mate can only offer the card whose button makes one there ("Asking the first mate", below), and `app_change` reads back only the list after a change.
No log line, feed line, record entry, card or error carries a link or a code.

Nothing on either Mac answers the `infinitary:` or `firstmate3000:` scheme.
A link is pasted by its person, and a device joins only after that person confirms the kind and the address it names: the app on another Mac at its first launch (`docs/view.md`, "Joining"), and a computer that runs work in Terminal, by the command that carries its link, with a typed yes (below, "Joining by a command"; `docs/helper.md`, "Joining").
A device never joins because a page or a document opened a link.

## Joining

1. The device reads the link with `parsePairingLink` and refuses one it cannot read or whose `as` it cannot be: Infinitary at its first launch takes a link for a Mac (or an older home's `view`), and the work mode a link for a Mac or for another user.
2. It makes its own key, opens TLS 1.3 to each address in turn, `at` then each of `also`, and sends no request until the home's public key hashes to `key`.
   It keeps the address that answered.
   A link with `via` is dialed only through the private socket this Mac's SSH connection forwards there, never at `at` (`docs/connection.md`, "Where a device dials").
   A mismatch closes the socket.
   Inside the handshake the device has shown only its certificate and a signature bound to that handshake.
3. On that socket it sends `POST /pair` with `{ "code", "kind", "name" }`, its `kind` the link's.
   A device that may run work adds `"user": { "name", "uid" }`, the macOS user it runs as; the work mode adds `"found": { "git", "claudeCode" }`, what it has there (`docs/helper.md`, "Joining"); and Infinitary at its first launch adds `"window": true`.
   `name` is the device's own label, such as its computer name.
   The home pairs it as the link's kind, but for a link for a Mac used from this Mac itself (`joinedKind`): Infinitary at a second app's first launch joins as a `view`, and the work mode as another user here as `work`, refused as `same-user` when it runs as the home's own user.
   A phone adds `"system": "ios"` and no `user`: it joins as a `view` whichever link it used, a link for a Mac or an older home's `view`, so it is never a computer a project can run on and Settings -> Devices' "Runs on" never lists it.
   A link made for another user here is not for a phone (409 `kind`).
   The home keeps the system when the device joins, before its first hello says it again.
   The grant answers the kind it was paired as.
4. The home answers:

| Answer | When |
| --- | --- |
| 201 `{ "deviceId", "kind" }` | The code is open, its kind matches (a phone is paired as a `view` whichever link it used), and the device showed a key not yet on the list. The link is spent before the answer is written, and the device is on the list with its key's pin. |
| 400 `malformed` | The body is not the shape above, or a computer that runs work sent no user. An older home also answers it to a phone's `system`. |
| 401 `unknown` | No open link has that code |
| 401 `unproven` | The device showed no key of its own |
| 409 `kind` | The link was made for another kind, or Infinitary at its first launch, or a phone, used a link for another user |
| 201 `{ "deviceId", "kind" }`, with `again` | A device finding its home again showed a key on the list (below, "Finding the home again"). The link is spent and the entry stays as it was, kind and all: a computer that runs work finds its home with any link that adds one, and a phone, a view, with a link for a Mac. |
| 409 `paired` | That key is on the list already, and the device did not ask `again`. One entry per key keeps Remove whole. |
| 409 `same-user` | A computer that runs work dialed from this Mac as the macOS user the home runs as (`docs/helper.md`, "The home's side") |
| 410 `used` | The link was used already |
| 410 `expired` | The link is older than ten minutes |
| 410 `removed` | A device finding its home again showed a key the list no longer holds: the home removed it while it was out of reach |

Only a link used well is spent.
Every refusal is `{ "refused", "reason" }`, and none echoes the code.
`/pair` also refuses a request with an `Origin` (403), another method (405), a body that is not `application/json` (415) or one over 4 KiB (413).
Answers carry `Cache-Control: no-store`.

5. The device keeps its grant, `{ at, homeKey, deviceId, kind, key, cert }` and the link's `via` when it had one (`deviceGrantSchema`), private to itself (0600 in its own data folder).
6. The home says it once in the feed (`device_joined`, `deviceJoinedLine`), by the device's own name: "MacBook Air joined.
   It can control your first mate and run its work." for a Mac that joined at its first launch, "Mac mini joined your devices.
   It has git and Claude Code, and no sign-ins yet." for one a command or its address set up, "Running as Builder is set up.
   It runs work only, and has no sign-ins yet." for another user on this Mac, and "MacBook Air joined.
   It can control your first mate." for a second app here.
7. A device that may run work then gets its setup card (below, "Finishing its setup"); one that only controls needs nothing more, and a computer that found this Mac again runs work as before.

## Finishing its setup

A computer that runs work does nothing until it has sign-ins of its own and a project set to run on it, and the join alone said so only once in the feed (the captain's FI3-1350: "nothing told me to do github sign in and AI subscription sign in for that machine").
So the moment one joins, the host files one card, "Finish setting up Mac mini" or "Finish setting up Running as Builder" (`DeviceSetup`, `src/core/devices/deviceSetup.ts`; its words `src/shared/deviceSetup.ts`; design skill `components/devices/FinishSetup`), built from typed facts alone and never from the first mate's judgment:

- **What it reads.**
  What the join found there (`found`: git and Claude Code), what the computer last said of its own sign-ins (`DeviceSignIns.lastSaid`), and the projects whose Runs on names it.
  A computer whose card is still asking is asked its sign-ins the moment it comes into reach, so the card reads what it has rather than what the join assumed.
- **Its rows.**
  "A subscription of its own", done once the computer reports any account there, whatever its allowance read (the captain's pick: a Claude login whose allowance macOS there will not let Infinitary read still counts); "Its own GitHub sign-in, to clone and push", done once it reports a sign-in for GitHub, whatever its health; and last, "A project that runs there", worded as optional - a computer with no project runs nothing, and that is fine - done once a project's Runs on names it.
  Each row carries its id and whether it is done (`data-setup-row`, `data-done`), so a reader takes the fact, never the words.
- **Its buttons.**
  One per row still open, in the card's own footer, which only the captain's click runs: "Add a subscription" opens Settings -> Intelligence, "Sign in to GitHub on Mac mini" opens Settings -> Projects with that computer's GitHub sign-in started under its row (`forgeSignInOn` on the open effect, `src/shared/cards.ts`), and "Choose a project" opens Settings -> Projects; the first open row's button is the default.
  "Not now" takes the card down for good: the card's own resolution remembers it (`CardStore.chosenAction`), across restarts, until the computer is removed and added again.
- **How it moves.**
  Every button resolves the card, as every card's does.
  The host raises it again under the same id when a row moves - the computer reports a sign-in, a project is set to run there - and never when the computer merely says the same again, so a row the captain is already on does not come back on an allowance read.
  Once every row is done it comes down by itself, and the feed says once "Mac mini is set up.
  It runs website with its own sign-ins."
  A computer taken off the list takes its card with it.
  A computer that joined before this Mac started and never had the card gets none: for one set up later, or signed out again, the backstop below speaks.
- **The backstop** (`docs/helper.md`, "Runs on"; `docs/forge.md`, "A computer's own sign-in").
  A task about to start on a computer with no sign-in at all waits as queued work, the feed says "Mac mini has no sign-ins yet. website's next task waits until it has one.", and it starts by itself the moment that computer reports one.
  A project that lives on GitHub set to run on a computer with no GitHub sign-in of its own raises the host's GitHub card for that computer, "Sign in to GitHub on Mac mini", unless the setup card is on the stack and already asks in its own row; a clone that computer's GitHub refuses crosses the connection typed, so the task waits behind that sign-in's gate and starts by itself once the computer reports it.

## Joining by a command

A computer that runs work joins by one command, run once in Terminal as the macOS user who should run the work (design skill `components/devices/AddAMac`).
The command carries a link inside it, with the link's rules: it works once, for ten minutes, it exists only after the captain's own click, and it lives in Settings -> Devices' panel alone.
`inf:devices:invite` with `command` (`another-mac` or `another-user`) answers the link and the command (`joinCommand`, `src/core/devices/joinCommand.ts`): the command for another Mac carries a link for kind `mac`, and the one for another user a link for kind `work`.
A Mac joined by its command can open Infinitary there any time to control this one, with no new link (`docs/view.md`, "A Mac that runs work"), and its Terminal says so.
A Linux computer joins a Mac or a Linux home by a link pasted into its own Infinitary at its first launch (`docs/view.md`, "Joining"), and a Mac joins a Linux home the same way: each runs its own system's Infinitary, and its work runs in that system's background (`docs/helper.md`, "In the background").
The command for another computer runs on a Mac or on a Linux computer with an x64 chip, and gets Infinitary for that computer's system (below, "Infinitary for another system").
A home with no Infinitary to send for any system - a development run, or an installed one that is no release - refuses to make it at once: "This copy of Infinitary cannot send itself to another computer; only an installed one can.", or on a Linux home "This copy of Infinitary cannot send itself to another computer: the command adds a Mac." and "Paste a link into Infinitary on the other computer instead."

- **Running as another user on this Mac**: this Mac's own app started in its work mode with the link, `'<app>' work join '<link>'` (in a development run, Electron and the checkout's folder before `work`).
  The app asks its yes and joins (`docs/helper.md`, "Joining").
  On a Linux home it is that computer's own Linux app, started as it starts again past its next update (`appLauncher`, `docs/helper.md` "In the background"), and the other user's work draws on a display of its own (`docs/helper.md`, "No screen needed").
  Its link names `127.0.0.1`, which that user reaches from this Mac itself whatever network this Mac is on, so a new address never strands its work (below, "Finding the home again").
- **Another computer**: one line, `/bin/sh -c '<script>' firstmate '<link>' '<this Mac's name>' '<address>' ...`.
  The script is the same every time and names no value; every value is its own quoted word after it, so nothing a name holds can change what runs.
  On a system Infinitary does not run on (`uname -s` and `uname -m`: anything but a Mac, or Linux on x64) it stops before anything else: "Infinitary does not run on this computer's system.", "It runs on Macs, and on Linux computers with an x64 chip." and "Nothing changed on this computer."
  On Linux it stops there too where that user cannot make a user namespace, as Ubuntu 24.04 and later keep an app with no profile of its own from doing, asked with the AppImage launcher's own probe (`SANDBOX_PROBE`, `unshare -Ur true`): the AppImage it gets would start with Chromium's sandbox off each time its work starts, with nobody there to ask (`docs/linux-packages.md`, "The sandbox").
  It says "Infinitary would run on this computer without its sandbox: its system keeps apps from making one.", "Install the Infinitary package for this system, then paste a link from MacBook Pro at its first launch instead." and "Nothing changed on this computer.", as adding that computer by its address refuses `sandbox-off` (below, "Adding, step by step"); the command has no Ubuntu package way, so Ubuntu 24.04 and 26.04 stop too.
  It checks this Mac's key with the system's own curl (a Mac's `/usr/bin/curl`, Linux's on its search path, `--pinnedpubkey`), saying "Could not reach MacBook Pro at 192.168.1.20." or "Something answered at 192.168.1.20, but not the computer that made this command." before anything else, then asks its yes; a Linux computer with no curl says "This command needs curl to get Infinitary from MacBook Pro." and "Install curl, then run it again."
  Only after a yes does it get Infinitary from this Mac with the link's code, naming its own system and chip ("Getting Infinitary from MacBook Pro… done."), unpack it in a temporary folder - a Mac the home's gzipped tar, or a published zip with its own ditto; Linux keeps the AppImage as it came, in its own cache folder rather than a shared `/tmp` - and start that copy as `work join --fetched <app> <link>`, which joins without asking again and keeps the copy (`docs/helper.md`, "Joining").
  The temporary folder is deleted whatever the join answered.
  A used, expired or stopped command says so ("That command was used already.
  Make a new one on MacBook Pro.") and gets nothing.
  Both computers then run the same version, and need only the same network.

### Getting Infinitary from this Mac

`POST /firstmate` (`FETCH_APP_PATH`) on the connection's listener answers this app as one gzipped tar of its bundle, made as it is sent (`/usr/bin/tar`, at utility QoS).
The body is `{ "code" }`: pairing answers whether that code is an open link for a device that may run work (`DevicePairing.opened`), and reading it never spends it, so only `/pair` joins.
From protocol 5.1 (`FETCH_APP_SYSTEM_SINCE`) the body may also name the asking computer's `system` and `chip`, and the home answers Infinitary for them (below, "Infinitary for another system"), by its `Content-Type` (`FETCH_APP_TYPES`): a Mac's bundle as before (`application/gzip`), a Mac's published zip from a home that is not a Mac (`application/zip`), or a Linux AppImage itself (`application/octet-stream`).
A computer that names no system is a Mac asking as Macs always have, and gets this home's own bundle or `none`; a computer names its system only to a home whose welcome says 5.1 or later, since an older home refuses the field as `malformed`.
A refusal is `/pair`'s, with the same statuses - `malformed` 400, `unknown` 401, `kind` 409, `used` and `expired` 410 - or `none` 404 from a home that cannot send itself; none echoes the code.
Like `/pair`, it refuses an `Origin` (403), another method (405), another body type (415) and a body over 4 KiB (413).
The bundle is the installed app this runs from (`appBundleOf`): a Mac's `.app`, or the AppImage an installed Linux app runs from; a development run has none, so its command for another computer is refused at once ("This copy of Infinitary cannot send itself to another computer"), unless `INFINITARY_APP_BUNDLE` names one, a `.app` or an `.AppImage`, as a test's stand-in does.

## Adding a computer by its address

The captain may add a Mac, or a Linux computer with an x64 chip, by the address he reaches it at with SSH, such as `sam@mini.local` (design skill `components/devices/AddAMac`, "By its address").
A Mac home or a Linux home then sets it up over SSH - a Mac's Remote Login, a Linux computer's SSH server - with the captain's own SSH key, and nothing needs to be open on it.
The look there asks the other computer's system first, and that system's adapter sets it up (`FarSystem`, `src/core/devices/farSystems.ts`): a Mac exactly as before, and a Linux computer the same steps in its own folders.
Its work may be in either spelling's data folder of the Infinitary rename, so the look reads the grant, and the removal and the controller start the copy kept there, from the first folder that holds one, Infinitary's first, and never from a folder that moved (`farFolderArgs`; `docs/helper.md`, "Under the other name").
When that computer does not let the captain's key in, Infinitary asks once for that user's password, uses it only to let its own key in there, and keeps none of it (below, "The password, once").
An Ubuntu 24.04 or 26.04 computer is set up from Infinitary's Ubuntu package instead of the AppImage (below, "The Ubuntu package").
It is the captain's own click: Settings -> Devices' "By its address", or Add it on the first mate's card (below, "Asking the first mate"), which asks `inf:devices:add` with the address (`RemoteLogin`, `src/core/devices/remoteLogin.ts`).
The address is the one thing the captain supplies: one address, never an option, with no space and never a leading dash (`remoteLoginAddressSchema`, `src/shared/remoteLogin.ts`).
An alias from his own SSH settings works, because his own SSH resolves it.

### Macs nearby

While "By its address" is open, Settings -> Devices lists the Macs on this network with Remote Login on, under the field (`NearbyMacs`, `src/core/devices/nearby.ts`; `inf:devices:nearby`).
Remote Login announces itself over Bonjour as `_ssh._tcp`, and this Mac only listens for that, with macOS's own `/usr/bin/dns-sd`: it never tries the addresses around it, and what it lists is what answered.
A Linux home listens for the same with Avahi's `avahi-browse --parsable --resolve` from its search path (`src/core/devices/avahi.ts`), which hears each computer's name on this network with its announcement, so none is asked again; it is stopped after a dns-sd browse's time and another starts, and one that ends by itself, as when Avahi's daemon is not running, says it could not look.
It hears every Mac with Remote Login on, and a Linux computer whose SSH server Avahi announces, which many do not by default (Ubuntu ships the announcement as an example, `/usr/share/doc/avahi-daemon/examples/ssh.service`); typing its address always works.
A Linux home with no `avahi-browse` lists nothing, as before.
While nothing answered, a Linux home's list reads "Looking for computers on this network that announce SSH…".
Each Mac that announces it is asked once for its name on this network (`dns-sd -L`), four at a time, and is listed by the name it announces, drawn as text, with the address it fills in: the user Infinitary runs as here, at that name, such as `sam@Sams-Mac-mini.local`.
This Mac answers too, and is left out by its own names on the network (`ownNetworkNames`, `src/core/devices/computerName.ts`); nothing is listed until those are read.
A Mac already on Your devices is marked "on your list": one added at that name, or one not on this Mac that joined under the same name (`nearbyOnList`, `src/shared/nearbyMacs.ts`).
Picking one fills the field with the user name selected, to change before Add it, which then runs as for a typed address.
Typing an address still works, including a private network's name, such as Tailscale's.

The list is looked for only while the aside is open: the window asks `inf:devices:nearby` with `true` when it opens and every twenty seconds after, and with `false` when it closes, and the look stops by itself a minute after the last ask.
Every run of dns-sd also ends by itself (`-t`): a browse after 75 seconds, when another starts if the list is still looked for, and a name lookup after five, when that Mac is left off.
A Mac the last browse announced stays two seconds for the next one to announce it again, so the list does not blink.
So an Infinitary that stopped without a word leaves nothing listening for long.
A development run may stand in its own program with `INFINITARY_DNS_SD`; a packaged app ignores it, and every end-to-end launch sets one that finds nothing, so a test never listens on the Mac's own network.

### Announcing to a phone

While a phone (a device whose system is `ios`) is on Your devices, this Mac announces itself over Bonjour as `_infinitary._tcp` in the local domain, under its own name in System Settings, at the port the connection listens on (`MacAnnouncement`, `src/core/devices/announce.ts`).
The phone browses for that to find this Mac again after its address moved, and then dials it and checks the key it was paired with (above, "Joining"), so the announcement carries no key and no secret.
It runs macOS's own `dns-sd -R` (or a development run's `INFINITARY_DNS_SD` stand-in), which has no end of its own, so a shell holds it with the app's pipe (`runDnsSdHeld`, `src/core/devices/dnsSd.ts`): dns-sd is killed once the pipe closes, when the announcement stops or the app is gone however it went, so a quit or a crash leaves no announcement.
It starts when the list gains a phone, and stops once the last phone is removed or the app quits, for good: a change on the list during quit starts nothing.
One that ends by itself, as when mDNSResponder restarts, starts again while a phone is listed, five seconds later and doubling up to a minute.
A Mac with no phone on its list announces nothing.
A computer with no dns-sd, as a Linux home, announces nothing yet.

Bonjour browsing is a local network operation (Apple's TN3179).
When macOS does not let the app use the local network, dns-sd says so with Bonjour's policy-denied answer (-65570), and the list says "macOS has not let Infinitary look for computers on this network." and "Allow it in System Settings, under Privacy & Security, Local Network.
You can still type an address."; a Mac that answers once it is allowed is listed.
The list says so only on that answer, never on a guess: while no Mac answered it reads "Looking for computers on this network with Remote Login on…", and when dns-sd stopped some other way, "Could not look for computers on this network.
You can still type an address."
The app's `NSLocalNetworkUsageDescription` is the sentence macOS shows if it asks (`electron-builder.yml`): "Infinitary lists the computers on your network that have Remote Login on, so you can add one, and reaches the computers you added."
Listing asks for no entitlement and no `NSBonjourServices` list, which macOS does not require for it.

### The captain's own SSH

Every step runs the system's own ssh - a Mac's `/usr/bin/ssh`, Linux's from its search path, since NixOS keeps none in `/usr/bin` (`systemSshTool`; so do `ssh-keyscan` and `ssh-keygen`) - with the app's environment (`hostEnv`), so the captain's own agent answers, in batch mode, so it never asks anything (`runSsh`, `src/core/devices/ssh.ts`).
The app reads no SSH settings and no keys: SSH reads the person's own, so an alias still resolves.
What the app adds only narrows what SSH does: no terminal, no agent or display forwarding, no port forwarding a setting asks for, no local command, and no shared connection left behind.
It never loosens how SSH checks that the other Mac is the one it reached before.
It stores no password, and every SSH sign-in but one types none: the one that lets Infinitary's own key in (below, "The password, once").
An Ubuntu package install types that account's password to the installer on an already signed-in session, never to SSH, and keeps none of it (below, "The Ubuntu package").

### Your yes on the check line

The first reach of an address reads the check line and sends nothing until the captain says this is the Mac (`readHostKey`, `src/core/devices/hostKey.ts`).
The aside asks "Is this sam@mini.local?" and "Compare this line with the one that computer shows.", with the line, "This is the computer" and "Cancel".
Cancel keeps the address and sends nothing.
The yes is remembered in `devices/host-trust.json`, 0600, and in a known-hosts file beside it that only Infinitary's own SSH reads (`DevicePairing`, `src/core/devices/pairing.ts`).
The captain's SSH settings are not written, and a yes is never taken on first sight.
A later add of that address does not ask again.
A Mac that answers unlike the remembered key is refused as `host-changed` before a sign-in or a copy, and nothing is sent.
`ssh` for a remembered address sets `UserKnownHostsFile` to Infinitary's file, `GlobalKnownHostsFile` to `/dev/null`, `KnownHostsCommand` to none, `VerifyHostKeyDNS` to no, `StrictHostKeyChecking` to yes and `UpdateHostKeys` to no, so a changed key is also refused by SSH itself before it signs in (`hostTrustSshOptions`, `src/core/devices/hostTrust.ts`).
SSH splits an option's value at spaces, and Infinitary's folder is under Application Support, so the file's path is quoted to stay one file (`sshPathWord`).
A development run may stand in its own program with `INFINITARY_SSH`; a packaged app ignores it.

### The password, once

A Mac that lets the captain's key in never asks for a password.
When the look is refused with `key-refused`, SSH's own `-v` note says which ways that Mac lets a user in (`passwordMethods`, `src/core/devices/sshPassword.ts`).
A Mac that takes no password is refused as `password-off`, and nothing is asked.
Otherwise `inf:devices:add` answers the password question (`{ asks: "password", address, user }`, `remoteLoginAddAnswerSchema`), and nothing else happens there.
Settings -> Devices shows it in the aside: "sam@mini.local did not let your SSH key in." and "Infinitary can let its own key in with that user's password.
It uses the password once and keeps none of it.", a password field named "sam's password on that computer", a primary "Add it" and a ghost "Cancel".
Cancel keeps the address and sends nothing.

Add it asks `inf:devices:add` again with `{ password }`, on that one call.
The look runs again with the captain's key, so a Mac that lets it in by then never gets the password.
Then the feed says "Letting Infinitary's own key in on sam@mini.local." and one SSH run types the password (`placeOwnKey`):

1. It runs only with the remembered check line (`hostTrustSshOptions`): with none, it is `host-unknown` and nothing starts.
   SSH checks the host key before it signs in, so a Mac that answers unlike the remembered one never sees the password.
2. It asks nothing but the password, once: `BatchMode=no`, `PubkeyAuthentication=no`, `IdentityAgent=none`, one method (`password`, else `keyboard-interactive`), `NumberOfPasswordPrompts=1`, its own connection (`ControlPath=none`) and no proxy.
3. The password is never an argument, in the environment or in a file.
   SSH asks for it through a small askpass script in a fresh 0700 folder (`SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`), which prints a word only this run knows on SSH's notes and reads one line from SSH's input, which it shares.
   Infinitary writes the password there once, only on that word and only before SSH says it signed in, then ends that input and zeroes its copy.
   The folder is deleted whatever happens.
4. The remote command adds Infinitary's public key line to that user's `~/.ssh/authorized_keys` once, with the folder and the file only that user may change, on a system Infinitary is set up on over SSH only: a Mac or Linux (`other-system` otherwise).

The key's comment is `infinitary` on a key this app makes, and a key whose comment reads `firstmate-3000`, made before the rename, is read as this app's too.

A password that Mac did not take is said in the feed with two `warn` lines, and `inf:devices:add` answers the question again with `wrong`, which the aside shows above an empty field.
A Mac that never asked for one is `password-off`.
Once the key is in, the look runs again with it and the add goes on as above, with no password.
A key placed that the Mac still does not let in is `key-not-taken`.

Infinitary's own key is made with `/usr/bin/ssh-keygen` the first time it is needed: ed25519, no passphrase, named `infinitary`, in `devices/ssh-key/`, a 0700 folder that appears whole or not at all, with both halves 0600 (`makeOwnKey`, `src/core/devices/ownKey.ts`).
The addresses where it is let in are kept in `devices/ssh-key-placed.json`, 0600 (`DevicePairing.ownKeyPlacedAt`).
Every later `ssh` to such an address, the setup's, an update's, a removal's and this Mac's own connection, offers that key first with `-i`, only the keys named (`IdentitiesOnly=yes`) and none added to an agent (`DevicePairing.sshOptions`), so the captain's other keys and agent are not needed there.
The password is held only as the one request's argument in memory, and as bytes zeroed once written or once the run ends: it is in no feed line, log, saved file, task record or command's arguments.

The same aside asks again when an Ubuntu package needs that account's password to install or update (below, "The Ubuntu package").
The words then say Infinitary will install itself, or update itself, and the password is written only to `sudo -S` on that computer, never as an argument.
A password already typed on this add, to let the key in, is the one used for the install, so it is not asked twice.

### The Ubuntu package

Ubuntu 24.04 and 26.04 added by address run from Infinitary's Ubuntu package, not the AppImage.
The owner turns on that computer's SSH server, then types the address and, when the package is missing or another version, that account's password once.
The look also reads whether the account may install software (`sudo -n true`) and the installed `infinitary` version.
An account that may not is refused as `cannot-install`, unless the package already matches this computer's version, in which case no password is asked.
This computer gets the deb for its own version from the tap, checks it, and sends it.
The other computer checks it again and installs it with `apt-get`, which brings git, Xvfb and the libraries, and the package's install script loads the AppArmor profile, so Ubuntu's limit and the sandbox both stay on.
The same step turns on linger for that account.
The work then joins from `/opt/infinitary/infinitary`, and no AppImage is kept there.
Update asks for the password again and installs the new package the same way.
Removing the computer leaves the package installed.
Any other Linux system keeps the AppImage way above.
Only a home that reads the tap installs the package; one that reads none (below, "Infinitary for another system"), such as a development run or the journeys on a Linux runner, sets up Ubuntu 24.04 and 26.04 the AppImage way too.

### Adding, step by step

1. "Reaching sam@mini.local with your SSH key.": one look at the other computer, which writes nothing there - its system and chip (`uname -s`, `uname -m`), the user it runs as, its own name, whether it is this Mac itself (below, "Where a computer joins from"), and whether that user already runs work for a first mate.
   A system with no adapter, or a chip Infinitary is not published for there, is refused as `other-system`; a Linux computer that lacks what its work needs - git, Xvfb for the display its hidden windows draw on (`docs/helper.md`, "No screen needed"), FUSE 2's `fusermount` and library, which open the AppImage, or a library the AppImage needs to start (`docs/linux-packages.md`, "What the AppImage needs") - is refused as `needs-tools`, before anything is sent.
   The refusal names the package for each it lacks, by the program that installs software there (`apt`, with Debian's 64-bit time names where apt knows them, `dnf`, `pacman` or `zypper`; `LINUX_NEEDS`, `src/shared/remoteLogin.ts`), or by its plain name where the look found none of them.
   A Linux computer where that user cannot make a user namespace - Ubuntu 24.04 and later keep an app with no profile of its own from making one - is refused as `sandbox-off`, unless it is Ubuntu 24.04 or 26.04, which gets the package instead (above, "The Ubuntu package").
   The AppImage's own launcher would turn Chromium's sandbox off there, and its work's web pages and cards run in that sandbox or not at all (`docs/linux-packages.md`, "The sandbox").
   The look asks with the launcher's own probe (`unshare -Ur true`); on any other such system the Infinitary package keeps the sandbox on, so that computer joins by a link pasted at its first launch instead.
   A Linux computer keeps its work in `${XDG_CONFIG_HOME:-~/.config}/<folder>/work`, as Electron keeps a Linux user's data, and names itself by its pretty host name, or else `uname -n`.
   A Mac that did not let the captain's key in asks for that user's password first (above, "The password, once"), and the look runs again with Infinitary's own key.
   When it does, the look also reads which one, by the pin of that first mate's key, and the id it gave that user, both public, from the grant the work mode keeps there (`JoinedHome`).
   A user that runs this first mate's work as a computer on the list is found again instead (below, "Finding the home again"); one this Mac removed is set up anew; another first mate's is asked about first (below, "Another first mate's Mac"), and one whose grant names no key is refused.
2. "Preparing Infinitary for Mac mini.": Infinitary for that computer's system, got and checked first when it is not this app's own (below, "Infinitary for another system"); then a one-use link for a computer that reaches this Mac only through this Mac's own SSH connection, kept with the address and where the look found that Mac is (`invite`, `{ remoteLogin, via: "ssh", locality }`).
   This Mac opens one SSH connection of its own for the setup (`SshMaster`, below, "Through the home's SSH"), whose own session runs that system's fixed bootstrap there: it makes a fresh folder only that user may enter under `/tmp`, for the join's private socket, and a temporary folder for the copy - on Linux in that user's own cache folder, since a shared `/tmp` may forbid running it - and says where both are.
   This Mac forwards that socket to its own loopback listener over the connection's control socket, then sends the copy in a session of its own, with its own end, saying how much it sent so far (below, "How far the copy has gone"): a Mac home's own Infinitary as one gzipped tar (`packApp`, `src/core/devices/appArchive.ts`, the same archive `/firstmate` sends), or a file - a Mac's published zip, unpacked there with ditto, or a Linux AppImage - which that computer checks against its SHA-256 before it keeps it, refusing a copy that did not arrive whole.
   Once all of it arrived there, "Starting Infinitary on Mac mini.", and only then does the bootstrap get one typed line (`sshJoinSchema`, `src/shared/sshConnection.ts`), the link and the socket, and start the copy as `work join --fetched <app> --from-home` with that line on its input - never in its arguments, where that Mac's other users could read it.
   The join dials this Mac through that socket alone, joins, keeps the copy and sets itself to run in the background (`docs/helper.md`, "Started by the home").
   Both folders are deleted whatever happens, the setup's connection ends with the join, and a link nobody used is closed at once.
3. The joined line, as for any device, and, when nobody is logged in there as that user, "Mac mini starts running work the next time sam logs in there.".
   When that user's session there refused to start it in the background, no login mends it, so the joined line is followed instead by two warning lines: "Mac mini could not set itself to start in the background, so it runs no work for now." and "Ask again to add it.": asking again finds the same computer and tries once more.

`inf:devices:add` answers the device once it joined, or the question for another first mate's Mac (below); each step is a `device_setup` feed line, and the row in Settings -> Devices follows them.
From then on this Mac keeps its own SSH connection to it (below, "Through the home's SSH").

### How far the copy has gone

The copy is made as it is sent, so nothing knows its size before its end: the row and the feed say the bytes sent so far, never a share of a total (captain's approval of FI3-1361, piece 5).
`device_setup` carries it as `copy`: `preparing` on the setup's first line, `sending` with `sent`, the bytes handed to that Mac's input so far, and `starting` once all of it arrived.
This Mac counts each piece of the archive as it hands it to that Mac's SSH session (`copyCount`, `src/core/devices/appArchive.ts`), so the count runs ahead of what arrived by no more than what SSH holds in flight.
The count is said at its first bytes, then at most once a second while it moves, and once more at its end with all it sent: "Sending Infinitary to Mac mini: 42.3 MB sent.", in the size words a file's chip uses (`fileSizeWords`).
Each count is one run of feed lines (`feedRunSchema`, `src/shared/events.ts`): it rewrites the line before it in place while that line is still Activity's newest, the same way the captain's settled runs do (`docs/orchestrator-contract.md`, "Settled runs"), and a count after any other line starts a line of its own.
A copy that stops is refused as before, with its last count left in the feed above the two lines.
Updating Infinitary there sends the same copy and says no count.

### Infinitary for another system

A computer gets this app's own copy when it runs the same system and chip: a Mac home sends its universal bundle to any Mac, as it always has, and a Linux home that runs from an AppImage sends that file to Linux on its own chip (`FarBuilds`, `src/core/devices/farBuilds.ts`).
Any other computer gets the copy of Infinitary published for its system at this computer's own version, from that version's release on the public tap (`PublishedBuilds`, `src/core/devices/publishedBuilds.ts`; `docs/alpha.md`, "Builds by system and chip"): a Mac the universal zip, Linux on x64 the AppImage, and Ubuntu 24.04 and 26.04 the deb (above, "The Ubuntu package").
Its SHA-256 is the one the tap's builds file names for this version, written after the release fetched every file back; a version the file no longer names, once a newer one is published, is checked against the `.sha256` its release publishes beside the file.
The feed says "Getting Infinitary for Studio's system from its published release, and checking it." while it is got, and the row still reads "Preparing Infinitary for Studio…".
Bytes that do not match are refused as `build-unverified` and kept nowhere; a tap that cannot be reached, or a version with no such build, is `no-build`.
Matching bytes are kept in `devices/builds/<version>/<system>-<chip>/`, checked again against the published checksum each time they are sent, used as they are when the tap cannot be reached, and deleted once another version's are kept.
The other computer checks the copy against the same SHA-256 when it arrives (`sha256sum`, or a Mac's `shasum`), so a copy cut short is never kept.
The same build answers a computer that names its system where it gets Infinitary (above, "Getting Infinitary from this Mac"): the command run on a Linux computer, and a computer updated over the connection, which this computer gets and checks before it asks the update order, so its copy starts at once.

Only an installed release reads the tap.
A development run, or an installed build that is no release, reads none, so it adds a computer of another system only by a link pasted at that computer's first launch (`docs/view.md`, "Joining"); a test stands in its own tap with `INFINITARY_PUBLISHED_TAP`, a folder laid out as the tap's releases (`standInTapFetch`), which a packaged app never reads.

### Another first mate's Mac

A user there that runs another first mate's work may run it for one that is gone for good, as after Infinitary was set up again on its Mac.
Add it then asks once, before anything is sent there, and the captain's yes is what lets that user leave it (captain's answer on FI3-985).

1. The look reads the other first mate's pin from the grant there, and `inf:devices:add` answers the question (`{ asks: "leave", address, name }`, `remoteLoginAddAnswerSchema`) in place of a device.
   The feed says only "Reaching sam@mini.local with your SSH key."; nothing was written there and no link was made.
2. Settings -> Devices shows it where the captain clicked: "sam@mini.local runs work for another first mate.", "If that first mate is gone for good, adding Mac mini leaves it: Infinitary removes what it set up there for that one, with its sign-ins." and "Work that never merged stays there.
   If that first mate still answers, nothing changes.", with a danger "Leave it and add" and a ghost "Cancel", which holds the focus so Enter never leaves it.
   Cancel changes nothing.
3. "Leave it and add" asks `inf:devices:add` again with `{ leave: true }`: the steps above run, and the join's line carries `leave` (`sshJoinSchema`).
4. The join there checks the other first mate itself (`docs/helper.md`, "Leaving a home that is gone").
   One that answers stays, and Add it is refused as `still-answers`; one that does not is left as a removal would leave it, keeping each working copy that holds unmerged work, before the join uses the link.
5. After the joined line, the feed says "Mac mini left the other first mate it ran work for.", or "… Its unmerged work stays there." when it kept a working copy, and a warning line when it could not remove all of it.

The first mate's own card for adding a Mac by its address opens Devices, so its Add it asks the same question there.
The other first mate is not told: it does not answer.

### Refusals

Each refusal is two feed lines with `warn` dots, what happened and what to do, and nothing changed there (`remoteLoginWords.refused`).
`inf:devices:add` rejects with the same words, one line each, which Settings -> Devices shows in the address aside.
The address stays in the field.
Try again runs the same add, and nothing retries on its own.
Cancel closes the aside and changes nothing.
Success still closes the aside.
Why SSH failed is read from its own fixed messages after it exits 255 (`sshRefusal`, `src/core/devices/sshRefusal.ts`); why the work mode there refused is its typed outcome.

| Refusal | When | The lines |
| --- | --- | --- |
| `key-locked` | The other Mac accepted the key, but it is locked with a passphrase | "Could not sign in to sam@mini.local. Your SSH key is locked with a passphrase." "Unlock it once in Terminal, then ask again." |
| `agent-declined` | The other Mac accepted the key, but the agent holding it, such as 1Password's, did not sign: the captain declined, did not answer in time, or it could not ask | "Could not sign in to sam@mini.local. The app that holds your SSH key did not approve it." "Ask again, and approve it in that app when it asks." |
| `agent-not-running` | The agent the captain's SSH settings name, such as 1Password's, did not answer at all, whether its socket is gone or left behind with nothing listening: it is not open, so whatever else SSH tried was not let in | "Could not sign in to sam@mini.local. The app that holds your SSH key is not open." "Open that app, then ask again." |
| `key-refused` | It did not accept the key, when updating, removing or changing its address; adding asks for the password instead | "sam@mini.local did not accept your SSH key." "Check that Remote Login is on there and lets you in, then ask again." |
| `password-off` | It did not accept the key, and lets no one in with a password | "sam@mini.local did not accept your SSH key, and does not take a password." "Let your SSH key in there and ask again, or add it with a command instead." |
| `password-wrong` | It did not take the password typed once; said in the feed, and the aside asks again | "sam@mini.local did not take that password." "Nothing was kept. Check it, then try again." |
| `key-not-taken` | Infinitary placed its own key there, and the Mac still did not let it in | "sam@mini.local did not let Infinitary's own key in, after it was placed there." "Its Remote Login may read keys from another file. Add it with a command instead." |
| `remote-login-off` | Nothing answered Remote Login there | "sam@mini.local did not answer over Remote Login." "Turn on Remote Login there, in System Settings under General, Sharing, or start the SSH server on a Linux computer. Then ask again." |
| `unreachable` | Nothing answered at that address, or the connection dropped | "Could not reach sam@mini.local." "Check its address and that it is awake, then ask again." |
| `host-unknown` | This Mac has not checked that address, and the check could not be asked | "This computer has not checked sam@mini.local yet, so it cannot tell it is your computer." "Add it again by its address, and say this is the computer." |
| `host-changed` | It answers unlike the Mac this Mac reached before | "sam@mini.local does not answer as the computer this computer reached before." "If you did not set it up again, someone may be in between, so nothing was sent to it." |
| `other-system` | It runs a system Infinitary is not set up on over SSH, or Linux on a chip with no published build | "Infinitary cannot run on sam@mini.local's system." "It runs work on Macs, and on Linux computers with an x64 chip. Nothing changed there." |
| `needs-tools` | A Linux computer lacks git, Xvfb, FUSE 2 or a library the AppImage needs to start | "Studio needs xvfb, libfuse2 and libgtk-3-0 before it can run your first mate's work." "Install them there with its software app or package manager, then ask again." |
| `sandbox-off` | A Linux computer, other than Ubuntu 24.04 or 26.04, where the AppImage would run without Chromium's sandbox | "Studio would run Infinitary without its sandbox: its system keeps apps from making one." "Install the Infinitary package for its system there, then paste a link from this computer at its first launch instead. Nothing changed there." |
| `cannot-install` | An Ubuntu 24.04 or 26.04 account may not install software, and the package is missing or not this version | "Studio cannot install software there." "Use an account that can, or install Infinitary there and paste a link from this computer. Nothing changed there." |
| `no-build` | This computer could not get the copy of Infinitary published for that computer's system at this version | "Could not get Infinitary for Studio's system from its published release." "Check that this computer is online, then ask again. Nothing changed there." |
| `build-unverified` | The published Infinitary did not match its published checksum | "The copy of Infinitary published for Studio's system did not match its checksum, so nothing was sent." "Ask again later. Nothing changed there." |
| `already-joined` | That user already runs work for a first mate whose key its grant does not name, or, when updating or changing its address, another first mate's | "sam@mini.local already runs work for another first mate." "Remove it from that first mate, then ask again." |
| `still-answers` | The captain chose to leave another first mate that user runs work for, and it still answers there | "sam@mini.local runs work for another first mate, which still answers." "Remove it from that first mate, then ask again." |
| `in-reach` | That user runs this first mate's work already, as a computer on the list that is in reach | "Mac mini already runs work for your first mate, and is in reach." "Nothing changed there." |
| `same-user` | It is this Mac, as the user Infinitary runs as | "sam@mini.local is the user Infinitary already runs as, on this computer." "Add another user on this computer, or another computer." |
| `forwarding-refused` | Its Remote Login would not carry the join's connection back to this Mac | "Remote Login on sam@mini.local does not let Infinitary's connection through." "Allow forwarding in its SSH settings, then ask again." |
| `cannot-send` | This copy of Infinitary has nothing to send for that system: a development run without `INFINITARY_APP_BUNDLE` for it or a stand-in tap, or an installed one that is no release | "This copy of Infinitary cannot send itself to another computer." "Only an installed Infinitary can add a computer." |
| `busy` | Someone runs Infinitary's work there by hand | "Someone is running Infinitary's work by hand on Mac mini." "Stop it there, then ask again." |
| `failed` | Anything else | "Could not set up Infinitary on Mac mini." "Nothing changed there. Ask again." |

### Where a computer joins from

Whether a computer joins from this Mac itself is this Mac's own finding, never the device's word (`onThisMac`, below, "The saved list").
A connection forwarded through SSH reaches this Mac from its own loopback, so for a Mac added by its address the socket cannot tell; the look tells instead, before the link exists (`placeLocalityChallenge`, `src/core/devices/locality.ts`).
This Mac leaves a fresh token in a file of its own under `/tmp`, which only this Mac has and which every user on this Mac can read, and the look reads that path there.
The token read back means the other end is this Mac, as the captain's user or another one; anything else is another Mac.
The file goes once the look ends, holds no secret, and nothing names this Mac's hardware.
The link carries what the look found (`locality`), and pairing reads it in place of where the device's socket dialed from.
So the user Infinitary runs as on this Mac is still refused (`same-user`), another user here is still this Mac, and another Mac whose user has the same number joins.
It guards a mistake, as `same-user` always has: code already running as the captain could answer either way.
A link made any other way reads the socket, as before.
A computer keeps where it joined from when it finds this Mac again, and on every connection after.

### Kept with the device

How this Mac reaches each computer it set up over Remote Login is kept in `devices/ssh.json`, beside the list: `{ "version": 1, "devices": { "<id>": { "address": "sam@mini.local", "connection": "ssh" } }, "cleanups": { ... } }`, 0600.
`address` is the address it was added at, which rides its entry as `remoteLogin`.
`connection` is how it reaches this Mac: `ssh` when it reaches this Mac only through this Mac's own SSH connection to `address` (below, "Through the home's SSH"), as every Mac added by its address does, and `network` when it dials this Mac's address itself.
`cleanups` holds what this Mac has yet to remove on a computer it took off the list (below, "Removing it there"): `{ "<id>": { "address", "name", "at" } }`, bound to that computer's id.
A computer found again over Remote Login keeps the address that found it, whichever way it was added first, so Update and Remove reach it there.
Settings -> Devices names it by it ("a computer · sam@mini.local · seen just now").
A file that cannot be read leaves every computer on the list and none reached over SSH, and is never written over, so nothing in it is lost; moving it away starts it over.

### The card that asks for it

The app raises one Attention card per computer that runs work and connects on an older Infinitary than this Mac's (`DeviceUpdateNudge`, `src/core/devices/deviceUpdateNudge.ts`; words in `src/shared/deviceUpdateNudge.ts`; design skill `components/devices/UpdateNudge`).
It reads the same comparison as the row (`Computers.list`'s `otherVersion`, `than: "older"`), hung on `WorkDevices.onVersion`, and never asks the first mate to judge it.
A computer on a newer Infinitary, or out of reach, gets none; one that goes out of reach takes its card down without memory.
The card is "Update Infinitary on Mac mini": both versions, what the gap costs only while it costs something (no new work, or "still takes work"), and how Update it reaches that computer.
Its button is Update it, which opens Settings -> Devices with the update running (the `update` arrival), or Make the command for one too old to update from here.
It is raised once per gap, with one feed line, and a reconnect that says the same raises nothing.
Its answers carry the gap in their action ids (`update@<this>><that>`, `not-now@...`), so Not now and Update it hold across restarts for that gap only; this Mac or that computer changing version raises it again.
The close control names no gap and holds for the gap on the stack.
A refused update (`device_update`, stage `refused`) raises the card once more with the refusal in its body.
It comes down by itself, with one feed line, when that computer runs this Mac's version.
The first mate's offer to update the same computer answers that the card is standing instead of making a second.

### Updating

`inf:devices:update` updates Infinitary on a computer added by its address to this Mac's version, the same way: "Updating Infinitary on Mac mini.", Infinitary for the system that computer said in its hello - asked there when it never said one - sent in an SSH session of its own and started as `work update --fetched <app> --from-home --home <pin> --device <id>`, which checks the folder there runs work for this home as that computer, stops the run there, keeps the new copy in place of the old and starts it again, then "Mac mini runs this computer's version of Infinitary now.".
An Ubuntu 24.04 or 26.04 computer is asked for that account's password again, in the same aside, and the new deb is installed the same way as the first one; the installed program is then told to start again, with no copy kept in the work folder.
The copy for another system is got and checked first (above, "Infinitary for another system"), and that computer checks it again when it arrives.
This Mac's own SSH connection to it waits while it is updated (`SshConnections.hold`), so its controller never runs from a copy being replaced, and is made again to the new copy after.
When the session there refused to start it in the background, the feed says "Mac mini has this computer's version of Infinitary now." then the two warning lines "Mac mini could not set itself to start in the background, so it runs no work for now." and "Ask again to update it.".
A turn running there is cut off, as when that computer restarts (`docs/helper.md`, "That computer restarts").
A computer added any other way is updated over the connection (below, "Another version, and updating").

### Removing it there

Remove for a computer added by its address works as for any computer that runs work (below, "Remove").
Out of reach, Remove now also removes what Infinitary set up there over Remote Login at once: "Removing what Infinitary set up on Mac mini, over Remote Login."
(on a Linux computer "…, over SSH."), the copy kept there - a Mac's bundle, a Linux computer's AppImage, or on Ubuntu 24.04 and 26.04 the package's own program - found by what `uname -s` answers there - started as `work remove --from-home --home <pin> --device <id>`, then "Removed what Infinitary set up on Mac mini."
The Ubuntu package itself stays installed.
(`RemoteLogin.removeThere`).
The work mode there checks first that its folder runs work for this home as that computer, and touches nothing of another home's or another computer's (`other-home`), so an old address that reaches another Mac now never removes its Infinitary.
When its folder there is another's, as on a Mac that left this first mate, or holds nothing (`not-joined`), the feed says "Mac mini had nothing of your first mate's to remove." in place of the removed line.
A working copy that still holds unmerged work stays there, as it does when a computer removes itself.
When it could not remove all of it there yet, the feed says so in two warning lines, "Could not remove all that Infinitary set up on Mac mini yet." and "Mac mini tries again the next time sam logs in there.", in place of the removed line: that computer has let the home go, and finishes it itself (`docs/helper.md`, "Removed").
Once nothing is left there to hear it, the home does not listen for it.
When Remote Login could not do it, the feed says so, and this Mac keeps a cleanup-only record bound to that computer's id (`DevicePairing.sshCleanups`), never a connection: it tries again quietly after 1, 5, 15, then every 30 minutes, and at once when this Mac wakes, and says once when it removed something there.
After thirty days it stops, and says so once: "Could not remove what Infinitary set up on Mac mini: this computer has not reached sam@mini.local in thirty days." and "It stays there, with any unmerged work, until it is deleted there by hand."
Removed in reach, a computer this Mac reaches over its own SSH hears it through that connection, which stays until it went or fifteen seconds passed, and then gets the same cleanup as a backstop, which finds nothing of this home's left once it removed it itself.

## Finding the home again

A device keeps the address its link named (`at` in its grant), so after this Mac's address changes - the captain chose another, or the network gave it another - the device dials where this Mac was.
Another user on this Mac is not stranded so: its command's link names loopback, which no address change moves, and its work dials loopback from its next run whenever its grant names one of this Mac's own addresses, as one kept before that did (`docs/helper.md`, "Finding the home again").
A Mac that controls this first mate comes back by Leave and a new link (`docs/view.md`, "Leave").
A computer that runs work comes back by a new link from this Mac, in a new command, which it uses to find this Mac where it is now, as the same computer (design skill `components/devices/AddAMac`, "Finding this computer again"; `docs/helper.md`, "Finding the home again"):

1. The device sees that the link's `key` is the pin of the home its grant names, checks that key answers at the link's `at`, and sends `POST /pair` there with `"again": true`, showing the key it was paired with rather than a new one (`findHomeAgain`, `src/core/devices/dial.ts`).
2. With that key on the list, the home spends the link and keeps the entry as it was, so its id - which a project's Runs on and a task placed there name - its name and when it joined stay (`DevicePairing.claim`).
   It says so once in the feed, `device_joined` with `again`: "Mac mini found this computer again.
   It runs work as before.", and Settings -> Devices' panel turns to the same words.
3. The device keeps its grant with the link's `at` and nothing else changed, and dials there from then on.

With that key no longer on the list - the home removed it while it was out of reach - the home answers `removed` and spends nothing.
That answer is how the device hears it was removed, so the home forgets the key's pin in `removed.json` and stops listening for it.
The device removes what Infinitary set up there, as a removal would have, then uses the same link to join anew, with a new key.
A link from another home is refused on the device before anything is sent while the home it runs work for answers ("This user already runs work for MacBook Pro.").
While that home does not answer, the device asks its person to leave it first, as a removal would, keeping unmerged work (`docs/helper.md`, "Leaving a home that is gone").
Nothing follows this Mac to its new address on its own.

A computer added by its address is never stranded so: this Mac's own SSH connection forwards to wherever this Mac listens (below, "Through the home's SSH").
Add it at its address (`RemoteLogin.add`) still finds such a computer again when it is out of reach, and sets its copy of Infinitary up anew.
It finds a computer a command added the same way, once the captain reaches it with SSH, and moves it onto this Mac's own SSH connection for good (captain's pick on FI3-985).
The look reads that its user runs this first mate's work, as a computer on the list (above, "Adding, step by step"), and the feed's `finding` stage, with its `deviceId`, says "Telling Mac mini where this computer is now." in place of "Preparing Infinitary for Mac mini."; the copy's count and "Starting Infinitary on Mac mini." follow in the same stage, with the same `deviceId`, so the computer's own row follows them.
The same one-use link and this Mac's Infinitary go there and start as `work join --fetched <app> --from-home`, which finds this Mac with the link as above (`docs/helper.md`, "Finding the home again"): the home answers `again`, the link's handle names the same id (`claimedBy`), and `inf:devices:add` answers that computer, still on the list with its id, its projects and its sign-ins.
The link says `via=ssh`, so the computer's grant keeps `via` from then on and dials only the route this Mac's connection keeps there, and this Mac keeps it with `connection: "ssh"` and the address that found it (`findHomeAgain`, `keepSshRecord`).
Nothing moves the other way: a computer on this Mac's SSH refuses a link that dials an address (`via`), so a new command never takes it off that connection.
It then runs this Mac's version of Infinitary, as after an update.
In reach, Add it changes nothing there and says so (`in-reach`): only a computer out of reach has anything to find.

Pairing keeps where each device last reached this Mac, the address and port its connection's socket was dialed at, in `devices/reached.json` (`{ "version": 1, "reached": { "<id>": "192.168.1.20:47623" } }`, 0600), noted when it joins, finds this Mac again, or connects.
When that is not among the addresses the connection listens at now (`HomeConnection.listening`, read through `WorkDevices`), this Mac's address changed since (`DevicePairing.addressChanged`), and a computer that runs work out of reach carries `addressChanged` on the list.
The list is read again each time where the connection listens changes (`HomeConnection.onListening`), so once this Mac's network moves and the connection listens at the new address, the list says so with no link made (below, "Where devices find this Mac").
Loopback is listened on whatever this Mac's address, so there only the port can move.
A computer that reaches this Mac through this Mac's own SSH connection never carries `addressChanged` (below, "Through the home's SSH").
While the connection listens on loopback alone, this Mac is on no network and nothing from another Mac reaches it anywhere, so it never says so of another address; while it listens nowhere, it says nothing.
Settings -> Devices then says how it comes back (below, "Settings -> Devices").

## Through the home's SSH

A computer may reach this Mac only through this Mac's own SSH connection to it, the way the captain chose for a Mac added by its address (FI3-970).
A launchd agent's dial to an address on the local network waits for a person at that Mac to allow it, even through nc (below, "Through macOS's own nc").
So the background a computer runs in (`docs/helper.md`, "In the background") cannot reach this Mac on a shared network with nobody at that Mac's screen.
This Mac's own SSH runs under the captain's own session, and accepting a connection is no local network dial, so the connection is turned around at the transport alone:

- This Mac's SSH connection forwards a private Unix socket on that Mac to this Mac's loopback listener.
  That Mac gets no new network listener, and its work never dials this Mac's network address.
- The computer is still the TLS client, with its own key, and this Mac still checks it is on the list; SSH carries the bytes and decides nothing.
- Its link says `via=ssh` and names this Mac's loopback, where the forward delivers it (`invite`, `{ remoteLogin, via: "ssh", locality }`), and its grant keeps `via`: it dials only the route that connection keeps there (`docs/helper.md`, "Through the home's SSH"), and with none it is out of reach and dials nothing (`docs/connection.md`, "Where a device dials").
- This Mac keeps it with `connection: "ssh"` (above, "Kept with the device"; `DevicePairing.sshConnections`), and never says this Mac's address changed since it was last in reach: that connection follows this Mac wherever it listens.
- Where it joins from is the look's finding (above, "Where a computer joins from").

### The connection

`SshConnections` (`src/core/devices/sshConnections.ts`) keeps one connection to each computer `DevicePairing.sshConnections` lists while this Mac's Infinitary runs.
It starts only when the shell attaches the paired connection, and the shell stops it on quit after the connection closed, so each computer hears this Mac quit first.
Closing the window does not end it; quitting does, and sleep pauses it.

1. **The captain's own SSH, as the app's own master.**
   `SshMaster` (`src/core/devices/ssh.ts`) starts `/usr/bin/ssh` with `SSH_MASTER_OPTIONS`: `SSH_OPTIONS`' batch mode and narrowing, `ClearAllForwardings=yes`, and a control socket of the app's own (`ControlMaster=yes`, `ControlPersist=no`) in a fresh 0700 folder under `/tmp`, short enough for the suffix SSH adds while it makes it.
   It never shares the captain's own connections, and it ends with its own session.
2. **The controller there.**
   Its session runs the copy of Infinitary kept there - a Mac's bundle, or a Linux computer's AppImage, by what `uname -s` answers there (`CONNECT`, `src/core/devices/farSystems.ts`) - as `work connect --from-home --home <pin> --device <id>` (`docs/helper.md`, "Through the home's SSH"), which checks its folder runs work for this home as that computer, makes a fresh private socket folder and says the socket's path.
3. **The forward.**
   `ClearAllForwardings` clears a forward on the command line too, so this Mac adds the one it needs afterwards, over the control socket alone: `ssh -F /dev/null -S <control> -O forward -R <socket>:127.0.0.1:<port>`, to wherever the paired connection listens now.
   No setting of the captain's adds anything to it, and a forward his settings ask for stays closed.
4. **The route.**
   Told the forward is in place, the controller checks this Mac answers through it with its own key, publishes the route the work there dials (`HomeRoute`), and says whether that work runs: `running`, `at-login` while nobody is logged in there as its user, or `failed`.
   Every 15 seconds this Mac sends a beat, which renews the route's 75-second lease.
5. **Connected only on the welcome.**
   The connection is `connected` once the work there said hello through it, on any version, never on SSH's word or a loaded agent.

What rides the session is one typed, versioned JSON line at a time, at most 4 KiB, never a word a shell reads (`src/shared/sshConnection.ts`).
Every other request - a forward, a session that carries a copy - goes over the control socket with `ProxyCommand=/usr/bin/false`, so once the master is gone it fails instead of opening a connection of its own.

**Tries.**
A connection that drops or cannot be made is tried again after 1, 2, 4, 8, 15, then every 30 seconds, each 20% early or late at most, and from the start again once one stayed up a minute.
SSH's own keepalive (15 seconds, four unanswered) notices a dead network; the welcome and the connection's own pings decide whether the work is reached.
While this Mac sleeps nothing is tried; waking tries each computer not connected once at once.
This Mac's address changing needs nothing: the forward goes to its loopback, and a new port after a restart is forwarded on the next connection.

**Stopped until Try again.**
What only a person can mend stops the tries: a Mac this Mac never reached (`host-unknown`), one that answers unlike before (`host-changed`), a key refused (`key-refused`), locked or not answered by its app (`key-locked`), not approved by its app (`agent-declined`) or held by an app that is not open (`agent-not-running`), Remote Login that will not forward (`forwarding-refused`), Infinitary gone there (`not-set-up`), or a Mac whose Infinitary runs work for another home or as another computer (`other-home`).
SSH has checked that Mac answers as before, so `other-home` is that Mac, which left this first mate: Devices and the feed say its address runs work for another first mate now and to remove it here, never that it reaches another Mac or that its work catches up when it is back (`runsForAnotherFirstmate`).
Try again and Change address are not offered on that row, and Try again for every stopped Mac skips it, because it is not coming back.
The feed says it once, in two warning lines (`sshConnectionWords.stopped`), and once more when the computer is back after Try again ("Mac mini is connected using SSH again.").
A key that is locked, or whose app did not answer (`key-locked`), a key its app did not approve (`agent-declined`) and a key whose app is not open (`agent-not-running`) are mended outside Infinitary, by unlocking the key, approving it in that app or opening that app (`QUIET_RETRY_STOPS`), so this Mac also tries them again quietly when it wakes and every five minutes, each a little early or late.
Devices keeps saying it stopped while it is tried, the feed says why only once until it is back or the captain presses Try again, and the next try after it is unlocked, approved or opened brings it back by itself.
Try again (`inf:devices:try-again`) tries one computer, or every stopped one when none is named, except a Mac that left for another first mate; it changes nothing saved.

**One operation at a time.**
Setting a computer up, updating it, finding it again and changing its address each hold its connection (`SshConnections.hold`): the connection ends first, nothing is tried while the operation runs, and it is made again after.
A computer a command added has no connection until finding it again gives it one, so a connection pairing asks for while its computer is held waits for that operation too, and the controller there never reads a grant the join has yet to move.
A computer that joins during a setup is not tried until the setup is done, so the controller never finds a folder the join has yet to write.

**Ending.**
Stopping a connection ends the controller's input first, so it withdraws its route and removes its own socket folder; then the master over its control socket; then a stop signal, then a kill, each within a bound; then this Mac's control folder goes.
If this Mac's Infinitary crashes, the master's input ends with it, and the controller there withdraws its route and ends; if this Mac sleeps or loses power, the controller hears no beat for 75 seconds and does the same, and the route's lease runs out by itself.
Nothing reads a process number that may be another's now.

### Changing its address

The captain may reach a computer at another address: Change address on its row, or `inf:devices:change-address`.
One look there (`RemoteLogin.changeAddress`) must find a Mac whose Infinitary runs work for this home with this computer's id; anything else changes nothing and says why in two lines - another first mate's (`already-joined`), this first mate's as another computer (`another-computer`), none (`not-set-up`), or one SSH could not reach.
Found, `DevicePairing.setSshAddress` keeps the new address, the feed says "This computer reaches Mac mini at sam@studio.local now.", and the connection is made there.
No address is ever guessed, and no key is ever trusted anew.

## Another version, and updating

A computer that runs work says in its hello the contract it speaks and, from `WORK_UPDATE_SINCE` on, the version of Infinitary it runs (`appVersion`, `docs/connection.md`).
The connection tells the home's `WorkDevices` both at each welcome, whether or not the computer takes work, and that it went once its last connection did (`onWorkVersion`).
Settings -> Devices' list (`Computers.list`) measures them against this Mac's own: the versions of Infinitary when both are known, otherwise the contracts.
A computer connected on another version carries `otherVersion` on its entry - the version it said, `older` or `newer` when both read as versions (`compareSemver`), whether it still takes work, and how this Mac would update it - and one out of reach carries none, because the home cannot tell (design skill `components/devices/DevicesTab`, "Another version").
One that takes no work is still connected, so it reads "seen just now" and "no new work", never out of reach, and a task waiting for it says so too ("It takes no new work until it is updated.", `docs/helper.md`, "Runs on"), recalls its Update card, and Automatic's compared computers name it "has an older Infinitary".

### Updating

`inf:devices:update` (`Computers.update`) brings a computer that runs work to this Mac's version, the captain's own click on Update in Devices or on the first mate's card:

- **Added by its address**: over Remote Login, as above ("Adding a computer by its address", "Updating").
- **Any other computer that takes the update order** (`takesUpdate`, a contract from `WORK_UPDATE_SINCE` on, whatever its major): over the connection, below.
- **One too old to take it**: refused as `not-updatable`; Devices' Update makes the command for it instead, which run there once finds this Mac again and keeps this Mac's version (above, "Finding the home again").

### Updating over the connection

1. "Updating Infinitary on Mac mini.": the home asks the update order, `fm:firstmate:update` (`updateOrders`, `src/shared/work.ts`), of a connected computer whatever its version (`ask` with `anyVersion`).
   The order takes no arguments and answers `{ restarts }`, and its name and shape never change across majors, so a home on any later major can still ask it.
2. A computer that keeps a copy of Infinitary - another Mac added by a command - gets this Mac's at `/firstmate` with its own key and no code (below, "Getting Infinitary by its own key"), unpacks it beside its own and keeps it in its place; another user on this Mac runs this Mac's own app, so it gets nothing.
   Nothing there changes if the copy does not arrive whole.
3. It answers, then its run ends, and its background, which keeps it running while it is joined, starts it again from what is kept (`docs/helper.md`, "Updated by its home").
4. "Mac mini runs this computer's version of Infinitary now." once it is back on this Mac's version.
   Not back within three minutes, the feed says so in two warning lines instead ("Mac mini has this computer's version of Infinitary now, and has not started again yet."), and one with no background to start it again says it runs it once it is started there again.

Each step is a `device_update` feed line, and each refusal two `warn` lines that `inf:devices:update` rejects with too (`remoteLoginWords.refused`): `out-of-reach`, `current` (it runs this Mac's version already), `not-updatable`, `cannot-send` (another Mac, from a copy of Infinitary with no bundle to send), and `failed` (the computer could not get or keep the copy).
A turn running there is cut off, as when that computer restarts.

### Getting Infinitary by its own key

`/firstmate` with `{}` and no code answers this app to a computer that runs work already on the list, proven by the key it shows in TLS, as `/connection` admits it (`DevicePairing.opened`): `unknown` 401 for a key the list does not hold, and `kind` 409 for a Mac that only controls this first mate.
That path and body never change across majors either, nor across the two spellings of the Infinitary rename (`docs/connection.md`, "Two spellings"), so a home on either side of it updates a computer on the other: the computer keeps the app it is sent under its own name and moves its background to it (`docs/helper.md`, "Updated by its home").

## Every connection after

The device opens TLS to `at` showing its key, checks the home's pin before it sends a request, and asks for the WebSocket upgrade on `/connection`.
The home admits the request when the key the socket showed is on its list.
Nothing secret rides the request: no header, path or query carries one.

What a connection may do follows what it is, which its hello says (`as`, `docs/connection.md`) within what its kind may be, never beyond: a `view` is Infinitary open on the device, which a `mac` or a `view` may be, and a `work` connection its work, which a `mac` or a `work` device may be.
A `mac` holds one of each at once; a hello that says what its kind may not be is closed as `protocol`.

| Connection | Requests | Pushes |
| --- | --- | --- |
| `view` | the core channels whose `reach` is `views`, as the captain, and `leave` | every core push, numbered |
| `work` | the work requests about a conversation its home opened there, and about its own sign-ins, as itself; its welcome says whether its version takes new work (`takesWork`), and on any version it answers the update order (above, "Updating over the connection") | none |

## Through macOS's own nc

Since macOS 15, local network privacy gates an outgoing dial to an address on the local network: the system asks the person at the screen the first time a program dials one, and drops the dial until they answer (Apple's TN3179).
It tracks the responsible code up the process tree, and exempts a dial made under Terminal or over SSH, and by any child they spawn, but not one a launchd agent makes.
The system's own nc is such a child, and it only moves bytes: carrying a dial through `/usr/bin/nc` (`relayFor` and `relayedStream`, `src/core/devices/relay.ts`), started as `nc <host> <port>` with the app's environment, lets the dial take the exemption of whatever started nc, while the TLS, the home's pin and both keys stay the device's own, end to end.
The app's own dial, by contrast, is tracked back to the app and asked about.
So on macOS a device makes every dial to another computer's address through nc; a dial to loopback goes directly, since local network privacy never asks about it, and so do a dial to a private socket on its own Mac (`docs/connection.md`, "Where a device dials") and every dial on another system.
When nc exits with an error before it relayed a byte, nothing answered there, and the dial fails with what nc said; closing the socket stops nc.
It is every dial `pinnedSocket` makes to an address: joining, finding the home again, the checks before either, and every connection after, for a computer that runs work and for the app as a view (`docs/view.md`).

This is what lets a Mac added by its address over Remote Login join on a shared local network: the copy the home starts there runs under `sshd-session`, so its dial back to the home, carried through nc, takes that SSH exemption and reaches the home with nobody at the other Mac's screen.
What a launchd agent dials is not exempt, though, even through nc.
Once joined, a computer that runs work dials the home from its background agent (`docs/helper.md`, "In the background"), and on a local-network address that dial is gated by local network privacy, so on a headless Mac its background work cannot reach the home there until the permission is granted once on that Mac.
That is why a Mac added by its address is to reach this Mac through this Mac's own SSH connection instead (above, "Through the home's SSH").
A private network service's address, such as Tailscale's, is not a local-network address, so none of this touches it: the background work reaches the home over one with nothing to answer.
The home needs no relay of its own: it only listens, and accepting a connection is not a local network operation (TN3179); it reaches another Mac over Remote Login with `/usr/bin/ssh`, which runs under the person's own shell and is exempt.

### Held on the local network

A Mac a command added joins, since the command runs under Terminal or SSH, and then its background work dials this Mac from a launchd agent.
On a local-network address macOS holds that dial until someone at that Mac allows Infinitary there, so with nobody at its screen it never comes into reach (captain's pick on FI3-1001).
This Mac cannot see a dial macOS holds on another Mac, so it says what it knows (`DevicePairing.heldOnLocalNetwork`, `heldOnLocalNetwork` on the list):

- a computer that runs work, joined from another Mac, out of reach now,
- not reached through this Mac's own SSH connection (above, "Through the home's SSH"),
- never in reach since it joined, with nothing for it in `seen.json`,
- and last reached this Mac at an address on the local network (`onLocalNetwork`, `src/core/connection/addresses.ts`): a home or office range or a link-local address, never loopback or a private network service's shared range.

The join's own dial to hear this Mac's name says so in its hello (`nameOnly`, `docs/connection.md`), and the home counts it as nothing of that computer in reach, so only its work's own connection is.
A computer whose address changed since carries `addressChanged` instead, never both: that old address is the first thing to mend.
While `seen.json` cannot be read, no computer reads as held, since one in reach before cannot be told from one never in reach.
Settings -> Devices says why on its row and offers Add it by its address (below, "Settings -> Devices"), which finds it again over Remote Login and moves it onto this Mac's own SSH connection for good (above, "Finding the home again").
Someone at that Mac allowing Infinitary there brings it into reach too, and once its work reached this Mac either way the row never says it again.

## The saved list

`devices/devices.json` holds `{ "version": 1, "devices": [{ "id", "kind", "name", "pairedAt", "user", "onThisMac", "keyPin" }] }`.
Beside it, in files of their own so a list an older app reads is still the list it knows: `seen.json`, when each device was last in reach; `reached.json`, where each last reached this Mac (above, "Finding the home again"); `removing.json`, the computers to remove once they are back; `removed.json`, the key pins of computers removed while out of reach that have yet to hear it (below, "Remove"); `ssh.json`, how this Mac reaches each computer it added over Remote Login (above, "Kept with the device"); and `systems.json`, what each device said it is in its hello (above, "The shape").
A `systems.json` that cannot be read is never written over, and until it can be every device reads as a computer.
`user` is the macOS user a computer that runs work said it runs as, and `onThisMac` whether the device joined from this Mac itself, as the home found it: from its link when the look over SSH found it (above, "Where a computer joins from"), else from its socket; a list saved before either existed reads as it was.
The folder is 0700 and every file in it 0600, set again on each write.
The list is written whole to a temporary file and renamed into place.
It holds no secret: a pin is public.

A list that cannot be read, or one written by a newer version, admits no device and refuses every change, and is never overwritten.
The home says so once in its log.
Moving the folder away starts over.

`name` is the device's own words: at most 64 characters, with no control or formatting characters, so a name cannot reorder the text around it.
The home stores it as text and draws it as text.
It reaches the first mate through `app_state` and a feed line, so it is quoted there like any text a device chose.

## Where devices find this Mac

A new link carries every address this computer has, with `CONNECTION_PORT`.
The local network's name, such as `kuns-macbook-pro.local`, comes first when this computer is on a local network, then each local address, then the private network.
The first stays `at`.
The rest ride `also`.
Container bridges are left out.
The connection listens on loopback plus every one of those addresses, never a wildcard, a public address or a link-local address (`docs/connection.md`).
The other computer tries each in order and keeps the one that answered.
The link in the command for another user on this Mac names `127.0.0.1` alone, since that user dials from this Mac itself.
The addresses on offer are this Mac's own private IPv4 addresses right now (`offeredAddresses`, `src/core/connection/addresses.ts`): the local network's first, Wi-Fi and Ethernet before other interfaces, then the shared range a private network service hands out.
A bridge Linux makes for containers or virtual machines (Docker's `docker0` and `br-`, libvirt's `virbr`) is left out, since no other computer reaches it.
With no private address a link names `127.0.0.1`, which reaches only this Mac.
Nothing offers a chosen address.
`inf:devices:address:set` still answers, and still refuses an address that is not this Mac's own, and changes nothing.
A choice saved in `devices/address.json` is read no more.

Pairing follows this Mac's network while the connection runs (`DevicePairing.followNetwork`), which the shell starts beside the connection.
Nothing tells the app when an address comes or goes, so pairing looks at this Mac's own private addresses every five seconds and tells its listeners once a change has held for two looks in a row.
A moment off the network while this Mac changes Wi-Fi is no change.
The connection then listens on the addresses this Mac has now, in a new listening run (`docs/connection.md`).
Settings -> Devices is sent where devices find this Mac, whole, each time it reads differently (`inf:devices:addresses`), so its rows follow with the tab open.
The list then says a computer still looks for this Mac at its old address, per address (above, "Finding the home again").
A development run may keep the connection to loopback at a port of its own with `INFINITARY_CONNECTION_LOOPBACK_PORT`: pairing then sees no private address, so a link names `127.0.0.1` at that port and the connection listens there alone; a packaged app ignores it.
A development run may also stand in addresses and a network name with `INFINITARY_STAND_IN_ADDRESSES` and `INFINITARY_STAND_IN_NETWORK_NAME`, so a picture can show the rows without this computer's own network; a packaged app ignores both.
Every end-to-end launch sets it (`tests/e2e/launch.ts`), so a test never listens on the Mac's own network, where a firewall can drop the dial, or on the port a real app holds.
The launch reports that port as `connectionPort`, so a test that probes whether its app listens dials that app, never the port an installed app holds (`tests/e2e/phase0-guardrails.spec.ts`).
The app lists only this Mac's own interfaces and never reads another program's settings.

## A Linux home's firewall

A device dials its home at the connection's port, and a Linux desktop may turn on a firewall that drops that dial, so a computer added by a link never joins and nothing says why.
A Linux home looks at its own firewall (`firewallKeepsOut`, `src/core/devices/firewall.ts`), reading only what any user may read and never asking for a password, and says what it found as `firewall` where devices find it (`inf:devices:addresses`, `deviceFirewallSchema`: `ufw`, `firewalld` or `nixos`, with the port):

- **ufw** (Ubuntu, and Omarchy's own): on while its settings file, `/etc/ufw/ufw.conf`, says `ENABLED=yes`.
  Its rules are an administrator's to read, so while it is on the port may be closed.
- **firewalld** (Fedora): running while its service is active, unless `firewall-cmd --query-port` answers that the port is open, or, where it will not answer this user, its default zone is Fedora Workstation's own, which lets every port from 1025 in.
- **NixOS's own firewall**: on while its `firewall` service is active on a computer that has `/etc/NIXOS`.
  Its rules are an administrator's to read too.

Anything else is no warning: a firewall it cannot tell of is never said to keep devices out.
Pairing looks again at most once every ten seconds - each time Settings -> Devices reads where devices find this computer, and with each new link - and pushes what it found when it changed (`DevicePairing.checkFirewall`).
Settings -> Devices then says, in `--warn`, "The firewall on this computer may keep your other computers out." and "To let them in, run this once in a terminal:" over `sudo ufw allow 47623/tcp`, or `sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload`; for NixOS, "To let them in, add this to your NixOS configuration and rebuild it:" over `networking.firewall.allowedTCPPorts = [ 47623 ];` (`firewallWords`, `src/shared/devices.ts`; design skill `components/devices/DevicesTab`, "A Linux home's firewall").
It stands in the open link or command panel while one for another computer is open, and otherwise under the ways box; the command for another user on this computer never takes it, since that user dials loopback.
A Mac never looks: macOS asks its person before its firewall keeps Infinitary out.

## Leave

A connected device's person can take it off the list from the device itself: it sends the connection's `leave` frame (`docs/connection.md`), and pairing removes its entry exactly as Remove does (`DevicePairing.leave`), so the connection closes it as `unpaired` (4401).
A device that may run work leaves as Remove removes one (`leaveWithWork`, below): its window is cut at once, its work comes here first - or once it is back, when its work is out of reach - and only then is it off the list.
The home says it once in the feed, by the device's own name: "MacBook Air left."
(`device_left`).
A device can leave only itself; it cannot remove another.
A device out of reach cannot tell the home, which lists it until the captain removes it there (`docs/view.md`, "Leave").

## Remove

`inf:devices:remove` deletes the entry and writes the list.
Before it returns, the connection has closed that device's every connection with `unpaired` (4401), and it drops any frame it reads afterwards from a device it no longer holds.
The device needs a new link, and a new key, to come back.
When the last device goes and no link is open, the connection stops listening.

A computer that runs work never loses work that never merged to a removal (`Computers.remove`):

- **In reach**: each project whose Runs on names it runs on this Mac from then on, so a task that has not started follows its project here, and a task's own Runs on that names it is forgotten, so that task follows its parent's or its project's (`TaskService.forgetRunsOn`); each task started there stops, as the captain's Stop stops one (`CrewSupervisor.stopTasksOn`); every task's conversation there is closed and its working copy retired once its kept work is here (`PlacedSessions.bringHome`), which refuses when a working copy there still holds work this Mac lacks; and only then is it taken off the list.
  Cut off, it removes what Infinitary set up there (`docs/helper.md`, "Removed").
  Devices reads "Bringing website's unmerged work here…", then "Removing what Infinitary set up on Mac mini…" (`removal` on its row), and the feed "Removed Mac mini. website runs on this computer now.".
  When its work cannot all come here, it stays on the list and the tab says why.
- **Out of reach**, `inf:devices:remove` refuses unless the captain chose: `when-back` keeps it on the list, saved, and removes it as above the next time it is in reach; Keep it (`inf:devices:keep`) takes that back; `now` stops its tasks here, marks their working copies as left there, runs its projects here, and takes it off the list at once.
  Its unmerged work stays on that computer.
  It has not heard it was removed, so its key's pin is kept in `removed.json` and the connection keeps listening for it; the next time it dials it is refused, reads that as removed, and removes what Infinitary set up there, but a working copy that still holds work.
  The pin is forgotten after three refusals - a device needs two in a row - or after thirty days.
  A computer that runs work for another first mate now (`other-home`, above) is not coming back, so Devices asks only to remove it now, and the feed says nothing of this first mate's was there to remove (above, "Removing it there").

## The requests

| Channel | Reach | Catalog action |
| --- | --- | --- |
| `inf:devices:list` | home | the current value of both actions below |
| `inf:devices:invite` | home | `device-invite`, tier `hands` |
| `inf:devices:remove` | home | `device-remove`, tier `hands`; a computer that runs work out of reach takes `when-back` or `now` |
| `inf:devices:keep` | home | none: it takes back the captain's own wait to remove a computer once it is back |
| `inf:devices:try-again` | home | none: the captain's Try again, or the `devices.try-again` command, tries this Mac's own SSH connection once more and sets nothing |
| `inf:devices:change-address` | home | none: the captain's Change address reaches a computer added by its address somewhere else, once a look there finds the same computer |
| `inf:devices:add` | home | none: the captain's click adds the Mac at an address over Remote Login; `device-invite` with `how: "address"`, tier `hands`, only offers the card |
| `inf:devices:update` | home | none: the captain's click updates Infinitary on a computer that runs work, over Remote Login or the connection; `device-update`, tier `hands`, only offers the card |
| `inf:devices:shown` | home | none: whether Devices is offered here; every build's home answers yes, and a Mac that controls another is not answered |
| `inf:devices:stop` | home | none: it closes the captain's own open link and sets nothing |
| `inf:devices:addresses` | home | none |
| `inf:devices:address:set` | home | `device-address`, tier `hands` |
| `inf:devices:runs-on` | home | `project-runs-on`, tier `asked`: where a project's next task starts (`docs/helper.md`, "Runs on") |
| `inf:devices:sign-ins` | home | the current value of `device-sign-in` |
| `inf:devices:sign-in` | home | none: the captain's click starts it there; `device-sign-in`, tier `hands`, only offers the card (`docs/helper.md`, "Its own sign-ins") |
| `inf:devices:sign-in:answer` | home | none: what the captain typed goes to that computer once and is kept nowhere here |
| `inf:devices:sign-in:cancel` | home | none |
| `inf:devices:sign-out` | home | none |
| `inf:devices:forge-sign-in` | home | none: the captain's click in Settings -> Projects starts that computer's own GitHub sign-in there (`docs/forge.md`, "A computer's own sign-in") |
| `inf:devices:forge-sign-out` | home | none |

The list is also pushed whole, `inf:devices`, after any change to it, to what the home reads of a computer that runs work, or to whether a Mac that controls this first mate is connected.
Every action is the captain's own, on this Mac's window.
A paired view asks the core as the captain, and words typed on it reach the first mate as the captain's; so neither a request from a view nor the first mate can add or remove a device.
The first mate can read the list through `app_state` - each device's id, kind, name and when it joined - which holds nothing secret.
A lost Mac cannot add another device, and cannot remove the others.
Words typed on a paired view are the captain's own words (the captain's pick on FI3-709): in its input or under a card, they may ask the first mate for an own-words change - removing a project, disconnecting an account, signing out of GitHub, moving the projects folder or removing a panel - as words typed on this Mac may.
A lost view can therefore ask for those until the captain removes it here.

## Settings -> Devices

Every build offers the tab and the first mate's device cards: `inf:devices:shown` answers yes on every home, stable, alpha and development alike.
On an app that controls another Mac the tab is that Mac's row with Leave instead, and that Mac is not asked `inf:devices:shown`.

The tab after Usage, built to the agreed design in the design skill's `components/devices/DevicesTab` (`src/renderer/src/settings/DevicesTab.tsx`):

- **Your devices**: "Your first mate lives on this computer.
  From any computer you add you can control it, and any computer you add can run a project's work.
  Running as another user on this computer only runs work.
  Like every user here, it can read files in your home folder." over the list; on Linux the last sentence reads "Like every user here, it can read the files your home folder lets other users read.", since Linux keeps no private folders from other users and leaves it to the home folder's own permissions (`anotherUserHere`, `src/shared/deviceNames.ts`).
  This computer first, "Your first mate lives here", with no Remove; then each device by its own name, drawn as text, with Remove.
  A Mac that only controls this first mate (a `view`) reads "a computer · joined today 14:06 · seen just now" with its dot `ok` and "Controlling your first mate now" under it while Infinitary is open there and connected (`controlling` on its row), and "a computer · joined today 14:06 · out of reach since 14:02" with its dot `warn` once its last connection goes.
  The home hears a view come and go through the connection's `onViewDevice`, held by `WorkDevices`, and keeps when it was last seen in `seen.json`, so a restart still says since when.
  A device that may run work - a Mac, or a computer that only runs work - is drawn in `components/machines/MachineRow`'s shape, and a Mac's summary leads with "Controlling your first mate now" while Infinitary is open there (`controlling`, read as for a view), its dot and state following its work: "Running as Builder" with "another user on this computer · runs work only, while Builder is logged in · seen just now", or another Mac's name with "a computer · joined today 14:06 · seen just now"; then "Runs website and api · Signed in to Codex and GitHub" (or "Runs no project yet", "No sign-ins yet"); its dot `ok` in reach, `idle` while its connection is being made and `warn` out of reach; and on the right "1 task" in the accent, "idle", "connecting" while its SSH connection is being made, or "out of reach" in `--warn`.
  Out of reach it reads "out of reach since 14:02", or "not logged in since this computer restarted" for another user on this Mac nobody has logged in as since.
  Connected on another version of Infinitary, a line under its summary says which, "Has Infinitary 0.1.20, older than this computer's.", with "It takes no new work until it is updated." in `--warn` while it takes none, its dot `warn` and "no new work" on the right; Update stands before Remove (above, "Another version, and updating").
  Update on one too old to update from here makes the command for it, for another Mac or for another user on this Mac.
- **Bringing a computer back**: added by a command and out of reach with `addressChanged`, a computer's row adds "It still looks for this computer at its old address." under its summary, for another Mac with "A new command run there brings it back.", and for another user on this Mac with "A new command run as Builder brings it back."; Make a command opens the command panel for that kind.
- **Held on the local network**: a computer a command added that macOS holds on the local network (above, "Held on the local network") reads "a computer · joined today 14:06 · out of reach", and adds under its summary "It has not reached this computer since it joined. macOS lets Infinitary on Mac mini use your local network only once someone there allows it.
  Added by its address, this computer reaches it with your SSH key instead.", with a secondary Add it by its address before Remove.
  It opens one question in place: "Where to reach Mac mini" over "The address you use with SSH for it, as sam.
  Remote Login must be on there.", an address field with "sam@mini.local" as its placeholder, Add it and Cancel.
  Add it asks `inf:devices:add` with that address, as "By its address" does, and the row reads "Reaching sam@mini.local with your SSH key…", then "Telling Mac mini where this computer is now…".
- **Reached over your SSH**: a computer added by its address reads "a computer · sam@mini.local · connected using SSH" once its work said hello through the connection (`ssh` on its entry, `SshConnections.state`), "connecting using SSH…" before, and after an operation held it (an update, a change of address, finding it again) or a move of its work's folder, which make the connection again by design (`fresh` on the line, until an attempt fails), "reconnecting using SSH…" while this Mac tries again by itself after a drop, and its state on the right reads "connecting" in the first cases and "out of reach" otherwise (`deviceConnecting`, the one rule: out of reach with SSH state `connecting`; Subscriptions' device sign-ins, Projects' Runs on, the device forge rows, Remove's question and the remove-when-back line all say "connecting" by it, the sign-ins carrying it as `connecting`).
  It reads connecting for at most `CONNECTING_MS` (5 minutes) from when it began, and then reads "reconnecting", which every surface says as out of reach; a far end that keeps ending as moved keeps backing off on the ordinary waits and times out the same way.
  A computer never seen says "connecting using SSH…" on its line for every try, whether its first attempt failed or it dropped before its first hello, and "reconnecting using SSH…" only once it has been seen; its right side says "out of reach" as soon as an attempt fails or five minutes pass, while the line keeps saying connecting and the retries keep slowing.
  Remove's refusal, a placed conversation's refusal and a waiting Automatic start's words say connecting by the same rule, and the minute's "out of reach" feed line is held until it is really out of reach.
  The line then goes on: "starts the next time sam logs in there" while nobody is logged in there, and "could not start" when that user's session holds no background work, which no login mends.
  Stopped, its mono line says since when it is out of reach, the reason's two lines stand under its summary in `--warn`, and a secondary Try again stands before the rest.
  A ghost Change address stands on every such row and opens one question in place: "Where to reach Mac mini", its address in a mono field, Change it and Cancel; while it looks, the row reads "Reaching sam@studio.local with your SSH key…", with no state or Remove.
  Add it at its address while it is out of reach finds it again on the same row: "Reaching sam@mini.local with your SSH key…", then "Telling Mac mini where this computer is now…".
- **Remove** asks once in place, with Keep it focused, so Enter never removes: "Remove MacBook Air?
  It is cut off at once." over "To come back, it needs a new link." for a Mac that controls this first mate; "Remove Mac mini?
  Its unmerged work comes here first." over "Its task on website stops.
  Infinitary then removes what it set up there, with its sign-ins." and "website runs on this computer after." for a computer that runs work in reach; and "Remove Mac mini?
  It is out of reach."
  ("It is connecting." while its connection is being made) over "Its unmerged work on website is still there.
  Wait, and it comes here before Mac mini is removed.", with Remove when it is back and a danger Remove now, out of reach.
  Waiting reads "out of reach · removed when it is back" ("connecting · removed when it is back" while its connection is being made), with Keep it in place of Remove.
  A computer connected that takes no new work is asked the same, with "Remove Mac mini?
  It takes no new work." over "… Update it, and its work comes here before Mac mini is removed." and Remove once it is updated, since its work can come here only once it takes work again.
- **+ A computer** asks how to add it, over "Each way adds the same kind of computer.
  Pick the one that suits it.": "Paste a link into Infinitary there", a link for a Mac (`mac`), "Run a command there", the command for another Mac, or "By its address": "The other computer's address" over "The one you use with SSH.
  Remote Login must be on there.", an address field with "you@mini.local" as its placeholder, Add it and Cancel.
  On a Linux home, where the other computer is as likely Linux, the line under the label reads "The one you use with SSH.
  Its SSH server, or Remote Login on a Mac, must be on.", as does a row's own address question.
  Under them, the micro label "On this network" over the Macs nearby (above, "Macs nearby"): each by its name with the address it fills in, in mono, and "on your list" on one already added.
  The list is one Tab stop: ↑, ↓, Home and End move in it, ↓ in the field reaches it and ↑ from its first row goes back, and Enter or a click fills the field with the user name selected.
  While it is reached and set up, a row stands in the list with an idle dot, the address, and "Reaching sam@mini.local with your SSH key…", then the Mac's own name and "Preparing Infinitary for Mac mini…", "Sending Infinitary to Mac mini… 42.3 MB sent" with the count moving (above, "How far the copy has gone"), and "Starting Infinitary on Mac mini…".
  A refusal keeps the address in the field and shows its two lines in that aside, with Try again and Cancel.
  A Mac whose user runs another first mate's work asks once under the foot, with Cancel focused, before anything is sent there (above, "Another first mate's Mac").
  A computer whose Infinitary is updating reads "Updating Infinitary on Mac mini…" in place of what it runs, with no Update or Remove.
  **+ Running as another user** makes the command for another user on this Mac at once.
  The link or command stands in a panel at the top of the tab with Copy link or Copy command, "works once · 9:41 left" and Stop it, then reads what joined (`deviceJoinedLine`), and for a computer that runs work "Give it a project in Projects when you want it to run work.", with Done; once that computer has a sign-in the panel goes, and Done dismisses it before then; or "The link expired before any computer used it."
  (or "The command expired…") with Make a new one.
  Making a new one stops the one it replaces.
  The panel lives in the window's memory alone: it outlives a tab switch, and a restart forgets it.
- **How other devices find this computer**: one box of rows, On this network, On your private network and Over the internet, each with a dot, one line and a state.
  A link carries every way, so there is nothing to choose.
  Copy a link and Copy a command stand under the rows.

## Asking the first mate

Asked to add a Mac without being told which way, the first mate never picks one for the captain: the `device-invite` line tells it to ask him first on one decision card of its own, with every way as an option - a link, a command, the Mac's address, or another user on this Mac - and the address recommended, with a field for it, when he can name it.
Asked to connect a Mac, or to remove one, the first mate calls `app_change`, and the host files one card for the captain from typed facts, never the first mate's words (`HandoverOffer`, `src/shared/actions.ts`):

| Asked | The card | Its button |
| --- | --- | --- |
| `device-invite { name? }` | "Connect your MacBook Air": "Make a link here, then paste it into Infinitary on your MacBook Air." and "It works once, for ten minutes. Only your click can make it, so I never see it." | Make a link, beside Not now |
| `device-invite { name?, how: "command" }` | "Add your Mac mini by a command": "Make the command here, then run it once in Terminal on your Mac mini." and "It works once, for ten minutes. Only your click can make it, so I never see it." | Make the command, beside Not now |
| `device-invite { how: "another-user" }` | "Run work as another user on this computer": "Its work then runs as that user, with sign-ins of its own, and cannot control your first mate.", "That user, like every user on this computer, can read files in your home folder, outside private folders such as Desktop and Documents." and "Make the user in System Settings first. Then make the command here, and run it once as that user." | Make the command, beside Not now |
| `device-invite { how: "address", address }` | "Add the computer at sam@mini.local": "I set it up over Remote Login, with your own SSH key. Nothing needs to be open on it." and "Only your click can add a computer, so I ask first." | Add it, beside Not now |
| `device-update { deviceId }` | "Update Infinitary on Mac mini", for a Mac added by its address: "I copy this computer's Infinitary there over Remote Login, with your own SSH key, and start it again." and "Its running work stops for a moment and goes on after. Only your click can update it."; for another computer in reach on another version "I send this computer's Infinitary to it over your network, and it starts again." (another user on this Mac: "I start it again on this computer's own Infinitary.") with the same second line | Update it, beside Not now |
| `device-update { deviceId }`, too old to update from here | "Update Infinitary on Mac mini": "Its version of Infinitary is too old to update from here, so it needs a new command." and "Make the command here, then run it once in Terminal on Mac mini." (or "as Builder") | Make the command, beside Not now |
| `device-remove { deviceId }` | "Remove MacBook Air?", named from the list itself: "It is cut off at once." and "To come back, it needs a new link. Only your click can remove a computer."; for a computer that runs work "Its task on website stops, and its unmerged work comes here first." and "Then I remove what I set up there, with its sign-ins. Only your click can remove it." | a danger Remove Mac mini, beside Keep it |

The button's effect is `open` on `devices` with `make` (`link`, `command` or `user-command`), `add: <address>`, `update: <id>` or `remove: <id>`; the captain's click opens Settings -> Devices, which makes the link or the command, adds the Mac or updates Infinitary there, or removes the device, on arrival.
On a Mac controlling this one, the same button sends nothing and says to do it on this Mac (`docs/view.md`, "Card buttons that open Settings").
A value a line does not read, such as an address that is not one, is refused as `app_change`'s answer, and no card is offered for it; so is updating a computer out of reach, whose version the home cannot tell, or one on this Mac's version already.
`app_state` carries each computer's `otherVersion`, so the first mate can say which run another version.
A computer that runs work out of reach is not removed on arrival: its question opens instead, so the captain chooses whether to wait for it.
A link or a command therefore exists only after the captain's own click and lives in the panel alone, never in a card, its thread, a feed line, a record entry or a transcript.
Asking twice revises one card, and only the host's cards carry the `devices` target: no agent's `emit_card` offers it.

## While a link is open

The connection listens while something is paired, a link is open, or a computer removed while out of reach has yet to hear it, so a device can use its link, and a command can get Infinitary with it.
A link that expires with nothing paired stops the listener.

## Threats and what meets them

| Threat | What meets it |
| --- | --- |
| Someone on the same network reads or changes the traffic | TLS 1.3 on every address, loopback included. No plain listener exists. |
| A machine answers in the home's place: another macOS user holding the port, a spoofed address on the network, or a wrong address in a link | The device checks the pin before it sends a request or a code, and its key signs only that handshake, so an impostor learns at most which device dialed, nothing it can use. A port someone else holds can keep the home from listening, said in its log, or take connections on another address: they can deny the connection, never join it. |
| Another macOS user on this Mac | Loopback gets no shortcut: it takes the same TLS and a key the home paired. The devices folder is 0700 and its files 0600. The window's own IPC is not reachable from another user. |
| A web page in a browser on either Mac | A request with an `Origin` is refused on `/connection` and `/pair`. The home sends no CORS headers, and a browser trusts neither key. |
| A page or a document opens a link | Nothing answers the scheme. A device joins only on its person's paste and confirmation of the kind and the address, so a stranger's link cannot make this Mac a computer that runs work for their home. |
| Someone on the same network sees the announcement | While a phone is on the list, any network this Mac is on, public Wi-Fi included, learns that Infinitary runs here, this Mac's name and the connection's port. It carries no key and no secret, and learning it joins nothing: a device still needs an open link and the home's pin. |
| A device says `system` to change what it becomes | The word can only narrow a link for a Mac to a `view`; it never widens, and a link for another user refuses it. |
| Work run as another macOS user on this Mac reads the captain's files | Nothing in the app: macOS opens every home folder to every user on the Mac, outside private folders such as Desktop, Documents and Library, so that user reads the rest of the captain's home folder. The card, the Terminal question and Devices say so, and the app changes no permission (the captain's pick on FI3-862, words only). |
| Work run as the captain on the home Mac | A computer that runs work dialing from this Mac as the home's own macOS user is refused (`same-user`): its work would read and change everything the captain can. Where it dialed from is read off the socket; the user is its own word, so this guards a mistake, and code already running as the captain is out of pairing's reach (below). |
| Someone else sees a link: on the clipboard, in a message, in a screen share, or pasted into a conversation | It works once, for ten minutes, for the kind set at home; that bound is the guard. If someone else uses it first, the device it was meant for is refused as `used`, and the other one is on the list to Remove. |
| Guessing a link | Its code is 256 random bits, kept only as a hash and found by lookup. |
| A link used to find the home again | Only a key already on the list is kept, and only the device holding it can show it in the handshake; the device sends it only after the link's address answers with the home's own key. The one change is that the link is spent: no new device joins and nothing about the listed one changes. |
| The home's saved files are read later, from a backup | The list holds pins, which are public. The home's key would let someone answer as the home to its devices: show them a false stage and read what a view sends. It cannot be used to join the home or to learn a device's key. After any exposure, delete the folder and pair every device again. |
| A paired Mac is lost or stolen | Remove cuts it off at once, and its key is useless afterwards. It cannot add a device, remove one, or keep itself on the list. Until it is removed, a view's typed words are the captain's own words, so it can ask the first mate for an own-words change, as the captain chose (FI3-709); it can also start work and answer cards. |
| A view's saved grant is read later, from a backup of that Mac | It holds the view's own key (`userData/joined/home.json`, 0600, `docs/view.md`), which lets someone reach the home as that Mac until it is removed there. Leave deletes it, and Remove makes it useless. |
| A computer that runs work reads the stage, or a view runs work | Kind is set at home, checked at the claim, and checked on every request. A `work` device is sent no push, asks only the work requests, as itself, and is answered them only about a task the home runs there; a view is refused them. |
| A prompt-injected first mate | It can neither make a link nor remove a device: it can only offer the host's card, whose words the host writes from the list and whose button only the captain's click runs. `app_change` reads back the list, never a link. |
| Code running as the captain on the home Mac, such as a crewmate's shell | Out of pairing's reach: the same macOS user can read the home's key and add an entry to the list, which takes effect at the next launch. Crewmate isolation is social (`docs/architecture.md` §2, §4). |
| Flooding the listener | It listens only while something is paired, a link is open, or a removed computer has yet to hear it (thirty days at most). A handshake, the request headers and `/pair` each have 10 seconds. `/pair` and `/firstmate` take 4 KiB at most. Frames are capped and slow devices cut (`docs/connection.md`). |
| Someone else sees a command, or reads it off the other Mac while it runs | It carries a link, with a link's bounds: once, ten minutes, the kind set at home. While it runs on the other Mac its words are visible to that Mac's other users; if one of them uses it first, the intended Mac is refused as `used` and the other is on the list to Remove. |
| Getting Infinitary from this Mac | `/firstmate` answers only the holder of an open link for kind `work`, or a computer that runs work already on the list proving its own key in TLS, over TLS pinned to the home's key, and never spends a link; what it sends is the same app anyone can download. Nothing is fetched or written on the other Mac before its person's yes, and the copy joins only with that same link. |
| Updating a computer over the connection | Only the captain's click asks the update order, and only of a computer on the list; the computer gets Infinitary only from the home its grant pins, keeps it only once it arrived whole, and runs only what its background starts from its own folder. A prompt-injected first mate can only offer the card. |
| A command's words running on the other Mac | Every value - the link, this Mac's name, the address - is its own quoted word after a script that names none, so a name cannot add a command. |
| An older protocol or a replayed handshake | TLS 1.3 on both sides, with no early data and no resumed session. |
| A misleading device name | The name is limited as above, and the list shows when each device was added and its kind as the home set it. |
| A connection forwarded through SSH reaches this Mac from its own loopback | Where a computer joins from is this Mac's own finding before its link exists - a token only this Mac has, read back over the captain's SSH - and the link carries it; the claim reads that, never the socket. The user Infinitary runs as on this Mac is still refused, and another Mac with the same user number joins. |
| A computer that reaches this Mac through its SSH connection is pointed at an address | Its link and grant say `via=ssh`: a dial with no private socket is refused before anything is sent and never goes to the address instead, and whatever answers at a socket must still show this Mac's key. |
| Another user on that Mac plants a socket, or reads the route | The route names a socket this user owns, in a folder only this user may enter, or it is no route; it holds no key and no link; and the pin, not the socket, decides who answers. |
| Something answers at an address in the other Mac's place | The captain's own SSH checks it is the Mac it reached before, in batch mode it trusts no Mac it never reached, and the app never loosens either, so it refuses before anything is sent. A link also checks the home's key from the other side before it is used. |
| The link on its way to a Mac added by its address | It rides the captain's own SSH and reaches the work mode on its input, never in an argument that Mac's other users could read; it works once, for ten minutes, and is used within seconds or closed. |
| An address made to read as something else | It is one address: no space, no leading dash, and it follows `--`, so it cannot be an option to SSH or a word to a shell. The remote command is a fixed script with every value its own quoted word. |
| The captain's SSH key | It never leaves his agent or his key file: the app reads neither, forwards neither, types no passphrase and stores no password. |
| The password typed once to let Infinitary's own key in | It goes only to the Mac whose check line the captain said yes to, checked by SSH before it signs in, on a run that asks nothing else. It is never an argument, in the environment or in a file: it passes from Infinitary to its askpass on SSH's own input, only when that askpass asks with a word only that run knows, and its bytes are zeroed after. No feed line, log, saved file or task record holds it. |
| Infinitary's own SSH key | Its private half stays in its own 0700 folder, 0600, is never added to an agent and never leaves this Mac; only its public half is placed there. |
| A Mac added by its address claims to run this first mate's work already | The look only reads a pin and an id, both public, and decides what the feed says and whether a Mac in reach is left alone. Finding this Mac again still needs the key on the list, shown in the handshake; any other key is told `removed` and joins anew with the captain's one-use link, as Add it would have. |
| The connection this Mac keeps to a Mac it added by its address | Its own master and control socket, in a 0700 folder only this user enters, never the captain's shared connections; only the one forward the app adds, over the control socket with no setting read; every other request fails once the master is gone instead of connecting anew. A crash ends the controller there through its input, and silence through its 75-second lease. |
| An address that reaches another Mac later | Updating, changing the address and removing each check there first that the folder runs work for this home as that computer, and touch nothing else. A host key that changed stops the connection until the captain's Try again. |
| A prompt-injected first mate asks to add an attacker's Mac by its address | It can only offer the card, which names the address; only the captain's click reaches it, and a Mac added runs no work until the captain sets a project to run on it. |

## Not yet

- Checking this Mac's own SSH connection between two real Macs on a shared network, with nobody at the far one (FI3-970's acceptance): the tests stand in the far Mac as another folder on this one, over a throwaway SSH server.
- Checking a real Mac add a real Linux computer by its address with the published AppImage: the tests stand in the far computer on the same one, Linux on hosted Ubuntu, and the AppImage with a stand-in.
- Linux on an Arm chip, and Windows, by their address: no Linux Arm build is published, and Windows would be an adapter of its own (`FAR_SYSTEMS`).
- The command for another computer from a Linux home to a Mac, and a Mac updated over the connection from a Linux home, unpack the published zip with that Mac's own ditto; no test runs a Linux home with a Mac on its other side.
- What runs work, and the requests it asks, are `docs/helper.md`.
- A device following this Mac to a new address on its own: after the address changes, a Mac that controls it needs Leave and a new link, and another Mac that runs work a new command (above, "Finding the home again"); one added by its address is reached over this Mac's own SSH, and another user on this Mac dials loopback, neither of which moves.
- Updating, over the connection, a computer joined before `WORK_UPDATE_SINCE`: it knows no update order, so a new command run there once updates it.
- Checking on a real Mac that a Mac added by its address starts its work at its user's next login; the tests stand in launchd.
- Checking that the connection follows a real network change, a laptop joining another Wi-Fi: the tests stand in this Mac's network.
- This Mac's row saying what it runs and is signed in to.
- A setup row for git or Claude Code missing on the computer: the card says what the join found and asks for nothing about it.

- A Mac that joined at its first launch keeps the app the person installed and its work follows that app; updating it from here keeps a copy in its work folder, as for a Mac a command added (`docs/helper.md`, "A Mac that also controls").

## Tests

- `src/shared/devices.test.ts`: the link and the name, and every malformed link refused.
- `src/core/devices/identity.test.ts`: the certificate carries its key and verifies, the home's key survives a restart, and its files are 0600 in a 0700 folder.
- `src/core/devices/pairing.test.ts`: one use, expiry on an injected clock, the kind rule, one entry per key, Remove, the saved list and its refusals, a computer that runs work's user, `same-user` and `onThisMac`, and a listed key finding the home again with a new link while a removed one hears `removed`; and the command for another user on this Mac naming loopback whatever this Mac's address, while every other link names that address.
- `src/core/connection/connection.test.ts`: the whole join over TLS against the real pairing - a wrong, used or expired link refused, an impostor's key refused before anything is sent, Remove cutting a device before it returns, loopback with no key or a stranger's key refused, and each kind's limits.
- `src/core/core.test.ts`, "the connection serves the core to paired devices": the real core makes the links through its own requests, devices that know only the wire join and use it, the first mate can only offer the host's cards, the feed names who joined, and nothing saved holds a link.
- `src/core/core.test.ts`, "words typed on a paired Mac are the captain's own words": a view joined over the real connection asks the real first mate, in its input, to remove a project and, under a first mate card, to move the projects folder, and both changes are made.
- `src/core/core.test.ts`, "a development run keeps the connection to loopback at its own port": with the stand-in, a link names `127.0.0.1` at its port, a device joins there and the connection listens nowhere else, wired as the app wires it; a packaged build ignores it.
- `src/core/devices/pairing.test.ts` also holds Stop it, the joined callback and the address choice; `src/core/orchestrator/firstmateAgent.test.ts` the cards the host files; `src/renderer/src/settings/DevicesTab.test.tsx` the tab's words and states.
- `src/core/core.test.ts`, "says in Devices while a Mac that controls this Firstmate is connected": the real core and connection, wired as the shell wires them, list and push a view in reach and controlling while connected, and out of reach since it went, kept by pairing.
- `tests/e2e/devices.spec.ts`: the captain asks the first mate to connect a Mac, clicks Make a link on its card, a device joins with the link from the tab, its row says it controls this first mate until it goes, Remove cuts it off, and no card, feed line, record or saved file holds the link.
- `src/core/devices/homeLink.test.ts` and `tests/e2e/view.spec.ts`: Leave from the device, and the app joining as a view (`docs/view.md`).
- `src/core/devices/pairing.test.ts`, "joins another Mac as a Mac", "keeps the kind of a computer that finds this Mac again" and "hands Leave from a Mac that runs work to Remove"; `src/core/connection/connection.test.ts`, "lets a Mac hold its window's view and its work at once" and "cuts a device whose hello says it does what its kind never does"; `src/core/devices/computers.test.ts`, a Mac's one row; and `tests/e2e/view.spec.ts`, "a Mac joined at its first launch also runs that Mac's work": the kinds and what each connection may do.
- `src/core/devices/joinCommand.test.ts`: the command for another Mac run by the Mac's own `/bin/sh`, curl and tar in a UTF-8 locale, against the real pairing and connection and a stand-in bundle - asked first, the app got with the link and started to join, nothing left behind; a no, a Mac out of reach or not that Mac, and a used, expired or stopped command; a name that cannot change what runs; the same command on a stand-in Linux computer, stopped before anything where it cannot make a user namespace and asking as before where it can; the command for another user; and `/firstmate` itself, for a work link only and never spending it.
- `src/core/devices/pairing.test.ts` also holds `opened`, last seen, waiting to remove, and listening for a computer removed out of reach; `src/core/placed/placedSessions.test.ts`, "removing a computer that runs work", Remove over the real supervisor, record, Pi and connection - in reach, when back, and now.
- `src/renderer/src/settings/DevicesTab.test.tsx` the rows, panels and questions; `src/shared/devices.test.ts` the words; `src/core/orchestrator/firstmateAgent.test.ts` the command and remove cards.
- `tests/e2e/devices.spec.ts`, the second test: another user joins with a command made from the first mate's card, Devices lists what it runs, out of reach Remove waits and Keep it takes that back, and Remove takes it off with its project run here.
- `src/core/devices/dialTarget.test.ts`: a link for a computer that reaches this Mac through its SSH connection joins, connects and is answered through a private socket that does what the forward does, found to be another Mac with the home's own user number; it never dials its address, with or without an address given; nothing answering at a socket, or another key, is refused; a direct grant may dial through a socket with the same keys; and finding the home again moves a grant that dials an address onto the SSH connection, never back.
- `src/core/devices/pairing.test.ts`, "reads where a computer joins from off its link", "makes a link that reaches this Mac only through its own SSH connection" and "keeps a computer on the list, out of reach": the link's locality over the socket's, the link naming loopback, `connection: "ssh"` kept and never an address change, and an unreadable `ssh.json` never written over.
- `src/core/devices/sshConnections.test.ts`: this Mac's own SSH connection against a throwaway SSH server and a stand-in controller there - the socket forwarded to this Mac's listener carrying a computer's pinned connection, connected only on its welcome, beats, and nothing left on either side once stopped; tried again after a drop; stopped on a changed host until Try again, said once each way; a locked key tried again quietly every few minutes and at once on waking, still stopped in Devices and said once, and back by itself once unlocked; a key its app did not approve, a stand-in agent that asks before each use, stopped with its own reason, tried again quietly the same way, and back by itself once the app approves; a key whose app quit and left its socket behind, stopped with its own reason, tried again quietly, and back by itself once the app opens; stopped on Remote Login that will not forward and on Infinitary gone there; held while an update runs; a connection a find-again gives a computer a command added made only once that find ends; nothing tried asleep and at once on waking; removal in reach cleaned up over SSH after the connection let go; and a removal out of reach tried quietly and given up after thirty days.
  `src/core/helper/connect.test.ts`: the controller itself - its private socket, its route published only once this Mac answers through it, renewed on beats, withdrawn with its folder when the home lets go or goes quiet, ended when a later connection took the route, and another home's or computer's folder refused untouched.
- `tests/e2e/devices.spec.ts`, "reached over this Mac's own SSH": added by its address from the keyboard, connected using SSH, back by itself after this Mac restarts at another port, stopped with its reason when the host changed, and Try again, Change address and the `devices.try-again` command, each by keys.
- `tests/e2e/devices.spec.ts`, "leaves for another Firstmate": a Mac added by its address whose grant names another home while this Mac is quit, stopped as `other-home` with its reason in Devices and the feed, Try again and Change address absent, Remove by keys asking only to remove it now, and the feed saying nothing of this first mate's was there to remove.
- `src/core/devices/remoteLogin.test.ts`, the password: against a throwaway SSH server that offers passwords, a refused key asks for the password with nothing placed; a wrong one, through the Mac's own SSH and askpass, is said and asked again; with the right one (invented, which a stand-in for that server takes) Infinitary's own key is placed, 0600 in a 0700 folder, the Mac joins, and a later add reaches it with that key and asks for nothing; a Mac that takes no password says so; a Mac unlike its remembered key, or none remembered, never gets the password; and no argument, environment, feed line or saved file holds it, with every askpass folder gone.
  Its pairing folder has a space in its path, as Application Support does.
- `src/core/devices/nearby.test.ts`: Macs nearby against dns-sd's own lines in memory - each Mac asked its name once, four at a time, this Mac left out and nothing listed before its names are read, a Mac gone from every interface taken off, macOS's policy-denied answer said and a Mac that answers after listed, another error or an ended run said as could not look, a browse that ran its time followed by another with no blink, and nothing running once stopped or a minute after the last ask; `src/core/devices/dnsSd.test.ts` the same through a stand-in program, every run gone once stopped.
  `src/shared/nearbyMacs.test.ts`: the address a Mac fills in and which Macs read as on your list; `src/renderer/src/settings/DevicesTab.test.tsx`: the list, its states and its keys.
- `src/core/devices/announce.test.ts`: this Mac announces itself over Bonjour only while a phone is on the list, once, under its own name at the connection's port, stops with the last phone, starts again after a run that ended by itself, and starts nothing once disposed; `src/core/devices/dnsSd.test.ts` the held run ending dns-sd when stopped.
  `src/core/devices/pairing.test.ts`: a phone joins as a `view` by a link for a Mac or an older `view`, is refused a link for another user here, finds the home again, and is never a computer that runs work.
- `tests/e2e/devices.spec.ts`, "lists Macs nearby but this one": with a stand-in dns-sd, this Mac is not a row, ↓ and Enter fill the field with the user name selected, a changed user name is typed, the Mac is added over a throwaway SSH server and marked on the list when the aside opens again, and closing it leaves no run of dns-sd; "has not allowed the local network": the list says so and a private network's name still goes in.
- `src/core/devices/remoteLogin.test.ts`, "how far the copy has gone": a copy of incompressible bytes over a throwaway SSH server, its count said at every piece, each more than the last, its last count the archive's own size, one run of lines in the feed's words between preparing and starting, no total and no percentage; said at most once a second, a second copy says fewer counts and the same last one.
  `src/core/devices/appArchive.test.ts`: the count's rule, its first bytes at once and its end once; `src/core/core.test.ts`: a count rewrites its line in place while it is Activity's newest, and one after another line writes its own; `src/renderer/src/settings/DevicesTab.test.tsx`: the row preparing, sending with its count and starting, on a new row and on a computer found again.
- `tests/e2e/devices.spec.ts`, "says how far the copy has gone": an add by its address with a stand-in carrying incompressible bytes hears preparing, counts that rise, and starting, with no share of a total, and the feed keeps the last count as one line beside the starting line.
- `tests/e2e/devices.spec.ts`, "did not let your SSH key in": after the check line the aside asks for the password in a hidden field, says a wrong one above an empty field, and adds the Mac with Infinitary's own key, all by keys, with neither password in the feed, a card, a task, a saved file or an ssh's arguments.
- The SSH tests run on a Mac and on Linux alike: the throwaway SSH server is the system's own OpenSSH, and on Linux the far computer is Linux, so the stand-in Infinitary there is an AppImage (`STAND_IN_APP`, `tests/helpers/standInFirstmate.ts`) and the server stands in Xvfb and FUSE where the computer lacks them, a library list that holds every library the AppImage needs, and the user-namespace probe, since the stand-in uses none of them.
  A command for another computer that a test runs on that Linux computer outside SSH gets the same stand-in probe (`withNamespaces` in `tests/e2e/run-work.spec.ts`), since a hosted runner's kernel may refuse the real one and the command would stop there.
- `src/core/devices/remoteLogin.test.ts`: adding a Mac by its address with the Mac's own `/usr/bin/ssh` in batch mode against a throwaway SSH server on loopback (`tests/helpers/sshServer.ts`), the real pairing and connection, and a stand-in Infinitary that joins at the wire (`tests/helpers/standInFirstmate.ts`) - the copy sent whole, the link on its input and never in its words, each step said; every refusal, from a locked or refused key, a key whose agent did not approve it or quit, taking its socket or leaving it behind, Remote Login off, no answer, a Mac never reached or answering unlike before, to not a Mac, a user already joined, this Mac's own user and a Mac that cannot reach this one back, with nothing started there and the link closed; a background the session there refused, said as such after adding and after updating, never as the next login; updating, and removing it there, or saying nothing of this first mate's was there to remove when its folder is another first mate's or holds nothing; and, with the stand-in keeping its grant, a Mac of this first mate found again at this Mac's new address as the same computer, one in reach left as it is with nothing sent, one this Mac removed set up anew, another first mate's asked about once with nothing sent, the captain's yes carried to the join there and its leaving said, and another first mate that still answers left as it is (`still-answers`).
  It also holds where the look finds that Mac is - this Mac, with the token gone afterwards, or another Mac whose user has the home's own number, which joins - and a private socket the Mac's own OpenSSH forwards from the app's own connection to the home's listener: it carries a pinned connection, is 0600 for this user alone and taken by a route, a forward the person's settings ask for stays closed, and once cancelled it answers nothing.
  `sshRefusal.test.ts` reads SSH's own messages as the Mac's SSH printed them.
- `src/core/devices/relay.test.ts`: a computer that runs work joins, connects and is answered through a relay, against the real pairing and connection, and a home that does not answer or another computer answering is refused through it as directly; each through a stand-in that does what nc does, and on a Mac through macOS's own nc; the relay stops once its socket closes, and only macOS dials another computer through it.
- `src/core/placed/placedSessions.test.ts`, "removing a computer that runs work": out of reach, Remove now on a computer added by its address removes what Infinitary set up there at once, keeps its unmerged work there, and leaves the home listening for nothing.
- `tests/e2e/devices.spec.ts`, the third test: the captain asks the first mate to add a Mac at its address, clicks Add it, and Devices adds it over SSH; an address nothing answers at says what to do there and in the feed; nothing saved holds the link.
  `tests/e2e/run-work.spec.ts`: the built app on the other side of SSH - a Mac's bundle, or on Linux the AppImage a Linux computer gets - joins, runs in the background, is updated, comes back by itself after this Mac's address changes, and is removed; and a Mac a command joined, stranded once this Mac moved, is found by Add it at its address as the same computer with its sign-in kept and is on this Mac's SSH connection from then on.
- `tests/e2e/devices.spec.ts`, "a Mac whose user runs another Firstmate's work": Add it asks once in Devices with nothing sent, Cancel holds the focus and changes nothing, and Leave it and add by keys adds it, with the leave on the join's input and its leaving in the feed.
  `tests/e2e/run-work.spec.ts`, "its home gone for good, a new home adds it by its address": the built app there, asked by the home's question, stays with a home that still answers, and once that home is gone leaves it as a removal would, keeping its unmerged working copy, and joins over the home's SSH.
- `tests/e2e/devices.spec.ts`, "this Mac's address changes": the app started again at another port, a computer added by a command shows the line and Make a command, whose command finds this Mac again as the same computer with its project.
- `tests/e2e/devices.spec.ts`, "a Mac a command added that macOS holds on the local network": a stand-in Infinitary joins with the command made in Devices, the list is left as a Mac elsewhere on the local network leaves it, Devices says why, and Add it by its address by keys finds it again over a throwaway SSH server, after which its run is connected using SSH.
  `src/core/devices/pairing.test.ts`, "says macOS holds a computer joined from another Mac on the local network", and `src/core/devices/computers.test.ts`: which computers read as held, until in reach once, and never beside `addressChanged`; `src/core/connection/connection.test.ts` and `src/core/helper/helper.test.ts`: the join's dial for the name welcomed and counted as nothing of that computer in reach.
- `src/core/devices/pairing.test.ts`, "keeps where each device last reached this Mac": where a device reached this Mac kept beside the list, the address changed or not, on no network, at another loopback port, and found again; "keeps the address a computer was found again at over Remote Login".
- `src/core/devices/pairing.test.ts`, "follows this Mac's network": a move told once two looks agree and only once, a moment off the network not told, a new address beside the one in use told, the captain's choice told once by the choice, and nothing looking once stopped; `src/main/shell.test.ts`: only a development build follows it, and stops with the connection.
- `src/core/devices/computers.test.ts`: the real pairing following a stand-in network, the real `WorkDevices` and `Computers`, and a computer out of reach that last reached the old address, said on the list only once the connection listens at the new one.
- `src/core/connection/connection.test.ts`: what a computer says of its version, taking work or not, and the update order reaching one that takes none; `src/core/devices/pairing.test.ts`: `/firstmate` by a computer's own key.
- `src/core/devices/computerUpdate.test.ts`: the list saying another version, and Update over the real connection, pairing and work mode composition - the copy got with the computer's own key and kept, another user here getting nothing, the run started again on this Mac's version, not back in time or by hand, and every refusal.
- `tests/e2e/devices.spec.ts`, "a computer on another version": Devices says so and Update brings it to this Mac's version, and one too old gets the command; `tests/e2e/run-work.spec.ts`, "updated over the connection": the built app gets the home's Infinitary with its own key, keeps it and ends for its background.
