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
The window asks `inf:devices:this-mac`, a host channel, for what this app is, and follows its push of the same name: `home`, with the Mac it last left, or `view`, with that Mac's name, its address, when this Mac joined, whether it is in reach and since when it was last heard, whether the two copies of Infinitary are too far apart to make changes, how many times it had to read everything again, and whether the pushes a welcome replays are still arriving (`replaying`).

What a view keeps is `JoinedHome`'s (`src/core/devices/joinedHome.ts`), the one writer over `userData/joined/` (0700, every file 0600):

| File | Holds |
| --- | --- |
| `home.json` | The grant (`docs/devices.md`, "Joining"), with this Mac's own key, the other Mac's name once it has said it, and when it joined |
| `home-addresses.json` | The other Mac's other addresses, refreshed from each welcome, kept beside the grant so a version that knows only the grant still reads `home.json` (`docs/devices.md`, "Finding the home again") |
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
A Windows PC joins a Mac's, a Linux computer's or a Windows PC's first mate the same way, saying its security identifier in place of a user number (`docs/devices.md`, "Joining").
Paired as a Mac is, it also sets up its work there, which runs as this person's own Task Scheduler task while they are signed in (`docs/helper.md`, "In the background").
A home from before pairs it as a computer that only controls, and nothing is set up for work there.
A development run may stand in another name with `INFINITARY_DEVICE_NAME`, so two apps on one Mac read as two Macs; a packaged app ignores it.
The Mac where the first mate lives takes a second app on its own Mac for a view, which only controls; a development run there may stand in another Mac for every device that joins with `INFINITARY_JOINS_FROM_ANOTHER_MAC=1`, so two apps on one Mac join as two Macs.

### Joining by its address

"+ Join by its address" reaches the same question with no link to copy (INF-1827, design skill `components/devices/JoinAnotherMac`, "By its address"), on a Mac and on Linux alike.

1. The person types the address they sign in to that computer with, such as `kun@studio`, and a port when its SSH server listens on another than 22 (`addressAtPort`); or picks a computer nearby, which fills the address from the "Your account" field above the list.
2. `inf:devices:join-at` signs in there with the person's own SSH (`RemoteLogin.linkAt`): the key-line question the first time, kept by address and port, and the password once when that computer refuses the person's key, letting Infinitary's own key in as Settings -> Devices does.
   This computer's own first mate signs in, which beside a command the window started, as at an installed app's first launch, is the command's: the shell asks it each step with `inf:devices:link-at` (`docs/run.md`, "Joining another computer").
3. That computer's open Infinitary makes a one-use computer link (`docs/devices.md`, "A computer that joins by its address"), which the shell holds; the window gets only whether it runs work and names a private address.
4. The window asks step 2's question above, naming the computer the typed address names (`kun@studio` asks of `studio`), and `inf:devices:join-held` joins with the held link as step 3 above does, dialing first the host SSH reached; Cancel forgets it.

A Windows PC signs in with Windows' own SSH, `ssh.exe` in `System32\OpenSSH`, which reads the remembered key's file by a path written with forward slashes; it signs in with the person's key alone, so a computer that refuses that key answers that it did, with no password step.
Each stop is one warning line with the address kept: Infinitary not open there, which starts nothing there; too old; controlling another computer; this computer itself; no curl on Linux; or Remote Login's own refusals.
Nothing reaches the feed or the record until the join itself.

## A Mac that runs work

A Mac (`mac`, `docs/devices.md`) both controls that Mac's first mate from its window and runs its work with no window (`docs/helper.md`, "A Mac that also controls"): one device on that Mac's list, whose window and work keep the same grant, each connection saying which it is (`as`, `docs/connection.md`).

- **Joined here at its first launch**: the grant goes to this user's work folder too, and the work starts in the background from this app (`setUpWork`, below): a LaunchAgent on a Mac, a systemd user service on Linux (`docs/helper.md`, "In the background").
  A Linux computer joins a Mac's or a Linux computer's first mate this way, and a Mac a Linux computer's, each with its own system's Infinitary.
  Nothing runs there until a project is set to run on it.
- **Added by a command or its address**: Infinitary opened here with no grant of its own starts as a view of the home its work runs for, with that grant and no new link (`Shell.start`, `windowFromWork`).
  It follows where the work's grant dials, and dials through the route the home's SSH keeps when the home reaches it that way.
- **Clicking Infinitary there** while its work runs opens its window as a view of the home, however it joined.
  On a Mac joined here at its first launch the work runs this same app, so macOS may hand the click to the work, which opens the app beside itself as a new copy that becomes this view (`docs/helper.md`, "What it is").
- **Another user on that Mac** only runs work: Infinitary opened as that user is its own.
- `thisMac`'s `runsWork` says it, so Leave says it stops that work too (below).
- **Removed as the entry its window holds** while its work runs for the same home as another entry, the window takes the work's grant at once and carries on, with its windows open as they are (`Shell.removedThere`); `thisMac`'s `carriedOn` makes Settings -> Devices say so (`docs/devices.md`, "One computer, one entry").
- **On the list twice**, the window asks the home to fold its own entry into the one its work keeps once it is in reach (`foldProof`, `ViewBackend`), then carries on as above.

### Setting its work up again

The window checks its work half and sets it up again by itself (`setUpWork`, `src/core/helper/workSetup.ts`; `Shell.checkWork`), with no new link, at every connection to the home, the first of each launch included, as its window comes back to the front while its work could not start (`Shell.windowFront`), on the notice's Try again (`inf:devices:set-up-work`) and on the home's Fix it (below).
None runs before a launch's first welcome, which proves the Mac is still on its home's list, so a Mac removed while its app was closed sets nothing up again and hears it was removed instead.
One check runs at a time, and one asked meanwhile runs once more after it.
A window that only controls, or a computer that runs no work, checks nothing; a Windows PC whose window joined runs work and checks it as a Mac does, with Task Scheduler as its background (`docs/helper.md`, "Running").

