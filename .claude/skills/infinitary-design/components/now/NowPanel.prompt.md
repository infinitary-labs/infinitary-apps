The now panel: what IS, as the `Now` panel of the right side rail (the activity feed on the left says what happened).
When expanded, it has no waiting/working counts line: the host title row carries the panel's two header buttons, a dim search icon and the Open task board icon, beside the title and collapse button (`components/panel/Panel.prompt.md`, "Header buttons").
Their accessible names and tooltips are "Search tasks" and "Open task board".
The list starts below that row with rows for "waiting on you", "working" and "queued", and two collapsed groups that show only their count until clicked: "backlog", "done · 7d".
The order is nearest to happening first: waiting on you, working, queued, backlog, done · 7d.
Queued is open work that starts by itself when nothing holds it (start policy when ready), and a task that is starting until its crewmate begins; backlog is open work that waits for the captain's word (start policy on request).
A blocker or a hold never moves a row between them: it is the row's one dim word and its status reason.
The task board opened from the panel (`TaskBoard.prompt.md`) names its row and columns with the same five words.
Empty groups are absent.
When collapsed, the host header draws what the panel says it holds, `N waiting · N working` (`Panel.prompt.md`, "The collapsed summary"), and Open task board beside the chevron; Search tasks is drawn only while the panel is expanded.

Waiting on you means a live task has a reachable ready decision: `waitingCardId`, not the broader `flags.needsYou` attention flag.
Hidden replies, Working cards, notes, no-card holds, dead dependencies and closed tasks do not create a waiting row or compact count.
A ready decision behind another card counts because its task can bring it forward.
Count each task once.
A waiting child separates into Waiting on you while its nonwaiting parent and siblings keep their existing working grouping; do not duplicate parent context or add row decoration.
Working lists a working task's live tree beside it: its parent and the parent's other open parts.
A finished part - a done review, plan or piece of work - stays under done · 7d, never in Working, and finished work does not hold a tree together.

A row is a shared task status mark, the task key in dim mono at the start of the title, the title (one line, ellipsized), and, when space permits, the project name in dim mono at the end (ellipsized; the trailing track is `fit-content(40%)` so short names size to content and long names cap at 40%).
Hide the project name and its grid track when the panel content is 320px wide or less, or when exactly one registered, non-archived repo project exists (Scratch and archived projects do not count).
A task another computer runs adds where after the project name, `website · on Mac mini`, and while that computer is out of reach the line ends `out of reach` in `--warn`, and while its connection is being made it ends `connecting` in `--fg-3` with no warn mark (`../devices/RunsOn.prompt.md`).
A part that does not fit leaves whole, the project name first and then the place; `out of reach` always stays, so the narrow panel keeps the track for those words alone.
Count from the full board, not the visible-task filter.
The row keeps the full project name in its accessible label; the preview shows it, and the row has no hover title.
A blocked or held row carries exactly one dim word after the title; a child row indents under its parent when both belong to the same group.
The task key also stays on hover, search, and the row locator.
The shared mark, word and reason follow the Shared task status rule below; group membership is not a status.
Nothing else in the rail: no chips, meters, models, or ages - everything richer hides behind a rest (the crew summary, Row hover below) or a click (the record).

```jsx
<NowPanel counts={{waiting:1,working:2}} groups={{
  waiting:[{id:"a",key:"FM3K-12",projectName:"infinitary",title:"Which project should take this?",group:"waiting",tone:"ok"}],
  working:[{id:"b",key:"FM3K-9",projectName:"infinitary",title:"Refactor the auth middleware",group:"working",tone:"warn"},
           {id:"c",key:"FM3K-10",projectName:"infinitary",title:"Add the retry test",group:"working",tone:"ok",depth:1}],
  queued:[{id:"d",key:"FM3K-11",projectName:"Scratch",title:"Publish the release notes",group:"queued",tone:"ring",word:"blocked"}],
  backlog:[{id:"e",key:"FM3K-13",projectName:"infinitary",title:"Write the release checklist",group:"backlog",tone:"ring"}]
}} onOpen={(t)=>openRecord(t.id)}/>
```

