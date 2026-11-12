# The connection

How a paired device, and the window on the home itself, reach the home's core: the same requests and pushes, over one WebSocket on TLS.
The home is the Mac that holds the record (`docs/architecture.md` §9).
The connection is the core's adapter for its clients: it sits on the two seams, `core.dispatch` in and `core.events` out (§17), and names no channel (`src/core/connection/connection.ts`).
The window on the home is one of them, through the local door below (`docs/view.md`, "The window on the first mate's own computer").
The envelope around the contract's own requests and pushes is `src/shared/connection.ts`, which every client parses; both are published as JSON Schema in `docs/contract.json` with the version rule (`docs/contract.md`).
How a device pairs, and the keys both sides prove themselves with, is `docs/devices.md`.

## When and where it listens

- **For devices, only while something is paired or a link is open.**
  `startConnection` follows the pairing seam (`PairedDevices`, below) and listens for devices while `any()` holds.
  When the last pairing goes and no link is open it stops listening for them at once and closes every device.
  The desktop app composes it with the real pairing (`core.services.devices`), so with nothing paired and no link the shipped app listens for devices on no address.
- **On the local door, always.**
  Given `localDoor`, a folder, it also listens on a loopback port the system chooses, from start to quit, whatever is paired ("The local door" below).
  A change to where devices are listened for restarts only the devices' listeners and closes only devices; the door and its clients stay.
- **TLS 1.3 only, on every address.**
  Each listener serves the home's own key (`docs/devices.md`, "Keys") and asks the device for its own; it accepts no older protocol, resumes no session, and has no plain listener, loopback included.
  A handshake, the request headers and a whole request each have 10 seconds.
- **Loopback plus every address a link may carry.**
  It always listens on `127.0.0.1`.
  `listenOn` (`src/core/connection/addresses.ts`) adds each offered address, and `listenAddresses` admits one only when it is an address (never a name to resolve), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, the shared `100.64.0.0/10` a private network service such as Tailscale hands out, IPv6 `fc00::/7`), and on one of this Mac's own interfaces right now.
  A wildcard, a public address and a link-local one are refused.
  What a pairing link advertises is pairing's own value (`docs/devices.md`, "Where devices find this Mac"), read each time listening is reconciled; when the set changes, the connection stops and listens anew, so connected devices come back and reload.
  Pairing follows this Mac's network and tells its listeners when an address moves, so the connection listens where this Mac is now rather than where it was.
- **It says where it listens.**
  `listening()` answers each address it listens at as `host:port`, and `onListening` hears that answer each time it changes - a new listening run at another address, the first link or pairing, the last one gone; a new run at the same addresses says nothing.
  Settings -> Devices reads it, through `WorkDevices`, to say a computer still looks for this Mac at its old address (`docs/devices.md`, "Finding the home again").
- **One port and two paths:** pairing's port on each address, `CONNECTION_PORT` (47623) unless a development run stands in its own (`docs/devices.md`, "Where devices find this Mac").
  WebSocket upgrades go to `CONNECTION_PATH` (`/connection`); a request there that is not an upgrade is answered 426.
  A device uses its link once at `PAIR_PATH` (`/pair`, `docs/devices.md`, "Joining").
  Any other path is 404.
- A refused address or a failed bind is one log line; the connection stays off and tries again on the next change to what is paired.

## Who gets in

Every refusal happens on the upgrade, before the device can send a frame:

| The request | Answer |
| --- | --- |
| Carries an `Origin` header (every browser sends one, so no web page reaches the home) | 403 |
| Asks for another path | 404 |
| Is not admitted by the pairing seam, or its device's pairing went while it was asked | 401 |

The pairing seam is `any()`, `subscribe(listener)`, `identity()` (the home's TLS key and certificate), `admit(request)` (the paired device the upgrade request's TLS socket proves to be, or null), `holds(deviceId)` and `claim(body, request)` (a device using its link at `/pair`).
Pairing decides how a device proves itself; the connection never reads a secret from an address.
A change to what is paired reaches the connection before the change returns: every connected device whose `holds` no longer answers true is closed in that same call (`unpaired`), and a frame from a device no longer held is dropped and the device closed.

