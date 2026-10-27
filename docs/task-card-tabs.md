# The task card's tabs

A task's card has tabs: Info first, then Crewmate once a crewmate has run the task, then one Browser tab for each page the task's browser holds.
The captain chose the direction on the prototype card FI3-1419: one card per task, a strip under its title, the stage's existing surfaces re-homed rather than a new one, and a Crewmate tab that reads like a CLI agent's session and whose typing steers the crewmate.

## What is on the strip

`TaskTabStrip` (`src/renderer/src/cards/TaskTabStrip.tsx`) draws a tablist under the task's title on the record, the Crewmate tab and the browser view.
Its tabs come from the task's browser fact and whether a crewmate has run it (`taskTabsOf`, `hasCrewmateTab`, `src/renderer/src/cards/taskTabs.ts`):

- `Info` is the record, as it always was: Now, Progress, the Browser line, the body, and the footer with its fact strip and action bar.
- `Crewmate` is the crewmate's own session (below, "The Crewmate tab"), on every task a crewmate started (`startedAt`), open or closed.
- `Browser · <page title>` is the browser view; a page with no title reads `Browser`, and a stopped browser's tab reads `Browser` and says it stopped as the view does ("The view" in `docs/task-browser.md`).
  The site is not in the tab, since nearly every page is a localhost port; it stays in the view's own row and foot line.
- A browser that holds a second page has a second Browser tab, one per page in the order they opened (`browserTabLabel`, `src/shared/taskBrowser.ts`).

A task with nothing but Info - one no crewmate has started, with no browser - draws no strip.

## One entry per task

The record, the Crewmate tab and the browser view are three shell-held stack entries that replace each other, so a task has one entry on the stack.
`openRecord`, `openCrewmateView` and `openBrowserView` each take the task's other tabs out of the stack (`src/renderer/src/app/store.ts`).
The tabs, the record's `Open`, the view's `Task record` link, a card's door to the browser and a task row on the Tasks panel all go through them.
Info keeps its populated document while another tab of that same task is selected, so returning does not recreate its sandbox or repeat its initial reads and readiness frames.
The stage parks it invisibly and inert, preserves its subscriptions and reading position, and releases it when another task or card is selected or the task card is hidden.
Initial opening still waits for populated frame readiness; returning never reveals an empty replacement.
Tabs of the same task crossfade; replacing a tab does not play the longer entrance for closing a whole card.
Hide or Esc closes the task's card whichever tab is shown, and the card behind it comes up.
The record keeps its own width; the Crewmate tab and the browser view take the stage's full width.
All three draw the record's own top (`RecordPaneChrome`): the status pill and the key with the size control and Hide in the card's corner, the title, then the strip, so Hide is in the same place whichever tab is shown.
Each shown tab points the first mate's turn at its task, as the record does.

Another page than the browser's current one is the controller's to pick, as navigation is (`docs/task-browser.md`, "The view").
While the captain only watches, those tabs are disabled and the current page's tab is selected.

## From a card

A card about a task is another way in (INF-358): the task's key in its head opens the record in front of the card (`docs/card-authoring.md`, "Task keys"), Show Info does the same by name, and Show Crewmate and Show Browser open the task's other tabs from the card where it has them; a card about no task refuses them with "This card is not about a task".
A card's live attachment opens the browser view the same way (`docs/task-browser.md`, "From a card").
The entry carries the card it came from (`EntryFrom` on the record, the Crewmate tab and the browser view, `src/renderer/src/app/store.ts`), and the task's next tab keeps it (`goToTab`), so Hide or Esc on any of its tabs returns to that card while it is still shown; once the card is gone, Hide reveals as any record does.
A tab opened from a Tasks row, a board tile or a key in a body names no card.

## The Crewmate tab

`CrewmateView` (`src/renderer/src/cards/CrewmateView.tsx`, its lines in `CrewmateLines.tsx`) draws the crewmate's own session as a transcript in Claude Code's shape, the captain's choice of dialect: a dot before each thing the crewmate said or did, an elbow before what a call answered, and a `>` before each line it was sent.
The marks are drawn, never typed glyphs; there is no setting for the dialect.
Under the transcript sit a status line and a boxed `>` prompt (below, "Typing").
In a short card the transcript gives up its room first, down to one line, then the title and tabs scroll away together with it.
The top row, status line and whole prompt stay in sight; reaching a tab by keys scrolls it back into view.
The middle starts at its end without scroll anchoring, and the card scrolls as a whole only when its top row and foot alone cannot fit.
The prompt grows to six lines or to the room the card has left (`useFootRoom`), then scrolls inside, and the transcript keeps its newest line in sight as it shortens.

