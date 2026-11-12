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
It reads `This card's browser has stopped, so this is the task's newer one, which kept nothing from it` or `This card's browser stopped when Infinitary quit, and nothing it signed in to was kept`, each ending in a full stop.
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
The foot line's caption reads `temporary · returning control shares this page`.

**Returning control.**
`Return control` hands back with one press, without another confirmation or Keep control button.
While the captain holds a crewmate's browser, a violet row under the chrome shows `Returning control lets the crewmate read and use this browser, including signed-in pages.` in `--text-sm --fg-1`, wrapping at narrow widths.
Below it, an unsaved site offers an unticked `Remember my <site> sign-in on this computer` in `--text-xs --fg-2`, with the checkbox in `--accent` and `--space-2` from its words.
A saved site instead shows `Sign-in saved on this computer · updates on return` and a small ghost `Manage` button, which opens Website sign-ins in view: in Settings → Secrets, or in Settings → General where that tab is not offered.
Remember clears on a different site or browser, and the return checks the site and save identity again before saving or refreshing.
A saved status refreshes the same site's existing save on return, including a different account chosen there; a removed or replaced record stays untouched.
A failed or unsupported save says why under the foot line even if control returned successfully.
Return control waits for a load the captain started, hands the page back and wakes the crewmate once with its old refs gone.
Hide and Escape never return control.
The row then reads `the crewmate is driving · fresh look at the page` once its turn runs, `nobody is driving` until then, and the caption reads `temporary · keeps what you signed in to until it stops`.
Returning gives the task the signed-in page, never authority to spend; the crewmate asks on a card before anything that matters.
Command search includes `Take or return browser control`, which runs the shown browser's same control.

**Asking for help.**
A crewmate that needs a person on the page - a sign-in, a code, a payment - asks on an ordinary decision card that names the site and why, with an action such as `Open browser and sign in` (`ResponseCard.prompt.md`, "A live attachment").
From that card on, the browser is paused for the captain: the row tints ember (`--warn-dim`, a `warn` dot), reads `site · paused for your help · the crewmate's reason`, and offers `Take control` as the primary button.
The card's open-browser action opens this view with the captain taking control at once, and the card leaves at that press; its Browser line has no button, so that action is the card's one way in.
Leave waiting, closing the card or Hide leave it paused, and the record's Browser line keeps saying so.
When the captain takes control from the record's Browser line instead, the captain's `Return control` takes the request card down, so the captain comes back to no card; its crewmate hears only the return's one wake.
When the browser that card names is gone - stopped, or ended when Infinitary quit - the action still opens this view, with the line from "From a card" over whatever the task's browser is now.
Its crewmate is told, so it can open the site again and ask anew: the view fills with its fresh browser paused for the captain's help, a new card asks, and the feed says so.

**A final submission.**
The captain makes the final payment, or any other submission that commits the captain, personally, on the site's own page (the answer `submission: captain` on FI3-835).
The crewmate fills in everything up to that step and stops, then asks on a review card (`ResponseCard.prompt.md`, "A live attachment"): an ordinary decision that names what the captain commits to - for a trip the route, dates and times with time zones, passengers, seller, total and currency, baggage, fare rules and anything still uncertain - with the change since the captain's last choice in a `<mark>`, and `Open browser and pay` beside `Stop here`.
From that card on the browser is paused for the captain's help, as for a sign-in; `Open browser and pay` opens this view with the captain taking control on the payment page, where a bank's check may open as a second page.
The captain pays there and presses `Return control`, and the crewmate reads the confirmation and leaves a note with what it kept, such as the reference, whose door reads `View booking`.
When the site never confirms, the crewmate asks again on a decision that says the outcome is unknown, with `Open browser and check` beside `Treat as not booked`; it never pays again.

**A move the browser refused.**
The browser never sends a form twice, so Reload on a page that answers a form that was sent - a payment's confirmation or its error - is refused rather than sent again.
The refusal says why in one line under the foot line, `--space-2` by `--space-3`, `--text-sm` `--fg-2`, as a status: `This page is the answer to a form that was sent, so reloading it would send the form again. The browser never sends a form twice: use the site's own links to see what became of it.` The line goes when the page moves, when the captain presses another of Back, Forward and Reload, or when control changes hands.

**Saved sign-ins.**
The captain may keep one sign-in per site on this computer, and separately allow future tasks across projects sharing this home to use that site automatically.
Without that permission, a new browser starts with none and uses one only after the captain's click on its request.
When a crewmate asks for help on a site this computer has a sign-in saved for, and its browser holds nothing of the captain's yet, its card's default is `Use my saved aurora.example sign-in`, beside `Sign in myself` and `Leave waiting` (`ResponseCard.prompt.md`).
That click gives the browser that one site's sign-in, reloads its page, hands it back to the crewmate, and opens this view, where the row reads `the crewmate is driving · fresh look at the page`; the captain never takes control and types nothing.
`Sign in myself` is the ordinary handoff above, whose saved status refreshes the existing site save without another tick.
The browser copies the site's sign-in back when it stops, so a session the site refreshed stays current.