1. The work folder keeps the window's own grant: a missing one is written again, under the folder's lock.
   Another device's grant there stays as it is and is named, `other-home` for another first mate's and `other-entry` for this one's under another entry on its list, and so does a removal there that has not finished, `removal-unfinished`.
   A grant a newer Infinitary saved, one this version cannot read, is never written over and is named `newer-work` (`docs/helper.md`, "Saved by a newer Infinitary").
2. A live run holds the folder (`folderHolder`), or the data folder's move is about to start one: nothing is touched.
3. Otherwise the background is set up again from the copy of the app the work folder records beside it (`installed.json`, `backgroundFromRecord`), as a command's or an address's join left it, so a removal and the home's updates still find it; with none, from the app that runs now, unless that app runs from a place it cannot be started from later, a disk image under `/Volumes` or a copy macOS moved aside (`placeDoesNotLast`), `app-place`.
   A recorded copy that is no longer there is not used: the app that checks sets the background up from itself, the record is cleared, and the home's feed says so once (`copyGone`).
   The system refusing it is `background-off`, a computer with no background the app can use `no-background`, and a run it started that has not taken the folder within a moment reads as starting.

What the check found (`WorkSetupReport`, `src/shared/workSetup.ts`) is never only logged.
The window keeps it for its own notice and tells its home over the connection (`inf:devices:work-setup`), only when the home lists the `work-setup` change; an older home hears nothing and the notice still shows here.
The home's list says what it reads of this Mac's own row, so the window clears the notice once its work is in reach there, and shows the home's reading, `local-network` or `not-reached`, while its own check found a run.
The notice sits under the input, in the quiet strip the other notices wear (`WorkSetupNotice`, design skill `components/devices/DevicesTab`, "A Mac that has not finished setting up"), with the reason, Not now and Try again, which checks again now.
Not now folds it, for as long as the window runs, into a quiet line at the top bar's left that opens it again; a new reason, or a stop after the work ran, shows it whole again.
A maximized card puts it aside with the main message, its buttons' labels included.
The home's Fix it on this Mac's row reaches the window as a live frame (`inf:devices:set-up-work`), which checks again the same way.

## The window on the first mate's own computer

The window on the computer where the first mate lives is a view of it too, over the same connection: every core request it makes goes to the first mate through the connection's local door, and every push comes back the same way (`LocalWindow`, `src/main/view/localWindow.ts`; `docs/connection.md`, "The local door").
It reads the door's address, pin and key from the door's folder at each dial, as any local client does, so it needs no pairing and is no row in Settings -> Devices.

- **What stays the same.**
  It asks as the captain himself, as before, so it keeps every request a view is refused, Secrets above all (`docs/secrets.md`): it stays the trusted surface, with no enrollment.
  Its look, keys, voice, frames and files are this computer's own and never cross; pages it would open open here.
  Its panels are asked of the first mate as every window asks ("Panels in every window" below).
  The first mate still runs in the same process, Quit is unchanged, and journeys start the app as before.
- **A task's browser.**
  It watches a task's browser as a view on another computer does: once over the connection for every window here, its pictures arriving as `live` frames (`BrowserWatches`, `src/main/view/browserWatches.ts`; "A task's browser on a view" below).
- **Card pictures** are read from the first mate's own copy on this computer, as before, never over the connection.
- **A drop.**
  On one computer a drop is only a restart of the connection, so it dials again every tenth of a second for the ten seconds a window waits for a welcome, then once a second, holding reads and refusing changes meanwhile, as every view does ("Reaching the other Mac" below).
  A first mate that starts, or starts again, so welcomes the window within a tenth of a second of opening its door (`DOOR_RETRY_MS`, `src/main/view/localWindow.ts`).
  A welcome that could not replay what the window missed makes the window read everything again, as a view's does; with nothing paired the connection keeps no pushes to replay, so a window that missed any reads everything again (`docs/connection.md`, "The handshake and the numbering").
  Every welcome after the first, replayed or not, counts in `thisMac`'s `linkBack`, and the window asks again what it asks only once and otherwise follows by push: the release notes and whether Devices and Secrets are offered, since a read the drop refused is never retried (`readOnceAgain`, `src/renderer/src/app/store.ts`).
  It also mounts again each panel it could not mount, such as one refused while the first mate beside it was briefly on another version around an update (`linkReturns`, `src/renderer/src/plugins/frames/FrameMount.tsx`).
  A view does the same when the other computer comes back in reach.
- **Beside a command.**
  The window opened while a command runs the first mate in another program is the same view of it, from a process with no core of its own, and the only window that touches this computer's desktop for that first mate: it follows the first mate's look and keys, applies its Dock choice, changes Start at login, posts its notifications and answers what only a program in the person's session can (`docs/run.md`, "The window opened beside it").
  Once the command no longer runs it says so over itself and starts no first mate by itself (`docs/run.md`, "When the command stops").
- **When the door cannot open**, when it never welcomes the window, or when it refuses the window's key, and for a command's first mate, which has no window, the window asks the core directly as before, and the log says why.
  A window that lost the door reads everything again from the core.

## What the window asks

`ViewBackend.dispatch` answers each core channel the window asks:

- A channel whose `reach` is `views` goes to the other Mac, as the captain at another Mac (`docs/connection.md`, "Requests").
  What a person types here is the captain's own words there, so the first mate there may make an own-words change on it, such as removing a project (`docs/devices.md`).