It reads three things and stores nothing:

- `tasks.crewmate` (`inf:tasks:crewmate`) is the transcript: `CrewTranscripts` (`src/core/tasks/crewTranscript.ts`) reads every session in `crewmates/<task>/sessions/` through the one session reader, following each as it grows (`SessionFollower`, `src/core/storage/sessionReader.ts`), with the Claude client's own file standing in for the app's copy while it holds a turn's tail, as Activity does (`docs/task-record.md`, "A crewmate's actions").
  A transcript whose sessions and record did not move is the same one, and the read is not delivered again (`revision`); it re-reads on the task's events, on each call's start and end and at each turn's end, and each second while it shows, since a call's result lands in the session after the call's own event.
- `tasks.crewmate.live` (`inf:tasks:crewmate:live`) is what the crewmate is writing now that its session does not hold yet, and when its running turn began: `CrewLiveText`, fed at the `broadcastEvent` seam and cleared at each call and each turn's end, and the supervisor's own turn clock.
  It is the product's own buffer, in every build: Observe's stays behind Observe's own gate (`docs/dev-observe.md`).
- `tasks.detail`, for the chrome, the status line, the cards a card block names and the pull request a change block names.

The transcript's lines (`CrewLine`, `src/shared/crewTranscript.ts`):

- The brief, the session's first prompt, folded to one line that opens to the whole brief.
- The crewmate's own words, in the app's face.
- Every call to a tool, in two lines: the tool's name, its target - a path in the working copy relative to it, a command, a page - and the line the crewmate wrote with the call, then what it answered, folded to its first line and a count a press opens.
  A task command such as `infinitary-browser-axi` names only what it was asked to do (`infinitary-browser-axi fill`, `taskCommandShown`), never its other words, which may hold what a crewmate typed into a page (`docs/axi-commands.md`).
  The whole text is read on its own when the fold opens (`inf:tasks:crewmate:result`), so a long session's transcript stays small.
  A call with no answer reads `running…` in the running turn, else `no result`.
- The app's own tools as blocks: a progress note's plan, a report with its headline that opens to its whole text, a card it put up with Show the card once the stage can show it or once it closed, and the pull request it opened, with its label and page from the record and its checks while the work is live.
  Show the card follows the shared `onStage` rule: a new card awaiting close-out has no button, while a replied-under card stays reachable; a minimized or collapsed card can still be brought back.
  Every other call to the app's own tools reads as a call.
- What an edit or a write changed, drawn from the call's own arguments (`diffOf`): each replacement as the lines it took out and put in, with up to two lines it kept on either side, and a new file as its lines, bounded at 80 lines and the rest counted.
- A picture a call's result holds - the browser's photograph of a page, a picture the crewmate read - shown small under the call, larger on a press; the transcript names it by ref and its bytes are read only when it shows (`inf:tasks:crewmate:picture`).
- Each line it was sent, by who sent it, told apart by the record's own `steered` events, whose text is the steer's whole text: the captain's own words alone (`SteerEventData.words`), the first mate's line, or one line from the app for a wake no steer names.
  A line the captain sent that the crewmate's session does not hold yet reads `queued` at the end, until a prompt carrying it reaches the crewmate; a closed task's never does.
- Where a turn was stopped and who stopped it, from the record's `interrupted` events, a compacted conversation, and a turn the model could not finish.

It never shows the crewmate's thinking, a system prompt, sign-ins, usage or token counts, nor the client's own notices (a background command finishing, `[Request interrupted by user]`); every string is redacted as an Observe line is (`redactObserveText`).
The transcript keeps its newest 1,500 lines and counts the rest.
It follows its end while the captain reads at its end, and stays where the captain scrolled otherwise.

