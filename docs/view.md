# The app as a view of another Mac

How the app controls the first mate on another Mac: it joins with a link pasted at its own first launch, then runs no first mate of its own, keeps no record, and asks the Mac where the first mate lives for everything it shows (`docs/architecture.md` §9).
That Mac serves it over the connection (`docs/connection.md`) as a paired Mac's view (`docs/devices.md`); a Mac it joins as also runs that Mac's work (below, "A Mac that runs work").
How it looks and reads is the design skill's `components/devices/JoinAnotherMac` and `RemoteControl`.

## What this app is

`Shell` (`src/main/shell.ts`) is the one place the main process asks what this app is, and it is one of two things:

- **The Mac where the first mate lives**: its own core, served to its window and to paired devices.
- **A view**: no core at all.
  The window's core requests go to the other Mac through `ViewBackend` (`src/main/view/viewBackend.ts`) and its link to that Mac, `HomeLink` (`src/core/devices/homeLink.ts`).

The window's calls, its pushes, its look, its frames' card pictures, its permissions and its focus and wake hooks all go through the shell, so nothing else in the main process reads a core directly.
The window asks `inf:devices:this-mac`, a host channel, for what this app is, and follows its push of the same name: `home`, with the Mac it last left, or `view`, with that Mac's name, its address, when this Mac joined, whether it is in reach and as of when, whether the two copies of Infinitary are too far apart to make changes, and how many times it had to read everything again.

What a view keeps is `JoinedHome`'s (`src/core/devices/joinedHome.ts`), the one writer over `userData/joined/` (0700, every file 0600):

| File | Holds |
| --- | --- |
| `home.json` | The grant (`docs/devices.md`, "Joining"), with this Mac's own key, the other Mac's name once it has said it, and when it joined |
| `appearance.json` | This Mac's own look while it controls the other: size, theme, wash, crew model names, default card size and how its panels sit, and the keys a person changed here (`docs/keyboard.md`) |
| `left.json` | The Mac it last stopped controlling, and whether it left or was removed |

It keeps no record of the other Mac's work: a view never opens the app's database, and its cards, tasks, feed and threads live only in the window's memory and the shell's.
Card pictures and project fonts it has shown are kept in memory for the run, up to 64 MB, by their name.

## Joining

The first-launch stage carries a second group under the provider chips, `YOUR FIRST MATE IS ON ANOTHER COMPUTER` with "+ Paste its link" and "+ Join by its address" (`src/renderer/src/devices/JoinAnotherMac.tsx`).
A link joins only by being pasted there and confirmed: nothing on either Mac answers the link's scheme.

1. The window reads the pasted text as a link (`parsePairingLink`) and refuses text that is not one before anything is sent.
2. It asks once, naming the address the link names: "Your first mate stays on the computer at 192.168.1.20.
   Control it from here?", and for a link for a Mac "It can also run work you give it, with sign-ins of its own."
   (`JOIN_RUNS_WORK`).
   It explains that this Mac shows the first mate while cards, tasks and conversation stay on that Mac.
   Cancel and set it up here is the alternative for keeping the first mate on this Mac, not a move of the other Mac's record.
3. `inf:devices:join` uses the link once as the link's kind - `mac`, or an older home's `view` - under this Mac's own name (`computerName`, `src/core/devices/computerName.ts`: the name macOS shows in System Settings, or the network name without `.local`), saying it joins with its window and, for a Mac, the macOS user its work runs as, and saves the grant.
   Paired as a Mac, it also sets its work up (below, "A Mac that runs work").
4. The shell stops this Mac's own core and its connection, becomes a view, and every window starts over as the other Mac's.

A refusal changes nothing here and says what happened: not a link, a link for another user on that Mac, used, expired, no longer open, nothing answering at the address, or something answering there that is not the Mac that made the link.
A development run may stand in another name with `INFINITARY_DEVICE_NAME`, so two apps on one Mac read as two Macs; a packaged app ignores it.
The Mac where the first mate lives takes a second app on its own Mac for a view, which only controls; a development run there may stand in another Mac for every device that joins with `INFINITARY_JOINS_FROM_ANOTHER_MAC=1`, so two apps on one Mac join as two Macs.

