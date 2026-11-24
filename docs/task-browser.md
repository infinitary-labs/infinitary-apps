# The task browser

Each task may have a browser of its own, on the computer the task runs on, which its crewmate drives: it opens a public website or a page a project serves on that computer, reads it, uses it with real input, photographs it into its evidence folder, and closes it.
The captain watches it drive in the task's browser view on the stage, takes control of it when the page needs a person, and makes every final submission on it personally.
The design is the captain's (rev-10 in `docs/architecture.md` §14, the isolated page in §4; the view's look is the design skill's `components/cards/TaskBrowser`).
This page says how the browser works now, for a task on this Mac; "On another computer" says what changes for a task that runs on a computer that runs work.

## Who has it

Every build has the task browser, stable, alpha and development alike.
The core keeps task browsers wherever its host has a browser engine; on a host with none, `CoreServices.browsers` is absent, so no crewmate is handed one or its command, and the view's commands and signed-in sites answer that this Mac keeps no task browsers.
`core.boot.test.ts` ("every build keeps task browsers on a host that has one") holds that for a packaged core, an unpackaged one and one whose host has no browser.

## What a crewmate has

One command in its shell, `infinitary-browser-axi`, on Pi and the Claude client alike, and one line in its instructions that says to run it (`docs/axi-commands.md` has the command, its channel and its table):