Settings → Secrets lists them last, under the micro label `WEBSITE SIGN-INS`, after the quiet rows, in every storage state (`components/secrets/SecretsTab`, "Website sign-ins").
Where the window offers no Secrets tab - a build without protected storage, or a computer that controls another - Settings → General lists them instead, after Sharing.
One `--text-sm --fg-2` line leads: "Sign-ins you saved as you handed a task's browser back.
Allow future tasks separately for each site, or choose access on each task’s request."
In Secrets it goes on: "They stay on this computer in their own storage, not in protected storage."
Then one list box (`--bg-1`, `--line-1` hairline, `--radius-m`) with a row per site, `--space-3` by `--space-4`, a `--line-1` hairline between rows: the site in mono `--text-sm` `--fg-1`, then when it was saved - `saved today`, `saved yesterday` or the day, `saved Oct 4` - in `--text-xs` `--fg-3`, and a small secondary Button `Remove`.
Each row also has an initially unticked `Allow future tasks to use this sign-in automatically` checkbox, separately changeable from Remove.
Below the list, `--text-xs --fg-3` explains that permission applies across projects sharing this computer; turning it off stops future grants, and Remove signs current browsers out too.
The permission lasts across restarts and existing saved records never gain it implicitly.
Automatic reuse happens on a crewmate’s explicit visit, not instead of a help or final-submission review; a rejected save is not retried in that browser.
Remove takes the row away at once and signs out every task browser using that sign-in; there is no undo, and signing in again saves it anew.
With none saved, the box holds one `--text-sm --fg-3` line: "None yet.
Tick Remember as you return control of a task's browser to save one."
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
While it uses a saved sign-in it names it instead: `signed in on aurora.example · saved on this computer` ("Saved sign-ins").

**States.**

| State | Status line | Under the row |
| --- | --- | --- |
| Watching | `busy` dot · site · the crewmate is driving · what it just did | the page |
| Nobody is driving: the crewmate's turn has ended and its browser stays open | `idle` dot · site · nobody is driving | the page, still |
| Paused for your help: the crewmate's card asked | ember row · `warn` dot · site · paused for your help · its reason | the page, still |
| Taking control: the crewmate's command finishing | `busy` dot · site · finishing the crewmate's current action… | the page |
| You have control | violet row · `captain` dot · site · you have control · the crewmate cannot see this page | the page, taking the captain's input; the visible sharing notice and saved status or Remember under the row |
| Returned | `busy` dot · site · the crewmate is driving · fresh look at the page | the page |
| Final payment: the crewmate's review card asked | as Paused for your help, then You have control on the payment page | the page; Return control after the captain pays, so the crewmate reads the confirmation |
| Outcome unknown: the site never confirmed | as Paused for your help, from the crewmate's decision that says so | the page where the site lists it, for the captain to check; the crewmate never pays again |
| Stopped | no browser row: the card's top names the task, with Hide in its corner | one centred sentence of why, a second line, Open again and its caption; no foot line |
| Unavailable | as Stopped | why it cannot open now, Open again still offered |
| Waits for an update on another computer: this computer controls a first mate on MacBook Pro too old to send its pictures | as Stopped | `Update Infinitary on MacBook Pro to show this task's browser here.` over `Until then, only a window on MacBook Pro can show it.`; no Open again (`../devices/RemoteControl.prompt.md`) |

The stopped sentence says what stopped it, in `--fg-1` at `--text-base` weight 500, ending in a full stop: `You stopped this browser`, `The crewmate closed this browser`, `This browser stopped after 30 minutes unused`, `This browser's page stopped working`, or `This browser was stopped when the task closed`.
The second line is `--text-sm` `--fg-2`: `Nothing it signed in to was kept`, or on a closed task `Its pictures are in the task's record`.
Then comes `Open again` (secondary Button), which starts a fresh browser at the last page with nothing signed in, and under it `A fresh browser, with nothing signed in` in `--text-xs` `--fg-3`; a closed task has no Open again.
Unavailable says why in the same place - `Four task browsers are already open on this computer. Stop one, then open this again.` or `This computer could not open a browser for this task right now.` - and keeps Open again for a later try.

**Never.**
The view never takes control by a click on the page, never sends what the captain types to the page while the captain watches, and never resumes the crewmate but by Return control; Hide, Esc and paging away change nothing about the browser or who holds it.
Watching keeps the browser from stopping for being unused: its half hour starts again when the view is put away.