- `inf:shell:preferences` and the appearance and layout reads and writes are this Mac's own (`ViewLook`, `src/main/view/viewLook.ts`), starting from the other Mac's look the first time it is in reach (the captain's pick on FI3-681).
  The panels switch is the exception: it is the other Mac's, read at each welcome and followed when it changes ("Panels in every window" below), while how the panels sit is this Mac's own layout.
  The window's project focus rides that layout, so a Mac that controls another keeps its own focus, and its turns carry it to the first mate there as a hint (`docs/project-focus.md`).
- The window's keys are this Mac's own too, and never a core channel: the main process's installed map reads and writes them through `ViewLook`, starting on a new profile's keyboard preset, or Legacy for a look kept from before presets, and the other Mac never hears of them (`docs/keyboard.md`, "Changing keys").
- `inf:update:status`, `inf:update:check` and `inf:update:open-release` are this Mac's own: the app installed here, read by the same update checker the Mac where the first mate lives makes for itself (`createInstalledUpdateChecker`, `src/core/update/updateChecker.ts`; `docs/alpha.md`, "Update channels").
  The top bar shows the same update notice, with this Mac's version, channel and upgrade command, and the version in its line opens that version's release page here.
  The other Mac is never asked: its own notice is about its own app.
- A press of Allow once on a Secrets use card is this Mac's own signed answer (`MacApprover`, `src/main/view/macApprover.ts`): set up as an approver, it asks this Mac's Touch ID or password and signs; otherwise it refuses with where to set it up, and never sends the press (`docs/secrets.md`, "Remote decisions").
- Anything else is refused here, without being sent: "answered only on the computer where your first mate lives".
  That is what stays with the first mate's computer (`reach: "home"`): its Secrets (`docs/secrets.md`, "Remote decisions"), but for the Save on an ask to keep a secret ("Asking to keep a secret on a view", below), and what is only ever that computer's own - its look, dictation, voice model, Observe, release notes, Dock and update, and what only the window on that computer may ask (`docs/run.md`, "The window opened beside it").
  Its computers and phones, the addresses they find it at, and its Knowledge are asked there (`reach: "views"`, the `devices-from-a-view` contract change), as the captain at another computer.
  Whatever started the first mate, a view asks every other request (`docs/connection.md`, "Requests").

Only the pushes a view shows reach the window (`VIEW_PUSHES`): the feed's events, the cards and their threads, quota, model names, the task board, a sign-in's steps, the sign-ins where projects live, integrations, Diagnostics, and the first mate's computers and phones with their addresses, nearby computers, sign-ins, presence and resources.
Streamed reply pieces and tool starts and ends arrive as `live` frames, outside the numbering, and reach the window as events as they did numbered (docs/connection.md, "Live pushes").
The captain's panels and their data reach it too (`inf:plugins:personal`, `inf:plugins:db`).
The other Mac's look and voice are its own; of its look the view hears only the panels switch.

A file given to the input or a reply goes to the other Mac only inside the message: a picture or text file as its chip, any other file not at all, because a path on this Mac means nothing there (`docs/composer.md`, "Files").
The input's line names that Mac: "Only pictures and text files can go to MacBook Pro.
Other files were not added."

Frames are built by this app, as on the Mac where the first mate lives; a card picture's name is asked of the other Mac (`inf:cards:picture`, a `views` read that answers the home's own copy as base64), and the frame scheme serves the answer (`src/main/frames/frameProtocol.ts`).
A project font a preview's `@font-face` names is asked of the other Mac the same way (`inf:cards:typeface`, a `views` read of a minted font name answering the home's own copy as base64), and the frame scheme's `typefaces` host serves the answer; a font the home cannot answer is not served, and the preview draws in the app's own typefaces (`docs/card-authoring.md`, "Fonts by reference").
A data file a card's script asks the bridge for is asked of the other Mac by this window (`inf:cards:data`, a `views` read of a minted data name answering the home's own copy as text), and only for a name the card's body carries; one the home cannot answer reaches the script as a refusal (`docs/card-authoring.md`, "Data by reference").
An app part a card's body names by reference takes this window's own copy of the part's code, as on the window's own computer (`docs/card-authoring.md`, "Parts by reference").
A proof log a merge card names is asked of the other Mac the same way (`inf:cards:log`, a `views` read of a kept log's name answering the home's own copy as base64), and the log reader shows the answer; a log the home cannot answer reads as one that could not be read (`docs/card-authoring.md`, "Proof logs").
A card's file for the captain saves into this Mac's Downloads: the window's own process asks the other Mac for it a piece of 1 MB at a time (`inf:cards:file`, a `views` read of the card's file answering that piece as base64 with the whole file's size and sha256) and saves it here once it arrives whole (`docs/card-authoring.md`, "Files for the captain").
A card's demo recording plays in this app's picture viewer a range at a time (a GIF demo is asked whole, in the same pieces, each time Play is pressed): each range is asked of the other Mac at most one piece of 1 MB at a time (`inf:cards:media`, a `views` read of a minted recording name, an offset and a length, answering that piece as base64 and the whole file's size), never kept, since the player asks again for what it needs.

## What the first mate asks of a window

A window's own settings are its computer's, so the first mate changes them at the window the captain names, never at its own computer's in their place (the captain's pick on the Settings parity review).
`app_state` marks those lines `window: true`: a window's look and layout, its update check and channel, and its key reminder (`WINDOW_CHANNELS`, `src/shared/windowAsks.ts`).
`app_change` takes the Mac by its name or id in `computer`, from the computers that control this one; left out, it means this computer.
The core sends one live frame (`inf:view:ask`, `ViewWindows`, `src/core/viewWindows.ts`) to one connection of that Mac, the newest that lists the `window-asks` contract change, so the ask's id reaches no other connection and the change runs once.
The window answers as its own Settings would, through the same `ViewBackend.dispatch` and the same key reminder store (`answerWindowAsk`, `src/shared/windowAnswer.ts`), by `inf:view:answer`.
The first mate builds a change to the look or the layout from one reading of the window's value, and the ask carries only the fields that change, each with its value in that reading (`changes`).
The window reads its own value again: if a field the change changes reads otherwise there, its own Settings moved it since, so it changes nothing and says so (`changedThere`); otherwise it sets only those fields over its value as it is then, so its own edit to any other field stays.
It answers its value after the change and its value just before (`before`).
The core hears the answer only from the window it asked, as the captain at that computer, and uses it only once both values match the contract.
It runs the catalog line's checks, trail and operation as for any change, reading the window's own before and after values rather than the first mate's reading, so an edit made there since is no line of the first mate's, and the trail names the computer ("usage shown in usd on Studio"); Check for updates there is a line of its own too.
A window's changes wait only on that window's other changes, never on this computer's Settings writes.
The key reminder only a window's own program keeps, so the first mate's computer asks its own window for it through the local door (`LocalWindow`, and the window beside a command), and a reminder no window answers reads as unknown in `app_state`.
When no such window is connected, nothing is sent and nothing changes, and the first mate is told so.
When a window was asked but did not answer within thirty seconds (`WINDOW_ANSWER_WAIT_MS`), or answered what the contract does not admit, the change may or may not have been made there, and the first mate is told to look before asking again.
The connection holds each ask's id for the window it went to until that window answers, the same thirty seconds run out or that window leaves, whichever comes first (`heldAsks`, `src/core/connection/heldAsks.ts`); an answer after that reaches nothing.