Clicking a row is a pointing gesture, never a write: a row waiting on you refreshes its ready decision and brings it to the front of the stack (or opens the record if no eligible choice remains); any other row opens the task's record (`TaskRecord`) as a front entry in the main card stack, shown at once.
One entry per task can remain open; each row reads selected while its record is open, even when paged away (FI3-309, replacing the gutter pane).
Open task board in its header shows every task at once on the stage (`TaskBoard.prompt.md`).
The panel has no buttons that change a task, no drag, no inline editing, no manual create - the record's action bar carries Drop task and the one next step (`TaskRecord`), and every other write happens by talking to the first mate.
The filter (a key/title search and project chips) sits behind the search icon and is the panel's own state.
Close search sits 6px right of the field: a 24px icon button with Lucide `x` at 14px in `--fg-3`, the next stop after the field, labelled "Close search" with the key Esc.
Search tasks still opens and closes the filter, and Find a task (⇧⌘F) still opens it with the caret in the field.
Esc in the filter empties the words, and a second Esc closes it, as the task board's Find does.
Closing the filter by Close search, Esc or Search tasks lets go of the words and the project chip, so every task shows again; a filter that is closed never narrows the list.
The field draws no clearing cross of its own: Esc and Close search do that job.
The filter keeps the reach of the focus ring's glow (18px) clear on every side, because the panel's frame cuts whatever is drawn past its edge.
The search ignores case and reads a curly apostrophe or quote in a title as the plain one a keyboard types, so `what's new` finds `What’s new in …`.
Chips keep the project key as the filter handle; row chrome uses the display name.
Group headers are the design system's micro labels; a collapsed group's header carries its mono count (the two open groups are already counted on the header line).
Queued and backlog also count crew-filed rows the captain has not opened, as ` · N new` beside the count, and such a row's one dim word is `found on <key>` unless it is blocked or held.
A collapsible header ends with the host panel expand chevron: the same 14px down stroke the rail uses to collapse a panel, in `--fg-2`, turned 180° so it points up while the group is collapsed and down while it is open.
In the app this is a Tier-2 frame template (`src/renderer/src/plugins/builtin/now/`), not this JSX; the look is the same, and with nothing to show there is no panel and no rail.

## Earlier work in the filter (FI3-579, piece 3)

Typing in the filter also searches work the panel does not list: closed work older than seven days, and dropped work of any age.
Matches are by key, title and goal, never by card or report text.
Nothing earlier is listed until text is typed; clearing the field removes the group at once, and the normal groups (and their seven-day window) are unchanged.
Matches appear as one more group labelled `earlier` after `done · 7d`, open (it exists only while text is typed), with the same row, status mark and accessible label as any row, newest closed first, at most 50.
A row opens the task's record exactly as any row does, including an answer or decision record the first mate owns.
The project chips narrow earlier matches like any others; a query matching nothing shows no group.
The panel stays read-only: this is a pointing gesture, never a write.

## Shared task status (FI3-565, direction A, piece 1)

All task rows, crew summary heads and record pills read one status, mark and reason.
A row, a board tile, the summary and the record header do not add a second tooltip for that status, because the words are already shown; a standalone mark still names itself.
The words are Backlog, Queued, Starting, Working, Idle, Interrupted, Waiting on you, Done and Dropped.
Starting is the still open cyan ring, used only while a start is being prepared, and it is not Working.
A confirmed manual start that did not begin reads Backlog · Could not start, and the Tasks row adds the dim word could not start.
Open work reads by its start policy, as the panel groups it: Backlog waits for Start, Queued starts by itself.
A blocker, a hold or a parent's parts is the reason beside the word, never another word: `Queued · Blocked by another task`, `Queued · Held`, `Backlog · Its 2 parts do the work`.
Open, working or idle work whose computer is out of reach keeps its mark's shape in `--warn` and reads `Idle · Mac mini is out of reach`; while its connection is being made it keeps its mark as it was and reads `Idle · Mac mini is connecting`, with no warn mark; either way, unless a blocker, a hold or its parts give the reason (`../devices/RunsOn.prompt.md`); Interrupted, Starting and Waiting on you keep their own.
Keep rows otherwise minimal.

Marks occupy a fixed 12px square, using a 16-unit viewBox: Backlog is a hollow circle, Queued adds a central dot, Working/Idle/Interrupted are filled circles in ember/cyan/lava, Waiting on you is an accent dot inside an accent ring, Done is a neutral check, Dropped is a tertiary cross.
Starting is a still open ring, cyan on the arc and neutral on the rest, with no spin.
Shape carries lifecycle, not just color.
All three surfaces use these same marks without animation.
Tooltips and accessible labels say the status followed by its reason.
The summary and record show that reason beside the status; existing posture phrases become reasons, not extra statuses.
Closed lifecycle wins over old activity; a reachable ready decision wins over activity on live work; evidenced continuing work wins over interruption, otherwise interruption wins over idle.
Unknown or paused posture stays Idle with an honest reason, never Working.
Stage geometry and color remain unchanged.
The action bar follows in a separate piece.