The status line reads where the crewmate stands, from the task's typed state (`crewStateOf`, `src/renderer/src/cards/crewmateState.ts`): Working with the running turn's age, `⌃C to interrupt` and Stop; Paused while the captain holds its browser; Waiting on you while a card of its waits on the captain; Idle; or nothing on a closed task, which keeps its Crewmate tab as a read-only replay with no prompt.

## Typing

The boxed prompt is the captain's direct door to the crewmate: Enter sends the line as the captain's steer on the crewmate's own lane (`window.infinitary.task.steer`, `inf:task:steer`), the path a reply under its card takes (`docs/card-threads.md`), never a first mate turn.
`CrewSupervisor.steerFromCrewmateTab` refuses in words, writing nothing, when no crewmate can be told anything: an empty line, a task not started, a closed one.
Otherwise the steer is a typed wake (`crewmate-tab-line`, `CREWMATE_TAB_STEER_LEAD` then the captain's words verbatim), recorded as a `steered` event with `via: "crewmate-tab"` (`CREWMATE_TAB_VIA`, `src/shared/provenance.ts`) and the span of the captain's words, which Activity reads as `You told the crewmate: ...`, and one task-less feed line (`toldInCrewmateTabLine`).
The first mate reads it on the task's timeline.
When the line passes one of the app's holds or tells the crewmate to go on without asking, the crewmate relays it with `needs_firstmate`, and the first mate records it as the captain's override with `from` as `crewmate-tab`, the words read from that steer (`docs/delivery-rigor.md`, "The holds").
A Pi or Claude crewmate takes it at its next step inside the running turn; an idle one takes it as a new turn.
A refused line keeps its draft and says why under the prompt; a draft also survives the card hiding and showing again, in memory only.

⌃C with the prompt focused, or Stop in the status line, is the captain's interrupt of the running turn (`inf:task:interrupt`, `CrewSupervisor.interruptFromCrewmateTab`), on the path the first mate's `interrupt_crewmate` takes: the task stays active and steerable, the interrupt is an `interrupted` event with `via: "crewmate-tab"`, and the turn's end writes the feed line every interrupt does.
With no turn running it refuses.
Esc still hides the card; every other key in the prompt is the prompt's own.
There are no slash commands, no shell and no file editing.

## Keys

The strip is one Tab stop: the selected tab holds it, the arrows, Home and End move focus between tabs, and Enter or Space shows the focused one.
A tab a key chose takes focus again on the strip the swap draws, with its ring (`askTabFocus`).
Five window commands in the catalog drive it, with command search and no default key (`docs/keyboard.md`): `cards.show-info` (Show Info), `cards.show-crewmate` (Show Crewmate), `cards.show-browser` (Show Browser), `cards.next-tab` (Next tab) and `cards.previous-tab` (Previous tab).
Each view lends its strip while it is mounted (`lendTaskTabs`), keyed by the tab it draws, and the commands act on the shown entry's own strip (`shownTaskTabs`).
While the shown view's own read has not answered it has no strip yet, so they take the task's tabs from another view's strip, including one that left a moment ago, and work out the place and the way to a tab from the shown view; an outgoing view's strip never speaks for the shown one.
They refuse in words when the shown card has no strip, no such tab, or no other tab to go to (`tabRefusal`, `src/renderer/src/app/commandRefusals.ts`).
On a card about a task, Show Info, Show Crewmate and Show Browser open that task's tab in front of the card ("From a card"); Show Crewmate refuses while no crewmate has run the task, and a card about no task refuses all three.
Inside the Crewmate tab the transcript is one Tab stop that scrolls by keys, each fold, Show the card and Stop are Tab stops, and the prompt takes Enter to send and ⌃C to interrupt.

## Tests

`src/core/tasks/crewTranscript.test.ts` holds the transcript to both dialects, the senders, the queued line, redaction, pictures and diffs; `crewmateState.test.ts`, `taskTabs.test.ts` and `store.test.ts` the window's side; `crewSupervisor.test.ts` the steer and the interrupt.
`tests/e2e/task-crewmate.spec.ts` replays a closed task's session by keys (folds, a diff, a picture, the blocks, Show Info and Show Crewmate), types a line a mock Claude crewmate takes mid-turn and reports on, and stops a turn with ⌃C; `tests/e2e/task-browser.spec.ts` walks the three kinds of tab.