## The first mate's own words

The first mate's core writes its own computer as this computer (`HERE`, `src/shared/deviceNames.ts`), which on a computer that controls it would name the computer the captain is at.
`ViewBackend.dispatch` names the first mate's computer there instead, by the name the view shows for it (`hereAs`, through `namedHere` in `src/main/view/namedHere.ts`):

- A refusal the first mate's computer answers, in the shapes the contract's refusals take: the answer's `refusal`, its `text` beside `ok: false`, and its `warning` beside `ok: true`.
  A card's page from a task that runs elsewhere reads "This task runs on another computer, so its project's page does not open on MacBook Pro."
- A request it refused with an error (`HomeRefusalError`, `src/core/devices/homeLink.ts`), never an error this computer gave itself.
- A feed line the core marks as its own words (`saidHere`, set by `recentFeed` in `src/core/tasks/taskFeed.ts`): every line but a crewmate's report and the captain's own turn, whose this computer is the computer they were written at.
  The line a view's joining writes ends "Your first mate's tasks and conversation stay on MacBook Pro."
- A line that says this computer or here as a place saves both as places in its fact (`PLACE_SAID`, `src/shared/deviceNames.ts`), and the view names them (`placesAs`) and words the line again: here becomes on that computer.
  A project's Runs on line, a computer gone out of reach and the way to run a waiting task here instead save theirs, so a project moved back reads "harbour-site runs on MacBook Pro now" and its next task "starts on MacBook Pro" there.
- In a task's record (`inf:tasks:detail`), each Activity line the core marks as its own words (`saidHere`, set by `condenseActivity` in `src/core/tasks/recordActivity.ts`), folded lines included: what the host, its own steering or the first mate wrote, never the captain's words or a crewmate's.
  A pull request a line links moves with the words before it.
  The record's Activity draws a line's timeline reading in its place (`timeline`, `src/core/tasks/taskTimeline.ts`), so each reading the same writers wrote is named the same way: its summary, its whole text and its retained details (`speaksAsFirstMatesComputer`, `src/shared/tasks.ts`).
  The brief and a turn's decision are kept exactly as served and stay as written.
  The record's newest problem (`plainProblem`) is named too.
- A card the first mate's computer writes itself (`author: "host"`): its title and body, in `inf:cards:list`, `inf:cards:show`, the past card reads and the `inf:cards` push, before the view's notifications read it.
  The body is markup, so the name goes in escaped, and the change bars' marks move with the words before them.

The window on the first mate's own computer asks over the local door, never through `ViewBackend`, so it shows each sentence as written.
A first mate too old to mark its lines (the `feed-said-here` and `activity-said-here` contract changes) has those lines shown as written, and its refusals and cards still named.
A here outside a saved place (in a refusal, a card or a line saved as English alone), the brief and the phone stay as written.

## Panels in every window

A panel the captain made or added shows the same in every window that shows his first mate: the window on the first mate's own computer, the window opened beside a command (`docs/run.md`), and a window on another computer.
The first mate keeps each panel, builds it and holds its data; a window asks for what it draws and draws it itself, and the panel's own code that runs outside a frame, its server actions, still runs once, on the first mate's computer.

- **What a window asks.**
  The list of panels (`inf:plugins:personal:list`, then the `inf:plugins:personal` push), each panel's data (`inf:plugins:db` and its push), a server action (`inf:plugins:invoke`), a mediated fetch, an integration, SQL, and Try again, Update and Ask again on a panel that stopped: all have `reach` `views` (the `panels-in-every-window` contract change), asked as the captain at another computer.
- **A panel's files.**
  Before a window draws a panel it asks the first mate for that panel's built files (`inf:plugins:files`, `src/shared/personal/panelFiles.ts`), naming the source, the panel and the version its list named.
  The first mate reads them where they are (`readPanelGraph`, `src/core/personal/panelGraph.ts`) and answers the bytes with the version of the app they were built for, or nothing for a panel it does not serve from that source at exactly that version.
  The first mate names no folder, so every window draws from the same answer: the window serves those bytes to the panel's frame by their hashes, under the same bounds the first mate's read keeps (`src/main/frames/frameMounts.ts`; `docs/ui-plugins.md`, "The frame realm").
- **Versions.**
  The files are built for the panel library of the first mate's version of the app, which only a window on that version serves.
  A window on another version draws the panel's place with one line of `PANEL_FILES_WORDS` instead: "This panel shows once Infinitary here and on the computer where your first mate lives are on the same version."
- **A panel being built.**
  A panel a crewmate is still building is drawn out of sight on the first mate's own computer (`docs/personal-panels.md`, "Built apart").
  A window on another computer is told of no such panel and is answered none of its files.