## Shared task facts (FI3-565, direction A, piece 2)

The crew summary and the task record read one set of task facts: status, task, Now, Progress, then the fact strip - model, intelligence, reasoning, the change, its checks, a review - with the model's reason under it, and the browser.
The summary draws them in that order, leaves the browser out, and adds a Project row under Task from the Tasks row's own project name, followed by where another computer runs it (`website · on Mac mini`).
The status, the task title and the project wrap in full; the other summary facts stay one line.
The task record draws the same values in the same order, keeps the browser line with Now and Progress, and places the fact strip just above its action bar, after Goal and your words, Activity and Details.
A smaller surface shows fewer of them, never different ones; the Tasks row stays a mark, key and title.

- **Now** is the newest row of the record's Activity, of any kind (an opened pull request, a checks reading, a report's headline, a progress note), in Activity's own words, with that row's short age (`now`, `2m`, `3h`, `1d`, mono `--text-xs` `--fg-3`) at the line's right edge and the absolute time on hover.
  Where its words name the task's pull request, the record links them (`../cards/TaskRecord.prompt.md`, "Pull request links"); the summary keeps them plain.
  Absent when the record has no row.
- **Progress** (FI3-734, the captain's Build it on the steps-view preview) is the plan the crewmate reported last with a progress note: a short, high-level list of what the task takes, each item done, current, next or skipped, as declared.
  Its label is `Progress`, so the side label column is 66px on both surfaces.
  Every note after the first list must carry the whole list, unchanged if nothing moved.
  The line’s right edge shows the newest list note’s short age, in Now’s mono `--text-xs` / `--fg-3` style, with its absolute time on hover.
  On the summary it is one line - the count in mono (`2 of 4`, then `· 1 skipped` when any item was) and the full name of the current item (`All done` once none is left) - and under it, 8px lower, one dot per item on a line across the panel: filled `--fg-2` when done, an `--accent` ring on `--accent-dim` when current, a hollow `--idle` ring when next, a `--fg-3` dash when skipped, the line `--line-2` and filled in `--fg-3` behind a finished dot, and the item's short label (`--text-xs`, the current one `--fg-1` medium, finished ones `--fg-2`, the rest `--fg-3`) centered under its dot, cut with an ellipsis, the full name on hover.
  Past eight items the finished ones before the newest finished one fold into one filled dot labelled `6 done`, their names on hover; a line that still holds more than eight dots staggers its labels above and below the line, each allowed two slots.
  On the record it is the same line, then the whole list under it, always open: one row per item with the list marks (a check, a lit ring, a hollow ring, a dash), a `--line-1` hairline behind the marks, the current item in `--fg-1` medium, a finished one with the short age of when it finished at the right edge, a skipped one followed by the dim word `skipped`; past eight items the same finished ones wait behind `Show earlier · N`, as Activity's do.
  Absent when the crewmate never sent a plan; a closed task keeps its list on the record and its summary draws none.
- **The fact strip** (FI3-1159, the captain's layout B) is the merge card's strip in the window's own type, so a task's facts read the same on its record, its summary and its merge card: one cell per fact, each an uppercase micro label over a one-line value 5px under it, the cells `--space-4` apart, wrapping whole with `--space-2` between rows, under a `--line-1` hairline with 10px above and below it.
  Its cells, in order: MODEL, INTELLIGENCE (the `SlotBadge`), REASONING (in words); then PULL REQUEST, the change by the label its host gave it (`#612`; BRANCH and the branch's name on a plain Git host), a link where the host has a page and the surface takes clicks; CHECKS, the merge card's 10px state dot and word (`running`, `passed`, `failed`, `not read yet`, `merged outside the app`) with the reading's short age after a `·`, the absolute time on hover; and REVIEW, an independent review's dot and verdict (`passed`, `findings`, `blocked`) with its risk (`findings · risk high`).
  Under the cells comes the footnote saying why that model was chosen (`--text-xs`, `--fg-3`).
  A value the record cannot say leaves its cell out; the strip is absent until the task has a model, a change or a checks reading.
  A closed task names its change once, on its closing line, so its strip keeps only the review of the change.
  Every surface names a model through one lookup: its Settings → Models name, listed or by name, with a known OpenRouter maker prefix dropped, else its bare id.
  The label is "Model" wherever a model is a fact, including the decision card's fact strip.
- **Browser** is the task's own browser on this computer, on the record only (`../cards/TaskBrowser.prompt.md`): the site, who is driving or what stopped it, and `Open`, parted by `·`.
  The summary leaves it out, and it is absent while the task has no browser and on another computer.

Ages beside a fact are short (`2m`); a sentence keeps `2 min ago`.
Facts carry stable identities (`data-task-fact`), never their labels' words.

## Row hover (FI3-565, direction A, piece 3)

Resting the pointer, or the keyboard's focus, on any Tasks row - backlog, queued, working, idle, interrupted, waiting on you or done, and a row the filter found in earlier work - opens the crew summary (`components/mate/Crewmate`, Reading a crewmate) for that row's task: the same panel, the same shared facts in the same order and words, after the same beat (130ms).
The row gains nothing: it stays a mark, key and title.

## Blocked by (FI3-1680)

Recorded blockers also draw as quiet lines in a 36px gutter to the left of the rows, in addition to the rows' own padding.
The gutter appears only while a line is drawn.
Each line runs from the waiting row to its blocker, and the arrowhead sits at the blocker: that task finishes first.
Lines use `--fg-3` at low opacity.
The row the pointer or the keyboard rests on lights its lines in `--accent`.
One lane per blocker, at most three.
Further blockers draw only while one of their rows is inspected, and the summary still names every blocker.
A folded group, a filtered row, or a row clipped out of the panel draws no line to that end.
The summary names that key instead, and the key opens the existing record.
Order, groups and parent indentation stay as they are.
Resting on a row still does not slow the stage.

- **Placement.**
  Outside the Tasks panel, on the side facing the stage (left of a panel in the right rail, right of one in the left rail), 14px clear of the panel's edge, centred on the row.
  It stays inside the window under the top bar with 8px of air, and clear of the input and the other rail's panels: where one is in the way it rises above it, and where that side has no room at all it takes the other side.
  A `--line-2` hairline runs from the panel's edge at the row's middle to the summary.
  No corner brackets: the row's own hover surface (`--bg-3`) marks it.
- **Layer.**
  Above the rails and the card stack, never under them, so it reads the same with a record open.
  It never takes the pointer.
- **Moving and closing.**
  It comes and goes as on the stage (`components/mate/Crewmate`): resting on another row while it shows moves it there at once, with no second beat.
  It fades out over `--dur-summary-out` when the pointer or the keyboard's focus leaves the row, on Esc, on a press on the row, when the list moves under it (a scroll, a row arriving or leaving), when the window resizes or loses focus, or when the task leaves the list.
  Leaving another row closes nothing: focus leaving the row a click opened keeps the summary of the row the pointer rests on, and Esc then closes that summary, never the record under it.
  After Esc or a press it stays closed until the pointer leaves that row.
  Esc closes only the summary, never a record open under it.
  The press still opens the record or brings the decision forward, exactly as a click did before.
- **The stage is untouched.**
  Pointing at a row selects no crewmate, pauses nothing and slows nothing; a working row's crewmate keeps its orbit.
- **The same summary from a card.**
  A task key anywhere the app shows one opens this same summary (`../core/TaskKey`), and a click on the key opens the task as a click on its row does.

## Keyboard

The list is one Tab stop, and the arrows move through it (the app's `docs/keyboard.md`, "Lists and Settings").
The arrows ↑ and ↓ move between the rows and the headers of the groups that open and close, Home and End go to the ends, → opens a closed group and steps into it, ← closes an open one and goes up from a row to its header, and Enter opens the row's task as a click does.
The header of a group that is always open is a label, not a stop.
In the search, ↓ goes to the first match, and F6 brings focus to the row it was last on.
Closed from the keyboard (Esc, or Enter on Close search), the filter gives focus to the list's stop, the row it was last on.
Focus is the `--focus-ring` hairline and glow, drawn over whatever the row paints: a row whose record is open keeps its `--accent-dim` tint, so focus and the open task never read as one.
A row and a group header span the panel's frame, which cuts whatever is drawn past its edge, so each draws it inside its own edge (`--focus-ring-inset`).
A focused row scrolls into view, and opens its summary as the pointer's rest does.
