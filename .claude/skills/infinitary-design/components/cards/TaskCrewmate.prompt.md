A task's Crewmate tab: its crewmate's own session read as a CLI agent's transcript, and a prompt under it whose line steers the crewmate (the captain's Approve and build on FI3-1419, direction A; the app's `docs/task-card-tabs.md`).

**Where it sits.**
It is one of the task card's tabs (`TaskRecord.prompt.md`, "Tabs"): a shell-held entry on the card stack that replaces the record or the browser view in the same place, one entry per task, never persisted or emitted as a card.
It takes the stage's full width, up to 1040 px, on the stack's ordinary surface (`--bg-2`, `--line-1`, the card shadow), and it fills the card's height: the transcript scrolls between the chrome and the prompt.
In a short card the transcript gives up its room first, down to one line, then the title and tabs scroll away with it behind the top row.
The top row, status line and whole prompt stay in sight, with no selected-tab underline peeking below the top row.
Reaching a tab by keys scrolls it back into view; a card too short even for the top row and foot scrolls as a whole.
The foot has `--space-2` bottom padding so it fits the smallest window with a tall input to the first mate.
Its chrome is the record's own - the status pill and its reason, the task key, Maximize and Hide, the title - with the tab strip under the title and `Crewmate` selected.
The first mate's input stays under it with the task's key attached, as for every shown task card.

**The dialect is Claude Code's** (the captain's choice, built in, no setting).
The transcript is `--font-mono` `--text-sm` at line height 1.6 in `--fg-2`, on one grid: a 16 px mark column, `--space-2` apart, then the line, starting 20 px in from the card's edge with everything else the card draws.
The marks are drawn in SVG, never typed: a 6 px dot before each thing the crewmate said or did, a 12 px elbow before what a call answered, and a mono `>` before each line it was sent.
A mark is `--fg-3`; it takes `--hot` on a call that is running and on the words the crewmate is writing now, `--captain` before the captain's own line, and `--danger` beside a stopped or failed turn.

**Its lines**, oldest at the top, each a `--space-2` above the one before:

- The brief, `>`: `The brief` in `--fg-3` and `open`, a fold that opens to the whole brief.
- The crewmate's words, a dot: in the UI face, `--text-base`, `--fg-1`, wrapping as written.
- A call, a dot: the tool's name in `--fg-1`, its target in parentheses in `--fg-2` (a path in the working copy relative to it, a command, a page), then the line the crewmate wrote with it in `--fg-3`, one `ch` apart.
  Under it, an elbow and what it answered: its first line in `--fg-3`, then `·` and a fold, `+11 lines`, in `--accent`, which opens the whole text in a `--bg-1` panel, `--radius-s`, `--text-xs`, kept to 320 px and scrolling inside.
  An error's first line is `--danger`; a call that has not answered reads `running…` in the running turn, else `no result`; one that answered nothing reads `no output`.
- An edit or a write: the elbow reads what it changed, `Added 3 lines, removed 1 line`, and its fold opens the diff: a `--line-1` box at `--radius-s`, `--text-xs`, each line marked `+ ` in `--ok` on `--ok-dim`, `- ` in `--danger` on `--danger-dim`, or two spaces in `--fg-3` for a line it kept; separate edits sit a hairline apart, and past 80 lines the rest are counted.
- A picture a call answered with, under its elbow: up to 240 px tall on `--bg-1` with a `--line-1` border at `--radius-s`, whole; a press shows it at its own size and another press brings it back.
- A line it was sent, `>`: the captain's in `--fg-1` after a `--captain` mark, the captain's words alone; the first mate's and the app's after the micro label `FIRST MATE` or `FROM THE APP`, their first line with a fold to the rest.
  A captain's line the crewmate has not taken yet ends in `queued`, `--text-xs` `--warn`.
- The app's own tools as blocks, a dot then a `--line-1` box at `--radius-m`, `--space-2` by `--space-3`, in the UI face at `--text-sm`, its label the mono micro label in `--fg-3`:
  - `PLAN · 2 OF 4` with the note's words in `--fg-1` and each item with the record's own plan mark (a check, a lit ring, a hollow ring, a dash), or `PROGRESS` alone for a note with no plan;
  - `REPORT · open` with its headline in `--fg-1`, opening to the whole text;
  - `CARD`, with how it ended once it closed, its title in `--fg-1`, and Show the card, a small secondary Button, while the stage holds it or once it closed (the past card);
  - the pull request's noun, its label as a link in `--accent` before the title it opened with, and its checks with the fact strip's dot and words while the work is live.
- `You stopped its turn.`, `Your first mate stopped its turn.`, `Its conversation was shortened to fit.` and a failed turn's words, each a note in the UI face, `--fg-3`.
- The words the crewmate is writing now, last, a `--hot` dot, in the face of its words, ending in a still `--hot` block a half `em` wide.

Nothing else shows: never its thinking, a system prompt, a sign-in, usage or token counts, or the client's own notices.
Past 1,500 lines the earliest are counted in one quiet line at the top.
It follows its end while the captain reads there, and stays where the captain scrolled otherwise; opening a fold keeps the captain's place.

**Under the transcript**, a `--line-1` hairline, then:

- The status line, mono `--text-xs` `--fg-3`: a `StatusDot` and the state - `Working…` in `--hot` with the turn's age (`12s`, `4m 05s`), the `⌃C` KeyCap and `to interrupt`, then `Stop` as an `--accent` text button (`Stopping…` while it goes); `Paused · you hold its browser` (`captain`); `Waiting on you` (`warn`); `Idle` (`idle`).
- The prompt: a box at `--radius-m` on `--surface-input` with a `--line-1` border, the hairline and focus ring taking `--line-2` and `--focus-ring` while it is focused; a mono `>` in `--accent`, the shared message field at `--text-sm` growing to six lines or to the room the card has left, then scrolling inside, and `to the crewmate · ↩` in `--text-xs` `--fg-3` at its right.
  Notes made with Point at on the task's running page wait above the box as queued notes (`TaskBrowser.prompt.md`, "Point at"); while any wait the caption reads `Send 1 note · ↩`, and Enter sends them with whatever is typed, or alone.
  Its placeholder reads `Tell the crewmate something; it hears it at its next step` while a turn runs, else `Tell the crewmate what to do next`.
  A refusal is one `--danger` `--text-sm` line under it; the draft stays.

A closed task reads as it ran: no status line and no prompt, only `This task is closed; its session reads as it ran.` in `--text-sm` `--fg-3`.

**Keys.**
The transcript is one Tab stop that scrolls by the arrows and the page keys, with `--focus-ring-inset`; each fold, Show the card, a picture and Stop are Tab stops after it, and Enter or Space presses them.
In the prompt, Enter sends, ⌃C stops the running turn, and Esc hides the card as it does anywhere on a task's card.
The dictation key records into the prompt while it has focus, the dictation mark under it (`../voice/VoiceInput.prompt.md`, "Dictating into another field"); Esc then abandons the recording first, and the card stays.
Show Crewmate in command search shows this tab (`docs/keyboard.md`).

**Words.**
The tab's name is `Crewmate`, the captain's word for it.
Every other word it shows is in `CREWMATE_WORDS` (`src/shared/crewTranscript.ts`), plain and sentence case; the tool names and targets are the things themselves, in mono.