### Joining by its address

"+ Join by its address" reaches the same question with no link to copy (INF-1827, design skill `components/devices/JoinAnotherMac`, "By its address"), on a Mac and on Linux alike.

1. The person types the address they sign in to that computer with, such as `kun@studio`, and a port when its SSH server listens on another than 22 (`addressAtPort`); or picks a computer nearby, which fills the address from the "Your account" field above the list.
2. `inf:devices:join-at` signs in there with the person's own SSH (`RemoteLogin.linkAt`): the key-line question the first time, kept by address and port, and the password once when that computer refuses the person's key, letting Infinitary's own key in as Settings -> Devices does.
3. That computer's open Infinitary makes a one-use computer link (`docs/devices.md`, "A computer that joins by its address"), which the shell holds; the window gets only whether it runs work and names a private address.
4. The window asks step 2's question above, naming the computer the typed address names (`kun@studio` asks of `studio`), and `inf:devices:join-held` joins with the held link as step 3 above does, dialing first the host SSH reached; Cancel forgets it.

Each stop is one warning line with the address kept: Infinitary not open there, which starts nothing there; too old; controlling another computer; this computer itself; no curl on Linux; or Remote Login's own refusals.
Nothing reaches the feed or the record until the join itself.

## A Mac that runs work

A Mac (`mac`, `docs/devices.md`) both controls that Mac's first mate from its window and runs its work with no window (`docs/helper.md`, "A Mac that also controls"): one device on that Mac's list, whose window and work keep the same grant, each connection saying which it is (`as`, `docs/connection.md`).

- **Joined here at its first launch**: the grant goes to this user's work folder too, and the work starts in the background from this app (`workFromWindow`): a LaunchAgent on a Mac, a systemd user service on Linux (`docs/helper.md`, "In the background").
  A Linux computer joins a Mac's or a Linux computer's first mate this way, and a Mac a Linux computer's, each with its own system's Infinitary.
  Nothing runs there until a project is set to run on it.
- **Added by a command or its address**: Infinitary opened here with no grant of its own starts as a view of the home its work runs for, with that grant and no new link (`Shell.start`, `windowFromWork`).
  It follows where the work's grant dials, and dials through the route the home's SSH keeps when the home reaches it that way.
- **Another user on that Mac** only runs work: Infinitary opened as that user is its own.
- `thisMac`'s `runsWork` says it, so Leave says it stops that work too (below).

## The window on the first mate's own computer

The window on the computer where the first mate lives is a view of it too, over the same connection: every core request it makes goes to the first mate through the connection's local door, and every push comes back the same way (`LocalWindow`, `src/main/view/localWindow.ts`; `docs/connection.md`, "The local door").
It reads the door's address, pin and key from the door's folder at each dial, as any local client does, so it needs no pairing and is no row in Settings -> Devices.

- **What stays the same.**
  It asks as the captain himself, as before, so it keeps every request a view is refused, Secrets above all (`docs/secrets.md`): it stays the trusted surface, with no enrollment.
  Its look, keys, panels, voice, frames and files are this computer's own and never cross; pages it would open open here.
  The first mate still runs in the same process, Quit is unchanged, and journeys start the app as before.
- **A task's browser.**
  It watches a task's browser as a view on another computer does: once over the connection for every window here, its pictures arriving as `live` frames (`BrowserWatches`, `src/main/view/browserWatches.ts`; "A task's browser on a view" below).
- **Card pictures** are read from the first mate's own copy on this computer, as before, never over the connection.
- **A drop.**
  On one computer a drop is only a restart of the connection, so it dials again within a second, holding reads and refusing changes meanwhile, as every view does ("Reaching the other Mac" below).
  A welcome that could not replay what the window missed makes the window read everything again, as a view's does; with nothing paired the connection keeps no pushes to replay, so a window that missed any reads everything again (`docs/connection.md`, "The handshake and the numbering").
- **When the door cannot open**, when it never welcomes the window, or when it refuses the window's key, and for a command's first mate, which has no window, the window asks the core directly as before, and the log says why.
  A window that lost the door reads everything again from the core.