A device has a `kind`, set at the home (`docs/devices.md`, "The shape"), and each of its connections is a `view` or its `work`, as its hello says within what its kind may be: a `view` is Infinitary open on another Mac showing this one, and is sent every push, with pictures of the task browsers it watches as unnumbered `live` frames ("Live pushes" below); a `work` connection is a computer's work (`docs/helper.md`), sent no push, which asks only the work requests and is asked the home's orders (below).
A `mac` may hold one of each at once; a `view` device is only ever a view, and a `work` device only ever its work.

## The local door

How a client on the home itself, as the same account, reaches the connection with no pairing: the window there, and any second local client, such as a command (`src/core/connection/localDoor.ts`).
It follows the phone door's pattern (`docs/devices.md`, "A phone that joins by its address").

- **Its files.**
  When the connection starts it empties the door's folder (`<userData>/local-door`, `paths.localDoorDir`), makes it again only its owner can open (0700), and writes three files only their owner can read (0600): `address` (`127.0.0.1:port`), `pin` (the pin of the door's own TLS key) and `key` (256 random bits, hex), the key last.
  Each start is a new port and a new key; quit removes the folder, so a key from an earlier run opens nothing.
  `localDoor()` answers the address while the door is open.
- **Reading the key is the permission.**
  Only the account the home runs as can read it, and that account could already read the home's record.
  Another account on the same computer reaches the loopback port but not the key.
- **Its listener.**
  The same TLS 1.3, with a key of the door's own, made in memory each run and never written, so pairing still writes nothing, not even the home's key, until the first link (`docs/devices.md`).
  The client pins it as every dial is, and shows no key of its own.
  An upgrade on `CONNECTION_PATH` carrying the key in `x-infinitary-local-key` (`LOCAL_DOOR_KEY_HEADER`) is admitted; a wrong or missing key is 401, an `Origin` 403 and another path 404, before any frame.
  It answers no pairing and no download of the app: every plain request is 426 on `CONNECTION_PATH` and 404 elsewhere, except a POST on `COMMAND_PATH` (`/command`) carrying the same key, which goes to the captain's own command, `infinitary-axi`, while the app wires one (`docs/axi-commands.md`, "Infinitary from your terminal"); a wrong key there is 401 and an `Origin` 403.
- **What a local client is.**
  Every local client shares one id, `local` (`LOCAL_CLIENT`), and any number may be connected at once with the same key.
  It is no device: it is on no list, is never heard coming or going (`onViewDevice`), never says its system or version, is never told a version is waiting, and has nothing to `leave`.
  It is this computer's own build, so it changes things whatever contract either side says (`access: "full"`).
  It is a view, sent every push, and asks as the captain himself (`{ kind: "captain" }`, no `view`), the actor the window always had: every core request, what stays on the home (`reach: "home"`, Secrets included) too, but a computer's work, which is refused as asked only by a computer that runs work.
  Pages it would open open on the home (`docs/view.md`, "Pages it would open").

## The handshake and the numbering

A device's first frame is `hello`, carrying the contract version it speaks (`PROTOCOL_VERSION`), the version of Infinitary it runs (`appVersion`, from `WORK_UPDATE_SINCE` on), when it was connected before its cursor, for a `mac` what this connection is (`as`: `view` from its window, `work` from its work mode), for a view the oldest home major it can still change things on (`viewFloor`, its build's `VIEW_FLOOR`; `docs/contract.md`, "The version rule"), what the device is (`system` and `chip`, from protocol 2.15; `docs/devices.md`, "The shape"), which the home keeps beside its kind (`PairedDevices.noteSystem`), the spellings of channel names it reads (`spellings`, from protocol 8.2; below, "Two spellings"), and the name of each contract change it has (`changes`, `docs/contract.md`, "Changes by name").
A system or chip this version has no word for is a later major's, so its hello is closed as `protocol`; a device on a system the record has no word for leaves the field out.
Absent, a connection is what its kind is, and a `mac`'s is its work; a hello whose `as` its kind may not be is closed as `protocol`.
The home answers `welcome` with its own contract version, its journal's `epoch` and newest `seq`, what the version rule lets the device ask (`access`, below), its own `name` when it can read it (`computerName`, `src/core/devices/computerName.ts`; a view says the Mac it controls by it), the spellings of channel names it reads (`spellings`), the name of each contract change it has (`changes`), and how the device catches up:

- `replay`: the pushes the device missed follow the welcome, in order, before anything else (below, "Catching up").
- `reload`: the device reads its state again through ordinary requests.
  A first connection is always a reload.

A `work` connection's welcome also carries `takesWork`: whether its version may take new work from this home, which needs the home's own major and `PLACED_WORK_SINCE` or later (`takesWork`, `src/shared/contractFeatures.ts`; `docs/helper.md`, "Versions").
It carries `onHomeMac` too, from protocol 9.1: whether that computer joined from this Mac itself, as the home's list found it (`onThisMac`, `docs/devices.md`, "Where a computer joins from"), which the computer keeps on its grant and its work's priority follows (`docs/helper.md`, "In the background"); absent while the list does not say.
Whatever it says, the home hears what a `work` device said of its versions and its changes (`onWorkVersion`), and may ask it the update order, and from protocol 8.15 the download order and how far that download got (`docs/devices.md`, "Updating over the connection" and "Downloading over the connection").
A `view` connection's welcome carries `startedByCommand: true` only when that view's hello does not list the `every-view-asks` contract change, so a view from before one rule for every view still asks what every view now may; the next major removes the field.
A computer's join dials once only to hear the home's name and `onHomeMac`, and its hello says so with `nameOnly`: the home welcomes it as any device, and tells nothing of it - never that computer in reach, its version, or a connection to ask (`docs/devices.md`, "Held on the local network").

A device allows 10 seconds for the pinned TLS dial (`HOME_DIAL_TIMEOUT_MS`), then another 10 seconds for the WebSocket upgrade and welcome (`HOME_WELCOME_TIMEOUT_MS`).
These waits are sequential, not a single 10-second first-connection limit.
A pairing's request and a fetch of Infinitary on the pinned socket end once that socket has been quiet for the dial's limit, or for an update's own quiet stretch of a minute, each with its own words (`src/core/devices/dial.ts`): Node arms a request's own limit only on a socket it makes itself, so the request arms it on the pinned socket.
A journey waiting for first contact allows both phases, rather than failing a still-pending attempt after the default 5-second poll.

Either way the device's cursor is then the welcome's `epoch` with the newest `seq` it holds.

`access` is `full` when the hello's major is the home's own.
A `view` connection is also `full` from the home's view floor (`VIEW_FLOOR`) up to the home's major, and on an older home when the `viewFloor` its hello said reaches that home's major, provided its hello says a floor or it is a phone (`system: ios`); a `work` connection is `read` on any other major (`contractAccess`, `docs/contract.md`).
Both sides ignore a frame's fields they do not know, so a later minor can add one.

Every core push but a `live` one ("Live pushes" below) is numbered once, at the connection, by one journal per listening run (`EventJournal`, `src/core/connection/journal.ts`): `seq` counts from 1 in a fresh random `epoch`, and every welcomed device is sent the same frame under the same number.
The journal keeps the newest 4,096 pushes or 16 MiB of frames, whichever is smaller, and the newest push whenever it keeps any.
It keeps them only while something is paired or a pairing link is open: otherwise only the local door's clients dial, on the same computer, so each push is numbered and nothing is kept, and a local client that dropped reloads unless it missed nothing.
A cursor is replayed when its epoch is this journal's and its `seq` is no newer than the journal's and no older than the push before the oldest one kept; anything else is a reload.
A home restart, or a pause in listening, starts a new epoch, so every returning device reloads.
While the local door is open the run never pauses: a change to the addresses devices are listened on closes their connections but keeps the run and its epoch, so they come back and replay.
Pushes made while nothing listens are not kept.

### Catching up