- **Where each panel was drawn.**
  Every window says what it did with each panel (`inf:plugins:personal:mounts`); the first mate keeps only its own computer's window's word, since that is the window a crewmate's capture photographs.
- **The switch and the layout.**
  The panels switch in Settings is the first mate's, set at its own computer's window; a view reads it from `inf:shell:preferences` at each welcome and follows it when it changes, and takes nothing else of that look (`ViewLook.heardPanels`).
  A switch heard before this Mac has a look of its own waits for the other Mac's saved look, so the window is never drawn in the default look first (`ViewBackend.heardPanels`).
  How the panels sit is each computer's own layout, except in the window opened beside a command, which follows the first mate's whole look.
  A panel's `settings.current` read follows the same split: a setting this Mac's own look holds, such as the theme or the music, is read from that look, and only the rest, such as notifications or the cost limit, is asked of the first mate (`ViewBackend.settingsNow`).
- **Settings read by a panel, on an older view.**
  A view whose hello does not list `settings-current` reads a panel's reads as a closed list, so the first mate leaves out every panel that reads settings, built or being built, from the panel list it answers, pushes and replays to that view (`lookFor`, `src/core/connection/cardCompatibility.ts`).
- **A gap.**
  A window that missed the first mate's pushes, because the first mate was out of reach or restarted, reads its panels again with everything else (`startPersonalPlugins`, `src/renderer/src/personal/personalPlugins.ts`).
- **An older first mate.**
  A first mate older than major 16 that does not list `panels-in-every-window` refuses these requests from a view, as before, and the view shows no panel of the captain's.

## Panels on the phone

The first mate answers Infinitary on iPhone and iPad everything a window on another computer asks for the captain's panels ("Panels in every window" above): the list and its push, each panel's built files, its data, its server actions, its integrations and SQL, all as the captain at another computer.
It answers a phone a panel's files whatever the phone's own version, since a phone never carries the first mate's build.
Infinitary on iPhone and iPad draws them on its Panels tab (`docs/ios.md`, "Panels").

- **The library.**
  A panel's files import the frame realm's library of the version they were built for (`PanelFiles.builtFor`), which only a window on that version serves, so the first mate also answers that library by its version (`inf:plugins:library`, `src/shared/personal/panelFiles.ts`), for a device that keeps one copy per version.
  It answers every file of the library its own build made, each with its pin, but the app's own panels under `builtin/` (`readPanelLibrary`, `src/core/personal/panelLibrary.ts`).
  It answers nothing for another version, and refuses a file whose bytes no longer match its pin, as the shell never serves one to its own frames.
  It reads the library once a run, from where the host says this build put it (`HostCapabilities.frameLib`).
- **Desktop windows.**
  A window on another computer still draws a panel only on the first mate's own version and never asks for the library ("Versions" above).
- **An older first mate.**
  A first mate older than major 16 that does not list `panels-on-the-phone` refuses the library as not a request it answers.

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
A first mate older than major 16 that does not list `sign-in-return` sends the view nothing for this sign-in, so the view's Google notice says to update that computer and its accept stays off (`googleUpdateThereWords`).
A view older than major 16 that does not list it is refused before any page opens, with words saying to update the view; the first mate's own window, and a first mate started by a command, sign in as before at home.
A development run may set the loopback address the view listens on with `INFINITARY_SIGN_IN_RETURN_HOST`, so two development runs on one Linux PC each play a computer of their own; a packaged app ignores it.
Infinitary on iPhone and iPad does the same from its Settings (`docs/ios.md`, "Google in Settings").

## A first mate on an older version

A first mate older than major 16 that does not list `every-view-asks` refuses what a view of it could not ask before, so this app says so rather than asking (`needsUpdateThere`, read from its welcome).
A Settings section that needs an answer from it shows "Update Infinitary on Mac mini to do this from here." in place of its rows; Appearance, Keyboard and Automation work as ever, and Devices shows the same words under Leave.
A card's button that opens Settings sends nothing and says the same, so the card stays on both computers; the first launch says it in place of its chips, and Switch Usage units and the allowance recheck refuse with those words.
A first mate older than major 16 that lists `every-view-asks` but not `devices-from-a-view` refuses a view's devices and Knowledge (`devicesNeedUpdateThere`): Devices shows the same words under Leave in place of that computer's list, a card's Devices button says them and sends nothing, and no Knowledge panel shows.
Once a window knows that version, nothing asks it the wider set on its own either: the diagnostics notice and the one-time sharing ask stay away, Automation's When choice lists no integration events, and a task browser's signed-in sites are not read.
A read a window makes as it first opens, before it knows that version, can still reach it, such as the home screen's sharing read, or Automation's list when Settings is opened that early.
A first mate with its own window refuses that read quietly; one started by a command answers it under its old rule, so the diagnostics notice can appear there.

## Updating the first mate's computer