## What the window asks

`ViewBackend.dispatch` answers each core channel the window asks:

- A channel whose `reach` is `views` goes to the other Mac, as the captain at another Mac (`docs/connection.md`, "Requests").
  What a person types here is the captain's own words there, so the first mate there may make an own-words change on it, such as removing a project (`docs/devices.md`).
- `inf:shell:preferences` and the appearance and layout reads and writes are this Mac's own (`ViewLook`, `src/main/view/viewLook.ts`), starting from the other Mac's look the first time it is in reach (the captain's pick on FI3-681).
  Its own panels are off.
  The window's project focus rides that layout, so a Mac that controls another keeps its own focus, and its turns carry it to the first mate there as a hint (`docs/project-focus.md`).
- The window's keys are this Mac's own too, and never a core channel: the main process's installed map reads and writes them through `ViewLook`, starting on a new profile's keyboard preset, or Legacy for a look kept from before presets, and the other Mac never hears of them (`docs/keyboard.md`, "Changing keys").
- `inf:update:status`, `inf:update:check` and `inf:update:open-release` are this Mac's own: the app installed here, read by the same update checker the Mac where the first mate lives makes for itself (`createInstalledUpdateChecker`, `src/core/update/updateChecker.ts`; `docs/alpha.md`, "Update channels").
  The top bar shows the same update notice, with this Mac's version, channel and upgrade command, and the version in its line opens that version's release page here.
  The other Mac is never asked: its own notice is about its own app.
- Anything else is refused here, without being sent: "answered only on the computer where your first mate lives".
  That is what stays with the first mate's computer (`reach: "home"`): its Secrets (`docs/secrets.md`, "Remote decisions"), and what is only ever that computer's own - its look, dictation, voice model, personal panels and their extensions, Observe, release notes, Dock and update.
  Its computers and phones, the addresses they find it at, and its Knowledge are asked there (`reach: "views"`, the `devices-from-a-view` contract change), as the captain at another computer.
  Whatever started the first mate, a view asks every other request (`docs/connection.md`, "Requests").

Only the pushes a view shows reach the window (`VIEW_PUSHES`): the feed's events, the cards and their threads, quota, model names, the task board, a sign-in's steps, the sign-ins where projects live, integrations, Diagnostics, and the first mate's computers and phones with their addresses, nearby computers, sign-ins, presence and resources.
Streamed reply pieces and tool starts and ends arrive as `live` frames, outside the numbering, and reach the window as events as they did numbered (docs/connection.md, "Live pushes").
The other Mac's look, voice and panels are its own.

A file given to the input or a reply goes to the other Mac only inside the message: a picture or text file as its chip, any other file not at all, because a path on this Mac means nothing there (`docs/composer.md`, "Files").
The input's line names that Mac: "Only pictures and text files can go to MacBook Pro.
Other files were not added."

Frames are built by this app, as on the Mac where the first mate lives; a card picture's name is asked of the other Mac (`inf:cards:picture`, a `views` read that answers the home's own copy as base64), and the frame scheme serves the answer (`src/main/frames/frameProtocol.ts`).
A project font a preview's `@font-face` names is asked of the other Mac the same way (`inf:cards:typeface`, a `views` read of a minted font name answering the home's own copy as base64), and the frame scheme's `typefaces` host serves the answer; a font the home cannot answer is not served, and the preview draws in the app's own typefaces (`docs/card-authoring.md`, "Fonts by reference").
A card's demo recording plays in this app's picture viewer a range at a time (a GIF demo is asked whole, in the same pieces, each time Play is pressed): each range is asked of the other Mac at most one piece of 1 MB at a time (`inf:cards:media`, a `views` read of a minted recording name, an offset and a length, answering that piece as base64 and the whole file's size), never kept, since the player asks again for what it needs.

## The first mate's own words

The first mate's core writes its own computer as this computer (`HERE`, `src/shared/deviceNames.ts`), which on a computer that controls it would name the computer the captain is at.
`ViewBackend.dispatch` names the first mate's computer there instead, by the name the view shows for it (`hereAs`, through `namedHere` in `src/main/view/namedHere.ts`):

- A refusal the first mate's computer answers, in the shapes the contract's refusals take: the answer's `refusal`, its `text` beside `ok: false`, and its `warning` beside `ok: true`.
  A card's page from a task that runs elsewhere reads "This task runs on another computer, so its project's page does not open on MacBook Pro."
- A request it refused with an error (`HomeRefusalError`, `src/core/devices/homeLink.ts`), never an error this computer gave itself.
- A feed line the core marks as its own words (`saidHere`, set by `recentFeed` in `src/core/tasks/taskFeed.ts`): every line but a crewmate's report and the captain's own turn, whose this computer is the computer they were written at.
  The line a view's joining writes ends "Your first mate's tasks and conversation stay on MacBook Pro."

The window on the first mate's own computer asks over the local door, never through `ViewBackend`, so it shows each sentence as written.
A first mate too old to mark its lines (the `feed-said-here` contract change) has its feed lines shown as written, and its refusals still named.
A task's timeline in its record, the cards the host writes and the phone show those words as written.

## Pages it would open

A page the first mate would open in a browser for a view's request, such as a sign-in's consent page, goes to the computers that control it as the push `inf:app:open-page` instead of opening on the first mate's computer (`asAView`, `src/core/askedFromAView.ts`), and each of those computers' Infinitary opens it in its own browser once, as it arrives; one a welcome replays after a drop is old news and is not opened (`ViewBackend.openPage`).
A page the first mate's own window asks for opens on that computer, as a command's first mate has none and sends all of them to its views (`docs/run.md`, "Control from another computer").
A Claude sign-in asked from a view runs the client with no browser on the first mate's computer, and the link the client prints opens on the view instead (`loginWithBrowser`, `src/core/claude/claudeAuth.ts`).
A sign-in that shows a code or asks for a pasted answer shows it on this computer as in the window.
A sign-in whose page sends the browser back to the first mate's own loopback address, as Google's does, comes back through this computer ("A sign-in that returns to the first mate's computer" below).

## A sign-in that returns to the first mate's computer

Google's sign-in for an installed app sends the browser back to `127.0.0.1` at a port the first mate's computer listens on, which reaches nothing on another computer (INF-3454's plan, the captain's answer direction=catch-here).
So a sign-in asked from a view hands the view its page and the port, as the push `inf:app:sign-in-page` with a return id, in place of `inf:app:open-page` (`openSignInPage`, `src/core/index.ts`).
The view listens on the same port of its own loopback address, opens the page once, and passes the path and query the browser brings back to the first mate's computer (`inf:integrations:sign-in-return`, `ViewBackend.openSignInPage`).
The first mate's computer hands it only to its own waiting sign-in's port, only with GET, and only once: a return the sign-in took with 200 spends the id, and one that ended or was cancelled refuses it (`SignInReturns`, `src/core/signInReturns.ts`).
Only the one-time code and the sign-in's state cross, and the code is useless without the check the waiting sign-in keeps; Google's keys stay on the first mate's computer.
The browser then shows the sign-in's own page, passed back as it answered, and the view stops listening.

When the view cannot listen on that port, such as when the first mate runs on the same computer, or the first mate's computer refused what it passed on, Settings → Integrations asks for the address the browser ended on (`RETURN_PASTE_WORDS`, `src/renderer/src/devices/viewWords.ts`).
A pasted address gives only its path and query; its host and port are never used, and anything but an `http` loopback address is refused.
The wait ends with the push `inf:app:sign-in-ended`, whatever ended the sign-in, and the field goes with it; a reconnect that reads everything again clears it too, while one that replays what it missed keeps it and keeps listening.
A browser that comes back while the connection is down is not passed on, since a request that changes something is refused while the first mate's computer is out of reach: the browser shows a page saying it could not reach that computer, and Settings asks for the address.
A first mate that does not list the `sign-in-return` contract change sends the view nothing for this sign-in, so the view's Google notice says to update that computer and its accept stays off (`googleUpdateThereWords`).
A view that does not list it is refused before any page opens, with words saying to update the view; the first mate's own window, and a first mate started by a command, sign in as before at home.
A development run may set the loopback address the view listens on with `INFINITARY_SIGN_IN_RETURN_HOST`, so two development runs on one Linux PC each play a computer of their own; a packaged app ignores it.
Infinitary on iPhone and iPad does the same from its Settings (`docs/ios.md`, "Google in Settings").

## A first mate on an older version

A first mate that does not list the `every-view-asks` contract change refuses what a view of it could not ask before, so this app says so rather than asking (`needsUpdateThere`, read from its welcome).
A Settings section that needs an answer from it shows "Update Infinitary on Mac mini to do this from here." in place of its rows; Appearance, Keyboard and Automation work as ever, and Devices shows the same words under Leave.
A card's button that opens Settings sends nothing and says the same, so the card stays on both computers; the first launch says it in place of its chips, and Switch Usage units and the allowance recheck refuse with those words.
A first mate that lists `every-view-asks` but not `devices-from-a-view` refuses a view's devices and Knowledge (`devicesNeedUpdateThere`): Devices shows the same words under Leave in place of that computer's list, a card's Devices button says them and sends nothing, and no Knowledge panel shows.
Once a window knows that version, nothing asks it the wider set on its own either: the diagnostics notice and the one-time sharing ask stay away, Automation's When choice lists no integration events, and a task browser's saved sign-in is not read.
A read a window makes as it first opens, before it knows that version, can still reach it, such as the home screen's sharing read, or Automation's list when Settings is opened that early.
A first mate with its own window refuses that read quietly; one started by a command answers it under its old rule, so the diagnostics notice can appear there.

## Notifications

A view posts the other Mac's card-worthy moments to this Mac's Notification Center as that Mac posts them to its own.
`ViewBackend` runs the same `CardNotifier` (`src/core/notifications.ts`) over the same `inf:cards` pushes, so the same card makes the same quiet notification on both Macs: its title and the first line of its text, with no sound.

- It posts only while this Mac's window is in the background; each Mac reads its own window.
- It follows the other Mac's own Notifications switch (Settings → General there), asked with `inf:settings:notifications:get`, a `views` read, before each one.
  A switch it could not ask about posts nothing.
- What the view finds when it reads everything again - at its start, or after a reload - is old news, as restored cards are at a restart: it seeds from `inf:cards:list` and posts only what changes after.
- A replay is news: a card that became ready while a dropped connection was being mended posts when its push arrives.

## Reaching the other Mac

`HomeLink` dials with the grant, says hello with the cursor it holds, and keeps the cursor in memory only.
On macOS it dials through macOS's own nc, as every device does (`docs/devices.md`, "Through macOS's own nc"); the app opened here is the responsible code for that nc, so on a local-network address macOS asks the person at this Mac about the local network once, as it would for a dial of the app's own.

- **Contact** is `reaching` until it has heard the other Mac since it started, `in-reach` once welcomed, `lost` when contact goes, and `closed` when the other Mac said it was quitting (`1001`).
  A dropped connection is dialed again at once, and only when that attempt fails does contact change; then it dials every 1, 2, 3 and then 5 seconds.
  The device pings every 10 seconds and drops a connection whose ping went unanswered.
  `heardAt` is the last moment it heard anything, recorded at each change of contact.
- **Requests** ride only a welcomed connection.
  A change asked while the other Mac is out of reach is refused at once, and a request in flight when the connection drops is refused and never asked again, whether or not the other Mac had done it.
  Only a read asked while the device is still reaching the other Mac - at its start, or in the one attempt right after a drop - waits for that attempt.
- **Catching up**: a welcome that replays sends the missed pushes in order and nothing else is needed.
  A welcome that reloads - the other Mac restarted, or this one was away longer than its journal keeps - raises `caughtUp`, and the window reads everything again in place (`resync` in the shell store, and `resyncReads`, `src/renderer/src/plugins/reads/resync.ts`, which every read subscription follows).
  Nothing typed is lost to a reload: the window does not start over.
- **Read only**: a welcome whose `access` is `read` (`docs/contract.md`) means the two copies of Infinitary are too far apart; the window says which one is newer and makes no changes.
  When the newer one is there, the window asks for this Mac to be updated, and this Mac's own update notice is how.
  A development run may stand in another contract version for the Mac where the first mate lives with `INFINITARY_CONTRACT_VERSION`, and its view floor with `INFINITARY_VIEW_FLOOR`, so a view on the same build reads as too far apart; a packaged app ignores both.

## Out of reach in the window

- **The top line**, at the top bar's left: "Controlling your first mate on MacBook Pro", or "MacBook Pro is out of reach · as of 14:32" with the time in mono (`RemoteControlLine`).
- **One pill** under the top bar says why changes are off: asleep or on another network, Infinitary closed there, or a newer or older Infinitary there; when contact returns it reads "MacBook Pro is back.
  This computer caught up." and fades (`ViewPill`).
- **Changes are off** (`changesOff`, `src/renderer/src/devices/viewWords.ts`) while the other Mac is not in reach or too far apart: card buttons are marked off, still Tab stops whose reason is their description and shows on rest, the pointer's or the keyboard's focus, unless the notice already shows it whole (`docs/keyboard.md`, "Facts shown on rest"), a close says why it did not happen, and sending from the input or a reply refuses at once with "Not sent.
  Your words stay here until MacBook Pro is back." under it.
  The words stay; nothing is queued, and nothing is sent later.
  The notice goes when changes are on again.

## Settings on a view

Settings shows every section of the first mate's computer but Secrets and Observe, each read and changed there, beside Appearance, this Mac's own look ("Set on this computer only.
MacBook Pro keeps its own."), Keyboard, this Mac's own keys, and Panels, this Mac's own layout; Automation is the other Mac's own automations, read and changed there, where they run (`docs/automation.md`, "On a computer that controls another"), and Devices starts with `ControllingTab` (`src/renderer/src/settings/ControllingTab.tsx`): which Mac this one controls, when it joined and at what address, and Leave.
Under it is that computer's own Devices, read and changed there through the same pairing owners: its computers and phones with their sign-ins, links and commands made there, a computer added by its address, Update and Remove (`docs/devices.md`).
A link or command made here is the first mate's computer's, so the computer it adds joins that one.
The Notifications switch there governs this Mac's notifications too ("Notifications", above).
Its words name the computer the first mate lives on where they would say this computer (`firstMatePlace`, `useFirstMatePlace`), and a sentence that computer says of itself as this computer is shown with its name (`hereAs`, through `useHereAs`).
An account row under a computer that runs work names that computer instead, since the account is on it (`AccountRow`'s `place`, from `DeviceSignInGroups`).
General leaves out that computer's Start at login, Dock, dictation and panels, which are its own (`GeneralTab`).
A project's folder is typed as its path on that computer, since a folder picker here shows only this computer's folders: Choose folder on the projects folder's line under Add project, and Folder on Mac mini in Add project (`FOLDER_THERE_WORDS`, `src/renderer/src/settings/addProjectWords.ts`); that computer checks the path and says why one cannot be used.
Their keyboard commands work there (`src/renderer/src/app/commandRefusals.ts`).

## Card buttons that open Settings

A card's button whose click opens a Settings section is sent, and opens that section here, Devices included, with what to do on arrival, such as making a link.
Only a first mate too old to answer it keeps the button from being sent (`doneThereWords`): it says so on the button's rest, the pointer's or the keyboard's focus, and, once clicked, as its inline line, and the card stays on both Macs.
The card's other buttons, such as Move to Grok beside Sign in, are sent as before, and while changes are off every button is marked off.

## A task's browser on a view

A task's browser shows its page in any window, wherever the first mate lives: the window asks the other Mac to watch the task, and the other Mac sends its pictures over the connection to this Mac alone (`docs/task-browser.md`, "The view"; `docs/connection.md`, "Live pushes").
`ViewBackend` watches once for every window here that shows the task, hands each picture to those windows, and asks for the room the last maximized window gave the page.
A window that closes or loads another document stops watching, and the other Mac stops sending once the last one has.
A drop ends every watch there, so each welcome watches again, with that room.

- **Taking it over.**
  A crewmate's request card's open-browser action - Open browser and sign in, Sign in myself, Open browser and pay - is sent from a view as from the first mate's own window: the other Mac answers the card on both Macs and hands the browser to the captain, and this Mac opens the view.
  Take control, Return control, Stop and Open again in the view are sent the same way, and the captain's clicks, typing and paste go to the page there (`inf:browser:input`).
  Its words name the computer where the first mate lives (`firstMatePlace`): "Remember my aurora.example sign-in on MacBook Pro", "signed in on aurora.example · saved on MacBook Pro".
- **While changes are off.**
  Take control, Return control, Stop browser, Open again, Back, Forward, Reload, another page's tab and a card's project-page button are marked off with the reason, as every other card button there is, and the browser.control key refuses with it.
  The page takes no clicks or keys, and the line under it gives the same reason unless the pill already shows it whole.
- **A saved sign-in.**
  Use my saved sign-in needs no one at the page, so a view sends it as any other choice: the other Mac gives the browser the site's sign-in and hands it back to its crewmate, the card is answered on both Macs, and this Mac opens the view.
  When the sign-in cannot be used, the browser stays paused there and the feed says why, as on that Mac (`docs/task-browser.md`, "Saved sign-ins").
- **A first mate too old to send pictures.**
  A first mate whose welcome does not list the `browser-from-any-view` change answers no watch, so this Mac marks itself `browserNeedsUpdateThere` and asks nothing of a task's browser.
  The take-over buttons send nothing and the card says so (`browserNotHereWords`, through `doneThereWords`), on the button's rest, the pointer's or the keyboard's focus, and, once clicked, as its inline line: "Update Infinitary on MacBook Pro to show this task's browser here."
  The card's door and the record's Open still open the task's browser view, which shows the stopped panel's shape in place of a page (`browserShownThereWords`), with that line over "Until then, only a window on MacBook Pro can show it.", and no Open again.

## Leave, and Remove at the other Mac

**Leave** asks once in place, with Stay focused: "Leave MacBook Pro?
This computer stops controlling it.", and for a Mac that runs its work "Leave MacBook Pro?
This computer stops controlling it and running its work." over "Its unmerged work goes to MacBook Pro first." while it is in reach.
When the other Mac is in reach the device sends the connection's `leave` frame, so that Mac takes it off its list - once its work is there, for a Mac that runs it - and its feed says "MacBook Air left."
(`docs/devices.md`, "Leave"); while it is out of reach it keeps listing this Mac until it is removed there, and the question says so.
Either way this Mac deletes its grant and its key, notes which Mac and which device on its list it left, and returns to its own first launch, which says "This computer left MacBook Pro."
The work there keeps its own grant until the other Mac's removal reaches it, and this window never opens that Mac again with it (`docs/helper.md`, "A Mac that also controls").

**Removed at the other Mac**: a connection closed as `unpaired` (`4401`), or two `401` answers in a row to the device's upgrade, means that Mac took this one off its list.
This Mac does the same as for Leave without telling it, and its first launch says "MacBook Pro removed this computer.
Paste a new link to come back."

Returning to its own first launch starts this Mac's core in place when this process never ran it - the app started as a view.
A core already stopped in this process (the app joined in this run) is never started twice: the app starts again in a new process instead, and an isolated run (e2e) quits so its driver starts it.
The first-launch gate stays derived (`docs/first-launch.md`); the line only says what happened.

## Tests

- `src/main/shell.test.ts`, "names that Mac where its own refusals and feed lines say this computer" and "shows its first mate's own refusals and feed lines as its core wrote them": a view names the first mate's computer in each refusal shape, a refused request and a line it marked, and leaves the captain's own words; the first mate's own window shows each as written.
  `src/core/tasks/taskFeed.test.ts`, "the first mate's own words on the feed": which lines the core marks.
- `src/core/connection/localDoor.test.ts`, "the local door": the door the window dials (`docs/connection.md`, "Tests").
  Every journey drives the window through it.
- `src/core/devices/homeLink.test.ts`: the device's side against the real connection and pairing - welcome with the other Mac's name, a read held while reaching, a change refused while out of reach and never sent, an exact catch-up after a drop, a request in flight refused and not asked again, Remove seen live and while away, Leave heard and unheard.
- `src/main/shell.test.ts`: the switch - joining stops this Mac's core and asks the other Mac, a view's own look, what is refused without being sent, pushes filtered, starting as a view with no core, Leave in place or by relaunch, Remove there, each join refusal, a second join refused while the first claims its link, and this Mac's own update notice and release page while the other Mac is newer, never asked of it.
  Its notifications: the other Mac's new card and finished report post here as that Mac's notifier makes them, never with this window in front or for what was there at joining, follow that Mac's switch, post after a replay and seed after a reload.
  What it asks of that Mac, its sign-in's steps shown, a page it sends opened here once and a replayed one not.
- `src/core/core.connection.test.ts`, "the connection serves the core to paired devices": every read a view may ask, the first mate's devices listed, linked and removed from a view, a card picture by its name from the real core, a demo recording's pieces with its size, a project font by its name, and Leave named in the feed.
- `src/renderer/src/devices/viewWords.test.tsx`: the words, the top line, the join aside's steps and Leave's question, the card buttons it sends, its browser's words and where its Settings say it lives.
- `src/renderer/src/attachments/intake.test.ts`: on a view, a dropped or chosen picture or text file is applied and any other file is refused by one notice, never a path.
- `src/shared/cards.test.ts` and `src/core/orchestrator/cardActions.merge.test.ts`: which buttons open Settings, and that the core's answer to each click agrees.
- `src/renderer/src/app/cardActions.test.ts`, "card action receipts": on a view, a button that opens Devices is sent and opens Devices here, and sends nothing on a first mate too old to answer it, while its other buttons, those that open other Settings sections included, are sent; a request card's take-over is sent and opens the browser view, and on a view of an older first mate sends nothing and says so, while its saved sign-in is sent.
- `src/main/shell.test.ts`, "shows a task's browser from the other Mac": two windows watch one task through one watch there, only a watching window sizes the page, a drop watches again with its room, and the last window's end stops the pictures; an older first mate is told apart and asked nothing.
- `tests/e2e/view.spec.ts`, "a Mac that controls another takes over a task's browser there": the second app opens a crewmate's page from its card, takes control, and types a town into the page on the first app, whose button, pressed from the second app, answers with it.
- `tests/e2e/update-channels.spec.ts`, "a Mac controlling a newer Firstmate on another Mac is offered its own update": the other Mac's newer contract named in the top bar, this Mac's own offer there, its release page opened here, and the other Mac offered nothing.
- `src/main/shell.test.ts`, "a Mac that controls another and runs its work": joining with a link for a Mac keeps the grant for its work and sets it up in the background, a Mac a command added opens as a view with its work's grant and never again as the device it left, and a grant that only runs work stays the work's; `src/core/helper/fromWindow.test.ts` the work folder's side.
- `tests/e2e/view.spec.ts`, "a Mac joined at its first launch also runs that Mac's work": the home standing in another Mac for each app, a link pasted at first launch joins a Mac that controls and, its work started, is in reach to run work; a Mac a command added opens Infinitary there and controls with no first launch and no new link, and its Leave says it stops its work too.
- `src/core/devices/remoteLoginLink.test.ts`, "asking a computer for a link by its address", and `src/core/devices/phoneDoor.test.ts`, "the computer link command": the key line then a link, a port kept with its key line, not open, this app's own link, the password once, and the command under each login shell with each reason it makes no link.
- `tests/e2e/join-by-address.spec.ts`: a fresh app, by keys only, joins another app on the same computer by its address over a local SSH server, answers the key line, controls it and is listed as a Mac.
- `tests/e2e/view.spec.ts`: two apps on one Mac - a fresh app joins at its first launch, shows the other's cards with their pictures, its feed and its tasks, an answer in either shows in the other, a button that opens Devices opens that Mac's Devices here and makes its link, out of reach refuses changes and never sends them, a restart there catches it up, it restarts as a view with its record untouched, and Leave returns it to its own first launch.
  A second journey drops a picture, a text file and a PDF on a view: the picture and the text reach the other Mac's first mate and are kept there, and the PDF, dropped or chosen, on the input or a reply, is refused with no path of this Mac sent.
