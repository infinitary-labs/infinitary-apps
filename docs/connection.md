# The connection

How a paired device reaches the home's core: the same requests and pushes the window uses, over one WebSocket on TLS.
The home is the Mac that holds the record (`docs/architecture.md` §9).
The connection is the core's second adapter, beside the window's: it sits on the same two seams, `core.dispatch` in and `core.events` out (§17), and names no channel (`src/core/connection/connection.ts`).
The envelope around the contract's own requests and pushes is `src/shared/connection.ts`, which every client parses; both are published as JSON Schema in `docs/contract.json` with the version rule (`docs/contract.md`).
How a device pairs, and the keys both sides prove themselves with, is `docs/devices.md`.

## When and where it listens

- **Only while something is paired or a link is open.**
  `startConnection` follows the pairing seam (`PairedDevices`, below) and listens while `any()` holds.
  When the last pairing goes and no link is open it stops listening at once and closes every device.
  The desktop app composes it with the real pairing (`core.services.devices`), so with nothing paired and no link the shipped app listens on no address.
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

A device has a `kind`, set at the home (`docs/devices.md`, "The shape"), and each of its connections is a `view` or its `work`, as its hello says within what its kind may be: a `view` is Infinitary open on another Mac showing this one, and is sent every push; a `work` connection is a computer's work (`docs/helper.md`), sent no push, which asks only the work requests and is asked the home's orders (below).
A `mac` may hold one of each at once; a `view` device is only ever a view, and a `work` device only ever its work.

## The handshake and the numbering

A device's first frame is `hello`, carrying the contract version it speaks (`PROTOCOL_VERSION`), the version of Infinitary it runs (`appVersion`, from `WORK_UPDATE_SINCE` on), when it was connected before its cursor, for a `mac` what this connection is (`as`: `view` from its window, `work` from its work mode), what the device is (`system` and `chip`, from protocol 2.15; `docs/devices.md`, "The shape"), which the home keeps beside its kind (`PairedDevices.noteSystem`), and the spellings of channel names it reads (`spellings`, from protocol 8.2; below, "Two spellings").
A system or chip this version has no word for is a later major's, so its hello is closed as `protocol`; a device on a system the record has no word for leaves the field out.
Absent, a connection is what its kind is, and a `mac`'s is its work; a hello whose `as` its kind may not be is closed as `protocol`.
The home answers `welcome` with its own contract version, its journal's `epoch` and newest `seq`, what the version rule lets the device ask (`access`, below), its own `name` when it can read it (`computerName`, `src/core/devices/computerName.ts`; a view says the Mac it controls by it), the spellings of channel names it reads (`spellings`), and how the device catches up:

- `replay`: the pushes the device missed follow the welcome, in order, before anything else.
- `reload`: the device reads its state again through ordinary requests.
  A first connection is always a reload.

A `work` connection's welcome also carries `takesWork`: whether its version may take new work from this home, which needs the home's own major and `PLACED_WORK_SINCE` or later (`takesWork`, `src/shared/ipc.ts`; `docs/helper.md`, "Versions").
Whatever it says, the home hears what a `work` device said of its versions (`onWorkVersion`), and may ask it the update order, and from protocol 8.15 the download order and how far that download got (`docs/devices.md`, "Updating over the connection" and "Downloading over the connection").
A computer's join dials once only to hear the home's name, and its hello says so with `nameOnly`: the home welcomes it as any device, and tells nothing of it - never that computer in reach, its version, or a connection to ask (`docs/devices.md`, "Held on the local network").

A device allows 10 seconds for the pinned TLS dial (`HOME_DIAL_TIMEOUT_MS`), then another 10 seconds for the WebSocket upgrade and welcome (`HOME_WELCOME_TIMEOUT_MS`).
These waits are sequential, not a single 10-second first-connection limit.
A journey waiting for first contact allows both phases, rather than failing a still-pending attempt after the default 5-second poll.

Either way the device's cursor is then the welcome's `epoch` with the newest `seq` it holds.

`access` is `full` when the hello's major is the home's own or the one before it, and `read` for any other major, older or newer (`contractAccess`, `docs/contract.md`).
Both sides ignore a frame's fields they do not know, so a later minor can add one.

Every core push is numbered once, at the connection, by one journal per listening run (`EventJournal`, `src/core/connection/journal.ts`): `seq` counts from 1 in a fresh random `epoch`, and every welcomed device is sent the same frame under the same number.
The journal keeps the newest 4,096 pushes or 16 MiB of frames, whichever is smaller, and always the newest push.
A cursor is replayed when its epoch is this journal's and its `seq` is no newer than the journal's and no older than the push before the oldest one kept; anything else is a reload.
A home restart, or a pause in listening, starts a new epoch, so every returning device reloads.
Pushes made while nothing listens are not kept.

## Requests

A device asks with `invoke` (`id`, `channel`, `args`) and gets one `result` per `id`, either `ok: true` with the answer or `ok: false` with the reason, in whatever order the answers finish.

- A view's request for a core channel whose `reach` is `views` is forwarded.
  It goes to `core.dispatch` as the captain - the same actor the window's adapter stamps, because a paired view is the captain at another Mac - and the core parses the arguments itself, so its own refusals (a malformed request, a refused action) come back as the reason.
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

Every core channel in `src/shared/ipc.ts` declares its `reach`, and the type of the contract refuses one that does not.
A view may ask what the captain does on the stage of another Mac: talking, cards and their threads, task records and their bar, and the reads that draw them (cards and their pictures, tasks, projects, the feed, the crew strip, quota, model names, the captain's appearance and layout, the first-launch state).
It may also read and change the automations that run there (`inf:automation:*`, `docs/automation.md`).
Everything else stays home's: settings, sign-ins and accounts, paired devices, project setup, voice, added panels and their data, Observe, SQL, diagnostics, retention, and anything that acts on the home Mac's own screen.
`src/shared/ipc.test.ts` pins the list, so widening it is deliberate.

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

The home pings every device every 30 seconds and drops one that has not answered the previous ping.
A frame may be up to `CONNECTION_MAX_FRAME_BYTES` (64 MiB), room for the largest turn the contract admits.

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
- `src/core/connection/journal.test.ts` and `addresses.test.ts`: the numbering and the listening rule on their own.
- `src/core/core.test.ts`, "the connection serves the core to paired devices": the real core, two devices, a dropped one caught up exactly, and every no-argument read a view may ask parsed against its own schema after the wire.
- `src/core/core.test.ts`, "a client that knows only the published contract": `scripts/contract-client.ts`, which reads only `docs/contract.json`, answers a card and reads the feed over the connection, and the version rule's window from both sides (`docs/contract.md`).
- `src/core/devices/homeLink.test.ts`: the device's own side as the app as a view runs it (`docs/view.md`): catching up, refusing while out of reach, Remove and Leave; and a home and a device on two sides of the Infinitary rename, read on the wire.
- `tests/helpers/connectionClient.ts`: a device written against the wire alone (`connectClient`), dialing with a real grant through the device's own side of pairing (`src/core/devices/dial.ts`), at any target, and able to change its upgrade for refusal tests.
- `src/core/devices/dialTarget.test.ts`: the same join and connection through a private socket, and a grant that reaches its home only through the home's SSH never dialing its address.
