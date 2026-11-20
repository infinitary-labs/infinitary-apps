A task's own browser on the stage, where the captain watches its crewmate use a page, and takes control of it when the page needs a person (the captain's Build it on FI3-835, every answer as proposed: one row of chrome, control by handoff, one-click returning control with a visible sharing notice, the action trail on, the record's facts as the door; the app's `docs/task-browser.md`).

**Where it sits.**
It is a shell-held entry on the card stack, like a task record and a past card (`CardStack.prompt.md`): one per task, opened at the front and shown at once, paging with the stack, never persisted, never emitted as a card and never a feed line.
It takes the stage's full width, up to 1040 px, on the stack's ordinary surface (`--bg-2`, `--line-1`, the card shadow).
It is not a window, a tab or a conversation of its own: the first mate's input stays under it with the task's key attached, because only the shown entry supplies the turn hint, so the captain's words reach the first mate about this task.
Hide or Esc puts it away; the browser keeps running, and the crewmate is never told.

**The doors.**
The record's Browser fact opens it (`TaskRecord.prompt.md`): the site, who is driving, then `Open` as a link.
A crewmate's card may carry the same door as its live attachment (`ResponseCard.prompt.md`, "A live attachment"), labeled by the crewmate - `Try it`, `View search`, `View booking` - and its click opens this view without answering the card.
Opening an open view focuses it, as a record does.
Hide or Esc on a view a card opened shows that card again while it is still on the stack.

**From a card.**
A card's door names the browser the card was emitted with.
When that browser has stopped and a newer one took its place, or Infinitary has quit since, the view opens with one line under its row that says so.
The line is 32 px tall with `--space-3` at its sides and a `--line-1` hairline under it, one sentence in `--text-sm` `--fg-2` that gives way with an ellipsis, whole on hover.
It reads `This card's browser has stopped, so this is the task's newer one, which kept nothing from it` or `This card's browser stopped when Infinitary quit; only what you signed in to for a sign-in request stays`, each ending in a full stop.
Under it the view is in whatever state the task's browser is now - the live page, the stopped panel with Open again, or `This task has no browser on this computer.` - so nothing pretends the card's page is still there.
A card whose browser is still the task's, open or stopped, opens the view with no line.

**A page from the project.**
A card's door may name a page from its task's project instead, such as a finished game's `Play` (the app's `docs/task-browser.md`, "A page from the project").
Its click opens this view at the front with that page loaded and the row already violet: `127.0.0.1:52011 · you have control · the crewmate cannot see this page`, with no `finishing…` step when no crewmate browser was running.
A browser the click started is the captain's own: its control button is `Close page` (primary) in place of `Return control`, with no question, and its foot line reads `temporary · the crewmate never sees this page`.
`Close page` stops it, and the view shows the stopped panel; no crewmate is told.
It works on a task that has closed, so a game's note can play it after its task is done.

**The card's top** is the task record's own (`TaskRecord.prompt.md`), as the Crewmate tab's is (`TaskCrewmate.prompt.md`): the status pill and its reason and the task key, with the size control (`ResponseCard.prompt.md`, "Maximize") and Hide, the card's shared top-right minus (`IconButton`, label `Hide`), in its corner; the title under them; then the tab strip ("The tab strip" below).
Hide sits in that corner on every tab of the task's card, in every state of the view, as on every other card, and never beside the browser's own controls, so it reads as putting the card away and never as closing the page (the captain on INF-1502: the close button was not where it usually is on cards, so what clicking it would do was unclear).

**One row of browser chrome** under the card's top, `--space-2` padding, a `--line-1` hairline under it:

- Back, Forward and Reload, 28 px icon buttons (Lucide `chevron-left`, `chevron-right`, `rotate-cw`).
  Navigation belongs to whoever has control, and watching is not control, so while the captain watches all three are marked off (`../core/IconButton.prompt.md`): dimmed, still Tab stops, their labels saying why (`Back · the crewmate is driving`).
  While the captain has control they are enabled and move the captain's page.