A view can see and start the first mate's computer's own update, so a computer left on an older version is brought up to date without anyone at it (`src/shared/homeUpdate.ts`, the `home-update` contract change).
The home answers `inf:home-update:status`, `inf:home-update:install` and `inf:home-update:later` on every major, and Update and Update later pass the read-only gate (`READ_ONLY_ASKS`, `docs/connection.md`), so they work across the very version split they end.
A view knows the home answers them when its welcome lists `home-update` or speaks a later major (`homeAnswersUpdate`, `thisMac.homeUpdates`); an older home shows no update control.
The home offers only what its own Version row offers: a copy updated through Homebrew, one whose installation was not confirmed, or one whose installer asks for a password says why in the row and offers nothing from afar (`createHomeUpdates`, `src/core/update/homeUpdate.ts`).
Update runs the home's own update unchanged, so the crew's work is saved first, Update later lets it go, and each stopped turn carries on after the restart (`docs/alpha.md`, "Saving work before an update").
A first mate a command started has no window of its own, so it opens the window beside it and asks it to install (`inf:own-window:ask`'s `update` kind); a window that does not open in time says so, and nothing starts.
The home's update notice opens on its own when a view starts the update and names who asked (`inf:update:asked`, `askedFrom`), so someone at that computer can still choose Update later.

On a Mac that controls another, Settings → General shows "Infinitary on Mac mini" under the Version row, with where its update stands and Update or Update later (`HomeUpdateRow`, words in `src/renderer/src/settings/homeUpdateWords.ts`); a section that waits for that computer's update shows the same row under its words.
Update asks first, naming the running work that finishes before the restart, how many background jobs stop, and that nobody can undo it from here if the new version does not start.
While it moves the row reads again every few seconds; a computer that does not answer once it began restarting reads "Restarting", and one still silent after a few minutes says someone needs to check it at the computer.
The command `updates.home` (`docs/keyboard.md`) opens the row; the phone's own controls are in `docs/ios.md`, "Updating the computer".
A development or end-to-end run stands in a direct Mac copy's update with `INFINITARY_MAC_UPDATE_STAND_IN`, the version its feed offers (`src/main/host/macUpdateStandIn.ts`): the real update controller and the crew's save run, nothing is downloaded or replaced, and a packaged build always uses the real installer (`tests/e2e/home-update.spec.ts`).
It stands in the window's opening beside a command's first mate with `INFINITARY_OPEN_WINDOW_STAND_IN`, a file where each ask is noted instead of asking macOS to open the app, so the journey opens the window as macOS would (`src/main/host/openWindowStandIn.ts`); a packaged build always asks macOS.

## Notifications

A view posts the other Mac's card-worthy moments to this Mac's Notification Center as that Mac posts them to its own.
`ViewBackend` runs the same `CardNotifier` (`src/core/notifications.ts`) over the same `inf:cards` pushes, so the same card makes the same quiet notification on both Macs, with no sound: what it asks, its name and its first prose (`docs/phone-push.md`, "What is sealed"), except that a view reads no task record, so it names the card by its own title and shows no project.

- It posts only while this Mac's window is in the background; each Mac reads its own window.
- It follows the other Mac's own Notifications switch (Settings → General there), asked with `inf:settings:notifications:get`, a `views` read, before each one.
  A switch it could not ask about posts nothing.
- What the view finds when it reads everything again - at its start, or after a reload - is old news, as restored cards are at a restart: it seeds from `inf:cards:list` and posts only what changes after.
- A replay is news: a card that became ready while a dropped connection was being mended posts when its push arrives.

A paired phone hears the same moments through a second `CardNotifier` on the first mate's computer, sealed through Infinitary's relay (`docs/phone-push.md`).
While this Mac's window is in front it says so to the first mate there (`inf:window:front`), and again at each welcome, so that computer pushes no card to a phone while the captain works here (`docs/phone-push.md`, "When the computer sends").

A click on a notification, a view's or the first mate's own computer's, brings the window forward with that card at the front (INF-4243's plan, piece 5: "Notifications appear and open their card").
The click notes the card in the main process (`noteNotifiedCard`, `src/main/notifiedCard.ts`) and tells the window with `inf:cards:notified`; the window takes it with `inf:cards:take-notified`, which clears it, and reads the cards again first when it does not hold that card yet (`openNotifiedCard`, `src/renderer/src/app/stackActions.ts`).
A window the click had to open takes it once it starts, so it never depends on a push reaching a page still loading.
Each notification on screen is held until it goes, the newest for each card, since one the garbage collector took hears no click.

## Reaching the other Mac

`HomeLink` dials with the grant, says hello with the cursor it holds, and keeps the cursor in memory only.
The grant keeps every address the other Mac offers, refreshed from each welcome, and a dial that reaches none listens for that Mac's announcement on the local network, checking its key at every address (`docs/devices.md`, "Finding the home again"), so a change of that Mac's address leaves the window out of reach only while no route answers.
On macOS it dials through macOS's own nc, as every device does (`docs/devices.md`, "Through macOS's own nc"); the app opened here is the responsible code for that nc, so on a local-network address macOS asks the person at this Mac about the local network once, as it would for a dial of the app's own.

- **Contact** is `reaching` until it has heard the other Mac since it started, `in-reach` once welcomed, `lost` when contact goes, and `closed` when the other Mac said it was quitting (`1001`).
  A dropped connection is dialed again at once, and only when that attempt fails does contact change; then it dials every 1, 2, 3 and then 5 seconds.
  The device pings every 10 seconds and drops a connection whose ping went unanswered.
  `heardAt` is the last moment it heard anything, recorded at each change of contact.
- **Requests** ride only a welcomed connection.
  A change asked while the other Mac is out of reach is refused at once, and a request in flight when the connection drops is refused and never asked again, whether or not the other Mac had done it.
  Only a read asked while the device is still reaching the other Mac - at its start, or in the one attempt right after a drop - waits for that attempt.
- **Catching up**: a welcome that replays sends the missed pushes in order and nothing else is needed.
  `HomeLink` says each welcome to `onWelcoming` before its state turns in reach, with how many pushes it missed, and to `onReplayed` once the last push it sent again is handled; `ViewBackend` says `replaying` from the one to the other, and only when something was missed.
  A welcome that reloads - the other Mac restarted, or this one was away longer than its journal keeps - raises `caughtUp`, and the window reads everything again in place (`resync` in the shell store, and `resyncReads`, `src/renderer/src/plugins/reads/resync.ts`, which every read subscription follows).
  Nothing typed is lost to a reload: the window does not start over.