- `open`, `back`, `forward` and `reload` open the task's browser at an address or move it, and `selectpage` switches to its other page ("A second page").
- `snapshot` reads the page again: from its top, from a line with `--from`, around some words with `--find`, or every line with `--full`; with a ref it reads a cut passage in full, and `wait` waits up to ten seconds for some words to appear first ("Reading a long page").
- `click`, `hover`, `drag`, `fill` (typing into a field, replacing what it holds, or choosing a list's option), `fillform`, `press` and `scroll` use the page with real input.
- `upload` gives a page that asked for a file one from the task's working copy ("A page that asks for a file").
- `screenshot` photographs the visible page, the whole page, or with `--uid` one element's visible part, into the task's evidence folder, where the crewmate opens it with its read tool; once the captain has handed the browser back it needs `--reason` ("A signed-in page").
- A file a page downloads is saved in the task's evidence folder, and the next answer says where ("A download").
- `stop` stops the browser, and `closepage` closes only a second page; `pages`, `console` and `network` read the browser's pages and the page's lists.

Beside it, that crewmate's `emit_card` takes `browser_button`, the label of a card's door to the browser ("From a card" below), with `browser_page` when that door opens a page from the task's project ("A page from the project" below), and `browser_handoff` with an action whose effect opens the browser for the captain ("Asking for help" below), which is also how it asks the captain to make a final submission ("A final submission" below); no other crewmate's schema has either.

The command is granted where the browser binds (`CrewSupervisor.browserHooks`): on this Mac when the host has a browser, and on a computer that runs work when that computer keeps task browsers ("On another computer").

The browser stays open across the crewmate's turns.
It stops on `infinitary-browser-axi stop`, on the captain's Stop browser, when its task closes done or dropped (except a browser the captain's own click on a page from the project started, which is the captain's, below), after half an hour with no command while nobody watches it and the captain does not hold it, when its page stops working, or when the app quits.
Whatever stopped it is told to the crewmate once, and the next open is a fresh browser, signed in only where the task may still use a kept sign-in ("What a task keeps").
At most four task browsers run on this Mac at once; the next one is refused in words, and none is stopped to make room.
One command runs at a time per task, in the order they came, and each answers within 30 seconds, in words when the page did not finish.

`TaskBrowsers` (`src/core/browser/taskBrowsers.ts`) is the one owner of every task browser and every word a crewmate reads from one.
It composes its parts over one typed core (`BrowsersCore`, `browserRecord.ts`, with each browser's record): the crewmate's commands (`crewmateCommands.ts`), the input actions (`pageActions.ts`), signed-in sites (`savedSignInGrants.ts`), each browser's notices (`pageNotices.ts`) and the files it writes to the evidence folder (`evidenceFiles.ts`).
Callers drive every browser through `TaskBrowsers`, and import the shapes and words they share from the part that owns them.

## Where a page may go

A crewmate opens a public website over https, or an http or https address on this Mac's loopback: `localhost`, a name ending in `.localhost`, `127.0.0.0/8` or `[::1]`.
It also opens a private site the captain allowed ("Private sites" below), by its name, over https or http.
Which websites a task needs is the crewmate's judgment, from its instructions; the host checks only the typed rules below, never what a site is for.
Opening a loopback address registers its origin (host and port, with a live-reload socket on the same port counted as the same origin) for that task alone.
The host registers one more the same way: the address it serves a project folder at for a page from the project ("A page from the project" below).
A website over plain http that is not on the list, and an address written out that is on a private network or kept for special use, is refused before anything opens, in words that say what to open instead.

Every request a page makes asks `decidePageRequest` (`src/core/browser/destinations.ts`) before it leaves, top level or not: a redirect, a frame, a picture, a script, a worker, a websocket, a popup.
Content the page makes itself (`data:`, `blob:`, `about:`) and the origins the crewmate opened go through, and so does a public website over https or wss, and a listed private site over any web scheme, from any page.
A page's own top-level move to another server on this Mac over http or https goes through too: a link, a redirect or a form, such as a sign-in's return to a program (`http://localhost:1455/auth/callback?...`), which the crewmate need not open first.
The browser keeps that origin in `reached`, and then a request to it goes through only from a document at that same origin, as the engine reports it (`page` on the request): the program's page loads its own parts and its live socket, while a website's hidden request to it, from any other page, stays refused.
The built-in engine names that page by the request's initiator, the document the browser says started it, which no page sets and no referrer policy hides; a frame's recorded address decides only a request with no initiator, since it can still read the page before a new document while that document asks for its parts.
A popup to such a server is refused, since only the page itself moves.
Two ways around the page check remain, by the captain's choice to keep sign-ins working in every engine: any page's own move may be a form's POST, so a website can send a program on this Mac a blind request by moving there, and in Google Chrome or Edge a live socket to a reached origin passes the guard from any page of that browser, or of any browser in the kept profile, since the guard never knows which page asked.
Everything else is refused: another server on this Mac by any other way, an address on a private network, a website over plain http or ws that is not listed, a file, an app scheme.
Google Chrome's request pausing never sees a websocket open, so there its websockets are judged by the connection guard alone: one to this Mac reaches only an origin the crewmate opened or a page's move reached, and one to a public website is carried to the address the guard checked, over wss or plain ws alike.

An address is only what it names, and a public name can resolve to a private address, or change to one between a check and a connection.
So every connection off this Mac's loopback goes through the browser's own connection guard (`startConnectionGuard`, `src/core/browser/connectionGuard.ts`), its session's one proxy.
The guard resolves the name itself, reads each answer's kind (`addressKind`, `src/core/browser/addresses.ts`): public, this computer, a private network such as an office or VPN network, or reserved.
It dials only the answers it checked, in the order the name server gave them, and never resolves the name again: a public answer, or for a listed name a private one too.
A name that is not listed with public and private answers connects through its public ones alone; its private answers are skipped and never dialed.
A name with no answer it may dial is refused at the connection, before anything reaches it, and named in the next answer.
The guard carries `CONNECT` tunnels, and the page's own TLS runs end to end through them; it neither reads nor ends it.
It also forwards a plain http request for a listed name, or for a host and port on this Mac's loopback its browser registered, its own sign-in and hop headers taken off, to the address it checked; any other plain request is refused.
A server that drops the connection, or a registered port on this Mac with nothing listening, drops the browser's request too, so the page reads a failed request, never an answer the server did not give.
The built-in engine never sends loopback through the guard: the browser resolves those names to this Mac itself, never through a name server, and the policy above has already checked their origins.
Installed engines send loopback through the guard too, because its request pausing never sees a websocket open ("Installed browser engines"): the guard dials this Mac's loopback, never through a name server, only for a host and port its browser registered (`local`), and refuses every other as this computer's.
WebRTC reaches its peers only through the guard (`disable_non_proxied_udp`), so it never goes around it.

The guard listens on loopback alone, starts when its browser opens and stops when it does, and answers only its own browser: the session signs in with a secret made for that guard, and any other caller is refused before anything is resolved.
The browser never answers a sign-in challenge for a page's cross-origin picture, so the host signs the session in once before the page loads, by asking the guard for `GUARD_SIGN_IN_HOST`, which it answers at once and never resolves; every connection after carries the sign-in.
An unpackaged run may stand in its own resolver with `INFINITARY_TASK_BROWSER_HOSTS`, a JSON map of names to addresses (`hostsLookup`); the guard still checks every answer, so the map can only narrow what a page reaches, and the end-to-end launcher gives every run an empty one, so no page reaches a real network.

The next answer names what was refused, by host and by why: a private network, plain http, another server on this Mac (open it with `infinitary-browser-axi open` to let the page reach it), or not a web address.
A name the guard could not find, or whose server did not answer, is named too, with a line saying the page itself loaded and only these parts it asked for are missing, since a page often works without them.
A name this computer's network has no route to - every address it dialed answered at once that there is no way there, as when a name has only IPv6 addresses and the network has no IPv6 - is named apart (`GuardRefusal.noRoute`), saying no server was asked.
A load of the crewmate's own that the guard refused says why in its lead (`guardRefusalLead`, `src/core/browser/pageNotices.ts`): the name was not found, did not answer, had no route from this computer's network, or leads to the addresses it names, each with its kind.
A private network's answer says the captain can allow the site for task browsers, and tells the crewmate to ask the first mate in its report (`needs_firstmate`), naming the site; a listed name that leads only to an address no task browser reaches says so; this computer's says to open the page by localhost; a reserved one says a proxy app or DNS filter usually gives it.
A mixed name whose public answers did not respond names them, and the private answers it skipped.

The browser also refuses, and tells the crewmate once:

- a certificate that does not verify: nothing from that site loads, and the browser never goes past it;
- a site's own sign-in box (HTTP authentication), which it never answers, so the crewmate asks the captain on a card;
- a request for a client certificate, which it never offers;
- a passkey request ("A passkey request").

Nothing a page asks for ever opens in the person's own browser or another app: an app scheme is refused like any other, and every permission, the one that opens an outside app among them, is refused, but what the captain allows once while holding the page ("A site's asks").
A page that takes the crewmate to a sign-in it did not expect, or on another site, is not signed in to by the crewmate: the help of the answer that opened it tells it to ask the captain with `browser_handoff` ("Asking for help").

### A page on a refused address

A page can come to rest on an address its browser refuses, as when it moves to a website over plain http or to an address written out on a private network: the browser engine then shows its own error page at that address, blank in the built-in engine and `localhost is blocked` in Chrome.
A program on this computer is such an address only for a moment, since a page's own move reaches it ("Where a page may go"): a kept-profile page the crewmate drives is refused there before it reopens in an empty context (`leaveKept`), and the captain can take the browser in that moment.
Each engine tells the core such a page with `onLoadFailed` (`HostPageEvents`, `src/core/host.ts`), so the captain's view reads the address again.
The error page takes the whole address as its title, so the view's tab names only its host and port, and the crewmate reads it as it reads the address (`titleOf`, `src/core/browser/browserRecord.ts`).
Whether the page is on one is read off its address as it is now (`pageBlock`, `src/core/browser/destinations.ts`), never off what the page said, so it holds whoever drives and goes once the page moves on.
The browser's open fact carries it as `blocked`: `local` for another server on its computer, `private` for a private network, `insecure` for a website over plain http.
The view says so in Infinitary's words in the line under its row (`blockedWords`, `src/shared/taskBrowser.ts`), after a line that nothing answers and before a stale card's words: for a program on the browser's computer, while the captain holds the page, `Infinitary blocked <site>, a program on the browser's computer. Return control, and the crewmate can let the page reach it.` When the captain returns control on such a page, the crewmate's first look names it after the line saying control came back (`blockedPageWords`, `src/core/browser/pageNotices.ts`): its host and port alone, since the rest of the address may carry a sign-in's code, why it is refused, and what to do.
For a program on this computer that is to open the program's address with `infinitary-browser-axi open`, which lets the task's pages reach it, then go `back`, which loads the refused page again with its whole address; if that does not finish, the crewmate asks the captain to sign in again.
What the page asked for while the captain held it stays his ("Taking control"); only the page it rests on is told.

## Private sites

A site on an office, home or VPN network has a private address, so a task browser reaches it only once the captain lists it.
Settings › Integrations › Private sites holds the list (`PrivateSitesSection`), one box after the Infinitary command box: one row per entry with Remove, a suffix's row saying it covers every name under it, and a "+ Site" button that opens the field in its place, which adds one with Enter or Add and closes with Escape or Cancel.
An entry is a name (`wiki.corp.example`) or a suffix of two or more parts (`.corp.example.com`, typed with or without `*`) that covers every name under it but not its own bare name (`normalizePrivateSite`, `listsPrivateSite`, `src/shared/privateSites.ts`).
An entry is never an address, `localhost` or a top-level domain alone, and a pasted address adds its host.
The first mate never adds one: when a crewmate's report names a private site the task needs, it puts up the app's own Allow card (`private-site-allow` in `src/shared/actions.ts`), and only the captain's click on Allow adds the site, landing on Settings › Integrations with the box in view and the site listed.

The home keeps the list in one file (`PrivateSites`, `src/core/browser/privateSites.ts`, `private-sites.json`) and is its one writer.
The list is one for every computer: a computer that runs work asks the home for it (`inf:work:private-sites`) before each of its crewmate's opens and keeps no copy, and while the home does not answer, the last list it read stands, empty at first.
A browser here reads the same file before each open.
Each add or Remove reaches open browsers at once (`PrivateSites.onChange`): the home gives its own browsers the new list and sends it to each computer with an open task browser (`inf:task-browser:private-sites`), and every browser's guard ends the connections it holds to a name no longer listed (`ConnectionGuardHandle.recheck`), so a removed site stops loading at once, on every page.
A computer out of reach at the change takes the list when the home hears from it again (`PlacedBrowsers.reached`), and the guard checks the list again once a dial ends, so a Remove that lands mid-dial ends that connection too.
Every computer admitted to work on the current contract includes this order; an older computer must update before it can run work.

A listed name is still resolved and checked by the guard.
Its public answers and its private-network answers are dialed; this computer's loopback, an unspecified address, link-local, multicast and cloud metadata addresses never are, however they are written, IPv4-mapped and NAT64 forms included (`neverReachable`, `src/core/browser/addresses.ts`, the same list the custom API's exception reads, `docs/custom-api.md`).
Any page of a task's browser reaches a listed site, as an ordinary browser does, over https or http.
An address written out stays refused even when its name is listed, so a site is reached by its name alone.

The fence is the page's, not the crewmate's: a hostile page cannot reach the rest of this Mac or its network through the task's browser, beyond the private sites the captain listed, while the crewmate's own shell stays socially isolated (`docs/architecture.md` §4).

## What a crewmate reads

Every page answer opens with a short facts block: the page's title and address, its ref book (`refs: g3`, or `none` when it has no refs), how many controls carry a ref, its place among two pages, the errors it logged since the last answer, and what was done (`did`); the command prints them as its aggregates (`BrowserPageFacts`).
An action says whether the page stayed or changed; notices follow the facts, then the outline window or changed lines.
Refusals without a page read, captures and closing the browser keep their own answers, and a refusal is typed (`BrowserAnswer.refused`), so the command prints it as an error.

The outline is the browser's own accessibility tree folded into one line per heading, piece of text and control (`outlinePage`, `src/core/browser/outline.ts`).
A control the crewmate can use carries a ref such as `g3:e5`, which names its page's book (`g3`) as well as the control (`e5`); the same element keeps its ref until the page moves to a new address, including a move that does not load a new document.
Each new document, each second page, and every page once the captain hands the browser back starts a new book (`RefBook`), numbered after every book its task's browsers have had in this run, and a book takes its number when a read first names a ref from it.
The numbers start again when the app starts, by which time every browser has closed.
A ref is used only on the page whose book gave it, so an old ref never lands on the element that took its place.
One from a page that moved or closed, from the other page, from before the captain handed the browser back, or from a browser the task had before is refused in words saying which, and so is a bare `e5` (`refusedRefWords`); nothing reaches the page.
A label read just before its control folds into the control's line, a field's value is shown, and a password field's value never is; once the captain has handed the page back, neither is text the crewmate did not type, nor a key in a format a service issues ("A signed-in page").
A line shows up to 2,000 characters.
A longer passage is marked cut short and names a ref, and `infinitary-browser-axi snapshot` with that ref reads it in full, up to 80,000 characters, still hiding a password and, once the captain has held the page, text the crewmate did not type and a key in a known format.
A wait for words, and a search, read the whole passage, not only the cut line.
A `time` or `relative-time` element shows its machine-readable `datetime`, and a title tooltip is named on its line.

## Frames

A frame's own document reads beneath the frame's line, one level in, by the same rules as the page's: its controls carry refs in the page's book, and the crewmate clicks, types and fills them as any other.
The frame's line names it and its site, as `frame "Card payment" from pay.example`; a frame whose document the host could not read says so, and one with nothing to read says that.
A frame's title names the frame, never the lines inside it.
Inside a frame, a field's value is hidden by the same rules as on the page ("A signed-in page"), and a link drops its query on a page that may show the captain's account.

A frame from a known issuer of human checks - Cloudflare's challenges, hCaptcha, reCAPTCHA, Arkose Labs and DataDome (`HUMAN_CHECKS`, `src/core/browser/outline.ts`) - says it is a human check, which only the captain answers.
Its controls still carry refs, and each ref carries the check's site (`RefEntry.check`): a click, hover, drag, typing or fill that names one is refused in words, before anything reaches the page, telling the crewmate to ask the captain with `browser_handoff`.
The list is a floor, never a claim that nothing else is a check: a check drawn in the page itself, or from another issuer, reads as an ordinary control, and the crewmate's guidance still keeps it to the captain.

The host reads a frame from the page's own site in the page's own session, and a frame from another site, which the browser runs apart from the page, through a session of its own that it attaches as the frame starts and lets run only once it is prepared as the page is (`PageFrames`, `src/main/host/taskBrowserFrames.ts`).
Each element inside such a frame gets a number of its own for the core, its frame's place and the browser's own number in one (`PageFrames.targetOf`), so the core's actions stay the same for every element.
A frame element's box is measured in its frame and moved by where the frame sits on the page, cut to the part of the frame the page shows; a click lands at that point through the page's own input, and typing goes to the element the frame focused.

## A passkey request

While the crewmate drives, a page that asks for a passkey (`navigator.credentials.get` or `create` with `publicKey`, in the page or any of its frames) is told at once that it is not allowed, the way a browser with no passkey answers, so the site offers its other ways, such as a password or a code.
A passkey request the page asks for never reaches the Mac's own passkey prompt, which would attach to the hidden window and wait for a person nobody can see.
The host also answers that no passkey this device holds can be used (`isUserVerifyingPlatformAuthenticatorAvailable`).
A quiet request that only offers saved passkeys in a sign-in field (`mediation: "conditional"`) is never offered: the page guard answers that the browser has none (`isConditionalMediationAvailable` is false, as are `conditionalGet` and `conditionalCreate` in `getClientCapabilities`), so a site asks through its own passkey button, which the host sees.
A site that makes the quiet request anyway has it left to wait as the page made it; in the Chrome engine a person who picks a passkey it offers meets the system's own prompt in Chrome's window, the one passkey path the host does not ask about.
The crewmate is told once, by site (`HostBrowserRefusal` `passkey`): the site asked for a passkey, the browser said none is available, to look on the page for another way, and that a sign-in is still the captain's to make.
While the captain holds the page, a passkey request is the captain's ("A site's asks").

## A site's asks

A page asks for what needs a person's yes through the page guard both engines add to every document (`pickerGuard` in `src/main/host/pageProtocol.ts`): a passkey (`navigator.credentials.get` or `create` with `publicKey`, not the quiet sign-in-field request), whether this device holds one (`isUserVerifyingPlatformAuthenticatorAvailable`), the camera, the microphone or both (`getUserMedia`), notifications (`Notification.requestPermission`), and reading the clipboard (`navigator.clipboard.read` and `readText`).
The guard holds the page's call and tells the host, which asks the core (`HostPageEvents.onAsk`, a `HostAskKind`, the asking site and a promise that settles when the call ended or its document went), and answers the call in the frame that asked.
A yes makes the page's own call go on to the engine, with the permission granted for that site (`AskGrants`): the built-in engine's permission handlers read it, and Chrome sets it on the browser's context (`Browser.setPermission`).
A no ends the call as a browser does when a person says no: `NotAllowedError`, or `denied` for notifications.

While the crewmate drives, every ask is no, and a passkey adds the crewmate's notice ("A passkey request").
While the captain holds the page (`TaskBrowsers.pageAsked`):

- a permission the site asks for waits in the view's row above the page, `<site> asks to use your camera.` and the like, with Allow once and Not now, answered through `inf:browser:ask`, a core request every view may ask, which the core answers only for the captain's own browser and its current ask; the browser's fact carries it as `ask`;
- one ask waits at a time, and another while it waits is no;
- an ask goes, answered no, when the page's call ends or its document goes;
- Allow once lasts while the captain holds the browser: Return control answers a waiting ask no and takes back every permission the captain allowed, so the crewmate never drives a page with the camera on.

A passkey in Chrome can use the computer's own passkeys, which only a person at that computer can use, in Chrome's own window there.
So a passkey request is the captain's only where the captain's window is on the computer the browser runs on, and Chrome is the engine (`TaskBrowsers.captainAt`, from the window that asked: at the home, a request no paired view made; for a browser on another computer, one from that computer's own window, sent as `here` with each take, input and ask, `browser-asks` in `src/shared/contract-changes/`).
The system draws its passkey prompt only on a real Chrome window on that computer's screen, so a passkey brings Chrome's window out; it is asked first.
There the device check says yes, and the request waits in the row `<site> asks for a passkey. Using it brings Chrome's window onto your screen.` with Use passkey and Not now.
Not now ends it as not allowed, as anywhere else, so the site offers a password or a code, and Chrome never sees it.
Use passkey lets the page's call run in Chrome and brings Chrome's window to the front (`HostBrowserPage.showWindow`) for the system's prompt; the row then reads `<site> asks for a passkey. Chrome shows its prompt in its own window.` with Show Chrome window, which brings the window forward again when it went behind another (the fact's `ask` carries `allowed`).
When the request ends, answered or not, Chrome's window goes back to the Dock, whatever brought it out; Return control puts every Chrome window of the browser back to the Dock too, so one that came out by itself never stays on screen.
Anywhere else, and on the built-in engine, the passkey request ends at once as not allowed, so the site offers a password or a code, and the row tells the captain why (`told` on the fact): this browser has no passkeys, or Chrome shows a passkey only on the computer it runs on.
What the captain was told goes with control.

## Reading a long page

An answer shows a window of the outline, never the whole of a long page, and says which lines it shows: `outline: lines 1-260 of 905` (`windowOf`, `src/core/browser/window.ts`).
Lines keep their number in the whole outline, so a window says where it sits and a later read names a line.
What the crewmate just did chooses the window:

- An open and a read show the page from its top, up to 400 lines or 20,000 characters.
  An action that moves to a new page also shows a fresh window from the top.
- `snapshot --from` shows the page from that line on, within the same bound, and `snapshot --full` shows every line, from the top or from that line.
- `snapshot --find` names every line that holds the words, and shows the part around the first, from the part of the page that holds it when that starts close above, within 6,000 characters; with `--from` too, the search starts at that line.
  A wait for words answers the same way once they appear, and a full read of a passage shows the part around its line.
  A page that fits that smaller bound whole shows whole, so nothing above the words is missed.
- A scroll shows the lines the page's window shows now, and says which lines between them it skipped (`outline: lines 5-74 of 446, those on screen`).
  The host reads where each element sits from the page's layout (`screenFromSnapshot`, `src/core/browser/reading.ts`); a line it cannot place reads as where its parent is, and with no places at all a scroll shows the top.

Within one answer, a passage of 200 characters or more that the answer already showed folds into a pointer to its first copy: `text (same as line 87, 885 characters)`.
An answer that leaves lines out ends with a map of the page - its landmarks, named regions and forms, and top two heading levels, each with the line it starts on - listing up to 60 parts.
It then ends with next lines, made only from facts the window knows: lines left after it, the next line past it that holds the searched words, and a line it shows cut short with its ref; the command prints them first in its `help`.
A next line never names a control to press, so the browser never steers a crewmate toward a final submission, and none is guessed from the page's words.
A search reads each line's words as the outline writes them, so what the outline keeps back - a password, and once the captain has held the page, text the crewmate did not type - is never found.

## Reading what changed

An action on the same page answers with only the outline lines that changed since that page's last answer, or `changed: nothing changed in the outline.` (`changesOf`, `src/core/browser/changes.ts`).
An addition names its current line (`+ line 115`), and a removal its old line (`- old line 115`); a replacement counts as one removal and one addition.
Unchanged controls keep their refs, so the crewmate keeps a ref from the same page instead of needing the answer to repeat it.
A fresh `snapshot` always reads a window, not a change answer.
A scroll keeps its on-screen window from piece 2, since scrolling can change what is visible without changing the outline.
The comparison uses only safe outline text, never raw values, and the baseline belongs to one page and one ref book.
A move, a closed page or a handback never compares with an old book; a fresh page gets its full window instead.
The answer shows at most 400 changed lines or 20,000 characters, then counts what it left out and offers a factual read of the current page, with its map when it has one.
Comparison work is bounded: a large wholesale replacement reports the differing middle as removed and added, rather than attempting an unbounded alignment.

A click waits for the address or title to change, including a move that does not load a new document, then for the page to settle, and the answer reports the new address and outline.
A click on a link, Enter, and typing that sends a form wait up to four seconds; any other click waits up to two.
A page that closes itself during that wait still reports the click, and the answer reads the page that remains.
Any other action waits a moment, and waits further when the address or title has already changed.

What the page did is reported once each: dialogs (each dismissed, a page leaving is let go), errors it logged or threw, windows it tried to open (refused), and requests the browser refused.
A signed-out site's own request for `/_global-navigation/payloads.json` that answers 404 is left out of those errors, since it says nothing about the page.
A load that found nothing listening says to start the project's server first, and a server's error status is named.

## Console and network lists

`infinitary-browser-axi console` and `infinitary-browser-axi network` read diagnostics alone, without an outline or an action suggestion, as compact rows with their totals (`PageDiagnostics.list`).
The browser refuses a combined request for a list and an outline read.
Each page keeps its own history from opening or the last control handoff, across navigation; switching pages reads only the current page's list.
The lists are in-memory and bounded to the latest 100 console messages and 100 network requests, with total counts and omitted counts.
Repeated reads do not consume them or the ordinary once-only error and refusal notices.
Closing a page or browser discards its diagnostics.

The console includes log, debug, info, warning and error messages, and uncaught exceptions, with each message limited to 300 characters.
Once the browser has been returned or uses a signed-in site, the console retains and answers only counts by level, never message text.
Taking or returning control clears both lists, and no diagnostics are collected while the captain holds the browser or control is changing.
A late response to a request from the captain's time cannot recreate that request in the list.

The network list contains only method, address, resource type and pending, response status or failed outcome.
Every network address omits credentials, query and fragment, even before a handback; non-web addresses are not quoted.
Once the browser has been returned or uses a signed-in site, a key in a known format in an address reads as `[key hidden]` ("A signed-in page").
Neither the host event seam nor the list carries request or response bodies, headers, cookies or failure text.
These observations do not retry a request or change the connection guard, final-submission rule, hidden-input rule or captain-control refusal.
The command still exposes no page script execution.

## Input actions

`hover` moves the pointer onto the element a ref names, without clicking.
`drag` names the source and then the destination; both refs must belong to the current page, and both elements must fit in the viewport together.
The host scrolls the destination into view and refuses a drag whose source is then outside the viewport, rather than sending input at an old point.
It re-measures the points after moving the pointer, since hover can close a menu and change the layout, then sends a left-button press, moves with the button held and releases it.
This is pointer input, not an uploaded file or synthetic page script.

`fillform` lists between 1 and 50 text fields, each `@ref=<text>`, filled in order without pressing Enter or submitting a form (`action: "fill"`).
Empty text clears a field.
Every ref and every field's editability and visibility is checked before input; a stale ref or absent field in that check changes no values.
Filling is not a transaction: if the page moves or a later field disappears after input starts, the answer says how many fields were filled and stops without retrying.
A field's new text is marked as the crewmate's own in its current ref book, as ordinary typing is; values never appear in the captain's action line.
`fill` puts text in one field, replacing what it holds, or chooses the option of that label when the element is a list (`action: "set"`): the host tries the list first, which does nothing to anything that is not one.

A scroll without a ref accepts `top` or `bottom` as well as `up` and `down`.
Top and bottom scroll the document to its edge, and answer with the lines on screen, as other scrolls do.
Up and down send a real wheel, and the host does not return until that scroll has ended, or until a one-second bound when the page never says so, so the answer is not read at the old position.
The wait follows the scroller under the wheel, or the document when the page itself scrolls, and ignores a scroll end from any other scroller.
A scroller inside a frame or a shadow root is not followed.
A page that locks scrolling can still take the bound, because the wheel then never ends.
The host also stops a moment after that bound, so a page that replaces its own timer cannot hold the answer.
A wheel that cannot move the page, because it is already at that edge, is still sent and does not wait the bound.
An element photograph accepts its page-named ref (`--uid`), or a whole-page photograph `--full-page`, never both.
A photograph of the visible page starts where the page is scrolled to, never at the document's top, so a scrolled page is never pictured as a blank band above what is on screen (INF-2375); a whole-page photograph starts at the top.
It scrolls that element into view and crops the photograph to its visible box; a hidden or removed element is refused.
All photograph guards apply to the whole page even for a crop: a reason is needed after a handback, and hidden typed text or a hidden key anywhere on the page refuses the picture.
All new actions use the existing serial queue and captain-control refusal, connection policy and ref books.
The command exposes no script execution, dialog acceptance, free tabs or emulation, and attaches a file only as "A page that asks for a file" says.

## A page that asks for a file

A task's page never appears on the desktop, so no picker of the Mac's ever opens on it: macOS would put the hidden window on the desktop to hold one, with no title bar and no way to close it.
The host takes every request a page makes for a file over the page's protocol (`Page.setInterceptFileChooserDialog`), so the page's own file button or field opens no picker, and the core is told which file field asked and whether it takes several files (`HostPageEvents.onFileChooser`).
While the captain holds the page, the app's own picker opens as a sheet over the app's window (`HostTaskBrowser.chooseFiles`), and the page gets the files the captain picks there, as it would from its own picker; cancelling gives it nothing.
While the crewmate drives, its answers say the page asks for a file until it attaches one or the page moves to a new document.
`infinitary-browser-axi upload <path>...` then gives the page files from the task's working copy, by their paths there (`action: "upload"`), which is the captain's choice on INF-1454, a change to rev-10's design: each must be a regular file inside the working copy, never through a link out of it and never under `.git`, and a field that takes one file takes one.
Without the page's request, `upload` is refused in words that say to click the page's file button first.
A file the crewmate does not have is the captain's to give, on a card that hands the browser over.
A browser on another computer has no picker of the app's: a request there while the captain holds it waits for the crewmate, and the task's record says so.

Printing and the color picker would also put a window of the Mac's on the desktop, and printing holds the whole app until it is answered, so neither opens.
Before a document's own script runs, the host's fixed script replaces the page's print with one that does nothing and stops a color field's own picker, and tells the host through a binding it removes at once; the crewmate's next answer says the page asked to print or opened a color picker, among its dialogs.
A list's menu and a date field's calendar put nothing on the desktop, so they are left as they are.

## A download

A file one of the browser's pages downloads - a link the site serves as an attachment, an address that is a file, or a file the page builds itself - is saved in the task's evidence folder under `downloads/`, where the crewmate reads it and hands it on by path in its report, which is the captain's pick on INF-2442's card (INF-1734).
The host asks the core where each download goes as it starts (`HostBrowserOpen.onDownload`), and the core answers with the name the site suggested, reduced to one name in that folder (no folder parts, no control characters, not hidden), or `download` when it gave none.
A name already there is never overwritten: the next is `name-2`, `name-3` and so on before its extension, claimed the moment the download starts.
A finished file is the owner's alone (0600), since it holds whatever the site put in it; one that was cancelled or interrupted is removed, and nothing of it is kept.
The crewmate's next answer lists each finished file by its path and size and where it came from, or says a download did not finish, and names any still running; an address that turned out to be a file says so in the answer to the `open`.
The task's timeline gets one line for each finished download.
A download the captain makes while holding the page is saved and told the same way, since the file is now in the task's folder.
A download still running when the browser stops is cancelled.
On a computer that runs work, the file lands in the task's evidence folder there, beside its pictures ("On another computer").

## A second page

A page may open another window - a sign-in, a bank's check - and it opens inside the same browser as its second page, with the same site data, so its opener and a sign-in carry between them.
A browser holds at most two pages (`TASK_BROWSER_PAGES_MAX`); a window a page opens past that, or at an address a page may not reach, is refused and named in the next answer.
The new page becomes the current one: the crewmate's next answer says the page opened a second page and at which site, and its commands act on it.
With two pages every answer says which page it reads (`page: 2 of 2`) and names the other; `infinitary-browser-axi selectpage` switches, and each page keeps its own refs, refused on the other page with words saying to switch.
A second page that closes itself, as a bank's check does once answered, goes, and the crewmate's commands return to the first; `infinitary-browser-axi closepage 2` closes it, and the first page goes only with the browser.
A page another page opened is its own hidden window, made the same way as the first (`drivePage`, `src/main/host/taskBrowser.ts`).

The captain's view watches the current page, and the card's tab strip names each page Browser and its title ("The view").
While the captain holds the browser, the captain's pick of a page's tab makes that page current for the captain's input, and for the crewmate's fresh look once the captain hands it back.
What the second page says in the captain's time, its opening and closing included, is kept for nobody.

## A signed-in page

Once the captain has handed a browser back, or once it may use a kept sign-in - from its start when its task keeps one ("What a task keeps") - it may hold the captain's sign-in, so until it stops it keeps only what the task needs (`signedIn`).
The host reads that from typed facts - the captain returned control, the browser may use a kept sign-in, or its page runs in the kept profile - never from the page.

- Text typed into the page is read out only while it is just what the crewmate itself typed there since the captain last handed the page back (`OutlineOptions.typedOnly`, `RefBook.noteTyped`).
  Any other - a typed field's value, the text of an editable part of the page - may be what the captain typed, such as a card number or a code, whether or not the captain sent it: the outline says the field holds something, `(value hidden)`, and never what, and a wait for words never finds it.
  A typed field is a text box, a search box, a number field, or anything the browser marks editable, read from the accessibility tree's own facts, never from the field's label; an option chosen from the site's own list reads as before.
- A key in a format a service issues reads as `[key hidden]` in place, so the rest of its line still reads (`OutlineOptions.hideKeys`, `hideKeys` in `src/core/keyFormats.ts`).
  A page the captain held may show a key just made there, such as a new access token, and copying it is the captain's.
  That holds wherever the page's words reach the crewmate: a line of text, a control's or link's name, a list's options, including those a refused choice names, a field's value, a tooltip or description, a full passage, the page's title in the facts block, the pages list and its Also open line, a dialog's message, and every address, the network list's included.
  A link's address is hidden once it is read without its query, so an address that only looks like it holds a key still loses its query.
  A search or a wait for words never finds it, and an answer that hid one says what reads `[key hidden]` and to ask the captain on a card when the task needs that key.
  The formats are an explicit list of issuers' own prefixes and frames, shared with the diagnostics redaction (`KEY_FORMATS`): a key in another format still reads, so the list is a floor, never a claim that nothing else is a key (`docs/secrets.md`), and adding a format is a decision of its own.
- A picture is taken only for a reason the crewmate gives: `infinitary-browser-axi screenshot` without `--reason` is refused in words, and with one the task's timeline gets one line naming the site and the reason.
  A page that holds hidden typed text is not photographed at all, since the picture would show it: the refusal names each such field, and the crewmate reads the page instead.
  Nor is a page that shows a hidden key, element pictures included.
- What the page logged is counted, never quoted.
- Every address the crewmate reads - the page's, where it moved, a link's, a refused popup's - is read without its query and fragment, where sites keep tokens and codes, and Open again starts from that bare address.
- Every answer's help from such a browser says to keep only the results the task needs, such as a booking reference, a status or a total, and never passwords, codes, card numbers or whole account pages, in a card, a report or a picture.

No raw trace of the page is ever recorded, signed in or not, and the view's pictures go to the watching viewer alone and are never kept.
The captain's own view shows the whole address.

## The view

The captain opens a task's browser from the Browser line in its record's facts, under Progress: the site, who is driving or what stopped it, then `Open`.
`Open` brings the task's browser view to the front of the stack in the record's place, a shell-held entry like the record (`TaskBrowserView`, `src/renderer/src/cards/`), one entry per task between the two.
The view is the Browser tab of the task's card, whose tab strip shows Info and a Browser tab for each page (`docs/task-card-tabs.md`).
Its top is the record's own (`RecordPaneChrome`): the status pill, the task's key, the size control and Hide in the card's corner, the title and the strip, so Hide stays where it is on every card; the browser's own row of Back, Forward, Reload, the status line, the control button and More sits under it.
A stopped browser has no row: the top names the task over the stopped panel.
While it is shown the captain's words reach the first mate with the task as their hint, as a shown record's do; Hide or Esc puts it away and the browser keeps running.

What the view reads is the task's browser fact, which `tasks.detail` carries (`TaskBrowsers.fact`, typed by `taskBrowserFactSchema` in `src/shared/taskBrowser.ts`).
Open, it names the site (the current page's host and port), the page's title and address, and what the crewmate did last in a few words - `typed into "Email"`, `clicked "Send"` - never what it typed.
With two pages it also lists each page's own site and title, in the order they opened, and which is current (`pages`, `page`).
Stopped, it names why (the captain, the crewmate, half an hour unused, the page stopping, the task closing) and the page it was on.
Every command, page move and stop emits a `task_browser` event, which re-reads that task's detail; only a stopped browser's page is stored, with its task ("After a restart").

Who is driving is read off the task's work posture, the same typed fact as the record's pill (`browserDriverOf`): the crewmate drives while its turn runs, and once the turn ends nobody does and the page stays as it was left.
Back, Forward and Reload are shown and marked off while the captain watches, since navigation belongs to whoever has control and watching is not control ("Taking control" below): each stays a Tab stop whose label says who drives (`docs/keyboard.md`, "Facts shown on rest").

The page reaches the view as pictures, never as itself.
While a view watches (`inf:browser:watch`, a core request every view may ask), the host streams the hidden page's own pictures over the browser's protocol - one when watching starts and one each time the page changes - and sends each to that viewer alone on `inf:browser:frame`; the view draws the newest on a canvas, fitted to its width or at the page's own size.
The core keeps each viewer's watches (`BrowserViews`, `src/core/browser/browserViews.ts`): a window on the first mate's computer, or the connection of a computer that controls it, which gets its pictures as `live` frames (`docs/connection.md`, "Live pushes") and hands them to its own windows that watch (`docs/view.md`, "A task's browser on a view").
The page never enters the app's window, so the app's own menus, More's included, draw over it, and nothing the captain does in the view reaches the page.
A window that unwatches, loads another document or goes, or a connection that drops, stops its pictures.
Every window works the same way, wherever the first mate lives; only a view of a first mate too old to send pictures says to update it there (`docs/view.md`, "A task's browser on a view").

The page lays out at 1280 by 800 (`TASK_BROWSER_PAGE`) unless the captain maximizes the view (the design skill's ResponseCard, "Maximize").
Maximized, the view gives the page its room: the place under its row and the browser's lines, above its foot line, which it asks for on `inf:browser:size`, a core request every view may ask, and asks again when the window's size settles.
The sharing notice and a refusal line take room from the page, which fits under them.
The core lays every page of the task's browser out at that size (`TaskBrowsers.sizeView`): its window, its viewport, its pictures and every point the captain presses, and a browser, a second page or Open again that opens while the view stays maximized opens at it.
A resize waits only for a click the crewmate's command is making, and a click waits for a resize, so the page never moves between a command finding a control and pressing it; a read, a wait or a load goes on at the new size.
Restore, Hide or a window that stops watching gives the page back its own size.
Only a viewer that watches the task may ask, and a size is between 320 by 240 and 3840 by 2400 (`TASK_BROWSER_PAGE_MIN`, `TASK_BROWSER_PAGE_MAX`).
While any view watches a task's browser it does not stop for being unused; its half hour starts again when the last view goes.

Each page the browser holds is a Browser tab on the card's strip, reading Browser and the page's title (`browserTabLabel`), the current one selected; the site stays in the view's row.
Picking a page's tab is navigation, so it is the captain's only while the captain holds the browser (`{ kind: "page" }` on `inf:browser:input`); while the captain watches, the other pages' tabs are disabled.

More holds Fit or Actual size, Stop browser, Copy page address, and Report a problem, which starts the first mate input with "This task's browser has a problem: " for the captain to finish.
Stop browser (`inf:browser:stop`) stops it at once, and unlike the crewmate's own close it also ends the kept sign-ins the task may use ("What a task keeps").
Open again (`inf:browser:reopen`) starts a fresh browser, signed in only where the task may still use a kept sign-in, at the page the stopped one was on, refused in words past the cap of four or once the task has closed; the crewmate's next answer says the captain opened it again.
Both are core requests every view may ask.

## From a card

A crewmate's card may carry one door to its task's browser: the crewmate names the label (`Try it`, `View search`, `View booking`) with `browser_button`, and the host names the browser.
At emit the card's browser door (`CardBrowserActions.browserAttachment`) reads the task's browser fact and writes the card's live attachment (`LiveAttachment` in `src/shared/cards.ts`, `cards.attachment_json`): the label, the task, this run's `session` and the browser's `generation`.
`TaskBrowsers` mints a new `session` each time the app starts and counts each task's browsers in that run, so the two name one browser: Open again or the crewmate's next open after a stop is a newer generation, and a card from before a restart names a session no browser has.
A label that is empty or longer than 32 characters is refused in words, and so is a button on a task with no browser, or whose browser stopped when the task closed, unless it names a page from the project (below); a stopped browser Open again can still start is a door too.
A revision without `browser_button` takes the door away, and the attachment is part of the card's offer and its fingerprint (`docs/card-evidence.md`).

The card's chrome draws the door between the body and the buttons (`CardAttachment`, `src/renderer/src/cards/`; the design skill's ResponseCard, "A live attachment"): the micro label, the site and who is driving or what stopped it, read off the task's detail as the record's Browser line reads them, and the label as a button.
On a request card ("Asking for help") it draws no button.
The click opens the task's browser view at the front of the stack, so it never answers the card, runs no effect and leaves its merge where it was; the body's frame never sees it, and the card docks beside the page ("A card beside the page").
When the task's browser has stopped and may be opened again (`canOpenAgain`), and its task is open, the same click also asks what Open again asks (`inf:browser:reopen`, `pressReopens` in `CardAttachment.tsx`), so one press brings the page back; a refusal shows when the captain presses Open again in the view, and a view whose changes are off only opens the view.
The view compares the door's browser with the task's (`attachmentStanding`): the same one, open or stopped, opens as the record's Open would; one that stopped and was followed by a newer one (`replaced`), or ended by the app's quit (`restarted`), opens with a line under the row saying so, above whatever the task's browser is now.
The card's line says `this card's browser has stopped` in both cases.

### After a restart

A stopped browser's page is kept with its task (`KeptPages`, `src/core/browser/keptPages.ts`): one owner-only file, `browser.json`, in the task's own folder on the computer that runs its browser, beside its registered stops (`docs/leftover-programs.md`).
It holds the stopped fact, with the address bare when the captain signed in, the project folder its page served, if any, and the kept sign-ins the task may still use (`saved`, "What a task keeps").
Each stop with a reason writes it; the app's quit writes each open browser's page as stopped by the quit (`quit: true`, with `stopped` read as `gone` by a reader without the field); a browser that opens removes it; the task's close removes it, so a closed task's build is never brought back.
After a restart the first read of the task's browser reads the file as its stopped browser (`TaskBrowsers.endedOf`), with the session and generation it had, so a card from before the restart still names it and Open again, or a card's press, starts it there.
A computer that runs work answers the home's facts for each task it holds, not only the browsers that spoke since its start (`heldTasks`, `src/core/helper/browsers.ts`), so its restart keeps the page too.
The view then reads `This browser stopped when Infinitary quit.` or its earlier reason, with Open again, instead of `This task has no browser on this computer.`

### When nothing answers

A card's page is often a build its crewmate started on the task's computer, which may have stopped by the time the captain presses.
Nothing answering is one typed fact: the host's own connection to the page's loopback address is refused (`probeLoopback`, `src/core/browser/pageAnswers.ts`), never anything the page says, and only for an address the task's crewmate opened, never a project folder the host serves itself.
A timeout or any other failure reads as unknown and changes nothing.
The host checks when Open again or a card's press opens the browser and loads its page, and when the first view starts watching an open browser.
A refused connection starts one outage for the task, which its open fact carries as `unanswered` until a check after the crewmate's next open, move or reload finds the address answering.
At each check during an outage the host tells the card stack (`TaskBrowsersOptions.onUnanswered`, `CardActions.pageUnanswered`), which steers the task's crewmate once through its durable inbox with a `page-unanswered` wake, named for the outage (`page-unanswered:<session>:<task>:<n>`): the address, and that the captain opened its page and waits there, with the next move left to the crewmate.
Once its task closed there is no wake; while a turn of its crewmate runs the wake still goes, and its lane hands it to the crewmate at its next chance.
The view says so in the line under its row ahead of a stale card's words: `Nothing answers at <site>, so its crewmate was asked to start it again.` or, while its crewmate is working, `Nothing answers at <site>, and its crewmate is working now.`, each followed by `The page shows here once it answers.`; the page shows by itself once the crewmate opens it again.

### Starting a page again

A crewmate may save the command that starts its page with `open <url> --start '<command>' --within <seconds>`, for an address this computer serves (`PageStarts`, `src/core/browser/pageStarts.ts`, which runs it; the browser's own steps around it, which load no process code, are `src/core/browser/pageStartSteps.ts`).
`--within` goes with `--start`, a whole number of seconds the build may take to answer; it is the crewmate's number, and the host adds no default and no ceiling of its own.
`--start` for any other address is refused in words, and nothing is kept.
The host keeps the command, the folder the command's shell was in, the page's origin and the wait in one owner-only file, `page-start.json`, in the task's own folder on the computer that runs its browser, beside its kept page; one for each task, the newest replacing the last, removed at the task's close, and never part of a card or of a fact a view or phone reads.
At that open, if the address answers, the start is only kept; if nothing answers, the host runs it at once and opens the page once it answers, and the answer says which happened.
That wait for the build is outside the task's command queue, so the captain's moves on the browser and every other command still answer within 30 seconds; only the crewmate's open waits, its answer kept for its next command once its shell's limit passes, and the open itself then joins the queue.
The host runs it with the person's environment (`hostEnv`), below the window's priority (`atUtilityQos`), in the kept folder, in a process group of its own that counts to the task, with its output in `temp/page-start.log` in the task's folder.
It is not a crewmate's job: its exit wakes nobody by itself, and it is no proof of life for the idle ladder.
The task's shell is not laid over it, since that shell is lent to a crewmate's conversation and a restart may have none, so a start command cannot reach the task's own commands.
When a check during an outage finds a start kept for that origin, the host runs it instead of waking the crewmate: the open fact carries `starting` beside `unanswered`, the view's line reads `Nothing answers at <site>, so Infinitary is starting it again. The page shows here once it answers.`, and the page loads once the address answers, with no model asked; the check that started it loads it, once, and only while the page is still on that origin, so a page moved on meanwhile stays where it is.
When the program exits before the address answers, or the wait runs out (the host then stops it), the outage's one wake goes to the crewmate with the command, its exit code or that the wait ran out, and the log's path, and the view says the crewmate was asked; the same outage runs it no more.
A build the host started stops when its task's browser stops, for any reason (the captain's Stop browser, the crewmate's stop, or 30 minutes unused), unless a turn of its crewmate is running: then it is left alone, and it stops at that turn's end if the browser is still stopped (`PageStarts.stopWithBrowser`, `PageStarts.turn`).
The crew's turn owner tells the task's browsers when each turn begins and wherever it goes idle, an ongoing personal turn included (`CrewTurns`, through the supervisor's `browsers.turn`).
It always stops at the task's close and when Infinitary quits, whatever turn runs; the host never stops a program it did not start, and it cannot tell whose program answers at an address, so if anything answers, the page loads and nothing is started.
A crewmate's `emit_card` with `browser_button` on a page this computer serves, with no start saved for that page's origin, goes up as asked, and its answer adds one line saying a stopped server will wake the crewmate and how to save a start instead (`startWords.missing`); a page Infinitary serves from the project and every other address add nothing.
For a task on a computer that runs work, that computer says so beside each browser fact it sends (`unstarted`, never part of the fact a view reads), and the home reads it there.
On a computer that runs work the start is kept and run there, the failure travels with the `unanswered` event, and the home tells it of each turn with `inf:task-browser:turn` (`page-start.md`): a turn's end is always sent, even when the home forgot the turn across a restart, and each time that computer comes back in reach the home says again whether each of its tasks' turns runs; a computer on an older build refuses the flag, and its crewmate starts its server itself.

### The crewmate beside the page

With no card docked, a crewmate's browser shows a folded Crewmate line under the page, with its latest words or report headline when available.
Open it to see the Crewmate tab's transcript and message box beside the page, whether you are watching or have taken control from the task record.
Command-backslash opens or folds the column, and Shift-Command-L opens it and focuses its message box.
Words sent here use the Crewmate tab's lane and never return browser control or share the page.
If a card docks, its own thread takes the column instead.

### A card beside the page

A view opened from a card's own door, its browser's or a page from the project (below), docks that card as a column beside the page, as a request docks ("The request beside the page"; `dockedCardOf` in `src/renderer/src/cards/browserRequest.ts`): the card's body on top, so a checklist reads beside the page it is about, its thread under it once anyone has written there, and the card's one field at its foot.
Its choices stay off the column behind a Back to the card link under the body, which brings the card to the front of the stack with its buttons (Back to the card, `browser.card`, refused with its own line while no such card is docked); the strip on the card opens the view again.
Its column takes the request's width and folds to its latest line under the page as a request's does, on a narrow window or with ⌘\ (`entryView` places it as it places a request), and the link sits under the card's scroll so it stays in sight.
A reply from the field rides the card's thread lane as any reply does, and putting the view aside while it waits puts the card aside with it, as a request's does.

A card a crewmate of the same task puts up while that task's Browser tab shows arrives in the column instead of in front of the view (`arrivedInBrowser`, read by `reconcileStack` in `src/renderer/src/app/stack.ts`): the view keeps the stage, the card counts as seen once drawn, and the newest such card replaces an earlier one.
A card from another task arrives in the stack as usual, and while a request stands the request keeps the column and nothing arrives there.

### Pointing at a page

Feedback on a running build is about a place on its page, so the captain's Point at marks one there as it marks a picture (`docs/card-threads.md`, "Pointing at a place").
Point at sits in the row before the control button, with the card's own key (`cards.point-at`), and is offered while a browser is open and a note has somewhere to leave from: a card docked beside the page or the Crewmate column, on a home that lists the `card-note-places` change.
It works while the captain watches and while the captain has control.

Turning it on holds the newest picture of the page still (`useWatchedPage`'s `hold`, `usePagePointAt` in `src/renderer/src/cards/BrowserPointAt.tsx`): pictures that arrive meanwhile wait, and the newest is drawn when Point at ends.
A surface over the held picture takes the pointer and the keys, so nothing reaches the page: the captain's input is off while Point at is on, whoever holds the browser.
The captain presses a spot, drags a box or, with the line tool, draws one freehand line, in the held picture's own pixels.
By keys, the arrows step through what the page's outline names, lighting each thing's box, Shift with an arrow makes a box of the captain's own that the arrows then move and Shift sizes, and Enter opens the note popover; Escape ends Point at.

`TaskBrowsers.places` reads what the outline names once, when Point at holds the picture, through the read the crewmate's own outline takes (`pagePlaces`, `src/core/browser/places.ts`): each thing on screen by its role, its name and the box the window shows it in, at most `TASK_BROWSER_PLACES_MAX` of them.
It reads names only: no value typed into the page and nothing inside a typed field or an editable part.
The answer also carries the page's address and title as the crewmate's own reads give them, so where the browser may hold a sign-in the address loses its query and fragment and a key in the address, a name or the title reads hidden.
While the captain holds the browser the read hides the same, since a sign-in may be under way and the crewmate's next read comes after the return.
Nothing is recorded by the read, and a mark waits for it, so a note never leaves without the name the read could give.
The read is a core request every view may ask (`inf:browser:places`), and a view on another computer marks the picture it already has.

A note on a page is a card note whose `page` holds the page's address and title and, as `under`, the role and name of the smallest thing the outline names around the mark's middle; its `place` is the mark and its excerpt the page's title.
The popover shows the exact picture that will be sent, the held picture with the mark's number, and Queue keeps the note; while the captain has control it also says that sending shows this picture of the page to the crewmate.
Point at ends when the popover closes, queued or put away, and the live pictures resume.
A mark made while the column is folded opens it, so the note is written and waits where it will leave from.

With a card beside the page, the note joins that card's queued notes and leaves as one reply on its thread, with the card's other notes.
With no card there, it waits above the Crewmate column's message box and leaves with the box's next line, or alone: `inf:task:steer` takes the notes and their pictures as a third value, and `CrewSteer.steerFromCrewmateTab` words them after the captain's words and keeps the pictures as the line's own.
Either way the crewmate reads a Pointed at line with the page's title and address, the mark's number and place and what it is on, as `- page "Sign up" (http://127.0.0.1:5173/), mark 1, box 40,133 47×18 in the 1280×800 picture, on text "Name": …`, and gets one picture per held picture with its numbered marks drawn in.
Marks made on the same held picture share one picture; a page that changed between two marks gives two.
Nothing reaches the crewmate or the task's record before the captain sends, and a held picture that is never sent is forgotten with its queue.
A note beside a card is kept with that card's draft, as the card's other notes are (`docs/card-authoring.md`, "Unsent picks follow you"): its words, place and page follow to every window that shows the card and across a restart, and no agent reads a draft.
The held picture is never part of a draft, so only the window that marked the page sends it (`docs/card-threads.md`, "Pointing at a place").
A note with no card beside the page waits in its own window alone.

## A page from the project

A browser button may open a page from the task's project instead of the browser as it is: a crewmate gives `browser_page`, an HTML file's path relative to its working copy, which is its path in the project folder too, such as `index.html` for a finished game's `Play`.
The card's live attachment is then kind `page` (`LiveAttachment` in `src/shared/cards.ts`): the label, the task and the path, with no browser named, because none need be open.
At emit the card's browser door (`CardBrowserActions.pageAttachment`) refuses `browser_page` without a label, beside `browser_handoff`, and on a path that is not an `.html` or `.htm` file relative to the folder with no empty, `.`, `..` or `.git` part (`projectPagePathRefusal`, `src/shared/projectPage.ts`).
It refuses a task with no project, one that runs on another computer, and a file it finds neither in the task's working copy nor in the project folder.
Finding is `projectFile` (`src/core/workspace/projectPage.ts`): the folder is resolved once, then every part of the path is read without following it, so a link anywhere on the way is refused, and the end must be a regular file.

The card's chrome draws the door as the browser's other door is drawn (`CardAttachment`, `src/renderer/src/cards/`): the micro label, the path and `opens in this task's browser`, and the label as a button.
Its click asks `inf:cards:open-page` with the card's id alone, a core request every view may ask: the page opens in the task's browser on the first mate's computer, where the project folder is, and the view watches it there.
On a computer that controls the first mate, the button is marked off with the reason while changes are off (`docs/view.md`, "A task's browser on a view").
The core reads the path off the card's own attachment, checks the page again in the project's folder as Settings → Projects holds it now, and asks `TaskBrowsers.openPage`, which answers the browser it opened for the view to open on.
A refusal comes back in words the strip shows in place of the path until the next click.
The click answers nothing: it runs no effect, places no gate and leaves the card and its merge as they were, so a note carrying it never holds its task open and still opens the page after the task closed.

`TaskBrowsers.openPage` serves the project folder on a loopback address of its own (`serveProjectFolder`, `src/core/browser/projectServer.ts`) and registers its origin on the browser like one the crewmate opened, so every other request keeps the rules above.
The server answers only GET and HEAD, only to a request that names its own address as its host, and only for a file `projectFile` finds in the folder at that moment, so a file merged after the page opened is there on the next load; it closes with the browser.
It never opens the working copy's file, so before the work is merged the page is the project's current one or not there yet.
A browser the task's crewmate has open is taken first, exactly as Take control takes it, then loads the page; Return control hands it back as usual.
With none open - stopped, never opened, or its task closed - a fresh browser starts with the captain in control from the start.
It is the captain's own: its fact says so (`own`), its task's close leaves it running (only the task's removal stops it), and Open again starts it as the captain's again from a fresh server.
The view offers Close page in place of Return control, with no question, and it stops the browser rather than waking a crewmate that never opened it (`TaskBrowsers.returnControl`).
The cap of four browsers counts it like any other.

The project line in the sequences document has a finished casual web project's crewmate play-test and photograph it in its own browser through a local server it runs, then put up a note with that picture and Open (`docs/sequences.md`); the host never learns that it is a game or a page.

## Taking control

The captain takes a task's browser over with Take control in the view's row, and hands it back with Return control; nothing else moves it - not a click on the page, a sign-in, a redirect, Hide, a card closing or a timer.
Both are core requests every view may ask (`inf:browser:take`, `inf:browser:return`), and both name the browser the view shows by its `session` and `generation`, so a stale view never takes or returns a newer one.

`TaskBrowsers.takeControl` marks the browser `taking` at once, so every crewmate command that starts from then on refuses, including one already queued behind the command running.
The running command finishes, or fails within its 30-second bound, and its answer goes to the crewmate as usual; then the browser is `captain`.
While it is `taking` the view's row reads `finishing the crewmate's current action…`.

While the captain holds it:

- the crewmate's commands refuse in words, its stop too, saying the captain will hand it back and wake it once;
- the captain's pointer, wheel and keys on the view's picture go to the page through `inf:browser:input`, a core request every view may ask, which the core answers only for the captain's own browser (`TaskBrowsers.captainInput`), as the browser protocol's own input at the page's own pixels; the editing keys of the window's own system (⌘ on a Mac, Ctrl on Linux, where Ctrl+Y redoes too) go as the page's editing commands whatever system the page runs on, paste with the words on the captain's own clipboard ("Paste" below), and Back, Forward and Reload move the captain's page;
- nothing records any of it: no timeline line, no fact, no notice, no event, and nothing the IPC layer keeps;
- what the page says - refused requests, errors, dialogs, popups and its moves - is kept for nobody, so the crewmate never hears of the captain's time;
- the browser never stops for being unused, and its fact carries `control: "captain"`, which the record's Browser line reads as `you have control` and the view's row as `you have control · the crewmate cannot see this page`, tinted violet.

### Paste

The paste key on the view, ⌘V on a Mac and Ctrl+V on Linux, carries the words on the clipboard of the computer whose window the captain pressed it in, which need not be the computer the page runs on ("On another computer").
The view lets the paste key go on to the window's own paste and reads the words from that paste alone (`clipboard` on the key input), since the app's window may not read the clipboard on its own (`src/main/security/permissions.ts`).
The page's computer types those words into the page when its own clipboard holds other words, and otherwise runs the page's own paste, which keeps a picture or formatting only it can read.
A paste with no words, or past `TASK_BROWSER_PASTE_MAX`, is the page's own paste, and so is a paste key that brings no paste before it is let go.

Return control hands the browser back with one press.
While the captain has control, the view shows `Returning control lets the crewmate read and use this browser, including signed-in pages.` before that press.
Command search's `Take or return browser control` runs the same control on the shown browser.
A browser in the kept profile asks the site's rule for later tasks beside it, and a listed site adds Manage, which opens Signed-in sites in Settings → Secrets or Website sign-ins in Settings → General where the Secrets tab is not offered (`openSavedSignIns`, `src/renderer/src/app/shellCommands.ts`; "Signed-in sites").
`TaskBrowsers.returnControl` waits, at most ten seconds, for a load the captain started to finish, so a return during a reload hands back the loaded page; then every page starts a new book, so every older ref is refused, nothing from the captain's time is kept, the crewmate's next answer leads with a line saying control came back, followed by why when the page rests on a refused address ("A page on a refused address"), and its fact carries `returned`, which the view's caption reads as `temporary · keeps what you signed in to until it stops`, or, in the kept profile, `what you signed in to here stays on this computer` until a listed site names it (`signInCaption`).
While the captain holds a browser in the kept profile, the caption reads `what you sign in to here stays on this computer`.
The crewmate is woken once through its task's durable lane: `CardActions.browserReturned` steers the typed `browser-returned` wake (`docs/inbox.md`), named by the run, the browser and its count of returns, so the inbox queues each return once.
The wake names the site, says the old refs are gone and to take a fresh look with `infinitary-browser-axi`, the command's home view, repeats what the crewmate said it would do next, says returning gives the task the signed-in site, never permission to buy, pay or submit anything that matters, and says a browser outside the kept profile keeps nothing past its stop, so the crewmate tells the captain a sign-in stays only when its browser said it opened the site in the kept profile.
It carries none of the page itself, so nothing the captain signed in to is written to the inbox or the timeline; the crewmate reads the page in its own turn.
Until its first command after the return, and through its first read, the view's row reads `fresh look at the page`.

A browser in the captain's hands - paused for the captain's help, being taken, or the captain's - is the captain's turn: the idle ladder reads it as a witness (`browserWithCaptain`, `docs/report-sort.md`), so the crewmate is never nudged while the captain signs in, and its work posture reads as waiting for the captain.

A page that crashes while the captain holds it stops as any crashed page does (`its page stopped working`), and its crewmate hears it on its next command; nothing is returned and nobody is woken.
When the app quits or crashes while the captain holds it, the browser is not kept: the next run has no browser, and a request card's strip says its browser stopped when Infinitary quit.
What the captain signed in to in the kept profile stays there, listed or not, until Remove all; nothing else is kept, and the stopped view and the strip say so.
Open again starts a fresh browser that is the crewmate's.

## Asking for help

A crewmate that needs a person on the page - a sign-in, a verification code, a payment - asks on an ordinary decision card.
It declares the request with `emit_card`'s `browser_handoff`: the site its browser is on, why it needs the captain, and what it will do once control comes back, each in its own words; the host reads none of them and never infers a request from the page.
The card names the site and why in its body, and carries exactly one action whose effect is `{ kind: "open", target: "browser" }`, labeled as the captain's step (`Open browser and sign in`), beside one such as `Leave waiting`.
The supervisor refuses in words a request whose site is not the one its browser shows, one with no open browser, one while the captain already holds it, one on a merge card, and an open-browser action with no request; the first mate's card lint refuses that action outright.

Before the card goes up, `TaskBrowsers.requestHelp` marks the browser `waiting`, so the crewmate's next commands refuse, lets the running one finish, and writes one timeline line, `asked you to take over its browser at <site>`.
The card's live attachment carries `handoff`, and its strip is drawn as attention, `<site> · paused for your help`, while the request stands (the design skill's ResponseCard); a request card always has its strip, with no button.
Its open-browser action is the card's one way into the browser, since a door beside it would show the page without answering the card.
The record's Browser line reads `paused for your help`, and the view's row tints ember with the crewmate's reason and Take control.
Waiting on the captain, the browser never stops for being unused.
The crewmate may take its request back with `infinitary-browser-axi withdraw`, which keeps the browser, its pages, history and sign-ins as they were, writes one timeline line, `withdrew its request for you to take over its browser at <site>`, and tells the crewmate to close its request card; `infinitary-browser-axi stop` takes it back and stops the browser.
Once the captain has taken control, both are refused like every other command.

The open-browser action is the captain's own click on the card's chrome: `CardActions.act` refuses it from a body's frame, takes control of the browser the card's attachment names - a newer or older one is never taken - and hands the shell an effect that opens the view, where the row reads `finishing the crewmate's current action…` and then the captain's control.
Once that page is the captain's and the view has come forward, the page takes the window's focus, so the captain's first keys reach the field the page itself focused, such as a sign-in's first box, with no click first (`browserPageFocus`, read by `useHandedOverFocus` in `TaskBrowserView.tsx`).
A press begun since the click keeps focus where it put it, and every other way into the view, such as the record's Open, a card's door or Take control, leaves focus where it is.
It is the one action that does not answer its card: the request stays with the page (`CardBrowserClicks.openBrowserBesideCard`), and its crewmate is told nothing until the captain returns control.
An app controlling this Mac from another never sends that click: the card stays on both Macs and says to do it on this Mac (`docs/view.md`, "A task's browser on a view").
When the browser the card names is gone - it stopped, a newer one followed it, or it ended when the app quit - the click answers the card and opens the view, whose line says so over whatever the task's browser is now ("From a card").
`CrewSupervisor` reads that off the task's browser fact (`attachmentStanding`) at the click, and again once the take or the signed-in site's grant is refused, never off the refusal's words; a request the click left up leaves then.
Its crewmate is then steered at once through its task's durable lane with the captain's choice and that its browser was gone (`card-choice` with `browserGone`, `docs/inbox.md`), so it can open the site again and ask anew on a new card, and the feed says so.
The steer never names the action, so a signed-in site the host offered stays unnamed.
Leave waiting is an ordinary reply to the crewmate; it, a close and Hide leave the browser paused.

### The request beside the page

While the request is up and the captain holds its browser, the view docks the card as a column beside the page, the thread column's own width, 40% of the stage between 288 and 360 pixels (`BrowserRequestColumn`, `dockedRequestOf` in `src/renderer/src/cards/browserRequest.ts`): the crewmate's own card on top, with its steps and any values to copy and no "You asked" line, the thread's head with its Collapse thread, its thread under it once anyone has written there, and the card's one field at its foot.
The column is added beside the page, never taken from it: the page keeps the width the view would have alone, up to 1,040 pixels, and the stage places the pair on the thread's ladder, folding the docks before it narrows the page (`requestPlacement` in `src/renderer/src/cards/cardGeometry.ts`, read by `entryView`).
Where the page would keep under 720 pixels beside it, as on the narrowest window, the column folds to its latest line under the page, a collapsed thread's latest line or the request's title, with no field (`BrowserRequestLine`), so the page keeps its height. ⌘\ (`cards.thread`) opens or folds it, as it does a card's thread, and so do the line and Collapse thread; ⇧⌘L opens a folded column on its way to the field.
The captain's choice holds over the window's width while the request is up (`requestColumns` in the shell); focus goes to what undoes the move unless the page holds the keyboard, which keeps it.
A view opened another way, such as from the record's Browser line, docks the task's open request the same way.
The card's choices, its door and its size and leave buttons stay off the column: the page beside it is the door, and Return control is its closing choice.
The click that opened the page answers nothing, so the shell keeps the card in its list (`src/renderer/src/app/cardActions.ts`), and after Hide the stack shows the request again, its line saying the page is the captain's.
A reply from that field rides the card's thread lane as any reply does, and its steer tells the crewmate the captain holds its browser and wrote from beside the page (`browserHeld` on `thread-reply`), so it answers from what it knows and revises the card if its steps should change.
The crewmate may revise the request under the same id while the captain holds the browser (`CardBrowserActions.holdsRequest`); the revision redraws in the column and pauses nothing again, and a new request stays refused. ⇧⌘L (`focus.card-reply`) goes from the page to the column's field, and Go to the browser page (`browser.page`) goes back.
Return control carries the words still in the field (`words` on `inf:browser:return`): the core keeps them for the return's one wake (`CardActions.holdReturnWords`), which may arrive from another computer after the press answers, and the wake carries them verbatim after its own words (`words` on `browser-returned`); the field empties once the return is accepted.
A return carries words alone, so pictures, files or notes in the field go first as an ordinary reply, words and all, and a reply refused or still preparing keeps the field and the browser (`returnWordsOf` in `src/renderer/src/cards/returnWords.ts`); words past a reply's limit hold the return with a plain line.
While a reply in the column waits on its crewmate, its waiting line is a card thread's, and putting the view aside (Hide or the minus) puts the request aside with it (`closeRecord` in `src/renderer/src/app/stackActions.ts`), so the card comes back when the answer lands, as any replied-under card does (`docs/card-threads.md`, "The waiting line"); its open-browser action opens the page again, still the captain's.
Go to the browser page refuses with its own line while no page of the captain's is shown.

The captain may take the browser from the record's Browser line instead, with Take control in the view, while the request card is still up.
Either way, the captain's Return control takes that card down (`CardActions.browserReturned`), so the captain comes back to no card: it asked for what the captain has done.
Only a request card naming the browser the captain returned goes, read off the task's browser fact (`attachmentStanding`); one naming an older browser stays, since its click tells its crewmate that browser is gone.
Its crewmate hears only the return's one wake, never a choice the captain did not make.

## Signed-in sites

Each computer keeps the captain's website sign-ins in one browser profile of its own, the kept profile, and a task's browser uses a site there only when the captain allows it, on that task's request card or by the site's rule (INF-4585).
A task's browser otherwise opens in an empty context of its own, signed out of everything, whatever the kept profile holds.
The sign-in stays where the browser engine put it; nothing copies it to a file, to another browser or to another computer.

**The kept profile.**
The built-in engine's kept profile is one partition on disk, `persist:task-browser-kept` (`KEPT_PARTITION`, `src/shared/taskBrowser.ts`), with Electron's cookie encryption fuse on in every packaged build, so its cookies on disk are encrypted with a key the system keeps for the app (`enableCookieEncryption`, `electron-builder.yml`; the fuse is one way, and `tests/release-contract.test.ts` holds it).
Each installed engine keeps its profile under the app’s data, `task-browser-chrome-kept` or `task-browser-edge-kept`, opened in its own default context ("Installed browser engines").
Every browser opened in the kept profile shares it, and one kept connection guard serves it, so a page there may go only where some browser in it may go ("Where a page may go").

**Signing in.**
A crewmate that asks the captain to sign in, or to create an account, marks its request with `emit_card`'s top-level `browser_sign_in` true, beside `browser_handoff` ("Asking for help").
The captain's click takes the browser and reopens its page at the same address in the kept profile (`TaskBrowsers.takeControl`, `SavedSignInGrants.openForSignIn`), so what the captain signs in to stays.
A request without it, such as a payment review, leaves the page where it is, and the captain's sign-in there goes with the browser.
While the captain signs in, each site the page passes through, such as a separate sign-in service, is noted on the browser (`passed`).

**The rule.**
Returning control from the kept profile asks one question above the page, `Your <site> sign-in stays on <computer>. Later tasks:`, naming the site the entry will be kept under, with two choices: `Use it without asking`, which leads and is picked for a site not yet listed, as the captain chose, and `Ask me each time` (`signInRuleLegend`, `ASK_EACH_TIME_LABEL`, `USE_WITHOUT_ASKING_LABEL`).
A site the computer the browser runs on already lists starts at its rule there, which the browser's fact carries (`rule`), with Manage beside it.
While the captain holds the browser, each page the captain opens reads its cookies again, and when they cover a name above the page's, the fact carries that wider site (`keepAs`, `SavedSignInGrants.readKeepAs`) and the question names it.
Return control sends the displayed site and the rule (`inf:browser:return` with `site` and `automatic`); the core checks the site again, and when the site's cookies and its own origins' page storage hold something, it lists the sign-in with that rule and the pages passed through, and the browser may use it from then on (`SavedSignInGrants.keep`).
The entry is the whole site the sign-in's cookies cover: the widest name among the cookies the page's parent shares with every name under it, such as `apple.com` for a sign-in made at `idmsa.apple.com`, otherwise the page's own host and port (`signedInSiteOf`).
The engine never accepts a cookie on a public suffix, so this stops at the registrable domain, as a browser groups one site; the page signed in at stays among the pages passed through.
The entry is never wider than the site the question named: a session cookie that arrived after the question last read the cookies, with no page opened since, keeps the page's own name, as the captain agreed to.
Return control keeps nothing when the page no longer lies at or under the named site, and a named site other than the page's own covers it only when the page's host lies strictly under it and the name carries no port (`namesPage`), so another port of the same host is never kept under the rule chosen for the first.
An entry for a name under the new one, kept before by a page's exact name, folds into it with its id and pages, so a task allowed it keeps its allowance.
A site that holds nothing is not listed, and the answer says so.

**Where the list lives.**
`WebSignIns` (`src/core/browser/webSignIns.ts`) is the one writer over `userData/web-sign-ins/`: a 0700 folder with one 0600 file per site, named by a digest of the site, holding the site, when the captain signed in there, which entry it is (`id`), its optional `automatic` rule, the sign-in pages passed through (`via`), the other names under its site that task browsers opened with it (`opened`) and its optional `failedAt`.
It holds no cookie and no page storage.
A file from before, a copy of a site's cookies and page storage (version 1), retires: the list deletes it unread the first time it meets it, and Settings never shows it.
`TaskBrowsers` is its only caller, and each computer keeps its own.
One lookup finds the entry for a page (`WebSignIns.find`): one whose site is the page's or a name above it, or whose pages passed through hold the page's site, the one also covering the browser's first address first, then one the page lies under, then the newest.
The offer, the grant, the Return control rule and a use by the rule all read it, so a later task stopped on a sign-in page or a sibling page of a kept site finds it.

**What a task may open there.**
A browser in the kept profile may open only the sites it was allowed and the sign-in pages passed through on the way to them (`SavedSignInGrants.allows`); a site is one with a name under it or above it, whatever the port.
The crewmate's own open of any other site, a link, a redirect or a second page that leaves for one, reopens in an empty context of its own, signed out, and the crewmate's next answer says so (`keptMayOpen`, `openIn`).
A browser that was allowed nothing never opens the kept profile.

**What a task keeps.**
What a task was allowed - by a grant, by a use under the rule, or by the captain's own sign-in on its browser - belongs to the task, not to one browser.
Its browser's stop by the crewmate, the stop after half an hour unused, a page that stopped working and the app's quit keep it, in memory and in the task's owner-only `browser.json` beside its kept page (`KeptPages`, `saved`: site to entry id), and the task's next browser starts with it (`TaskBrowsers.allowanceOf`).
Each entry must still be on the list by its id when that browser starts, so Remove or Remove all ends it.
The captain's Stop browser and the task's close drop it.
A browser the captain's own click on a page from the project started is the captain's and starts with none of it, so closing that page, Return control included, leaves the task's as it was.
A task holds at most `SAVED_SIGN_INS_PER_TASK` sites.
A task's own empty context still ends at every stop, since the engine keeps it only in memory.

**A later task.**
When a crewmate asks for help on a site the computer lists and its browser may not use it yet, its fact carries the offer (`offer`), and the host adds `Use my <site> sign-in` to the request card as its default, last in the row, and relabels the crewmate's open-browser action `Sign in myself` (`CardBrowserActions.withSavedSignIn`, `offeredSignIn`).
The offer reads the entry `WebSignIns.find` names, so a page on a sign-in page or a sibling of a kept site is offered it too.
The crewmate never learns which sites are listed, and only the host adds that action: its effect is `{ kind: "open", target: "browser", savedSignIn: true }`, which the crewmate's tool cannot declare and the supervisor refuses from any other author.
The host adds it after the card lint, so the 2 or 3 actions a decision gives are counted over the crewmate's own (`docs/card-authoring.md`, "The shape lint").
The captain's click is the grant: `SavedSignInGrants.grant` lets the browser the card names use that one site, reopens its page at its address in the kept profile, signed in, hands the browser back to its crewmate - refusing every older ref, as a return does - and writes one line on the task's timeline, `you let it use your sign-in at <site>`.
The crewmate is woken once on its durable lane, the `browser-returned` wake with `saved`, named by the run, the browser and the site, so one browser is granted a site once.
The shell opens the view, where the foot line reads `signed in on <site> · kept on this computer`; the captain never takes control and types nothing.
A grant that cannot be made - the browser no longer waits, the site is no longer listed, or the kept profile could not open - leaves it paused for the captain, and the feed says why.
A grant whose browser is gone tells its crewmate as the open-browser action's click does ("Asking for help").
A browser using a signed-in site keeps what "A signed-in page" keeps: a picture needs the crewmate's reason.

**Use it without asking.**
A site whose rule is `Use it without asking` needs no card: the crewmate's own open of that site reopens its browser in the kept profile, signed in, its next answer says the captain's rule allowed it, and the task's timeline gets `used your sign-in at <site>, as your rule for it allows`.
It never stands in for a help or payment review card.
The rule lasts across restarts and applies to tasks across every project on that computer.
Changing it to `Ask me each time` stops later uses and leaves a browser already using the site signed in; Remove signs it out.

**Settings.**
Settings → Secrets lists them last on the main page, under Signed-in sites, in every storage state, and says they stay in each computer's own browser profile, not in protected storage; where this window offers no Secrets tab - a build without protected storage, or a computer that controls another - Settings → General lists them instead, after Sharing (`signInsInSecrets`).
In Secrets, each row shows the site’s current rule and opens to the rule control and Remove.
The list is per computer: this computer's first, under its name once other computers are listed, then each computer that runs work, with its own sites, or a line saying it could not be asked (`WebsiteSignInsSection`, `src/renderer/src/settings/`, read with `inf:browser:sign-ins`, which answers `available: false` where this build keeps no task browsers).
Each row shows the site with when the captain signed in there, its rule as a `Later tasks` choice and Remove.
Remove (`inf:browser:sign-ins:remove`, `SavedSignInGrants.remove`) takes the site off that computer's list and clears it in that computer's kept profile - its cookies, its own origins' page storage, and those of the sign-in pages it passed through and the other names under its site task browsers opened with it, where no other entry names them - so every browser using it is signed out at once, a line goes on each such task's timeline, and each crewmate is told on its next command.
Under each computer's list, Remove all (`inf:browser:sign-ins:remove-all`, `SavedSignInGrants.removeAll`) signs that computer out of every site, including sign-ins in the kept profile that never reached the list, such as a site whose sign-in the captain abandoned or one passed through on the way: it empties the list and takes every browser's allowances at once, before anything waits, so no open finds its way back in, reopens every browser in the kept profile in an empty context of its own, signed out, then empties the kept profile - the built-in engine's partition of every cookie and every origin's site data, and Chrome's by stopping its kept Chrome and deleting its profile folder, by its path when Chrome is not switched on - and each crewmate whose browser could use a sign-in is told on its next command.
The list, the rule (`inf:browser:sign-ins:automatic`), Remove and Remove all are core requests the captain asks from any window that controls the first mate; the first mate never changes a rule or removes a site.

**What it cannot promise.**
Sites end sessions on their own schedule.
Then the page asks for a sign-in again; the crewmate's wake tells it to ask the captain again on a card with `browser_handoff` carrying `saved_failed` true, and since its browser already uses the site the card offers only `Sign in myself`.
A use by the rule tells it the same.

**A sign-in that did not work.**
Only the crewmate decides that a signed-in site failed: a second request card on the same site may be a payment review, so the host never infers it.
Its `saved_failed` marks the exact entry its browser was given, by its `id`, with when (`WebSignIns.markFailed`, `SavedSignInGrants.markFailed`), and writes one line on the task's timeline, `said your sign-in at <site> did not sign its page in`.
A browser that uses no entry for the site marks nothing, and its crewmate's tool answer says so; a removed or replaced entry is never marked.
The rule rides the grant's notice, not the card tool's own words, so it costs the fixed context nothing.
The next request card on that site that offers it leads with `Sign in myself` as its default and keeps `Use my sign-in (did not work last time)` as a second choice, without the site, which the card names.
The captain's next sign-in on the site clears the mark; a rule change keeps it.

A signed-in site is as safe as that computer's own login and its disk: in the built-in engine's kept profile, also the key its system keeps for the app; in Chrome's, only Chrome's own fixed stand-in key, which never reaches the system's keychain ("Installed browser engines").

## A final submission

A purchase, a booking or any other submission that commits the captain is the captain's to make, on the site's own page, under the captain's control (the answer `submission: captain` on the FI3-835 design).
A crewmate prepares it up to its last step and stops there; it never presses that step itself.

**The review.**
It asks on an ordinary decision card with `browser_handoff`, which is the review: the card names what the captain commits to, read from the page as it is now - for a trip the route, dates and times with their time zones, passengers, seller, total and currency, baggage and fare rules - with anything still uncertain, and marks what changed since the captain last chose.
Its open-browser action is labeled as the step, such as `Open browser and pay`, beside one such as `Stop here`.
If the price or terms change after a review, the crewmate stops and asks again on a new one: an earlier choice does not cover them.
What a review names, and when one is needed, is the crewmate's knowledge, carried in `browser_handoff`'s description, its prompt line and the help of the commands that press; the host reads none of it, and there is no booking runner and no card kind for it.
The host handles the review card as any request ("Asking for help"): the browser pauses before it goes up, and the action's click hands the captain the page.

**The captain's step.**
The captain pays on the page with control, a bank's check opening as a second page where the site opens one; nothing the captain types is kept ("Taking control").
The captain's Return control wakes the crewmate once, and the wake (`browser-returned`) tells it to read what the page says happened and keep only the result, such as a reference.
Whether the captain paid or not, the card details the captain typed stay the captain's: a payment page handed back reads its card fields as filled, with their values hidden, and is not photographed ("A signed-in page").
If the page does not confirm it - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown: the crewmate never submits, reloads or resends it, checks where the site lists it, such as its bookings, and asks the captain on a card to check in the browser.
Until the seller or its payment service shows what happened, the crewmate says plainly that it does not know whether it went through: a missing booking or charge proves nothing, so it never guesses either way and never suggests trying again.
The handoff's description and both browser wakes that meet an unknown outcome carry these words from one constant, `UNKNOWN_OUTCOME_WORDS` (`src/shared/taskBrowser.ts`).

**Never sent twice.**
The browser never sends a form twice.
The host page knows whether its document is the answer to a form that was sent - the browser's own request for it was a `POST`, read when it commits (`src/main/host/taskBrowser.ts`) - and refuses to reload it (`FORM_RESEND`, `src/core/host.ts`), whoever asks.
Tracking starts in the session's first document-request callback, before the request continues: a second page without an opener can commit its document before its window reaches `drivePage`.
The same refusal reaches every caller:

- the crewmate's `infinitary-browser-axi reload` answers in words that it did not reload, and its line in the view reads `did not resend a form`;
- the captain's Reload says why in one line under the view's foot line;
- a signed-in site's grant on a page already in the kept profile leaves a form's answer as it is, and the crewmate's next answer says so.

Going back or forward to a form's answer the browser did not keep shows nothing rather than sending it again (`ERR_CACHE_MISS`), and the crewmate's answer says that too.
A redirect after the form that changes its request to `GET`, the way most sites answer one, is an ordinary page and reloads as one.
A redirect that keeps `POST` stays guarded, as does a move within the same document; navigating to a new `GET` document clears the guard.

**Retries.**
No retry of the app's replays a browser commitment.
A wake or steer the inbox delivers again - after a provider failure or a restart (`docs/inbox.md`) - is words alone: the host keeps no browser command to replay, and a restart keeps no browser, page or form, since every browser closes when the app quits.
A crewmate whose redelivered wake finds its browser gone reads the outcome as unknown, as the wake says, and asks.
A request card from before a quit still stands; the captain's click on it tells its crewmate that its browser was gone, and the steer says an unknown outcome still is unknown, so the crewmate checks again on a fresh browser and asks anew.
Open again, after a stop within one run, starts a fresh browser, signed in only where the task may still use a kept sign-in, at a plain visit to the last address, never sending what the page last sent.

## On another computer

A task that runs on a computer that runs work (`docs/helper.md`) has its browser there, beside its crewmate's shell.
That computer keeps task browsers when it has a browser engine and a command process, as the work mode always does, and its roster says so (`browsers`, from contract 4.1, `TASK_BROWSERS_THERE_SINCE`); one that keeps none, or speaks an older contract, gives its tasks no browser, and their crewmates are not told of one.
The home names the browser in the crewmate's instructions and tells that computer the task has one (`PlacedSpec.browser`); that computer grants the command to the crewmate's shell when it opens the conversation, and the browser goes when the conversation there closes for good.

Its pages are that computer's.
A page a project serves on that computer's own loopback is the one the crewmate opens, its connection guard resolves and checks every address from there, so a name that leads to that computer or its private network is refused at the connection unless the captain listed it, and its pictures land in the task's evidence folder there, where the crewmate reads them.
That computer's own `TaskBrowsers` owns it, with every rule on this page and the home's private sites list, and its crewmate reaches it through that computer's own task channel (`ComputerBrowsers`, `src/core/helper/browsers.ts`; `docs/axi-commands.md`).

The captain reads and drives it from the home as the captain does one here (`PlacedBrowsers` and `HomeBrowsers`, `src/core/placed/placedBrowsers.ts`):

- Its fact is the one that computer last said (`inf:work:browser`), sent once each time it changes and asked for whole each time that computer comes back into reach (`inf:task-browser:facts`).
  The record's Browser line, a card's door, the view and the idle ladder read it as they read a fact here.
- While a view watches, that computer sends the page's pictures (`inf:work:browser-frame`), the newest one at a time, and the room a maximized view gives the page goes there.
- Take control, the captain's input, Return control, Stop browser, Open again, a request card's pause and the task's close are orders to that computer (`browserOrders`, `src/shared/workBrowsers.ts`), answered there by the same rules.
  Out of reach, each is refused in words and nothing is done.
- What that computer has the home do once - a line on the task's timeline, the crewmate's wake on a return - arrives as a work request that the conversation's ledger answers once (`inf:work:browser-event`, `docs/helper.md` "Holding a conversation").
  Its stopped pages are kept in each task's folder there, and a page nothing answers at is checked there; the crewmate's wake for it arrives as the `unanswered` event, which that computer sends only to a home that lists the `page-unanswered` change, so an older home wakes nobody.
- That computer keeps its own signed-in sites, in its own kept profile and its own `WebSignIns`, and nothing of a sign-in crosses between computers (`kept-sign-ins`, `src/shared/contract-changes/`).
  A crewmate's sign-in request there reaches the home on its card with its mark (`signIn` on `browserHandoff`, `browser-sign-in-mark`), and the home's request card pause sends it back, so the captain's take opens that computer's kept profile; a home without the change drops the mark, and that sign-in ends with the browser.
  The home adds that computer's name to an open browser's fact (`computer`), so the view's kept-profile words - the captions and the return question - name the computer the sign-in stays on (`signInPlace`).
  The captain signs in to its page through the view, its Return control carries the rule (`rule` on `inf:task-browser:return`), and a request card's offer is read off its fact.
  The click on that offer, the crewmate's mark that it failed, the Settings list, the rule, Remove and Remove all are orders to that computer (`inf:task-browser:use-sign-in`, `inf:task-browser:sign-in-failed`, `inf:task-browser:sign-ins`, `inf:task-browser:sign-in-rule`, `inf:task-browser:sign-in-remove`, `inf:task-browser:sign-in-remove-all`), answered there by the same rules.
  A computer without the change keeps no sign-in for later tasks, and its browsers start signed out; one with it refuses the retired copy orders in words.
- Point at's outline read is an order to that computer (`inf:task-browser:places`), asked only of one that lists the `card-note-places` change; without it the home answers that the outline could not be read, and a mark still carries its place and its picture with no name under it and no stepping by keys.
  Only the read gives the page's address and title as the crewmate's own reads do, so a note made without it names the page's site alone.
- The home's quit leaves a browser there running with its crewmate's turn; that computer's quit or restart ends it, and the home reads that it has none once that computer is back.

## The page itself

The host makes each page (`src/main/host/taskBrowser.ts`, behind `HostTaskBrowser` in `src/core/host.ts`): effects only, while the core keeps every decision.

- It is a hidden window of its own at 1280 by 800, or the room the captain's maximized view gives it ("The view"), never a view in the app's window: only a window's own page paints and takes input while nobody can see it.
  The core alone resizes it (`HostBrowserPage.resize`), and a second page opens at its opener's size.
  The view the captain watches draws pictures of it (above), so the page stays hidden while it is watched.
- Its site data lives in a partition unique to that open, in memory only, cleared when it closes, its sign-ins with it, unless the task may use a signed-in site, when its pages open in the kept profile ("Signed-in sites"); its cookies are read and removed for the core alone (`HostBrowserCookies`), and so is its page's own storage (`HostPageStorage`).
- It is sandboxed with context isolation and web security on, has no preload and so no app bridge, and refuses every permission and device permission but what the captain allowed once ("A site's asks"), and every new window but a second page the core lets in ("A second page"); a download goes only where the core says ("A download").
- Navigation, redirects and frame navigation are checked against the same policy as requests; loopback is reached directly, and everything else through the browser's connection guard, its session's one proxy ("Where a page may go").
  A web address the policy refuses is refused by its request, so the page shows the browser's own refusal at that address, as Google Chrome's does, rather than staying put as if nothing was asked ("A page on a refused address"); a navigation to any other scheme never reaches the network and is refused before it starts.
- It never reloads a page that answers a form that was sent ("A final submission").
- It draws every dropdown's list in the page, as Chromium's in-page list (`appearance: base-select`): a Mac's own list is a native menu, a window of its own, which closes at once beside a hidden page and is never in the page's pictures.
  The rule is added to each new document in a layer and marked important, so a site's own styles do not win it back, and a dropdown can look different from the same site in another browser.
- A certificate error, a site's sign-in box and a request for a client certificate are refused and told to the core (`HostBrowserRefusal`); a passkey request is a site's ask ("A site's asks").
- Every page and frame believes it is in front (`Emulation.setFocusEmulationEnabled`), since its hidden window never is: a site that waits until it is looked at, or reads the clipboard only in front, works as it does in a person's browser.
- Every page uses an ordinary Chrome user agent, without Infinitary's name and version or Electron's token; reloading and navigating keep it.
  The host sets it on each page through Electron, and makes it Electron's fallback (`app.userAgentFallback`) when the task browser is made, before any page opens.
  A page a website opens loads its first document with the identity its renderer and session start from, since native popup navigation ignores Electron's per-page override (`electron/electron#45897`), so the fallback is what that page shows.
  The page's protocol does not carry the identity: a command to a page opened without an opener reaches its renderer only after the first document commits, when its first script may already have run.
  Holding that document until the command answers stalls the page whenever another protocol client, such as Playwright in the journeys, attached to it first.
  The app's own windows show only its own files, so the fallback changes nothing a person sees there.
  A website-opened second page keeps its native navigation, opener and form body, with the ordinary identity in its first request, its first script's `navigator.userAgent` and its first fetch.
  The host never reloads such a page to change its identity, since that could repeat a form submission.
  `tests/e2e/task-browser-user-agent.spec.ts` checks real request headers, document scripts and fetches for opening, reloading, navigation, links, scripted popups, a blank popup followed by navigation, redirects and a form sent once, with the app's main process held still as each document commits, the way a busy computer holds it.
- The host drives it over the browser's own protocol, attached to that one page and its frames from other sites and nothing else ("Frames"): the accessibility tree, an element's box, mouse and keyboard input at a point, typed text, a list's option, and the picture, at one pixel per point.
  It also reads a time element's `datetime` and a title tooltip off the page, and the core names them on the outline line, and where each element sits, so the core knows which lines the window shows.
  A whole-page picture is at least as wide as the window, so the scrollbar is not left out of its width.
  A watched page asks for its picture stream again once each new document is in, since a stream asked for while one commits may go with the old one.
  A same-document move is told to the core, the same as a new document, so a ref from before it is refused.
  The crewmate never sends a protocol command or runs script of its own in the page.

These windows are not the app's.
`appWindows()` (`src/main/windows.ts`) leaves them out of every app push, reload, focus, notification click and dock activation, and a development run that `pnpm dev`'s starter did not start still quits when its last own window closes.

## Installed browser engines

When a task opens a browser, the computer running the task tries its own Google Chrome first, then Microsoft Edge, then the built-in engine.
Neither browser is downloaded by Infinitary, and no app setting chooses one.
An installed browser is skipped if it is missing, too old to draw the in-page dropdown, or cannot start or answer, including when a company policy prevents it.
The app logs each refusal and the built-in page records the last reason as a typed fact (`HostBrowserEngine`, `src/core/host.ts`).
`findInstalledBrowser` checks the browsers’ standard stable installation paths on macOS, Windows and Linux.
Automated journeys explicitly pin the built-in engine unless an internal trial requests Chrome, which does not try Edge.

Edge uses the same guarded host as Chrome, with its own empty and kept profile directories.
It uses its installed browser identity and does not suppress its automation indicator.

- Each installed engine starts on demand through `hostEnv()` with a profile folder under the app's data, no first window and the protocol on a private pipe, so no port is open to any other program (`src/main/host/chrome/cdpPipe.ts`).
  It neither installs nor wakes Google's updater (`--disable-updater-scheduler`), which would outlive the app, and it starts in its own app folder, so nothing it starts holds a folder of the app's; the updater the person's own Chrome set up still keeps Chrome current.
  It stops once no browser is open, an open that failed included, and when the app quits; the quit waits until Chrome has exited, so nothing writes in the app's data after it.
  The kept profile's Chrome is the exception: once a browser opened in it, it runs until the app quits or Remove all, as the built-in engine's kept partition does, so a sign-in a site keeps only in a cookie for the browser's session lasts for a later task allowed it.
- Each browser outside the kept profile is a separate empty context of its engine, in memory only, whose one proxy is the browser's connection guard, loopback included (`<-loopback>`), and whose first page is a minimized window of its own (`src/main/host/chrome/chromeEngine.ts`).
  Closing the browser ends the context and everything it held.
  The kept profile runs in a separate process whose default context keeps its sign-ins on disk ("Signed-in sites").
  Remove clears a site's page storage there through a page's session, an open page's or a blank one held at its start for it, since Chrome answers the browser's own session with an internal error.
  Chrome encrypts them there with its own fixed stand-in key (`--use-mock-keychain` on a Mac, `--password-store=basic` on Linux), never one the system keeps, so they are as safe as the computer's login and its disk; Remove all deletes both installed browsers’ kept profiles.
  Chrome binds no site's sign-in to a key in the computer's keychain (device-bound sessions, which Google's sign-in starts, are off), so a sign-in leaves nothing there and never raises the keychain's own dialog.
- Chrome adds no automation sign of its own to the page (`--disable-blink-features=AutomationControlled`), and the host sets no user agent: sites see the Chrome that is installed.
  On a Mac it uses a stand-in keychain (`--use-mock-keychain`), so Chrome's own stored passwords and keys never reach the person's keychain; the system's passkeys are still offered, as "A passkey request" says.
- The page is sized, never the installed browser's window, whose own bars take room of their own.
  On Linux a screenshot briefly restores a minimized window without requesting focus, then minimizes it again.
  A screenshot that the browser does not answer fails within a bound instead of holding the command queue.
  When an installed browser stops, its temporary download folder goes too.
- What the built-in engine does through Electron, the host does over Chrome's protocol (`src/main/host/chrome/chromePage.ts`): every request and navigation is paused and asked of the core, a frame's inside a frame from another site and every worker's included, and a frame or worker whose requests could not be heard stays held; a websocket, which Chrome's pausing never sees, is judged by the guard, the guard's sign-in is answered and a site's sign-in box refused, a certificate that does not verify ends its request with its `ERR_CERT_` code, every permission is refused but what the captain allowed once, set on the browser's context and reset to denied when control returns, a download is saved where the core says, and a dialog or a request for a file goes to the core.
- A page another page opened shares its opener's context, so the opener's sign-ins reach it.
  Chrome holds it at its start until the core lets it in; a page the core refuses runs with every request it makes held, and closes.
  Chrome opens such a page as a tab in its opener's window, which it shows while it opens; the host minimizes the window again.
  The host sends every command that prepares a page without waiting for its answer, then lets the page run: Chrome answers some only once the page runs, as for a page a form opens with its answer.
- The page commands both engines share - the outline, input at a point, a list's option, the pictures and the picture stream, the in-page dropdown rule and the protocol messages the core hears - live in one module (`src/main/host/pageProtocol.ts`).
- Chrome's protocol has no way to pick a client certificate, so Chrome asks in its own window, where nobody answers.

## The record and the evidence

The task's timeline gets one line when its browser opens, with the origin, and one when it stops on its own (half an hour unused, or the page stopped working).
A picture goes to the task's evidence folder under the name the crewmate gave it, or the first free `page-N.png`, and a card may show it by that path (`docs/card-authoring.md`).
A download goes to its `downloads/` folder and adds one line to the timeline ("A download").

## Tests

`destinations.test.ts`, `outline.test.ts` and `taskBrowsers.reading.test.ts` beside the modules hold the policy, the outline and the browsers' lifecycle against a stand-in page (`tests/helpers/taskBrowserStandIn.ts`), which every `taskBrowsers.*.test.ts` file shares.
`outline.test.ts` also holds a ref's book in every ref, kept across reads and numbered on its first, a bare control number naming nothing, and the words that refuse a ref by where it came from.
It also holds that, once the captain has held the page, typed text reads hidden - in typed fields, a list that completes as one types and an editable part of the page - unless it is just what the crewmate typed, while a chosen option still reads, that the hidden fields are all named, and that a search never reads what is hidden.
It also holds every line of a long page with its words and whether the window shows it, a line the host could not place read as where its parent is.
`changes.test.ts` holds unchanged outlines, additions and removals with old and current numbers, repeated lines, and bounded work and output for a wholesale replacement.
`taskBrowsers.actions.test.ts` holds hover, drag, multi-field fill without submitting, edge scrolls, a stale destination or later field refusing before input, stopping a fill on a page move, element captures and whole-page privacy and captain-control guards.
`outline.test.ts` also holds a frame's document read under its site's line with refs to its controls, a frame it could not read, a human check's frame named with its controls' refs carrying its site, and a value the captain typed inside a frame hidden.
`taskBrowsers.actions.test.ts` also holds every action on a human check's control refused before anything reaches the page, while the rest of the page stays the crewmate's.
`taskBrowsers.handoff.test.ts` holds `withdraw` keeping the browser and its pages and handing the commands back, refused with nothing waiting and once the captain holds the browser.
`taskBrowsers.reading.test.ts` also holds the background notice that the page itself loaded, the no-route notice and lead, and the passkey notice.
`taskBrowsers.asks.test.ts` holds a site's asks: every ask no while the crewmate drives, a permission waiting for Allow once or Not now one at a time, going when its call ends and taken back at Return control, and a passkey told no on the built-in engine, told no in Chrome away from its computer or once the captain moves away, and run behind Show Chrome window at it.
`tests/e2e/task-browser-asks.spec.ts` drives the real guard and Electron host while the captain holds the page: Allow once lets its notifications through, Not now ends its clipboard read as not allowed, its passkey request ends at once with the row saying why, and Return control takes the permission back.
`tests/e2e/task-browser-frames.spec.ts` drives the real core and Electron host on a page whose form sits in a frame from another site: the frame reads under its site's line, the crewmate types into its field and sends it with Enter, the page believes it is in front, and a passkey request in the frame ends as not allowed before a second passes on the frame's own clock, with its notice.
`wheelScroll.test.ts` holds that a wheel does not return until that scroller's scroll has ended, and that a page already at that edge does not wait.
`tests/e2e/task-browser-actions.spec.ts` exercises the real core delegate and Electron host in the hermetic launcher: hover reveals a menu, two fields hold their values, real pointer input drops an item, edge scrolls reach their content, and a crop photographs one element.
`tests/e2e/task-browser-file-request.spec.ts` does the same for a page that asks for a file: the crewmate's press on a site's own file button opens no picker and leaves every page window hidden, `upload` refuses a file outside the working copy or through a link out of it and attaches one inside it, printing answers without opening anything, and while the captain holds the page their press on the same button takes the app's picker's file and their press on a color field opens no picker.
`taskBrowsers.reading.test.ts` also holds a same-page action answering only changed lines, a no-change action, and a fresh inspection recovering the full window.
`window.test.ts` holds the windows: a page that fits whole with no map, a repeated passage folded at its depth, a cut within its bound with its map and next lines, reading on from a line and past the end, a search past the cut within the smaller bound and stepping to the next match, a search reading a whole cut passage, the lines on screen with the skipped lines named, the top when nothing could be placed, the part around a passage, and a small page shown whole around its words.
It also holds a cut passage naming a ref, a wait reading past that cut, a time element's `datetime` and a title tooltip, and a full read that still hides what the captain typed.
`reading.test.ts` holds the snapshot's marks, which elements the window shows, the whole-page picture's width and the navigation-payload error left out of an answer.
`taskBrowsers.reading.test.ts` holds a click on a link, and a button click, whose address changes after the click, answering with the new page, a full read of a cut line, a long page read from its top, from a line, around words and on screen after a scroll, and a wait answered with the part that holds its words.
It also holds a ref from before a move refused for every action and a full read, with nothing sent to the page, while the element that took its place keeps its own ref, and a ref from a browser the task had before refused.
`chromeEngine.integration.test.ts` (`src/main/host/chrome/`, a probe that skips where Chrome is not installed or a Linux computer has no display) starts the installed Chrome against a local site and the real connection guard: a page sites see as Chrome and not automation, sized as asked, real typing and clicks, a refused request, a public name reached only through the guard, a certificate that does not verify, a site's sign-in box, a dialog, a request for a file, a second page let in and one refused, a second page that closes itself told as closed, a download, a form never reloaded, a form whose answer opens in a second page sent once and never again on its reload, each browser's own empty site data, and a site's notifications ask granted in Chrome on a yes and asked again once taken back.
It also holds the requests of a frame inside a frame from another site, and of its worker, refused by the core, and websockets reaching only the port on this computer the browser opened, from a page there and from one off it.
It also holds the three reasons the built-in engine opens instead, with stand-ins for a Chrome too old and one that does not start, and Chrome stopped after an open that failed.
`findChrome.test.ts`, `cdpPipe.test.ts` and `engineChoice.test.ts` hold where Chrome is looked for, the pipe putting each message back whole however it is read, and the switch with each fallback's reason.
The task browser journeys run on either engine, chosen by `journeys.yml`'s `browser_engine` input: they read a task's page through `tests/e2e/taskBrowser.ts`, which asks Electron for a built-in page and, for a Chrome one, the Chrome engine's own list of its pages (`ChromeEngine.pages`), which a source build keeps on `globalThis` under `infinitary.taskBrowser.chromeEngines` and a packaged app never publishes.
`addresses.test.ts` holds which addresses are public, however they are written, and each address's kind, and `connectionGuard.test.ts` the guard against a stand-in site on loopback: only its own browser's sign-in is answered, a public name tunnels to the one address it checked and is resolved once, a name that leads only to this Mac or a private network is refused before any connection with each answer's kind, a name with public and private answers tunnels to its public one alone, and one whose public answer does not respond reports what it skipped, a private address written out is refused unresolved, this Mac's loopback is carried, unresolved, only to a host and port its browser registered, and a request to a registered port with nothing listening dropped, a server that drops the connection dropping the browser's request too, a name not found and a server that does not answer are told apart, and closing ends its tunnels.
It also holds a name whose every address the network has no route to told apart from one whose server refused.
It also holds a listed name and a name under a listed suffix tunnelling to their private answers while the suffix's bare name is refused, a listed name whose answers no task browser reaches refused, a plain http request for a listed name forwarded to its checked address without the guard's sign-in, a plain request without the sign-in refused before any lookup, a listed name's open tunnel ended once the name is removed while a public one stays, and a Remove that lands mid-dial refused.
`privateSites.test.ts` holds the list's file, what an entry may be and each change being heard, `destinations.test.ts` a listed site opening over http and https from any page and never by its address, and `taskBrowsers.reading.test.ts` a crewmate opening a listed site, its pages reaching it, an unreadable list keeping the last read, and a Remove refusing its pages at once and asking the guard to end its connections; `placedCallbacks.test.ts` holds the home's answer to a computer that runs work, `placedBrowsers.test.ts` the home sending each change to a computer with an open browser, and again when one is back in reach, and only logging an older one's refusal, and whether the captain's window is on that computer with each take and input, and an ask's answer refused for an older one, `actions.test.ts` the Allow card, and `cardActions.test.ts` its click landing on Integrations.
`tests/e2e/private-sites.spec.ts` has the first mate offer the Allow card, the captain's key on Allow add the site and land on Integrations with the box in focus, and the captain open the field with + Site, add a suffix with Enter, be refused an address with its reason, close the field with Escape, and remove the first site by key, each change saved.
`taskBrowsers.reading.test.ts` also holds public websites through the guard and its refusals' words, each kind of answer's lead among them, and the certificate, sign-in box and client certificate refusals.
`taskBrowsers.view.test.ts` holds a second page opening, taking the crewmate's commands, each page's refs refused on the other, switching back and closing itself, the two-page cap and a refused popup, the captain's pick of a page and the view following the current page.
`taskBrowsers.signIns.test.ts` holds a browser handed back keeping only what the task needs: no query, no error words, no typed text the crewmate did not type and no picture of it, while what the crewmate types itself reads back until the captain holds the page again.
`taskBrowsers.keys.test.ts` holds a key the page shows after a handback reading as `[key hidden]` in a text line, a control's name and description, a full passage, the title and address, the pages list, a dialog, a refused choice's options, a link's address and the network list, never found by a search or a wait, refusing every picture, a link whose host looks like a key still read without its query, and a browser never handed back reading it as it is.
`docs/axi-commands.md` ("Tests") holds the command, its channel and its process; `crewmateTaskTools.test.ts` that no crewmate is served a browser tool, and `cardActions.browser.test.ts` that a task on this Mac gets its own browser's command and prompt line and an app without one gives none.
`taskBrowsers.view.test.ts` also holds the captain's side: the fact and its action line, pictures to a watcher, the idle stop held while watched, Stop browser and Open again.
It also holds a page kept with its task: a page open at the quit read as stopped by it after the restart and opened again there, a stopped page's reason kept and forgotten at the task's close; and a page nothing answers at: one wake name for each outage, ended once the address answers, and only an address the crewmate opened on this computer checked.
`taskBrowsers.starts.test.ts` holds a page's saved start against a stand-in: the open with `--start` keeping it and running it when nothing answers, only keeping it when something does, its wait for the build outside the task's queue so the captain's press answers meanwhile, its failure's words, its refusal off this computer; the captain's press running it instead of waking the crewmate and loading the page once it answers, once and only while the page is still on that address, a failure waking the crewmate once with how it failed, and the build stopped with the browser, forgotten at the close and stopped at the quit; each turn's begin and end told to the start owner with whether the browser is open again; and `emit_card`'s line said for a page this computer serves until a start is saved for it, and never for another site or on a computer that keeps no starts.
`cardActions.browser.test.ts` holds that the crew's turn owner tells the task's browsers when a turn begins and ends, and that `emit_card` puts the card up with that one line.
`pageStarts.integration.test.ts` runs a start through a real shell: the owner-only kept file read again by a new run, a loopback server in the saved folder answering and stopped on request, a start that exits first with its code, and a wait that runs out stopping its group, and a start whose folder is gone failing at once with the reason in its log, the corrected start then running; a build left alone when its browser stops during a turn, kept when the browser opened again by the turn's end and stopped at the end of a turn it is still stopped at, and one stopped at once with no turn running or at a close mid-turn.
`browsers.starts.integration.test.ts` runs a start on a computer that runs work, heard at the home: the crewmate's open running it there, the captain's Stop browser stopping it, Try it starting it again with the home's view reading it as starting, a stop during the crewmate's turn at the home leaving the build until that turn ends, a turn's end reaching that computer after the home forgot the turn and when it comes back in reach, the home reading that a page served there has no saved start, and a start that fails reaching the crewmate's wake at the home with its exit code.
`tests/e2e/task-browser-start.spec.ts` has a crewmate open its build's page with `--start` while nothing answers, the captain's Stop browser stop the build, and the captain's Try it start it again by keys, the view saying Infinitary is starting it until the page loads, with no wake reaching the crewmate.
`cardActions.browser.test.ts` holds the `page-unanswered` wake, once for an outage and queued while a turn runs, `wakes.words.crewmate.test.ts` its words, and `CardAttachment.test.tsx` that the press opens a stopped browser again only while it may be opened again, and a quit's line on the strip.
It also holds the maximized view's room: the page, its pictures and its photographs at the room and back at 1280 by 800 on restore or when that view stops watching, no size from a view that does not watch, the newest room laid out at once while a command loads, never between a click finding its control and pressing it, and a browser, a second page and Open again opening at the room.
`taskFacts.test.ts`, `TaskFacts.test.tsx` and `stackActions.test.ts` hold who is driving, the record's Browser line and the view's place on the stack.
`tests/e2e/task-browser.spec.ts` drives a real task page through the hermetic app: a crewmate types and clicks by refs on a local sign-up page that counts only a real click, the page keeps its own site data across a reload, cannot reach the app, and is refused a picture from a public name that leads to this Mac - at the connection, by its guard - one over plain http and data from another server, the picture lands in the evidence folder at 1280 by 800, closing leaves no page behind, and the next task's browser starts empty.
Its reading journey has a crewmate click a release that opens without a full load, its old ref refused rather than used on the link that took its place, then read the long passage, the exact time and a plain-text feed.
Its long-page journey has a crewmate open a changelog too long for one answer, read its map and folded repeats, find words in its last section, read on from the line the first answer's next lines name, and scroll to see the lines on screen rather than the top again.
`tests/e2e/task-browser-view.spec.ts` has the captain open a crewmate's browser from the record and watch the page's own pixels while the crewmate drives, maximize the view and find the page laid out at the view's room and following the window's size, restore it to 1280 by 800, carry the task on the first mate input, see nobody driving once the turn ends, stop the browser from More, open it again fresh, and hide the view with the browser still running.
`places.test.ts` holds what Point at reads of a page's outline: each named thing once with its box in whole pixels, nothing typed, only what the window shows, a hidden key and the most one read carries.
`taskBrowsers.places.test.ts` holds the read against the stand-in page: the names with the page's address and title, nothing recorded, the bare address and hidden key while the captain holds the browser and once it is handed back, and the answer for a page that cannot be read; `reading.test.ts` holds each shown element's box, `placedBrowsers.test.ts` the same order to a computer that runs work and none to one without the change, and `crewSteer.captainInput.test.ts` the notes and their pictures leaving on the Crewmate tab's line.
A journey in `tests/e2e/task-browser-view.spec.ts` has the captain point at a running page by keys and by pointer: the held picture stays still and the live pictures resume, the press never reaches the page, the crewmate reads each place with what it is on and gets each held picture, and a note made while the captain holds the browser says its picture shows the page to the crewmate.
Its second journey has a crewmate emit a decision whose door reads `Try it`: the card names the task's browser, the click shows the page with the card unanswered behind it (the same offer, no thread line, the task as it was) and its checklist docked beside the page with no choices, Back to the card shows the card with its buttons, a reply from the column's field (reached with ⇧⌘L) is answered in the card's thread, the card the crewmate then puts up arrives in the column while the view stays, Back to the card from command search shows it with its choices, and once the browser is stopped and opened again both the card and the view it opens say the card's browser has stopped; once that browser is stopped and its build stops too, Try it pressed by keys opens the page again, the view says nothing answers there, and the crewmate is asked once.
Its restart journey has a crewmate leave its task's browser open at a local page, the app quit and start again on the same data, the browser read stopped at that page because of the quit with the card's browser line still naming it, and Try it pressed by keys open that page again.
`cardTool.test.ts` holds that only a crewmate with a browser is offered `browser_button`, `cardActions.browser.test.ts` the attachment it writes and its refusals, `cardStore.test.ts` and `cardColumnMigrations.test.ts` the column, and `CardAttachment.test.tsx` and `stackActions.test.ts` the door's line and the view's return to its card; `browserRequest.test.ts` holds which card docks beside the page, and `stackActions.test.ts` a card arriving in the column and none while a request stands.
`taskBrowsers.handoff.test.ts` holds taking and returning control against the stand-in page: a take while a command runs lets it finish and refuses the one queued behind it, the captain's input reaches the page and nothing records it, what the page said in the captain's time never reaches the crewmate, a return during a reload waits for it and refuses every older ref, each return is one named wake, a stale handle is refused, a crash or a quit in the captain's hands wakes nobody, and a request pauses the browser only on the site it names.
`cardActions.browser.test.ts` holds that a request card pauses the browser before it goes up, that the captain's click takes the card's own browser and tells the crewmate nothing, that a click or a signed-in site's grant whose browser ended with a quit, or stopped and was replaced, steers the crewmate once with that fact and the feed line and never names the signed-in site, that a browser in the captain's hands is never nudged, the request's refusals, and the one wake on return; `wakes.test.ts` its words, `reportSort.test.ts` the witness, `cardTool.test.ts` the parameter and the first mate's refusal, and `taskFacts.test.ts`, `CardAttachment.test.tsx`, `cardActions.test.ts` and `stackActions.test.ts` the record's words, the strip's tint and its missing button, and the view the action opens.
`cardActions.browser.test.ts` also holds that a return takes down the request card naming that browser, leaves a card that asked nothing and one naming an older browser, and wakes the crewmate only once.
The first journey in `tests/e2e/task-browser-handoff.spec.ts` has a crewmate ask the captain to sign in on a local account page: its card's strip reads paused for your help with no button beside the card's action and its browser refuses the crewmate, the card's key opens the record, whose Open shows the paused page and says so, Open browser and sign in hands the captain the page with no word to the crewmate and puts the window's focus on it, the captain types into the page's focused Email field with no click first and signs in with real clicks and typing on the view's picture while no file under the app's data and no model call holds the captain's password, Hide resumes nothing and the sharing notice stays visible before handback, and Return control wakes the crewmate once - its old ref refused, its fresh look leading with the return, the page signed in, and nothing the page logged or asked for in the captain's time reaching it - and its picture of the signed-in page is refused without a reason and taken with one, which its record names.
`webSignIns.test.ts` holds the list - its folder's and files' modes, one entry per site with no cookie or page storage in it, the rule bound to the entry Settings showed, a mark only on the entry it was given, a copy from before deleted unread, a broken file read as nothing - and which cookies make up a site's sign-in.
`taskBrowsers.signIns.test.ts` holds signed-in sites against the stand-in page: a sign-in request opens the kept profile and one without it does not, a site holding nothing is not listed, a second task granted the site is signed in with nothing copied while a third is signed out, a kept browser opens only its allowed sites and the pages passed through, its own navigation and second pages elsewhere leave for an empty context, the rule opens the site without a card, a request is offered the site only while its browser may not use it, a grant is refused to a browser not waiting or stale or with nothing listed, a site that turned it away is marked, and Remove clears its cookies and page storage in the kept profile, keeping a sign-in page another entry still names; `placedBrowsers.test.ts` holds the same orders to a computer that runs work.
`taskBrowsers.signIns.test.ts` also holds a sign-in request from a computer that runs work, crossing the home as a card and back as an order, kept in the kept profile past its browser's stop.
`taskBrowsers.signInSites.test.ts` holds a sign-in made on a separate sign-in page under a company's name: the question names the whole site, the entry is kept under it (or under the page's name when the question named only that), later tasks stopped on the sign-in page or a sibling page find it, Remove clears a sibling page's storage, and a task keeps what it may use across its crewmate's stop, the idle stop, a restart and the captain's page from the project, until Stop browser, Remove or its close.
`cardActions.browser.test.ts` holds the request card's added default and relabeled action, a card left as declared with nothing listed, a crewmate's declared signed-in site never carried, the sign-in mark carried to the request, the click's grant and its feed line when refused, and the saved wake; `wakes.test.ts` its words, `taskBrowser.test.ts` the foot line, `WebsiteSignInsSection.test.tsx` the Settings rows per computer with the rule, and `core.boot.test.ts` the gate.
The first journey in `tests/e2e/task-browser-saved-sign-ins.spec.ts` has a crewmate's sign-in request open a club page whose server keeps its sign-in in a cookie in the kept profile, the captain sign in, keep `Ask me each time` while returning control, and find the site in Settings with its rule while the list holds no cookie and no file the password; a second task's own browser then reads the page signed out, its request offers `Use my <site> sign-in` as its default beside `Sign in myself`, and that one click signs the page in with nothing copied and wakes the crewmate, which reads it signed in while no model call holds the password; Remove in Settings then signs that browser out.
A journey beside it has a club page that keeps its sign-in in local storage kept under `Use it without asking`, so a second task's own open is signed in with no card, and Remove clears that storage; a third has the crewmate mark a sign-in the club turned away, so the next request leads with `Sign in myself`.
`tests/e2e/task-browser-sign-ins.spec.ts` has the rule changed in Settings → Secrets by keys outlive a restart, sign a later task's own open in, change back to `Ask me each time` from the view's Manage without signing out the open browser, and Remove sign it out.
The third journey in `tests/e2e/task-browser-view.spec.ts` has a crewmate meet a site whose certificate no one trusts and read the refusal, then click Pay on a local shop whose bank's check opens as the browser's second page: the view names each page Browser and its title on the card's tabs, which watching cannot use, and draws the check's own pixels; once approved the check closes itself, the crewmate is back on the shop, which says it was paid, the second page's tab goes, and Stop browser closes it all.
The second journey in `tests/e2e/task-browser-handoff.spec.ts` has the captain take a browser from the view while its crewmate's wait on the page runs: that wait answers in full and the crewmate's next command refuses, the captain maximizes the view and signs in on the page at its new size with an invented account that no file and no model call holds, Hide resumes nothing, and Return control wakes the crewmate once.
The third journey in `tests/e2e/task-browser-handoff.spec.ts` has the captain sign in on a page whose sign-in returns to a program on the same computer the crewmate never opened: the program is reached once, with the code, and loads its own part, the sign-in page's hidden request to it never arrives, nothing is marked blocked, and Return control's first look reads the signed-in program.
`destinations.test.ts` holds the rule: a top-level move to a server on this Mac goes through and names its origin, that page's own requests to the origin go through, and any other page's request to it, or the page's to another server, is refused.
`taskBrowsers.handoff.test.ts` holds the same against the stand-in page, and that a page resting on a refused address is marked blocked while the captain holds it, its title reads as the host and port to the captain and as its shown address to the crewmate, the first look after the return names the refusal and the remedy, and the mark is gone once the page leaves that address.
A journey in `tests/e2e/task-browser.spec.ts` has one task's browser keep its own visits on a page this Mac serves, while a second task's page is refused that server's data and picture, its request to take over that server's site is refused with nothing paused, its own redirects to a public name that leads to this Mac and to a private address are refused, and its own open of the first task's page starts with none of that task's site data.
`taskBrowsers.handoff.test.ts` holds that a form's answer is never reloaded - for the crewmate, the captain and a signed-in site's grant, which opens the page at its address in the kept profile instead - and that going back to one the browser did not keep is named; `wakes.test.ts` the return wake's words for an unconfirmed submission, and `cardTool.test.ts` the review knowledge in `browser_handoff`'s description.
`task-browser-form-reload.spec.ts` sends real loopback forms through the native browser, including popups with and without an opener, and checks the host's refusal, both callers' answers and the server's single submission.
It keeps the refusal across fragment moves and redirects retaining `POST`, and verifies reload after redirects to `GET` and navigation away from the response.
`tests/e2e/task-browser-booking.spec.ts` runs a final submission on an invented airline (`tests/e2e/fakeAirline.ts`) on a Pi crewmate and a Claude crewmate, each crewmate's calls checked to have come through its own runtime, and a Claude crewmate's local check too.
Its booking journey compares fares on a decision whose door reads View search; asks for a sign-in on a card the captain closes, after which the request is still reachable from the record and the captain takes control from the view; fills in the passenger once woken; stops on a review card naming the trip, the passenger, the seller, the total and currency, the baggage, the fare rules and what is uncertain, marking a total that rose since the search, with nothing paid; and once the captain pays on the page and returns control, leaves a note with the reference, the airline paid once and nothing the captain typed in a file or a model call.
Its unpaid journey has the captain type invented card details on the review's payment page and hand it back without paying: the crewmate reads each card field as filled with its value hidden, its picture of the page is refused, no model call holds the card number, expiry or code and no file under the app's data the card number or expiry, while the page still holds them and the airline is paid nothing.
Its lost-answer journey has the captain pay on a page whose confirmation never comes, and the captain's Reload say why it sends nothing; the crewmate's own reload is refused and it watches My bookings; the app quits while that turn runs, and the next run delivers the wake again, which finds the browser gone, checks My bookings afresh and asks the captain to check in the browser on a decision that says the outcome is unknown; the app quits once more before the captain answers, and the captain's `Open browser and check` on that card tells the crewmate its browser is gone, so it opens My bookings again and asks anew on a card that names its fresh browser, where the captain then checks - the airline paid once throughout.