- The status line takes the rest of the row: a `StatusDot`, the site in mono `--fg-1` (the page's host and port, `localhost:5173`), then who is driving in `--fg-2`, then, while the crewmate drives, what it just did in `--fg-3` - each part after `·`; while the browser is paused for the captain, the crewmate's reason takes that place.
  It is one line and never wraps: the action gives way first with an ellipsis, then who is driving; the site never does.
  The whole line, with the page's title and address, is on hover.
- The control button, a small Button before More: `Take control` (secondary) while the crewmate drives or nobody does, `Take control` (primary) while the browser is paused for the captain's help, `Return control` (primary) while the captain has control, and none while the captain's Take control is finishing the crewmate's command or Return control is on its way.
- Point at, an IconButton before the control button, the card's own control and key (`AnnotationControls`, the same arrow glyph, ⇧⌘A), offered where a note has somewhere to leave from: a card docked beside the page or the Crewmate column.
  While it is on, its two tools sit before it as in the picture viewer (`PictureViewer.prompt.md`): the box and the freehand line, the chosen one pressed.
- More, a small ghost Button, last in the row.

**What the crewmate just did** is one short line at a time, replaced by the next, never a list: `opened /signup`, `read the page`, `waited for "Thanks"`, `typed into "Email"`, `typed into "Email" and pressed Enter`, `clicked "Create account"`, `chose "Economy" in "Class"`, `pressed Tab`, `scrolled down`, `went back`, `reloaded the page`, `photographed the page`.
A name is the control's own accessible name, cut at 40 characters; what was typed is never shown.

**Taking control.**
Take control is the only way the page becomes the captain's: never a click on the page, a sign-in, Hide, a card closing or a timer.
The crewmate's new browser commands refuse from that click on, and the one it is running finishes or fails within its bound; until then the row reads `finishing the crewmate's current action…` with a `busy` dot and no control button.
Then the row tints violet, the captain's own color (`--captain-dim` behind the whole row, a `captain` dot), and reads `site · you have control · the crewmate cannot see this page`, with `Return control`.
While the captain has control, the page takes the captain's pointer, the captain's wheel and the captain's keys: a click on it puts the keyboard there, its cursor is the pointer's own, and Escape, Tab and every other key go to the page rather than the app, while the app's own window commands stay the app's.
A Mac's editing keys reach the page as its editing commands - select all, undo, redo, cut, copy and paste - so the captain pastes on the page itself, never in a card or the first mate's input.
Nothing the captain types is shown, logged or kept, and the crewmate sees none of it: its tools refuse, and what the page says while the captain holds it is never reported to it.
The foot line's caption reads `temporary · returning control shares this page`, or, in the kept profile, `what you sign in to here stays on this computer`.

**Returning control.**
`Return control` hands back with one press, without another confirmation or Keep control button.
While the captain holds a crewmate's browser, a violet row under the chrome shows `Returning control lets the crewmate read and use this browser, including signed-in pages.` in `--text-sm --fg-1`, wrapping at narrow widths.
Below it, a browser in the kept profile (a crewmate's sign-in request) asks the site's rule for later tasks on one wrapping line in `--text-xs --fg-2`: the legend `Your aurora.example sign-in stays on this computer. Later tasks:`, then two radios, `Ask me each time` (checked first) and `Use it without asking`, `--space-3` apart, each radio in `--accent` and `--space-1` from its words, the chosen one's words in `--fg-1`.
A site the computer the browser runs on already lists starts at its rule there, and a small ghost `Manage` button follows, which opens Signed-in sites in Settings → Secrets, or Website sign-ins in Settings → General where the Secrets tab is not offered.
Outside the kept profile the notice is at least as tall as the browser toolbar and site permission row, growing if the text wraps.
A browser outside the kept profile asks nothing about saved sign-ins: what the captain signs in to there goes when the browser stops.
A failed or unsupported save says why under the foot line even if control returned successfully.
Return control waits for a load the captain started, hands the page back and wakes the crewmate once with its old refs gone.
Hide and Escape never return control.
The row then reads `the crewmate is driving · fresh look at the page` once its turn runs, `nobody is driving` until then, and the caption reads `temporary · keeps what you signed in to until it stops`, or, from the kept profile with no site listed, `what you signed in to here stays on this computer`.
Returning gives the task the signed-in page, never authority to spend; the crewmate asks on a card before anything that matters.
Command search includes `Take or return browser control`, which runs the shown browser's same control.

**Asking for help.**
A crewmate that needs a person on the page - a sign-in, a code, a payment - asks on an ordinary decision card that names the site and why, with an action such as `Open browser and sign in` (`ResponseCard.prompt.md`, "A live attachment").
From that card on, the browser is paused for the captain: the row tints ember (`--warn-dim`, a `warn` dot), reads `site · paused for your help · the crewmate's reason`, and offers `Take control` as the primary button.
The card's open-browser action opens this view with the captain taking control at once; its Browser line has no button, so that action is the card's one way in.
Leave waiting, closing the card or Hide leave it paused, and the record's Browser line keeps saying so.
The card does not leave at that press: it docks beside the page ("The request beside the page" below) until `Return control` takes it down, so the captain comes back to no card.
When the captain takes control from the record's Browser line instead, or hides the view, the request card stays on the stack, its line saying the page is the captain's, and `Return control` takes it down the same way; its crewmate hears only the return's one wake.
When the browser that card names is gone - stopped, or ended when Infinitary quit - the action still opens this view, with the line from "From a card" over whatever the task's browser is now.
Its crewmate is told, so it can open the site again and ask anew: the view fills with its fresh browser paused for the captain's help, a new card asks, and the feed says so.

**The request beside the page.**
While the task's request card is still up and the page is the captain's, it docks as a column at the view's inline end, however the view was opened, under the card's top and beside the row, the page and the foot line, so the steps stay in sight while the captain acts.
The column is the thread column's width, 40% of the stage held between 288 and 360px, with a `--line-2` hairline inside its start; it takes the page's height and scrolls inside, never making the view taller.
The column is added beside the page rather than taken from it: the page keeps the width the view would have alone, up to 1,040px, and the pair is centred as one, folding the docks first when it needs their room, as a card and its thread do.
It holds the crewmate's own card on top - its head, title and body, with no "You asked" line, no choices, no browser strip and no size or leave buttons, taking the room left and scrolling - then the thread's head with its Collapse thread, and, once anyone has written there, the card's thread (`CardThread.prompt.md`) under a `--line-2` hairline, which takes the larger share while the card keeps up to 40% of the column and scrolls whole, head included, then the card's one field at the foot under a `--line-2` hairline, as in a thread column.
Where the page would keep under 720px beside the column, as on the narrowest window, the column folds to its latest line: one row under the page, above the foot line and a `--line-1` hairline, that is a collapsed thread's latest line (`CardThread.prompt.md`, "Collapsing the thread"), or the request's title before anyone has written, with no field, so the page keeps its height and the view's whole width.
A click or Enter on that line, ⌘\ or ⇧⌘L opens the column, ⇧⌘L with the caret in its field; Collapse thread or ⌘\ folds it again, and the captain's choice holds over the window's width while the request is up.
The page beside it is the card's door and `Return control` its closing choice: the words still in the field ride the return to the crewmate, once, and the field empties.
A reply sent from the field is answered in the column while the page stays the captain's; the crewmate may revise the card, which redraws in place. ⇧⌘L goes from the page to the field, and `Go to the browser page` in command search goes back.
A request naming an older browser never docks; the view's line from "From a card" says why.

**A card beside the page.**
A card whose own door opened the view (`Try it`, `View booking`, a project page's `Play`) docks in the same column, drawn the same way, so its checklist reads beside the page.
Its choices stay off the column behind a `Back to the card` link under the body, in `--accent` at `--text-sm`, which brings the card to the front of the stack with its buttons; `Back to the card` in command search does the same.
A card the same task's crewmate puts up while its Browser tab shows arrives in the column instead of in front of the view, and the newest replaces an earlier one; while a request stands, the request keeps the column.

**A final submission.**
The captain makes the final payment, or any other submission that commits the captain, personally, on the site's own page (the answer `submission: captain` on FI3-835).
The crewmate fills in everything up to that step and stops, then asks on a review card (`ResponseCard.prompt.md`, "A live attachment"): an ordinary decision that names what the captain commits to - for a trip the route, dates and times with time zones, passengers, seller, total and currency, baggage, fare rules and anything still uncertain - with the change since the captain's last choice in a `<mark>`, and `Open browser and pay` beside `Stop here`.
From that card on the browser is paused for the captain's help, as for a sign-in; `Open browser and pay` opens this view with the captain taking control on the payment page, where a bank's check may open as a second page.
The captain pays there and presses `Return control`, and the crewmate reads the confirmation and leaves a note with what it kept, such as the reference, whose door reads `View booking`.
When the site never confirms, the crewmate asks again on a decision that says the outcome is unknown, with `Open browser and check` beside `Treat as not booked`; it never pays again.

**A site's asks.**
While the captain has control, what the page asks a person for - the camera, the microphone, notifications, reading the clipboard - waits in one row under the chrome, above the page, until the captain answers (the app's `docs/task-browser.md`, "A site's asks").
The row is 44 px tall, `--space-3` at its sides, `--warn-dim` behind it and a `--line-1` hairline under it: one sentence in `--text-sm --fg-1` that gives way with an ellipsis, whole on hover, then two small Buttons, `Allow once` (primary) and `Not now` (secondary), `--space-2` apart.
It reads `127.0.0.1:52011 asks to use your camera.`, `… your microphone.`, `… your camera and microphone.`, `… to send you notifications.` or `… to read your clipboard.` The page's own request waits behind it; one ask shows at a time, and the row goes when the captain answers, when the page stops asking, or at `Return control`, which answers it `Not now` and takes back everything allowed once.
A passkey the site asks for in Chrome, with the captain's window on the computer Chrome runs on, takes the same row with `Use passkey` (primary) and `Not now` (secondary), and the words `site asks for a passkey. Using it brings Chrome's window onto your screen.`; Use passkey brings Chrome's window to the front for the system's own prompt, and the row then reads `site asks for a passkey. Chrome shows its prompt in its own window.` with one primary Button, `Show Chrome window`.
Chrome's window goes back when the site has its answer.
Anywhere else, a passkey request ends at once and one line under the chrome tells the captain why, in the 32 px notice style of "From a card": `site asked for a passkey. This browser has no passkeys, so it told the site none is available. Look on the page for a password or a code.`, or, away from Chrome's computer, `… Chrome shows a passkey only on the computer it runs on, so it told the site none is available. …`.
That line goes when control changes hands.
While the crewmate drives, nothing shows: every ask is answered no.

**A move the browser refused.**
The browser never sends a form twice, so Reload on a page that answers a form that was sent - a payment's confirmation or its error - is refused rather than sent again.
The refusal says why in one line under the foot line, `--space-2` by `--space-3`, `--text-sm` `--fg-2`, as a status: `This page is the answer to a form that was sent, so reloading it would send the form again. The browser never sends a form twice: use the site's own links to see what became of it.` The line goes when the page moves, when the captain presses another of Back, Forward and Reload, or when control changes hands.

**Signed-in sites.**
Each computer keeps the captain's website sign-ins in one browser profile of its own, the kept profile; nothing copies a sign-in to a file or to another computer.
A crewmate's sign-in request opens its page there, and the captain picks the site's rule as control comes back (above).
A new browser starts in an empty context of its own, signed out, and uses a site only after the captain's click on its request, or by the site's rule `Use it without asking`.
In the kept profile a browser opens only the sites it was allowed and the sign-in pages passed through; any other site opens signed out.
When a crewmate asks for help on a site the computer lists and its browser may not use it yet, its card's default is `Use my aurora.example sign-in`, beside `Sign in myself` and `Leave waiting` (`ResponseCard.prompt.md`).
That click opens the page in the kept profile, signed in, hands it back to the crewmate, and opens this view, where the row reads `the crewmate is driving · fresh look at the page`; the captain never takes control and types nothing.
`Sign in myself` is the ordinary handoff above.

Settings → Secrets lists them last, under the micro label `SIGNED-IN SITES`, after Protected secrets, in every storage state (`components/secrets/SecretsTab`, "Signed-in sites").
Where the window offers no Secrets tab - a build without protected storage, or a computer that controls another - Settings → General lists them instead, after Sharing.
One `--text-sm --fg-2` line leads: "Sites you signed in to in a task's browser.
Each computer keeps its own in its own browser profile.
For each site, later tasks use it without asking or ask you each time."
In Secrets it goes on: "They stay in that computer's browser profile, not in protected storage."
With other computers, each computer's list has its own `--text-xs --fg-2` heading, `On this computer` first, then `On Mac mini`; a computer that could not be asked shows one `--text-sm --fg-3` line saying so in place of its list.
Each list is one box (`--bg-1`, `--line-1` hairline, `--radius-m`) with a row per site, `--space-3` by `--space-4`, a `--line-1` hairline between rows: the site in mono `--text-sm` `--fg-1`, then when the captain signed in there - `signed in today`, `signed in yesterday` or the day, `signed in Oct 4` - in `--text-xs` `--fg-3`, then `Later tasks` in `--text-xs --fg-2` with a select of `Ask me each time` and `Use it without asking` (`--bg-2`, `--line-2`, `--radius-s`, `--space-1` by `--space-2`), and a small secondary Button `Remove`.
Below the lists, `--text-xs --fg-3`: "A rule applies to tasks across all projects on that computer.
Use it without asking never covers a payment or a final submission; Remove signs the site out there."
Changing a rule to `Ask me each time` leaves a browser already using the site signed in; Remove takes the row away at once and signs that computer's kept profile out of the site, every task browser using it with it; there is no undo, and signing in again adds it anew.
Under each computer's box, one row: `--text-xs --fg-3` words, "Remove all signs this computer out of every site, including sign-ins never added to this list.", naming that computer, and a small secondary Button `Remove all` at its end; it shows with an empty list too, since the kept profile may hold sign-ins the list never named.
With none, the box holds one `--text-sm --fg-3` line: "None yet.
A site is added when you sign in to it in a task's browser and return control."
It never lists the person's own Safari or Chrome sign-ins, the first mate's subscription sign-ins, or anything typed.

**More** opens a popover under its button, right-aligned to it, drawn like a `RowMenu`'s (`--bg-2`, `--line-2`, `--radius-m`, `--shadow-2`), growing from the button and fading out like every popover:

1. `Actual size` while the page is fitted, `Fit` while it is at its own size.
2. `Stop browser`.
3. `Copy page address`.
4. `Report a problem`: puts "This task's browser has a problem: " in the first mate's input, focused at its end, so the captain says what is wrong to the first mate about this task.

It closes on Escape, an outside click or a pick, and it may sit over the page: the page in the view is a picture the app draws, so nothing native covers the app's own menus.

**The page** sits under the row at its own size, 1280 by 800, the size every check is made at.
Fitted, the default, it scales to the view's width, whole, never cropped and never past 1:1; at its own size it is one pixel per point and scrolls inside the view.
Maximized, the view gives the page its room: the page lays itself out afresh at the size of its place under the row, so it fills the view at one pixel per point with no bars beside it, and it follows the window's size while the view stays maximized.
Restored, it is 1280 by 800 again.
The sharing notice and a refusal line take room from the page without resizing it; it fits under them.
It is a live picture of the task's page, redrawn whenever the page changes, so the captain watches exactly what the crewmate's browser shows.
While the captain watches, the pointer and the keys do nothing to it, and its cursor stays the default; while the captain has control they are the captain's on the page ("Taking control").
Until the first picture arrives the page's place is an empty `--bg-1` block at the page's proportions, with no spinner.
**The tab strip** (the task card's own, shared with the record, `components/cards/TaskRecord`, "Tabs") sits under the title and above the row, 32 px, with a `--line-1` hairline under it.
Its tabs are `Info`, `Crewmate` once a crewmate has started the task (`components/cards/TaskCrewmate`), then one `Browser · <page title>` tab per page the task's browser holds, in `--text-sm` weight 400, `--space-1` by `--space-2` padding, one line that gives way with an ellipsis at 45% of the strip, whole on hover.
A page with no title reads `Browser`, and a stopped browser's one tab reads `Browser`.
The site is never in a tab: nearly every page is a localhost port, so it stays in the row and the foot line.
The shown tab is `--fg-1` with a 2 px `--accent` line under it; the others are `--fg-3` on nothing.
The current page is the one the row's site names and the page shows; when a page opens a second one, the second becomes current, and when it closes itself the first does again.
Picking another page is navigation, so it is the captain's only while the captain has control, like Back and Forward: then a tab click makes that page the captain's, and the crewmate's once the captain hands it back.
While the captain watches, the other pages' tabs are disabled and the current page's tab is selected.

**The foot line**, `--text-sm`, `--space-3` at its sides, a `--line-1` hairline above it: the task key in mono `--fg-3`, the task's title in `--fg-2` with an ellipsis, then on the right `Task record` as a link, which opens the task's record at the front, and the sign-in caption in `--fg-3`.
The caption says what this browser holds of the captain's: `temporary · none of your sign-ins` - temporary because its site data goes when it stops.
While it uses a signed-in site it names it instead: `signed in on aurora.example · kept on this computer` ("Signed-in sites").

**States.**

| State | Status line | Under the row |
| --- | --- | --- |
| Watching | `busy` dot · site · the crewmate is driving · what it just did | the page |
| Nobody is driving: the crewmate's turn has ended and its browser stays open | `idle` dot · site · nobody is driving | the page, still |
| Paused for your help: the crewmate's card asked | ember row · `warn` dot · site · paused for your help · its reason | the page, still |
| Taking control: the crewmate's command finishing | `busy` dot · site · finishing the crewmate's current action… | the page |
| You have control | violet row · `captain` dot · site · you have control · the crewmate cannot see this page | the page, taking the captain's input; the visible sharing notice and, in the kept profile, the site's rule under the row |
| Returned | `busy` dot · site · the crewmate is driving · fresh look at the page | the page |
| Final payment: the crewmate's review card asked | as Paused for your help, then You have control on the payment page | the page; Return control after the captain pays, so the crewmate reads the confirmation |
| Outcome unknown: the site never confirmed | as Paused for your help, from the crewmate's decision that says so | the page where the site lists it, for the captain to check; the crewmate never pays again |
| Stopped | no browser row: the card's top names the task, with Hide in its corner | one centred sentence of why, a second line, Open again and its caption; no foot line |
| Unavailable | as Stopped | why it cannot open now, Open again still offered |
| Waits for an update on another computer: this computer controls a first mate on MacBook Pro too old to send its pictures | as Stopped | `Update Infinitary on MacBook Pro to show this task's browser here.` over `Until then, only a window on MacBook Pro can show it.`; no Open again (`../devices/RemoteControl.prompt.md`) |

The stopped sentence says what stopped it, in `--fg-1` at `--text-base` weight 500, ending in a full stop: `You stopped this browser`, `The crewmate closed this browser`, `This browser stopped after 30 minutes unused`, `This browser's page stopped working`, or `This browser was stopped when the task closed`.
The second line is `--text-sm` `--fg-2`: `What you signed in to for a sign-in request stays; nothing else was kept`, or on a closed task `Its pictures are in the task's record`.
Then comes `Open again` (secondary Button), which starts a fresh browser at the last page with nothing signed in, and under it `A fresh browser, with nothing signed in` in `--text-xs` `--fg-3`; a closed task has no Open again.
Unavailable says why in the same place - `Four task browsers are already open on this computer. Stop one, then open this again.` or `This computer could not open a browser for this task right now.` - and keeps Open again for a later try.

**Never.**
The view never takes control by a click on the page, never sends what the captain types to the page while the captain watches, and never resumes the crewmate but by Return control; Hide, Esc and paging away change nothing about the browser or who holds it.
Watching keeps the browser from stopping for being unused: its half hour starts again when the view is put away.

**Point at** holds the newest picture of the page still and marks it, while the captain watches and while the captain has control (`docs/task-browser.md`, "Pointing at a page").
The held picture stays where the live one was, at the same size; a surface over it takes the pointer and the keys, so nothing reaches the page, and the foot line's title gives way to the hint `The page is held still · press a spot, drag a box or draw · arrows step through the page, Enter writes the note`.
Marks are drawn as on a picture (`PictureViewer.prompt.md`, "Pointing at a place"): the same two-colour box, spot and line, the same numbered badge, the mark being written lit, and the queued marks of the held picture shown on it.
The arrows step through what the page's outline names, in its order, lighting each thing's box; Shift with an arrow makes that a box of its own, which the arrows then move and Shift sizes; `Enter` opens the note popover; `Esc` ends Point at and returns focus to its control.
The note popover is the card's own (`CardThread.prompt.md`), anchored at the mark, with `Annotate page` as its title and the page's title as its excerpt.
Under the excerpt it shows the exact picture that will be sent, a small copy at most 220 by 140px with the mark's number, captioned `The picture that will be sent` in `--text-xs` `--fg-3`; while the captain has control a second line reads `Sending shows this picture of the page to the crewmate.`
Queue or Cancel ends Point at and the live pictures resume; the folded column opens when a mark is made, so the note is written and waits where it will leave from.
Beside a docked card the note joins that card's queued notes and leaves with its reply; with no card it waits above the Crewmate column's message box, drawn as a queued note is (`Not sent`, its small marked copy, Edit and Remove), in a list at most 13rem tall that scrolls inside, and the box's caption reads `Send 2 notes · ↩`.
Nothing leaves before that send.

**When no card is docked.**
A crewmate's page opens with one Crewmate line under it, showing the newest words or report headline if there is one.
The line opens the same width column as a request, with the Crewmate tab's transcript and message box, not a card thread.
Command-backslash opens and folds it; Shift-Command-L opens it and focuses the message box.
The browser keeps showing the page as before, including the notice that the crewmate cannot see it while the captain has control.
A docked card takes the column instead, and a captain-owned page with no crewmate driving it does not gain a column.
