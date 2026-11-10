# The task browser

Each task may have a browser of its own, on the computer the task runs on, which its crewmate drives: it opens a public website or a page a project serves on that computer, reads it, uses it with real input, photographs it into its evidence folder, and closes it.
The captain watches it drive in the task's browser view on the stage, takes control of it when the page needs a person, and makes every final submission on it personally.
The design is the captain's (rev-10 in `docs/architecture.md` §14, the isolated page in §4; the view's look is the design skill's `components/cards/TaskBrowser`).
This page says how the browser works now, for a task on this Mac; "On another computer" says what changes for a task that runs on a computer that runs work.

## Who has it

Every build has the task browser, stable, alpha and development alike.
The core keeps task browsers wherever its host has a browser engine; on a host with none, `CoreServices.browsers` is absent, so no crewmate is handed one or its command, and the view's commands and saved sign-ins answer that this Mac keeps no task browsers.
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
Whatever stopped it is told to the crewmate once, and the next open is a fresh browser with nothing signed in.
At most four task browsers run on this Mac at once; the next one is refused in words, and none is stopped to make room.
One command runs at a time per task, in the order they came, and each answers within 30 seconds, in words when the page did not finish.

`TaskBrowsers` (`src/core/browser/taskBrowsers.ts`) is the one owner of every task browser and every word a crewmate reads from one.
It composes its parts over one typed core (`BrowsersCore`, `browserRecord.ts`, with each browser's record): the crewmate's commands (`crewmateCommands.ts`), the input actions (`pageActions.ts`), saved sign-ins (`savedSignInGrants.ts`), each browser's notices (`pageNotices.ts`) and the files it writes to the evidence folder (`evidenceFiles.ts`).
Callers drive every browser through `TaskBrowsers`, and import the shapes and words they share from the part that owns them.

## Where a page may go

A crewmate opens a public website over https, or an http or https address on this Mac's loopback: `localhost`, a name ending in `.localhost`, `127.0.0.0/8` or `[::1]`.
It also opens a private site the captain allowed ("Private sites" below), by its name, over https or http.
Which websites a task needs is the crewmate's judgment, from its instructions; the host checks only the typed rules below, never what a site is for.
Opening a loopback address registers its origin (host and port, with a live-reload socket on the same port counted as the same origin) for that task alone.
The host registers one more the same way: the address it serves a project folder at for a page from the project ("A page from the project" below).
A website over plain http that is not on the list, and an address written out that is on a private network or kept for special use, is refused before anything opens, in words that say what to open instead.

Every request a page makes asks `decideRequest` (`src/core/browser/destinations.ts`) before it leaves, top level or not: a redirect, a frame, a picture, a script, a worker, a websocket, a popup.
Content the page makes itself (`data:`, `blob:`, `about:`) and the origins the crewmate opened go through, and so does a public website over https or wss, and a listed private site over any web scheme, from any page.
Everything else is refused: another server on this Mac, an address on a private network, a website over plain http or ws that is not listed, a file, an app scheme.

An address is only what it names, and a public name can resolve to a private address, or change to one between a check and a connection.
So every connection off this Mac's loopback goes through the browser's own connection guard (`startConnectionGuard`, `src/core/browser/connectionGuard.ts`), its session's one proxy.
The guard resolves the name itself, reads each answer's kind (`addressKind`, `src/core/browser/addresses.ts`): public, this computer, a private network such as an office or VPN network, or reserved.
It dials only the answers it checked, in the order the name server gave them, and never resolves the name again: a public answer, or for a listed name a private one too.
A name that is not listed with public and private answers connects through its public ones alone; its private answers are skipped and never dialed.
A name with no answer it may dial is refused at the connection, before anything reaches it, and named in the next answer.
The guard carries `CONNECT` tunnels, and the page's own TLS runs end to end through them; it neither reads nor ends it.
It also forwards a plain http request for a listed name, its own sign-in and hop headers taken off, to the address it checked; any other plain request is refused.
Loopback never goes through the guard: the browser resolves those names to this Mac itself, never through a name server, and the policy above has already checked their origins.
WebRTC reaches its peers only through the guard (`disable_non_proxied_udp`), so it never goes around it.

The guard listens on loopback alone, starts when its browser opens and stops when it does, and answers only its own browser: the session signs in with a secret made for that guard, and any other caller is refused before anything is resolved.
The browser never answers a sign-in challenge for a page's cross-origin picture, so the host signs the session in once before the page loads, by asking the guard for `GUARD_SIGN_IN_HOST`, which it answers at once and never resolves; every connection after carries the sign-in.
An unpackaged run may stand in its own resolver with `INFINITARY_TASK_BROWSER_HOSTS`, a JSON map of names to addresses (`hostsLookup`); the guard still checks every answer, so the map can only narrow what a page reaches, and the end-to-end launcher gives every run an empty one, so no page reaches a real network.

The next answer names what was refused, by host and by why: a private network, plain http, another server on this Mac (open it with `infinitary-browser-axi open` to let the page reach it), or not a web address.
A name the guard could not find, or whose server did not answer, is named too.
A load of the crewmate's own that the guard refused says why in its lead (`guardRefusalLead`, `src/core/browser/pageNotices.ts`): the name was not found, did not answer, or leads to the addresses it names, each with its kind.
A private network's answer says the captain can allow the site for task browsers, and tells the crewmate to ask the first mate in its report (`needs_firstmate`), naming the site; a listed name that leads only to an address no task browser reaches says so; this computer's says to open the page by localhost; a reserved one says a proxy app or DNS filter usually gives it.
A mixed name whose public answers did not respond names them, and the private answers it skipped.

The browser also refuses, and tells the crewmate once:

- a certificate that does not verify: nothing from that site loads, and the browser never goes past it;
- a site's own sign-in box (HTTP authentication), which it never answers, so the crewmate asks the captain on a card;
- a request for a client certificate, which it never offers.

Nothing a page asks for ever opens in the person's own browser or another app: an app scheme is refused like any other, and every permission, the one that opens an outside app among them, is refused.
A page that takes the crewmate to a sign-in it did not expect, or on another site, is not signed in to by the crewmate: the help of the answer that opened it tells it to ask the captain with `browser_handoff` ("Asking for help").

## Private sites

A site on an office, home or VPN network has a private address, so a task browser reaches it only once the captain lists it.
Settings › General › Private sites holds the list (`PrivateSitesSection`): one row per entry with Remove, and a field that adds one with Enter or Add.
An entry is a name (`wiki.corp.example`) or a suffix of two or more parts (`.corp.example.com`, typed with or without `*`) that covers every name under it but not its own bare name (`normalizePrivateSite`, `listsPrivateSite`, `src/shared/privateSites.ts`).
An entry is never an address, `localhost` or a top-level domain alone, and a pasted address adds its host.
The first mate never adds one: when a crewmate's report names a private site the task needs, it puts up the app's own Allow card (`private-site-allow` in `src/shared/actions.ts`), and only the captain's click on Allow adds the site, landing on Settings › General with it listed.

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
A label read just before its control folds into the control's line, a field's value is shown, and a password field's value never is; once the captain has handed the page back, neither is text the crewmate did not type ("A signed-in page").
A line shows up to 2,000 characters.
A longer passage is marked cut short and names a ref, and `infinitary-browser-axi snapshot` with that ref reads it in full, up to 80,000 characters, still hiding a password and, once the captain has held the page, text the crewmate did not type.
A wait for words, and a search, read the whole passage, not only the cut line.
A `time` or `relative-time` element shows its machine-readable `datetime`, and a title tooltip is named on its line.

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
Once the browser has been returned or uses a saved sign-in, the console retains and answers only counts by level, never message text.
Taking or returning control clears both lists, and no diagnostics are collected while the captain holds the browser or control is changing.
A late response to a request from the captain's time cannot recreate that request in the list.

The network list contains only method, address, resource type and pending, response status or failed outcome.
Every network address omits credentials, query and fragment, even before a handback; non-web addresses are not quoted.
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
All photograph guards apply to the whole page even for a crop: a reason is needed after a handback, and hidden typed text anywhere on the page refuses the picture.
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

Once the captain has handed a browser back it may hold the captain's sign-in, so until it stops it keeps only what the task needs (`TaskBrowsers.signedIn`).
The host reads that from the typed fact that the captain returned control, never from the page.

- Text typed into the page is read out only while it is just what the crewmate itself typed there since the captain last handed the page back (`OutlineOptions.typedOnly`, `RefBook.noteTyped`).
  Any other - a typed field's value, the text of an editable part of the page - may be what the captain typed, such as a card number or a code, whether or not the captain sent it: the outline says the field holds something, `(value hidden)`, and never what, and a wait for words never finds it.
  A typed field is a text box, a search box, a number field, or anything the browser marks editable, read from the accessibility tree's own facts, never from the field's label; an option chosen from the site's own list reads as before.
- A picture is taken only for a reason the crewmate gives: `infinitary-browser-axi screenshot` without `--reason` is refused in words, and with one the task's timeline gets one line naming the site and the reason.
  A page that holds hidden typed text is not photographed at all, since the picture would show it: the refusal names each such field, and the crewmate reads the page instead.
- What the page logged is counted, never quoted.
- Every address the crewmate reads - the page's, where it moved, a link's, a refused popup's - is read without its query and fragment, where sites keep tokens and codes, and Open again starts from that bare address.
- Every answer's help from such a browser says to keep only the results the task needs, such as a booking reference, a status or a total, and never passwords, codes, card numbers or whole account pages, in a card, a report or a picture.

No raw trace of the page is ever recorded, signed in or not, and the view's pictures go to the watching window alone and are never kept.
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
Every command, page move and stop emits a `task_browser` event, which re-reads that task's detail; nothing about it is stored, so a restart forgets a stopped browser.

Who is driving is read off the task's work posture, the same typed fact as the record's pill (`browserDriverOf`): the crewmate drives while its turn runs, and once the turn ends nobody does and the page stays as it was left.
Back, Forward and Reload are shown and marked off while the captain watches, since navigation belongs to whoever has control and watching is not control ("Taking control" below): each stays a Tab stop whose label says who drives (`docs/keyboard.md`, "Facts shown on rest").

The page reaches the view as pictures, never as itself.
While a view watches (`inf:browser:watch`, a shell channel), the host streams the hidden page's own pictures over the browser's protocol - one when watching starts and one each time the page changes - and sends each to that window alone on `inf:browser:frame`; the view draws the newest on a canvas, fitted to its width or at the page's own size.
The page never enters the app's window, so the app's own menus, More's included, draw over it, and nothing the captain does in the view reaches the page.
A window that unwatches, loads another document or goes stops its pictures.
An app controlling this Mac from another shows no page: its view says the task's browser shows only on this Mac (`docs/view.md`, "A task's browser on a view").

The page lays out at 1280 by 800 (`TASK_BROWSER_PAGE`) unless the captain maximizes the view (the design skill's ResponseCard, "Maximize").
Maximized, the view gives the page its room: the place under its row and the browser's lines, above its foot line, which it asks for on `inf:browser:size`, a shell channel, and asks again when the window's size settles.
The sharing notice and a refusal line take room from the page, which fits under them.
The core lays every page of the task's browser out at that size (`TaskBrowsers.sizeView`): its window, its viewport, its pictures and every point the captain presses, and a browser, a second page or Open again that opens while the view stays maximized opens at it.
A resize waits only for a click the crewmate's command is making, and a click waits for a resize, so the page never moves between a command finding a control and pressing it; a read, a wait or a load goes on at the new size.
Restore, Hide or a window that stops watching gives the page back its own size.
Only a window that watches the task may ask, and a size is between 320 by 240 and 3840 by 2400 (`TASK_BROWSER_PAGE_MIN`, `TASK_BROWSER_PAGE_MAX`).
While any view watches a task's browser it does not stop for being unused; its half hour starts again when the last view goes.

Each page the browser holds is a Browser tab on the card's strip, reading Browser and the page's title (`browserTabLabel`), the current one selected; the site stays in the view's row.
Picking a page's tab is navigation, so it is the captain's only while the captain holds the browser (`{ kind: "page" }` on `inf:browser:input`); while the captain watches, the other pages' tabs are disabled.

More holds Fit or Actual size, Stop browser, Copy page address, and Report a problem, which starts the first mate input with "This task's browser has a problem: " for the captain to finish.
Stop browser (`inf:browser:stop`) stops it at once, as the crewmate's own close would.
Open again (`inf:browser:reopen`) starts a fresh browser, with nothing signed in, at the page the stopped one was on, refused in words past the cap of four or once the task has closed; the crewmate's next answer says the captain opened it again.
Both are core channels this Mac's window alone may ask.

## From a card

A crewmate's card may carry one door to its task's browser: the crewmate names the label (`Try it`, `View search`, `View booking`) with `browser_button`, and the host names the browser.
At emit the card's browser door (`CardBrowserActions.browserAttachment`) reads the task's browser fact and writes the card's live attachment (`LiveAttachment` in `src/shared/cards.ts`, `cards.attachment_json`): the label, the task, this run's `session` and the browser's `generation`.
`TaskBrowsers` mints a new `session` each time the app starts and counts each task's browsers in that run, so the two name one browser: Open again or the crewmate's next open after a stop is a newer generation, and a card from before a restart names a session no browser has.
A label that is empty or longer than 32 characters is refused in words, and so is a button on a task with no browser, or whose browser stopped when the task closed, unless it names a page from the project (below); a stopped browser Open again can still start is a door too.
A revision without `browser_button` takes the door away, and the attachment is part of the card's offer and its fingerprint (`docs/card-evidence.md`).

The card's chrome draws the door between the body and the buttons (`CardAttachment`, `src/renderer/src/cards/`; the design skill's ResponseCard, "A live attachment"): the micro label, the site and who is driving or what stopped it, read off the task's detail as the record's Browser line reads them, and the label as a button.
On a request card ("Asking for help") it draws no button.
The click opens the task's browser view at the front of the stack and asks the core nothing, so it never answers the card, runs no effect and leaves its merge where it was; the body's frame never sees it, and Hide returns to the card.
The view compares the door's browser with the task's (`attachmentStanding`): the same one, open or stopped, opens as the record's Open would; one that stopped and was followed by a newer one (`replaced`), or ended by the app's quit (`restarted`), opens with a line under the row saying so, above whatever the task's browser is now.
The card's line says `this card's browser has stopped` in both cases.

## A page from the project

A browser button may open a page from the task's project instead of the browser as it is: a crewmate gives `browser_page`, an HTML file's path relative to its working copy, which is its path in the project folder too, such as `index.html` for a finished game's `Play`.
The card's live attachment is then kind `page` (`LiveAttachment` in `src/shared/cards.ts`): the label, the task and the path, with no browser named, because none need be open.
At emit the card's browser door (`CardBrowserActions.pageAttachment`) refuses `browser_page` without a label, beside `browser_handoff`, and on a path that is not an `.html` or `.htm` file relative to the folder with no empty, `.`, `..` or `.git` part (`projectPagePathRefusal`, `src/shared/projectPage.ts`).
It refuses a task with no project, one that runs on another computer, and a file it finds neither in the task's working copy nor in the project folder.
Finding is `projectFile` (`src/core/workspace/projectPage.ts`): the folder is resolved once, then every part of the path is read without following it, so a link anywhere on the way is refused, and the end must be a regular file.

The card's chrome draws the door as the browser's other door is drawn (`CardAttachment`, `src/renderer/src/cards/`): the micro label, the path and `opens in this task's browser`, and the label as a button.
Its click asks `inf:cards:open-page` with the card's id alone, a core channel this Mac's window alone may ask, since the project folder is this Mac's.
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
Both are core channels this Mac's window alone may ask (`inf:browser:take`, `inf:browser:return`), and both name the browser the view shows by its `session` and `generation`, so a stale view never takes or returns a newer one.

`TaskBrowsers.takeControl` marks the browser `taking` at once, so every crewmate command that starts from then on refuses, including one already queued behind the command running.
The running command finishes, or fails within its 30-second bound, and its answer goes to the crewmate as usual; then the browser is `captain`.
While it is `taking` the view's row reads `finishing the crewmate's current action…`.

While the captain holds it:

- the crewmate's commands refuse in words, its stop too, saying the captain will hand it back and wake it once;
- the captain's pointer, wheel and keys on the view's picture go to the page through `inf:browser:input`, a shell channel the core answers only for the captain's own browser (`TaskBrowsers.captainInput`), as the browser protocol's own input at the page's own pixels; the editing keys of the window's own system (⌘ on a Mac, Ctrl on Linux, where Ctrl+Y redoes too) go as the page's editing commands whatever system the page runs on, paste with the words on the captain's own clipboard ("Paste" below), and Back, Forward and Reload move the captain's page;
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
An unsaved site offers an unticked `Remember my <site> sign-in on this computer`; a saved site shows `Sign-in saved on this computer · updates on return` and Manage, which opens Settings → General → Website sign-ins.
`TaskBrowsers.returnControl` waits, at most ten seconds, for a load the captain started to finish, so a return during a reload hands back the loaded page; then every page starts a new book, so every older ref is refused, nothing from the captain's time is kept, the crewmate's next answer leads with a line saying control came back, and its fact carries `returned`, which the view's caption reads as `temporary · keeps what you signed in to until it stops`.
The crewmate is woken once through its task's durable lane: `CardActions.browserReturned` steers the typed `browser-returned` wake (`docs/inbox.md`), named by the run, the browser and its count of returns, so the inbox queues each return once.
The wake names the site, says the old refs are gone and to take a fresh look with `infinitary-browser-axi`, the command's home view, repeats what the crewmate said it would do next, and says returning gives the task the signed-in site, never permission to buy, pay or submit anything that matters.
It carries none of the page itself, so nothing the captain signed in to is written to the inbox or the timeline; the crewmate reads the page in its own turn.
Until its first command after the return, and through its first read, the view's row reads `fresh look at the page`.

A browser in the captain's hands - paused for the captain's help, being taken, or the captain's - is the captain's turn: the idle ladder reads it as a witness (`browserWithCaptain`, `docs/report-sort.md`), so the crewmate is never nudged while the captain signs in, and its work posture reads as waiting for the captain.

A page that crashes while the captain holds it stops as any crashed page does (`its page stopped working`), and its crewmate hears it on its next command; nothing is returned and nobody is woken.
When the app quits or crashes while the captain holds it, nothing is kept: the next run has no browser, and a request card's strip says its browser stopped when Infinitary quit.
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
Waiting on the captain, the browser never stops for being unused, and the crewmate may withdraw the request with `infinitary-browser-axi stop`, which stops the browser.

The open-browser action is the captain's own click on the card's chrome: `CardActions.act` refuses it from a body's frame, takes control of the browser the card's attachment names - a newer or older one is never taken - and hands the shell an effect that opens the view, where the row reads `finishing the crewmate's current action…` and then the captain's control.
The card is answered by that click, as every action answers its card, and its crewmate is told nothing until the captain returns control.
An app controlling this Mac from another never sends that click: the card stays on both Macs and says to do it on this Mac (`docs/view.md`, "A task's browser on a view").
When the browser the card names is gone - it stopped, a newer one followed it, or it ended when the app quit - the click still answers the card and opens the view, whose line says so over whatever the task's browser is now ("From a card").
`CrewSupervisor` reads that off the task's browser fact (`attachmentStanding`) once the take or the saved sign-in's grant is refused, never off the refusal's words.
Its crewmate is then steered at once through its task's durable lane with the captain's choice and that its browser was gone (`card-choice` with `browserGone`, `docs/inbox.md`), so it can open the site again and ask anew on a new card, and the feed says so.
The steer never names the action, so a saved sign-in the host offered stays unnamed.
Leave waiting is an ordinary reply to the crewmate; it, a close and Hide leave the browser paused.

The captain may take the browser from the record's Browser line instead, with Take control in the view, while the request card is still up.
The captain's Return control then takes that card down (`CardActions.browserReturned`), so the captain comes back to no card: it asked for what the captain has done.
Only a request card naming the browser the captain returned goes, read off the task's browser fact (`attachmentStanding`); one naming an older browser stays, since its click tells its crewmate that browser is gone.
Its crewmate hears only the return's one wake, never a choice the captain did not make.

## Saved sign-ins

The captain may keep a website's sign-in on this Mac, one per site, and a task's browser uses one only after the captain's click on that task's own request (the answer `remember` on the FI3-835 design).
A task's browser starts with none, whatever this Mac has saved.

**Saving one.**
Ticking Remember saves an unsaved site's sign-in as Return control hands the page back (`inf:browser:return` with `remember` and the displayed `site`, `TaskBrowsers.returnControl`).
The selection clears when the displayed site or browser changes, and the core checks the site again after the captain's load settles and after reading site data.
Saved status instead sends the displayed save's `savedId`; a human return refreshes that exact record without another tick, including a different account chosen on the site.
A removed or replaced save is never restored or overwritten by a stale handback.
An unsupported or failed save leaves a visible warning even when handback succeeds, with no silent retry.
A sign-in is the site's own signed-in state, the way a browser keeps it, in two parts.
Its cookies are those the browser sends to the site's name, those its parent shares with every name under it, and those of the names under it (`cookiesOfSite`, `src/core/browser/webSignIns.ts`).
Its page storage is the local storage and the session storage of the site's own origins, `http://` or `https://` at exactly its host and port, read from the browser's pages on the site, where a site that keeps its sign-in in the page rather than in a cookie keeps it (`storageOfSite`).
A page reads only its own origin's storage, so a name under the site, its parent and another site hold none of the site's.
Session storage is each page's own, so a save reads it from the pages on the site at the captain's hand-back, and a browser's stop never reads it.
A site's own page storage is what its page chose to keep, which can include what the captain typed to sign in, such as a password field from the site's own sign-in answer; the save keeps it as the browser held it, in the same owner-only file.
It is never the person's own Safari or Chrome profile, or the app's subscription sign-ins, which live in their own stores.
A site that holds none of the three saves nothing, and a site that keeps its sign-in only in the page's own database is not remembered.
The browser that saves or refreshes a site's sign-in uses it from then on.

**Where they live.**
`WebSignIns` (`src/core/browser/webSignIns.ts`) is the one writer over `userData/web-sign-ins/`: a 0700 folder with one 0600 file per site, named by a digest of the site, holding the site, when it was saved, which save it is (`id`), its cookies, its local storage and session storage by origin, its optional `automatic` permission and its optional `failedAt`, when a crewmate last said it did not sign its page in.
A save made before local or session storage was kept reads as one with none, and a save with no `automatic` permission remains save-only.
`TaskBrowsers` is its only caller; nothing else reads it, and nothing makes the folder until the captain first ticks Remember.

**Using one.**
The captain separately enables `Allow future tasks to use this sign-in automatically` for one saved site in Settings.
It starts off for every existing save, lasts across restarts and applies to tasks across projects sharing the home.
On a crewmate's explicit visit, the browser uses the permitted site's saved state and reloads once before answering the command; it never substitutes for a help or payment review card.
The browser records the grant, hides signed-in-page diagnostics as for a manual grant, invalidates old references and requires a reason for pictures.
A browser attempts a site once; a website that rejects the sign-in needs the captain, not another automatic attempt.
Turning the permission off stops future grants but leaves browsers already using the save signed in; Remove also signs them out.

When a crewmate asks for help on a site this Mac has a sign-in saved for that its page can use - a cookie still alive, or local or session storage for the very origin the page is on - and its browser holds nothing of the captain's yet - no page the captain handed back, no saved sign-in - the host adds `Use my saved <site> sign-in` to the request card as its default, last in the row, and relabels the crewmate's open-browser action `Sign in myself` (`CardBrowserActions.withSavedSignIn`, `TaskBrowsers.savedSignInFor`).
The crewmate never learns which sites are saved, and only the host adds that action: its effect is `{ kind: "open", target: "browser", savedSignIn: true }`, which the crewmate's tool cannot declare and the supervisor refuses from any other author.
The host adds it after the card lint, so the 2 or 3 actions a decision gives are counted over the crewmate's own (`docs/card-authoring.md`, "The shape lint").
The captain's click is the grant: `TaskBrowsers.grantSavedSignIn` copies that one site's saved cookies, and its local and session storage for the origin the page is on, into the browser the card's attachment names, reloads its page so the site reads them, hands the browser back to its crewmate - refusing every older ref, as a return does - and writes one line on the task's timeline, `you let it use your saved sign-in at <site>`, beside the control handoffs.
The crewmate is woken once on its durable lane, the `browser-returned` wake with `saved`, named by the run, the browser and the site, so one browser is granted a site once.
The shell opens the view, where the row reads `fresh look at the page` and the foot line `signed in on <site> · saved on this computer`; the captain never takes control and types nothing.
The click works the same from an app controlling this Mac from another, which opens no view (`docs/view.md`, "A task's browser on a view").
A grant that cannot be made - the browser no longer waits, nothing its page can use is saved for its site, the browser took none of the cookies, or the page refused the storage - leaves it paused for the captain, and the feed says why.
A grant whose browser is gone tells its crewmate as the open-browser action's click does ("Asking for help").
A browser using a saved sign-in keeps what "A signed-in page" keeps: a picture needs the crewmate's reason, and its timeline line says the browser used the saved sign-in.

**Copying it back.**
When a browser that uses a saved sign-in stops - its crewmate's close, Stop browser, half an hour unused, a crash, its task closing - it copies that site's cookies, and the local storage of each of the site's origins one of its pages is on then, back into the save it was given before its site data goes, within three seconds, so a session the site refreshed stays current (`TaskBrowsers.copyBack`, `WebSignIns.refresh`).
It leaves the saved session storage as the captain's last hand-back saved it: a site may clear its page's sign-in while the browser sits idle, before the browser's half-hour stop, and a stop that copied that back would lose the sign-in.
The captain's hand-back on the saved site, through its saved status, reads the session storage again.
A save the captain removed or replaced since is left alone, since each save has its own `id`.
A site that holds no cookies by then copies none back over the save, and an origin no page is on, or one that holds nothing, keeps the local storage it was saved with.
The app's quit closes every browser at once and copies nothing back.

**Settings.**
Settings → General lists them under Website sign-ins, one row per site with when it was saved, its initially off future-task permission and Remove (`WebsiteSignInsSection`, `src/renderer/src/settings/`), read with `inf:browser:sign-ins`, which answers `available: false` where this build keeps no task browsers, so the section draws nothing there.
Remove (`inf:browser:sign-ins:remove`, `TaskBrowsers.removeSavedSignIn`) deletes the site's file, signs every browser using it out of that site at once - its cookies there, its own origins' local storage, and their session storage in each of its pages go, and nothing is copied back - writes a timeline line on each such task, and tells each crewmate on its next command.
The list, Remove and `inf:browser:sign-ins:automatic` are core channels this Mac's window alone may ask; the first mate never changes saved-site permission or removes a saved sign-in.

**A page never gets another site's storage.**
The host reads and writes local and session storage only through a page's own protocol, by its top document's own storage key (`HostPageStorage`, `src/main/host/taskBrowser.ts`).
The protocol finds that storage in this page alone, so a frame's storage, a partitioned one and another origin's are never read or written, and a write to a page that has moved to another origin is refused.
The core gives a page only the storage saved for the origin it is on, keeps only the site's own origins in a save, and never reads a page that is on another site.
Remove clears the site's own origins' local storage through the browser's site data, whether or not a page is on them.
Clearing site data does not reach session storage, so Remove clears it in each page that is on one of those origins, through that page's protocol.

**What it cannot promise.**
Sites end sessions on their own schedule, and a site that binds a session to the browser or device that made it may turn a copied one away.
Then the page asks for a sign-in again; the crewmate's wake tells it to ask the captain again on a card with `browser_handoff` carrying `saved_failed` true, and since its browser now holds a saved sign-in the card offers only `Sign in myself`.
An automatic use's notice tells it the same.

**A save that did not work.**
Only the crewmate decides that a saved sign-in failed: a second request card on the same site may be a payment review, so the host never infers it.
Its `saved_failed` marks the exact save its browser was given, by its `id`, with when (`WebSignIns.markFailed`, `TaskBrowsers.markSavedSignInFailed`), and writes one line on the task's timeline, `said your saved sign-in at <site> did not sign its page in`.
A browser on another computer marks the save this Mac lent it or made from its hand-back (`PlacedBrowsers.markSavedSignInFailed`).
A browser that uses no save for the site marks nothing, and its crewmate's tool answer says so; a removed or replaced save is never marked.
The rule rides the saved sign-in's notice, not the card tool's own words, so it costs the fixed context nothing.
The next request card on that site that offers the save leads with `Sign in myself` as its default and keeps `Use my saved sign-in (did not work last time)` as a second choice, without the site, which the card names.
A new save clears the mark; the captain's hand-back refreshing the save, a browser's copy back and the future-task permission keep it.
An allowed automatic visit still tries a marked save once, since it costs the captain no click, and Settings shows nothing new.

A saved sign-in is as safe as this Mac's own login and its disk.

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
- a saved sign-in's grant leaves the page as it is, and the crewmate's next answer says so.

Going back or forward to a form's answer the browser did not keep shows nothing rather than sending it again (`ERR_CACHE_MISS`), and the crewmate's answer says that too.
A redirect after the form that changes its request to `GET`, the way most sites answer one, is an ordinary page and reloads as one.
A redirect that keeps `POST` stays guarded, as does a move within the same document; navigating to a new `GET` document clears the guard.

**Retries.**
No retry of the app's replays a browser commitment.
A wake or steer the inbox delivers again - after a provider failure or a restart (`docs/inbox.md`) - is words alone: the host keeps no browser command to replay, and a restart keeps no browser, page or form, since every browser closes when the app quits.
A crewmate whose redelivered wake finds its browser gone reads the outcome as unknown, as the wake says, and asks.
A request card from before a quit still stands; the captain's click on it tells its crewmate that its browser was gone, and the steer says an unknown outcome still is unknown, so the crewmate checks again on a fresh browser and asks anew.
Open again, after a stop within one run, starts a fresh browser with nothing signed in at a plain visit to the last address, never sending what the page last sent.

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
- Take control, the captain's input, Return control, Stop browser, Open again, a request card's pause and the task's close are orders to that computer (`browserOrders`, `src/shared/work.ts`), answered there by the same rules.
  Out of reach, each is refused in words and nothing is done.
- What that computer has the home do once - a line on the task's timeline, the crewmate's wake on a return, a saved sign-in copied back - arrives as a work request that the conversation's ledger answers once (`inf:work:browser-event`, `docs/helper.md` "Holding a conversation").
- A saved sign-in stays the home's (`WebSignIns`).
  The captain's click on a request card lends that one site's save to the browser there, which holds it in its site data in memory only and copies it back by the save's id as it stops.
  Remember or a saved status brings what that browser holds home in the Return control answer, bound to the displayed site and save identity.
  Session storage rides beside cookies and local storage as an optional field (`heldSignInSchema`); a computer without it uses and copies back cookies and local storage only, and a copy back without it leaves the saved session storage as it was.
  A refresh uses the same identity and the home refuses a removed or replaced record.
  On an explicit visit, `inf:work:browser-sign-in` reads only a separately permitted site from the home; the command awaits that read and applies the session in memory.
  This live read bypasses the durable conversation ledger, so no sign-in is saved on the work computer or in a kept response.
  A home that does not support the read, or is out of reach, provides no automatic grant and the ordinary sign-in request remains available.
  Remove signs every browser there that uses it out of that site.
  Nothing on that computer writes a sign-in to a file.
- The home's quit leaves a browser there running with its crewmate's turn; that computer's quit or restart ends it, and the home reads that it has none once that computer is back.

## The page itself

The host makes each page (`src/main/host/taskBrowser.ts`, behind `HostTaskBrowser` in `src/core/host.ts`): effects only, while the core keeps every decision.

- It is a hidden window of its own at 1280 by 800, or the room the captain's maximized view gives it ("The view"), never a view in the app's window: only a window's own page paints and takes input while nobody can see it.
  The core alone resizes it (`HostBrowserPage.resize`), and a second page opens at its opener's size.
  The view the captain watches draws pictures of it (above), so the page stays hidden while it is watched.
- Its site data lives in a partition unique to that open, in memory only, cleared when it closes, its sign-ins with it; its cookies are read, written and removed for the core alone (`HostBrowserCookies`), and so are its page's own local and session storage (`HostPageStorage`), which a saved sign-in is made of ("Saved sign-ins").
- It is sandboxed with context isolation and web security on, has no preload and so no app bridge, and refuses every permission and device permission, and every new window but a second page the core lets in ("A second page"); a download goes only where the core says ("A download").
- Navigation, redirects and frame navigation are checked against the same policy as requests; loopback is reached directly, and everything else through the browser's connection guard, its session's one proxy ("Where a page may go").
- It never reloads a page that answers a form that was sent ("A final submission").
- It draws every dropdown's list in the page, as Chromium's in-page list (`appearance: base-select`): a Mac's own list is a native menu, a window of its own, which closes at once beside a hidden page and is never in the page's pictures.
  The rule is added to each new document in a layer and marked important, so a site's own styles do not win it back, and a dropdown can look different from the same site in another browser.
- A certificate error, a site's sign-in box and a request for a client certificate are refused and told to the core (`HostBrowserRefusal`).
- Every page uses an ordinary Chrome user agent, without Infinitary's name and version or Electron's token; reloading and navigating keep it.
  The host sets it on each page through Electron, and makes it Electron's fallback (`app.userAgentFallback`) when the task browser is made, before any page opens.
  A page a website opens loads its first document with the identity its renderer and session start from, since native popup navigation ignores Electron's per-page override (`electron/electron#45897`), so the fallback is what that page shows.
  The page's protocol does not carry the identity: a command to a page opened without an opener reaches its renderer only after the first document commits, when its first script may already have run.
  Holding that document until the command answers stalls the page whenever another protocol client, such as Playwright in the journeys, attached to it first.
  The app's own windows show only its own files, so the fallback changes nothing a person sees there.
  A website-opened second page keeps its native navigation, opener and form body, with the ordinary identity in its first request, its first script's `navigator.userAgent` and its first fetch.
  The host never reloads such a page to change its identity, since that could repeat a form submission.
  `tests/e2e/task-browser-user-agent.spec.ts` checks real request headers, document scripts and fetches for opening, reloading, navigation, links, scripted popups, a blank popup followed by navigation, redirects and a form sent once, with the app's main process held still as each document commits, the way a busy computer holds it.
- The host drives it over the browser's own protocol, attached to that one page and nothing else: the accessibility tree, an element's box, mouse and keyboard input at a point, typed text, a list's option, and the picture, at one pixel per point.
  It also reads a time element's `datetime` and a title tooltip off the page, and the core names them on the outline line, and where each element sits, so the core knows which lines the window shows.
  A whole-page picture is at least as wide as the window, so the scrollbar is not left out of its width.
  A watched page asks for its picture stream again once each new document is in, since a stream asked for while one commits may go with the old one.
  A same-document move is told to the core, the same as a new document, so a ref from before it is refused.
  The crewmate never sends a protocol command or runs script of its own in the page.

These windows are not the app's.
`appWindows()` (`src/main/windows.ts`) leaves them out of every app push, reload, focus, notification click and dock activation, and a development run still quits when its last own window closes.

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
`wheelScroll.test.ts` holds that a wheel does not return until that scroller's scroll has ended, and that a page already at that edge does not wait.
`tests/e2e/task-browser-actions.spec.ts` exercises the real core delegate and Electron host in the hermetic launcher: hover reveals a menu, two fields hold their values, real pointer input drops an item, edge scrolls reach their content, and a crop photographs one element.
`tests/e2e/task-browser-file-request.spec.ts` does the same for a page that asks for a file: the crewmate's press on a site's own file button opens no picker and leaves every page window hidden, `upload` refuses a file outside the working copy or through a link out of it and attaches one inside it, printing answers without opening anything, and while the captain holds the page their press on the same button takes the app's picker's file and their press on a color field opens no picker.
`taskBrowsers.reading.test.ts` also holds a same-page action answering only changed lines, a no-change action, and a fresh inspection recovering the full window.
`window.test.ts` holds the windows: a page that fits whole with no map, a repeated passage folded at its depth, a cut within its bound with its map and next lines, reading on from a line and past the end, a search past the cut within the smaller bound and stepping to the next match, a search reading a whole cut passage, the lines on screen with the skipped lines named, the top when nothing could be placed, the part around a passage, and a small page shown whole around its words.
It also holds a cut passage naming a ref, a wait reading past that cut, a time element's `datetime` and a title tooltip, and a full read that still hides what the captain typed.
`reading.test.ts` holds the snapshot's marks, which elements the window shows, the whole-page picture's width and the navigation-payload error left out of an answer.
`taskBrowsers.reading.test.ts` holds a click on a link, and a button click, whose address changes after the click, answering with the new page, a full read of a cut line, a long page read from its top, from a line, around words and on screen after a scroll, and a wait answered with the part that holds its words.
It also holds a ref from before a move refused for every action and a full read, with nothing sent to the page, while the element that took its place keeps its own ref, and a ref from a browser the task had before refused.
`addresses.test.ts` holds which addresses are public, however they are written, and each address's kind, and `connectionGuard.test.ts` the guard against a stand-in site on loopback: only its own browser's sign-in is answered, a public name tunnels to the one address it checked and is resolved once, a name that leads only to this Mac or a private network is refused before any connection with each answer's kind, a name with public and private answers tunnels to its public one alone, and one whose public answer does not respond reports what it skipped, a private address written out is refused unresolved, a name not found and a server that does not answer are told apart, and closing ends its tunnels.
It also holds a listed name and a name under a listed suffix tunnelling to their private answers while the suffix's bare name is refused, a listed name whose answers no task browser reaches refused, a plain http request for a listed name forwarded to its checked address without the guard's sign-in, a plain request without the sign-in refused before any lookup, a listed name's open tunnel ended once the name is removed while a public one stays, and a Remove that lands mid-dial refused.
`privateSites.test.ts` holds the list's file, what an entry may be and each change being heard, `destinations.test.ts` a listed site opening over http and https from any page and never by its address, and `taskBrowsers.reading.test.ts` a crewmate opening a listed site, its pages reaching it, an unreadable list keeping the last read, and a Remove refusing its pages at once and asking the guard to end its connections; `placedCallbacks.test.ts` holds the home's answer to a computer that runs work, `placedBrowsers.test.ts` the home sending each change to a computer with an open browser, and again when one is back in reach, and only logging an older one's refusal, `actions.test.ts` the Allow card, and `cardActions.test.ts` its click landing on General.
`tests/e2e/private-sites.spec.ts` has the first mate offer the Allow card, the captain's key on Allow add the site and land on General, and the captain add a suffix with Enter, be refused an address with its reason, and remove the first site by key, each change saved.
`taskBrowsers.reading.test.ts` also holds public websites through the guard and its refusals' words, each kind of answer's lead among them, and the certificate, sign-in box and client certificate refusals.
`taskBrowsers.view.test.ts` holds a second page opening, taking the crewmate's commands, each page's refs refused on the other, switching back and closing itself, the two-page cap and a refused popup, the captain's pick of a page and the view following the current page.
`taskBrowsers.signIns.test.ts` holds a browser handed back keeping only what the task needs: no query, no error words, no typed text the crewmate did not type and no picture of it, while what the crewmate types itself reads back until the captain holds the page again.
`docs/axi-commands.md` ("Tests") holds the command, its channel and its process; `crewmateTaskTools.test.ts` that no crewmate is served a browser tool, and `cardActions.browser.test.ts` that a task on this Mac gets its own browser's command and prompt line and an app without one gives none.
`taskBrowsers.view.test.ts` also holds the captain's side: the fact and its action line, pictures to a watcher, the idle stop held while watched, Stop browser and Open again.
It also holds the maximized view's room: the page, its pictures and its photographs at the room and back at 1280 by 800 on restore or when that view stops watching, no size from a view that does not watch, the newest room laid out at once while a command loads, never between a click finding its control and pressing it, and a browser, a second page and Open again opening at the room.
`taskFacts.test.ts`, `TaskFacts.test.tsx` and `stackActions.test.ts` hold who is driving, the record's Browser line and the view's place on the stack.
`tests/e2e/task-browser.spec.ts` drives a real task page through the hermetic app: a crewmate types and clicks by refs on a local sign-up page that counts only a real click, the page keeps its own site data across a reload, cannot reach the app, and is refused a picture from a public name that leads to this Mac - at the connection, by its guard - one over plain http and data from another server, the picture lands in the evidence folder at 1280 by 800, closing leaves no page behind, and the next task's browser starts empty.
Its reading journey has a crewmate click a release that opens without a full load, its old ref refused rather than used on the link that took its place, then read the long passage, the exact time and a plain-text feed.
Its long-page journey has a crewmate open a changelog too long for one answer, read its map and folded repeats, find words in its last section, read on from the line the first answer's next lines name, and scroll to see the lines on screen rather than the top again.
`tests/e2e/task-browser-view.spec.ts` has the captain open a crewmate's browser from the record and watch the page's own pixels while the crewmate drives, maximize the view and find the page laid out at the view's room and following the window's size, restore it to 1280 by 800, carry the task on the first mate input, see nobody driving once the turn ends, stop the browser from More, open it again fresh, and hide the view with the browser still running.
Its second journey has a crewmate emit a decision whose door reads `Try it`: the card names the task's browser, the click shows the page with the card unanswered behind it (the same offer, no thread line, the task as it was), Hide returns to the card, and once the browser is stopped and opened again both the card and the view it opens say the card's browser has stopped.
`cardTool.test.ts` holds that only a crewmate with a browser is offered `browser_button`, `cardActions.browser.test.ts` the attachment it writes and its refusals, `cardStore.test.ts` and `cardColumnMigrations.test.ts` the column, and `CardAttachment.test.tsx` and `stackActions.test.ts` the door's line and the view's return to its card.
`taskBrowsers.handoff.test.ts` holds taking and returning control against the stand-in page: a take while a command runs lets it finish and refuses the one queued behind it, the captain's input reaches the page and nothing records it, what the page said in the captain's time never reaches the crewmate, a return during a reload waits for it and refuses every older ref, each return is one named wake, a stale handle is refused, a crash or a quit in the captain's hands wakes nobody, and a request pauses the browser only on the site it names.
`cardActions.browser.test.ts` holds that a request card pauses the browser before it goes up, that the captain's click takes the card's own browser and tells the crewmate nothing, that a click or a saved sign-in's grant whose browser ended with a quit, or stopped and was replaced, steers the crewmate once with that fact and the feed line and never names the saved sign-in, that a browser in the captain's hands is never nudged, the request's refusals, and the one wake on return; `wakes.test.ts` its words, `reportSort.test.ts` the witness, `cardTool.test.ts` the parameter and the first mate's refusal, and `taskFacts.test.ts`, `CardAttachment.test.tsx`, `cardActions.test.ts` and `stackActions.test.ts` the record's words, the strip's tint and its missing button, and the view the action opens.
`cardActions.browser.test.ts` also holds that a return takes down the request card naming that browser, leaves a card that asked nothing and one naming an older browser, and wakes the crewmate only once.
The first journey in `tests/e2e/task-browser-handoff.spec.ts` has a crewmate ask the captain to sign in on a local account page: its card's strip reads paused for your help with no button beside the card's action and its browser refuses the crewmate, the card's key opens the record, whose Open shows the paused page and says so, Open browser and sign in hands the captain the page with no word to the crewmate, the captain signs in with real clicks and typing on the view's picture while no file under the app's data and no model call holds the captain's password, Hide resumes nothing and the sharing notice stays visible before handback, and Return control wakes the crewmate once - its old ref refused, its fresh look leading with the return, the page signed in, and nothing the page logged or asked for in the captain's time reaching it - and its picture of the signed-in page is refused without a reason and taken with one, which its record names.
`webSignIns.test.ts` holds the store - its folder's and files' modes, one sign-in per site, a copy back only into the save it was given, session storage left as saved by a copy back that read none, a save from before session storage read as one with none, a broken file read as nothing - and which cookies make up a site's sign-in.
`taskBrowsers.signIns.test.ts` holds saved sign-ins against the stand-in page: the tick saves only the site's cookies, a request is offered one only on its site and only while the browser holds nothing of the captain's, the grant copies it in, reloads, wakes once and needs a reason for a picture, a grant is refused to a browser not waiting or stale or with nothing saved, a site that turned it away is offered nothing more, a stopping browser copies back, Remove signs out the browser using it and nothing copies back, and the app's quit copies nothing; and for a site that keeps its sign-in in session storage alone, the hand-back saves it, a grant or an allowed future-task visit writes it into the page before the reload, a stop leaves it as saved, and Remove clears it in every page.
`cardActions.browser.test.ts` holds the request card's added default and relabeled action, a card left as declared with nothing saved, a crewmate's declared saved sign-in never carried, the click's grant and its feed line when refused, and the saved wake; `wakes.test.ts` its words, `taskBrowser.test.ts` the foot line, `WebsiteSignInsSection.test.tsx` the Settings rows, and `core.boot.test.ts` the gate.
The first journey in `tests/e2e/task-browser-saved-sign-ins.spec.ts` has the captain sign in to a club page whose server keeps its sign-in in a cookie, tick Remember while returning control, and find it in Settings; the browser copies the site's refreshed cookie back when it stops; a second task's request then offers `Use my saved <site> sign-in` as its default beside `Sign in myself`, on a page its empty browser shows signed out, and that one click signs the page in and wakes the crewmate, which reads it signed in while no file and no model call holds the password; Remove in Settings then signs that browser out, and stopping it writes nothing back.
A journey beside it does the same for a club page that keeps its sign-in in local storage, and another for one that keeps it in session storage alone: the hand-back saves the session storage, the first browser's stop after the page cleared it leaves the save as it was, a second task's one click signs its page in, and Remove clears the page's session storage so it reloads signed out.
The third journey in `tests/e2e/task-browser-view.spec.ts` has a crewmate meet a site whose certificate no one trusts and read the refusal, then click Pay on a local shop whose bank's check opens as the browser's second page: the view names each page Browser and its title on the card's tabs, which watching cannot use, and draws the check's own pixels; once approved the check closes itself, the crewmate is back on the shop, which says it was paid, the second page's tab goes, and Stop browser closes it all.
The second journey in `tests/e2e/task-browser-handoff.spec.ts` has the captain take a browser from the view while its crewmate's wait on the page runs: that wait answers in full and the crewmate's next command refuses, the captain maximizes the view and signs in on the page at its new size with an invented account that no file and no model call holds, Hide resumes nothing, and Return control wakes the crewmate once.
A journey in `tests/e2e/task-browser.spec.ts` has one task's browser keep its own visits on a page this Mac serves, while a second task's page is refused that server's data and picture, its request to take over that server's site is refused with nothing paused, its own redirects to a public name that leads to this Mac and to a private address are refused, and its own open of the first task's page starts with none of that task's site data.
`taskBrowsers.handoff.test.ts` holds that a form's answer is never reloaded - for the crewmate, the captain and a saved sign-in's grant - and that going back to one the browser did not keep is named; `wakes.test.ts` the return wake's words for an unconfirmed submission, and `cardTool.test.ts` the review knowledge in `browser_handoff`'s description.
`task-browser-form-reload.spec.ts` sends real loopback forms through the native browser, including popups with and without an opener, and checks the host's refusal, both callers' answers and the server's single submission.
It keeps the refusal across fragment moves and redirects retaining `POST`, and verifies reload after redirects to `GET` and navigation away from the response.
`tests/e2e/task-browser-booking.spec.ts` runs a final submission on an invented airline (`tests/e2e/fakeAirline.ts`) on a Pi crewmate and a Claude crewmate, each crewmate's calls checked to have come through its own runtime, and a Claude crewmate's local check too.
Its booking journey compares fares on a decision whose door reads View search; asks for a sign-in on a card the captain closes, after which the request is still reachable from the record and the captain takes control from the view; fills in the passenger once woken; stops on a review card naming the trip, the passenger, the seller, the total and currency, the baggage, the fare rules and what is uncertain, marking a total that rose since the search, with nothing paid; and once the captain pays on the page and returns control, leaves a note with the reference, the airline paid once and nothing the captain typed in a file or a model call.
Its unpaid journey has the captain type invented card details on the review's payment page and hand it back without paying: the crewmate reads each card field as filled with its value hidden, its picture of the page is refused, no model call holds the card number, expiry or code and no file under the app's data the card number or expiry, while the page still holds them and the airline is paid nothing.
Its lost-answer journey has the captain pay on a page whose confirmation never comes, and the captain's Reload say why it sends nothing; the crewmate's own reload is refused and it watches My bookings; the app quits while that turn runs, and the next run delivers the wake again, which finds the browser gone, checks My bookings afresh and asks the captain to check in the browser on a decision that says the outcome is unknown; the app quits once more before the captain answers, and the captain's `Open browser and check` on that card tells the crewmate its browser is gone, so it opens My bookings again and asks anew on a card that names its fresh browser, where the captain then checks - the airline paid once throughout.