A replay sends only what the newest whole list leaves (`replayOf`, `src/core/connection/journal.ts`; INF-3750's option C).
A card list (`inf:cards`) is pushed whole, so a later card list in the same replay replaces every earlier one.
A whole board (`inf:tasks`) replaces every earlier board and every change to one (`inf:tasks:delta`).
Each replaced push goes as an empty push under its own number, on `inf:replaced` (`REPLACED_PUSH_CHANNEL`, `src/shared/connection.ts`) with a null payload, so a device's numbering stays whole, as the phone requires, and it reads nothing from it.
A device from before the change ignores that push, as it does any push on a channel it does not read (`replay-newest-lists.md`).

The home then weighs the replay against a reload and answers `reload` when the replay would send more bytes.
A reload is weighed by what a view reads first on one (`RELOAD_READS`, `src/core/connection/connection.ts`): the card list, Activity, the whole board, the last reply, the conversation's state and the computers in reach.
Each is weighed by the newest answer to it the home wrote to any device in this run, or by the newest card list or whole board it pushed since, so the welcome never waits on a read.
While any of them has not been answered in this run, the device replays, as before the weighing.
A computer's window reads more than those on a reload, such as each thread it had read, so the weighing can choose a reload slightly heavier than the replay for it.

## Requests

A device asks with `invoke` (`id`, `channel`, `args`) and gets one `result` per `id`, either `ok: true` with the answer or `ok: false` with the reason, in whatever order the answers finish.
`args` leaves off empty arguments at its end (`invokeArgs` in `src/shared/connection.ts`), since JSON would write each as null and a request's optional last argument refuses null.
An empty argument before a given one still goes as null, so a request that can have one reads null there as absent, as `inf:task:run` does for a panel's move with no review.

- A view's request for a core channel whose `reach` is `views` is forwarded.
  It goes to `core.dispatch` as the captain, naming the view - the actor the window on the home asks as, because a paired view is the captain at another Mac - and the core parses the arguments itself, so its own refusals (a malformed request, a refused action) come back as the reason.
  Words a view types (`inf:converse`, `inf:cards:reply`) are therefore the captain's own words, own-words changes included (`docs/devices.md`, "The requests").
- A computer that runs work's request for a core channel whose `reach` is `work` is forwarded as that device (`{ kind: "device", deviceId }`), by the pairing its socket proved, once its welcome said it takes work (`src/shared/work.ts`, `docs/helper.md` "Holding a conversation").
  The core answers a work request only for a device, and a device nothing else.
  A view asking one is refused as asked only by a computer that runs work.
- A core channel whose `reach` is `home` is refused as answered only on the computer where the first mate lives, and a host channel or an unknown name as not a request this home answers.
  Neither reaches the core.
- A device whose `access` is `read` is answered its reads and sent every push; a channel whose `effect` is `change` is refused, until the device is updated, and does not reach the core.
- A device may send `leave` instead of a request: the home takes it off the list, as Remove does, and closes it as `unpaired` (`docs/devices.md`, "Leave").

The home asks a computer that runs work the same way, with `invoke` and one `result` per `id` (`HomeConnection.ask`): only a connected `work` device whose welcome said it takes work, and only the orders in `src/shared/work.ts`, `src/shared/signIns.ts` and `src/shared/resources.ts`.
In the core it reaches them through `WorkDevices` (`src/core/placed/workDevices.ts`), to which the shell attaches the connection once it starts it and from which it takes it back before it closes it.
Asked of anything else, or of a device whose connection goes before it answers, the request is refused as out of reach (`DeviceOutOfReachError`) and never asked again by the connection; the asker asks again under the same order id once the device is back.
`onWorkDevice` hears each such device come into reach and go.
`onViewDevice` hears each view come into reach, once welcomed, and go once its last connection goes; `WorkDevices` holds which are connected for Settings -> Devices (`docs/devices.md`).
A computer that runs work asks its work requests again after a drop under the same call id, which its home answers from what it kept; a view never asks again.

Every core channel of the contract (`src/shared/ipc.ts`, with its groups of channels in `src/shared/channels/`) declares its `reach`, and the type of the contract refuses one that does not.
A view of any first mate, with its window or started by a command, asks everything but what stays with that first mate's computer (`reach: "home"`): Secrets but the three a remote decision needs, and what is only ever that computer's own (look, dictation, voice model, Observe, release notes, Dock and update), with what only the window on that computer may ask of a first mate a command started (`docs/run.md`, "The window opened beside it").
The captain's panels, their files and data, and the SQL they read reach every view (`panels-in-every-window`, `docs/view.md`, "Panels in every window"), and so does the panel library their files import, for a phone (`panels-on-the-phone`, `docs/view.md`, "Panels on the phone").
Its computers and phones, the addresses they find it at, and its Knowledge reach a view (`devices-from-a-view`, `docs/devices.md`, "Settings -> Devices").
A page the first mate would open in a browser for a view's request goes to its views as the push `inf:app:open-page`, and a first mate started by a command, with nobody at its computer, sends every such page that way.
A sign-in whose browser returns to the first mate's own loopback address goes as `inf:app:sign-in-page` instead, and the view passes the return back with `inf:integrations:sign-in-return` (`docs/view.md`, "A sign-in that returns to the first mate's computer").
`src/shared/ipc.test.ts` pins the list, so widening it is deliberate.

## Live pushes

A picture of a task's browser goes only to the view that watches it, as a `live` frame (`{"t":"live","channel":"inf:browser:frame","payload":...}`), never through the journal: it has no `seq`, a replay never sends it again, and a welcome after a drop sends none (`browser-from-any-view`, `docs/task-browser.md` "The view").
A view's request to watch, size or stop watching a task's browser reaches the core with that connection as its viewer (`BrowserViewer`, `src/core/browser/browserViews.ts`), and the core sends that viewer's pictures down that connection alone.
The connection ends every watch it holds when it closes, so a view watches again after each welcome (`ViewBackend`, `docs/view.md`, "A task's browser on a view").
Per task, one picture is written at a time through the outbox; a newer one that comes meanwhile replaces any still waiting, so a slow link shows the page as it is now rather than a queue of old pictures, and `behind` still cuts a device that stops reading.
A view whose hello does not list the change is sent no `live` frame, since it never watches; a home that does not list it answers no watch, and its views say to update it.

What is happening in a turn now is live too (`streamed-events-live`): a streamed piece of a reply or its thinking (`assistant_delta`, `thinking_delta`), and a tool's start or an end that reports no usage (`tool_start`, `tool_end`), go on `inf:event` as `live` frames (`isStreamedEvent`, `src/shared/events.ts`).
They take no place in the journal, so a stream of them never pushes a dropped device's place out of what is kept, and a short gap still replays.
A view reads each again whole on its next event (the crewmate transcript and what it is writing now), so a replay that skips the ones it missed leaves it current at the next one.
A tool's end that reports usage stays numbered, since the usage reads follow it.
A phone is sent none of them, since it never reads them.
A view whose hello does not list the change is sent each as a `push` under the newest number already sent, which moves its cursor nowhere, so it reads them as before; the next major removes that.

The computers' processor and memory readings are live the same way (`computer-readings-live`): `inf:computers:resources` goes as a `live` frame, every two seconds while crew work runs or a screen asks (`docs/helper.md`, "Shared live readings").
Each reading is whole and the next one replaces it, so a replay that skips the ones a view missed leaves nothing behind.
A phone is sent none of them, since it never shows them, so they never wake it while crew work runs.
A view whose hello does not list the change is sent each as a `push` under the newest number already sent, as with streamed events; the next major removes that.

## Closing

| Code | Name | When |
| --- | --- | --- |
| 4400 | `protocol` | A frame that is not JSON text of the wire's shape, a request before `hello`, a second `hello`, or no `hello` within two heartbeats |
| 4401 | `unpaired` | The device's pairing went - Remove, or the device's own `leave` - or the last one did |
| 4408 | `behind` | More than 32 MiB waits to be sent to it; it comes back with its cursor |
| 1001 | `closing` | The home is quitting |

Stopping a listening run stops accepting connections and forwarding pushes at once, then waits for every device socket to close before resolving.
The close handshakes run concurrently, with one two-second grace for the whole run; any sockets still open at its end are terminated.
This lets a connected view hear `closing` before the app exits or its SSH connections stop, rather than mistaking a quit for lost contact.
A repeated `close()` waits behind the same drain, including one already underway for a changed address or the last pairing leaving.
HTTP requests do not extend this grace.

The home pings every device every 30 seconds and drops one that has answered no ping since the previous one (see "Pacing and liveness").
A frame may be up to `CONNECTION_MAX_FRAME_BYTES` (64 MiB), room for the largest turn the contract admits.

## Pacing and liveness

What the home writes to a device goes through that device's outbox (`src/core/connection/outbox.ts`), never straight to its socket.
The outbox writes each frame in pieces, as one WebSocket message in several fragments, and follows each piece with a ping whose payload names it.
A device's pong echoes that payload, so it says how much has arrived; a pong answers for its ping and every one before it, and one naming no ping answers for the oldest.
Only a window goes ahead of the newest answer, and the rest waits in the outbox.
The window starts at one piece (`pieceBytes`, 4 KiB) and follows the rate the answers measure: two seconds of it (`aheadMs`), growing by at most what was answered, as a TCP connection's start does.
A piece is a quarter of the window, never smaller than `pieceBytes`.
The heartbeat's own ping is a mark too, and any pong counts as an answer for the heartbeat.

So a device on a slow link answers every piece while a long catch-up arrives, instead of only once all of it has, and is not cut while it is still receiving.
Before the outbox, the home's ping waited behind everything it was sending: at 1 KB/s a catch-up over about 30 to 60 KB was cut 60 seconds in and started over.
The window bounds the other direction too: a ping a device sends, and the home's pong to it, wait behind about one window rather than the whole catch-up, so a Mac's link (`src/core/devices/homeLink.ts`, a ping every 10 seconds) and the phone's own ping are answered while it arrives.
At 1 KB/s that is about 8 seconds.
A device that stops reading still answers nothing, and is cut within two heartbeats.

A device on major 15 or later, or an older device whose hello lists `frame-parts` (`src/core/connection/frameParts.ts`), gets a frame longer than one piece as parts instead of fragments.
The outbox first sends `{"t":"parts","bytes":N}`, the frame's length in UTF-8 bytes, then each piece as a whole text message, and nothing else comes between them; a frame no longer than one piece still goes whole.
The device joins the parts into the frame and reads it as if it had come whole (`FramePartsReader`; on the phone, `PhoneParts` in `PhoneFrame.swift`).
A phone hears the computer only once a whole message has arrived, since its socket says nothing of a message still arriving, and gives up on a read when nothing has arrived for 40 seconds (`ReadOnlySession.answerWait`, `docs/ios.md`).
So before parts, an answer that took longer than that to arrive was cut every time: at 1 KB/s, a card list of about 80 KB read on reload was cut about 45 seconds in and read again from the start.
With parts the phone hears a part every piece, at most about 4 seconds apart at 1 KB/s, and a computer that answers its pings but sends nothing for a read it holds is still cut.
A device that does not list the change, such as an older phone or computer, gets every frame whole, and an older home sends no parts.
Every build of the app lists every change of its own (`homeLink.ts`), so it reads parts too; a device never sends parts to the home.

The kernel's send buffer and anything between the home and the device read eagerly, so the socket's own `bufferedAmount` says nothing about what a device has received; only its answers do.
`behind` counts what waits in the outbox and in the socket together.

## Where a device dials

A device reaches the home through one function, `pinnedSocket` (`src/core/devices/dial.ts`), and every dial goes through it: the check before a join, using a link, finding the home again, every connection after, and getting Infinitary from the home (`fetchFirstmate`).
Where a dial physically goes is apart from who must answer it.
The target (`DialTarget`) is an address, `host:port`, or a Unix-domain socket on the device's own Mac.
The authority is the home's pin and the device's own key, checked the same way whichever the target is: TLS 1.3, both certificates, no session resumed, and the pin checked before a byte of a request is written.
A socket gets no shortcut, as loopback gets none.
On macOS a dial to another computer's address goes through the system's own nc (`docs/devices.md`, "Through macOS's own nc"); a socket is dialed directly, since it is no dial to the network.
A link or grant is dialed at its own address unless a dial names another target.
One marked `via: "ssh"` reaches its home only through the private socket the home's own SSH connection forwards to its Mac (`docs/devices.md`, "Through the home's SSH"): with no socket to dial it is out of reach (`HomeRouteMissingError`), and it never dials its address instead.

## Two spellings

The Infinitary rename renames every code name and keeps the old names as aliases (the captain's answer on FI3-1780), so a channel's name has two spellings: Firstmate 3000's `fm:cards` and Infinitary's `inf:cards` (`src/shared/codeNames.ts`).
Each side's `hello` or `welcome` says which spellings it reads (`spellings`); this build reads both and says so.
A side writes a channel in its own spelling when the other side said it reads it, and in `fm` otherwise, which every version reads: a side that says nothing is from before the rename and reads only `fm` (`spellingFor`).
Each side reads either spelling as its own at the edge (`ownChannel`), so the core, a view and the work mode see only their own names, and a request in a spelling it does not know is refused as any unknown name is.
This build writes `inf` (step 8 of the rename), so it writes Infinitary's names to every side that said it reads them - Firstmate 3000 from the bridge release on says so - and Firstmate 3000's `fm:` names to a side from before the rename; it reads both.
A push is numbered once and written once in the journal, and respelled for a device that reads the other spelling at the moment it is sent (`pushFrameIn`), so every device still gets the same push under the same number.
The update order, `fm:firstmate:update`, keeps its one name in every spelling (`FROZEN_CHANNELS`), as do the download order, `fm:firstmate:update-download`, and `fm:firstmate:update-progress`, and as the paths `/connection`, `/pair` and `/firstmate` keep theirs, so a home on either side of the rename can still update a computer on the other (`docs/devices.md`, "Updating over the connection").
A spelling covers channel names alone: a shape's fields and values - an event's type, a work outcome's `firstmate` key, an SSH message - are the contract's, and change only under the version rule (`docs/contract.md`).
A development run may stand in either spelling for the home's connection with `INFINITARY_WIRE_SPELLING` (`fm` or `inf`), so two development runs rehearse a home and a device on two sides of the rename; a packaged app ignores it.

## Capabilities

`inf:app:healthcheck` carries `capabilities`, the names of what this home serves beyond its channel set (`HOME_CAPABILITIES`), so a client hides what a home lacks instead of reasoning about versions.
The names are open strings: a client ignores one it does not know, and a newer home's list still parses.
`connection` means paired devices reach this home over the connection as this page describes.

## Tests

- `src/core/connection/connection.test.ts`: each rule above against a stand-in core, the real event bus and the real pairing, the work requests and the home's own requests to a computer that runs work included, a view heard coming and going, and where it listens said only when that changes.
- `src/core/connection/localDoor.test.ts`, "the local door": its folder and files, its key admitting the captain with no device row and two clients at once, its refusals, no pairing on it, an earlier key refused, no pushes kept while nothing is paired, and its clients kept while devices' listeners restart.
- `src/core/connection/journal.test.ts` and `addresses.test.ts`: the numbering and the listening rule on their own.
- `src/core/connection/connection.test.ts`, "keeps streamed reply pieces and tool events out of the numbering": a returning device replays past a stream that outgrew the journal, a current view reads the stream live, a view from before the change under the newest number, and a phone none of it.
- `src/core/connection/outbox.test.ts`: the outbox's pieces, window and marks on their own, and the parts it sends a device that reads them; `frameParts.test.ts`: parts joined back into frames, and parts past their length refused; `connection.test.ts`, "pacing and liveness": a device receiving a long push through a slow link kept on one connection, one that stops reading still cut, and a long push sent in parts to a current device or an older one that lists `frame-parts`.
- `src/core/core.connection.test.ts`, "the connection serves the core to paired devices": the real core, two devices, a dropped one caught up exactly, and every no-argument read a view may ask parsed against its own schema after the wire.
- `src/core/core.contract.test.ts`, "a client that knows only the published contract": `scripts/contract-client.ts`, which reads only `docs/contract.json`, answers a card and reads the feed over the connection, and the version rule's window from both sides (`docs/contract.md`).
- `src/core/devices/homeLink.test.ts`: the device's own side as the app as a view runs it (`docs/view.md`): catching up, refusing while out of reach, Remove and Leave, a long push read whole from its parts; and a home and a device on two sides of the Infinitary rename, read on the wire.
- `tests/helpers/connectionClient.ts`: a device written against the wire alone (`connectClient`), dialing with a real grant through the device's own side of pairing (`src/core/devices/dial.ts`), at any target, and able to change its upgrade for refusal tests.
- `src/core/devices/dialAnswerEnd.test.ts`: a Firstmate fetch whose sink closes after the first piece, as tar's input does once tar has the whole app, still reads the home's answer to its end.
- `src/core/devices/dialTarget.test.ts`: the same join and connection through a private socket, and a grant that reaches its home only through the home's SSH never dialing its address.
- `src/core/devices/dialQuiet.test.ts`: a pairing whose home takes the request and never answers, and a fetch of Infinitary whose home stops sending part way, each ended after its quiet stretch with its own words, the part that came left unfinished.