- **Read only**: a welcome whose `access` is `read` (`docs/contract.md`) means the two copies of Infinitary are too far apart; the window says which one is newer and makes no changes but one.
  A first mate on major 16 or later, one whose welcome lists `messages-while-reading`, or one that speaks a newer major than this view, still hears plain words (`messagesWhileReading`): the input sends them as one string without the hints about what is on screen, a turn with pictures or files stays with "Only words can go until Infinitary is updated." under it, and the pill says the first mate still hears the captain and buttons come back once the older side is updated.
  When the newer one is there, the window asks for this Mac to be updated, and this Mac's own update notice is how.
  A development run may stand in another contract version for the Mac where the first mate lives with `INFINITARY_CONTRACT_VERSION`, and its view floor with `INFINITARY_VIEW_FLOOR`, so a view on the same build reads as too far apart; a packaged app ignores both.

### When the first mate moves

When the first mate moves to another computer, its welcome's home number goes up by one and every window hears `inf:home:moved` with the new home's addresses (`docs/devices.md`, "Moving the first mate").
The window keeps those addresses and the number beside its grant (`JoinedHome.keepHomeNumber`) and dials the new home with no new link; one that heard a higher number refuses a first mate with a lower one.
The old home's own window starts again as a window of the new home, and a window on the destination starts again as the home itself.
Dictation runs only in the window on the first mate's own computer, so a computer that becomes a window of another loses it; the Ready list says so before the click.

## Live, catching up or out of reach

The top line, at the top bar's left (`RemoteControlLine`), says how fresh what the window shows is (`freshnessOf`, `src/renderer/src/devices/viewWords.ts`):

- **Live**: "Controlling your first mate on MacBook Pro · live", once every change there is shown here.
- **Catching up**: "· catching up on what was missed" while a replay's pushes arrive, or "· catching up, reading everything again" while a reload's reads are under way (`catchUpOf`).
  The window counts a reload read once `resync` has answered: the store's `rereadThrough` follows `caughtUp` only then.
  A reload is counted in the same word that says the Mac is in reach, so nothing reads live between out of reach and catching up.
- **Out of reach**: "MacBook Pro is out of reach · since 14:32", the time in mono, and "since Nov 11 14:32" when that was not today (`sinceWhen`).

The line carries `data-freshness` and, while catching up, `data-catch-up` (`replay` or `reload`).
Catching up changes nothing about what is refused: changes are on as soon as the other Mac is in reach, and words typed while it was out of reach stay in the input, never sent.

## Out of reach in the window

- **One pill** under the top bar says why changes are off: asleep or on another network, Infinitary closed there, or a newer or older Infinitary there; when contact returns and the catch-up is done it reads "MacBook Pro is back.
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
General leaves out that computer's Start at login, Dock, dictation and panels switch, which are set at its own window (`GeneralTab`); the panels it switches show here all the same.
A project's folder is typed as its path on that computer, since a folder picker here shows only this computer's folders: Choose folder on the projects folder's line under Add project, and Folder on Mac mini in Add project (`FOLDER_THERE_WORDS`, `src/renderer/src/settings/addProjectWords.ts`); that computer checks the path and says why one cannot be used.
Their keyboard commands work there (`src/renderer/src/app/commandRefusals.ts`).
A first mate's card for an act Settings shows only on that computer (moving the first mate, keeping a copy, keeping one of two first mates, a page of Secrets) sends nothing from here: the card stays up and says to choose it on that computer (`fromHomeWords`).
The first mate refuses the click from a paired window too, an older one included, with the same instruction, so its card stays up (`cardActions.ts`).

## Asking to keep a secret on a view

An ask to keep a secret is answered at any window: this Mac draws the card's masked fields as the first mate's computer does and sends Save secret with the typed values in its own request over the connection, `inf:secrets:keep`, which that computer keeps straight in its Secrets (`docs/secrets.md`, "Asking to keep a secret").
A window on a version that does not list the change gets the card without Save secret and says where to answer it.

## Card buttons that open Settings

A card's button whose click opens a Settings section is sent, and opens that section here, Devices included, with what to do on arrival, such as making a link.
Only a first mate too old to answer it keeps the button from being sent (`doneThereWords`): it says so on the button's rest, the pointer's or the keyboard's focus, and, once clicked, as its inline line, and the card stays on both Macs.
The card's other buttons, such as Move to Grok beside Sign in, are sent as before, and while changes are off every button is marked off.

## Unsent picks on a view

A card's unsent picks, the words in its field and its queued notes are kept at the first mate's computer and follow the captain between every window that shows the card, this one and the window there included (`docs/card-authoring.md`, "Unsent picks follow you").
A pick made while that Mac is out of reach waits here and goes once it is back, unless another window changed the same question meanwhile.
Every welcome after the first, replayed or not and however short the drop, counts in `thisMac`'s `linkBack`, and the window reads every draft again on each, since a draft's live frames are never replayed (`ViewBackend`, `src/main/view/viewBackend.ts`).
A first mate too old to list the `card-drafts` change keeps none, and each window keeps its own as before.

## A task's browser on a view

A task's browser shows its page in any window, wherever the first mate lives: the window asks the other Mac to watch the task, and the other Mac sends its pictures over the connection to this Mac alone (`docs/task-browser.md`, "The view"; `docs/connection.md`, "Live pushes").
`ViewBackend` watches once for every window here that shows the task, hands each picture to those windows, and asks for the room the last maximized window gave the page.
A window that closes or loads another document stops watching, and the other Mac stops sending once the last one has.
A drop ends every watch there, so each welcome watches again, with that room.

- **Taking it over.**
  A crewmate's request card's open-browser action - Open browser and sign in, Sign in myself, Open browser and pay - is sent from a view as from the first mate's own window: the other Mac answers the card on both Macs and hands the browser to the captain, and this Mac opens the view.
  Take control, Return control, Stop and Open again in the view are sent the same way, and the captain's clicks, typing and paste go to the page there (`inf:browser:input`).
  Its words name the computer where the first mate lives (`firstMatePlace`): "Your aurora.example sign-in stays on MacBook Pro.
  Later tasks:", "signed in on aurora.example · kept on MacBook Pro".
- **While changes are off.**
  Take control, Return control, Stop browser, Open again, Back, Forward, Reload, another page's tab and a card's project-page button are marked off with the reason, as every other card button there is, and the browser.control key refuses with it.
  The page takes no clicks or keys, and the line under it gives the same reason unless the pill already shows it whole.
- **A signed-in site.**
  Use my sign-in needs no one at the page, so a view sends it as any other choice: the other Mac opens the browser's page signed in from its own kept profile and hands it back to its crewmate, the card is answered on both Macs, and this Mac opens the view.
  When the sign-in cannot be used, the browser stays paused there and the feed says why, as on that Mac (`docs/task-browser.md`, "Signed-in sites").
- **A first mate too old to send pictures.**
  A first mate older than major 16 whose welcome does not list `browser-from-any-view` answers no watch, so this Mac marks itself `browserNeedsUpdateThere` and asks nothing of a task's browser.
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

- `src/core/viewWindows.test.ts` and `src/shared/windowAnswer.test.ts`: an ask answered only by the window asked, a window not connected or silent, and a window answering its own ask; `src/core/core.settingsParity.test.ts`: a window's own setting changed at the named Mac's window and not at the first mate's computer, and the key reminder asked of this computer's window.
- `src/main/shell.test.ts`, "names that Mac where its own refusals and feed lines say this computer", and `src/main/shell.localWindow.test.ts`, "shows its first mate's own refusals and feed lines as its core wrote them": a view names the first mate's computer in each refusal shape, a refused request, a line it marked, a task's record and its own cards, in every answer and push they ride, and leaves the captain's and a crewmate's words; the first mate's own window shows each as written.
- `src/main/view/namedHere.test.ts`: what naming changes - a line's fact and its places, a record's own lines with the pull request they link, its timeline readings and problem, a host card's title, body and change bar, and the brief and a crewmate's words left as written.
  `src/core/tasks/taskFeed.test.ts`, "the first mate's own words on the feed", and `src/core/tasks/recordActivity.test.ts`, "marks the lines in the first mate's computer's own words": which lines the core marks.
  `src/core/dispatcher.placement.test.ts`, `src/core/placed/placedReach.test.ts` and `src/core/placed/placedRunsOn.test.ts`: the lines that save here as a place.
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
- `tests/e2e/panels-every-window.spec.ts`: the window opened beside a command and a window on another computer each draw a panel from the first mate's built files, run its action there and show its data, and draw it anew once it is built again; the second window's own folder holds no panel.
  `src/main/frames/panelMounts.test.ts` holds the mount: the files asked by source, panel and version, a draft asked only as one, another version's line, and the bounds held again.
  `src/core/core.connection.test.ts` holds the first mate's side with a real panel: a view is answered the same files as its own window, nothing for another version, and its word on where a panel was drawn is not kept; `src/main/shell.test.ts` the view's side, the files asked there, its panels switch followed, no panel being built heard, and an older first mate's panels left off.
- `tests/e2e/update-channels.spec.ts`, "a Mac controlling a newer Firstmate on another Mac is offered its own update": the other Mac's newer contract named in the top bar, this Mac's own offer there, its release page opened here, and the other Mac offered nothing.
- `src/main/shell.test.ts`, "a Mac that controls another and runs its work": joining with a link for a Mac keeps the grant for its work and sets it up in the background, a refused background named on the window and told to the home and set up again on the home's Fix it, an older home told nothing while the window still names it, a lost grant written again at the first connection after a launch, nothing set up again for a Mac its home removed while its app was closed, a Mac a command added opens as a view with its work's grant and never again as the device it left, and a grant that only runs work stays the work's; `src/core/helper/fromWindow.test.ts` and `src/core/helper/workSetup.test.ts` the work folder's side, each reason on real folders.
- `tests/e2e/devices-work-setup.spec.ts`: a Mac joins by a link while a stand-in service manager refuses its first start; the window's notice and the home's Devices row name the reason, with Fix it on the row, and Try again on the window, pressed from the keyboard, brings its work into reach.
- `tests/e2e/view-home-moved.spec.ts`: the other Mac starts again at another address, which no address the window keeps names; the window refuses another computer announcing Infinitary with a key of its own, comes back by the other Mac's announcement, keeps its new address, and that Mac pairs nothing new.
- `tests/e2e/view.spec.ts`, "a Mac joined at its first launch also runs that Mac's work": the home standing in another Mac for each app, a link pasted at first launch joins a Mac that controls and, its work started, is in reach to run work; a Mac a command added opens Infinitary there and controls with no first launch and no new link, and its Leave says it stops its work too.
- `src/core/devices/remoteLoginLink.test.ts`, "asking a computer for a link by its address", and `src/core/devices/phoneDoor.test.ts`, "the computer link command": the key line then a link, a port kept with its key line, not open, this app's own link, the password once, and the command under each login shell with each reason it makes no link.
- `tests/e2e/join-by-address.spec.ts`: a fresh app, by keys only, joins another app on the same computer by its address over a local SSH server, answers the key line, controls it and is listed as a Mac.
  A second journey does the same from a first launch whose window started its first mate in a command: the command's first mate asks for the link, the window joins with it, and the command stops and is not started again.
- `tests/e2e/view.spec.ts`: two apps on one Mac - a fresh app joins at its first launch, shows the other's cards with their pictures, its feed and its tasks, an answer in either shows in the other, a button that opens Devices opens that Mac's Devices here and makes its link, out of reach says since when and refuses changes and never sends them, a restart there reads out of reach, catching up by reading everything again and live in that order, it restarts as a view with its record untouched, and Leave returns it to its own first launch.
  A second journey drops a picture, a text file and a PDF on a view: the picture and the text reach the other Mac's first mate and are kept there, and the PDF, dropped or chosen, on the input or a reply, is refused with no path of this Mac sent.
