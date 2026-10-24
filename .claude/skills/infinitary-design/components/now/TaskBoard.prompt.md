# Task board

The task board shows every task the Tasks panel reads as a focused board: Waiting on you above the work not yet done in three columns, Backlog, Queued and Working, and the whole backlog, this week's done work, dropped work and older finds as short paged lists.
It never draws more than a page of a lane, so hundreds of tasks never make one long scroll, and every count is the whole lane's.
It is the Tasks panel opened wide, not a second place to work: the same tasks, the same five names, the same marks, words and reasons (`NowPanel.prompt.md`, "Shared task status"), a click that does what a row's click does, and moves that do what a record's buttons do.
In the app it is the Tasks panel's card (`PanelCard.prompt.md`), `src/panels/now/cards/board.tsx`; the behavior is `docs/task-board.md`.

## Where it opens

Open task board is a header button of the Tasks panel (`Panel.prompt.md`, "Header buttons": `open`, Lucide `maximize-2`, 14px, 1.5 stroke, `--fg-3`), between Search tasks and the chevron while the panel is expanded, and between the panel's counts and the chevron while it is collapsed, where Search tasks is not drawn.
Its label is "Open task board" with its key, `⌘B`, drawn after the words.
A press opens the board at the front of the card stack, or brings the open board forward; there is never a second board.
The board is a panel's card on the stack: it pages with the cards, it is never a card the first mate wrote or a feed line, and Hide (the × in the card's chrome) or Esc puts it away.
While it is open it keeps Find, view, each lane's page, selected tile and scroll across paging; after Hide the next board starts fresh on the Board view.
Its project chip is the window's project focus (`components/core/ProjectFocus`), so it opens on the focused project and Hide keeps it.
It is a wide card of `fill` height: up to 800px, giving way to the docks like any wide card, the docks folding only when the stage is under 560px, and as tall as a card may be.
Under about 700px the columns scroll sideways with the body; text never shrinks.
The first mate's input stays under it.

## Anatomy

The surface is the card stack's own, as tall as a card may be, under the panel card's one row of chrome, Tasks and Hide (`PanelCard.prompt.md`); the board's own rows stay while its body scrolls inside.

- **Its row**, over a `--line-1` hairline: the count of every task in Waiting on you and the four lanes of work in mono `--text-xs` `--fg-3`, the project chips, and Find at the right.
  Chips are pills in mono `--text-xs`: All projects, then each project's key, shown only when two or more projects have tiles; the pressed one is `--accent-dim` with an `--accent` border.
  Find is a small input ("Find a task") that narrows this board alone by key or title, never the panel; the chip and Find narrow every lane before it is paged.
- **The views**, over a `--line-1` hairline: Board, Backlog, Done · 7d, and Earlier matches only while Find has words - text buttons in `--text-sm` `--fg-2`, each list's whole count after it in mono `--text-xs` `--fg-3` (Backlog also `· N new` for crew filings not yet opened, Earlier matches a `+` when the search may have been cut); the pressed one is `--accent-dim` with an `--accent` border, `--fg-1`.
  Board opens first.
- **Waiting on you**, above every view: its micro label and count, "Cards waiting for you" in `--text-sm` `--fg-3` at the right, and Show all N while more than three wait; then at most three one-line rows (as a list's rows), or "Nothing waits on you".
  Show all N opens its own list, where these rows are not drawn again.
- A `--line-1` hairline.
- **Board**: three columns, Backlog, Queued and Working, `--space-3` apart, each after the first with a `--line-1` rule on its left: a micro label and mono count, then a page of five tiles `--space-2` apart, or one quiet line: "Nothing in the backlog", "Nothing queued", "Nothing working".
  Over a hairline at a column's foot, once it has a second page: its range ("6–10 of 12") in mono `--text-xs` `--fg-3` and Previous and Next.
  Five is a page, never a limit on running work.
  Columns sort by priority then oldest first.
  Done · 7d is not a column; its view button opens it as a list, newest first.
  A child sits under its parent, indented `--space-3` per level, only when both are in the same lane.
- **A list** - Backlog, Done · 7d, Waiting on you, Dropped · 7d (with "Read-only"), Earlier matches: its micro label and count with Previous and Next at the right, a page of twenty one-line rows, then over a hairline its range ("21–40 of 300") and Previous and Next again; the rows scroll between head and foot while the list has the room.
  Earlier matches may carry one `--text-sm` `--fg-3` line under its head: looking for earlier tasks, that the search stops at its newest matches and narrower words help, or that earlier results are unavailable right now.
- Previous, Next and Show all are small quiet buttons, `--text-sm` `--fg-2` with a `--line-1` border and `--radius-m`, `--bg-3` on hover; at a lane's end Previous or Next stays, at half opacity, so focus stays on it.
- **Foot**, over a hairline: Dropped · N at the left (a quiet text button, `--fg-1` while its list is shown), the Drop task tray beside it only while a tile is in the air, and the key hint at the right, "Arrows move · `Enter` opens · `Space` menu", in `--text-sm` `--fg-3`.
- **Live line**, under the foot: what the last move did or why it was refused, `--text-sm` `--fg-2`, `--warn` for a refusal (`role="status"`, read once); no height while empty.

## A tile

A tile is `--bg-1` with a `--line-1` border, `--radius-m`, `--space-2` by `--space-3` of padding, `--bg-3` on hover:

1. The shared status mark and the key in mono `--fg-2`, then one dim word after a `·`: blocked, held, urgent (top priority, in `--warn`), found on KEY, or part of KEY (a child standing alone in another column than its parent); and, while All projects shows and the tile is at least 200px wide, the project's name in mono `--fg-3` at the right edge.
2. The title in `--text-base` `--fg-1`, two lines at most.
3. The status word in `--fg-2` and its reason in `--fg-3`, `--text-sm`, two lines at most and whole on hover or focus; the word alone when the reason would repeat it.

A tile that can move carries the ⋯ menu (RowMenu's 24px kebab, `--bg-3` behind it) at its top-right corner, shown on hover or focus over the head's right end, and the `grab` cursor; Done and Dropped tiles have neither.

No model, age, picture or priority badge: the crew summary opens on a rest, the record on a click.
The selected tile is `--accent-dim` with a `--line-2` border, as an open Tasks row is tinted; focus is the `--focus-ring` drawn over it, never the tint.

A **row** of a list or of Waiting on you is the same face on one line with no card around it: the head (mark, key, word, project) in a 12rem column, the title on one line, then the status word and reason on one line in a column of up to 14rem, `--space-1` by `--space-3` of padding, transparent until hover (`--bg-3`) or selection.
Its ⋯ menu sits at its right end, centred; under 560px the rows stack the head, title and status.
A child whose parent is on another page stands alone there with "part of KEY".

## Gestures and keys

A click or Enter opens the tile's task as a Tasks row does: its waiting card comes forward, or its record opens at the front.
Resting on a tile, with the pointer or the keyboard's focus, opens the crew summary beside the tile after the usual beat, with the same hairline (`NowPanel.prompt.md`, "Row hover").
A rest on the same task elsewhere lights its tile at once with the tile's hover surface only (`--bg-3`): no summary, and the status reason keeps its two lines, so nothing moves (`NowPanel.prompt.md`, "The lit row").
The tile focus is on is the selected one, and while the board is shown it points the first mate's input turn at its task, as a shown record does.

The tiles and rows are one Tab stop after the board's own row and views: ↑ ↓ within a lane and onto its other pages, Home and End to the lane's real ends, turning its page and bringing the tile into view, ← → to the nearest drawn tile in the next column that has one, ↓ from Waiting on you's last row into the first column and ↑ from a lane's top back to it.
Space opens the tile's ⋯ menu.
Esc closes the menu or the summary, then lets go of a move that asks, then clears Find, then hides the board.
Find on task board, Show the backlog, Show done tasks, Show dropped tasks and Move the selected task are found by name in command search.
When a live change takes the focused tile away, focus goes to the task where the view draws it, or the nearest row, and the live line says where it went.

## Moves

A tile on the Board moves by dragging it onto a column or the Drop task tray, and any tile or row from its ⋯ menu; a list's rows are never dragged, so a row of the Backlog list moves by its menu, and nothing is dragged between views.
Every move is a record's own button (Start, Drop task) or the board's queue and unqueue, and none changes priority, order, project, parent or dependencies.
Backlog (or Back to backlog) takes never-started work at once; Queued (or Queue it) takes it at once while a blocker or hold stands, and asks once when it could start at once; Working (or Start now) is the record's Start and asks once; the tray is the record's Drop task and asks once in its words; Waiting on you never takes a drop.
Show the card, on a waiting tile's menu, brings its card forward, a completion card included, and only the card's own button merges.

- **Dragging**: a press becomes a drag after 5px; a ghost of the tile (`--bg-2`, an `--accent` border, `--shadow-2`) follows the pointer and the tile itself stays at 40%.
  Every lane that takes it is tinted `--accent-dim` with a `--line-2` hairline; the one under the pointer gets an `--accent` hairline, and one that refuses a `--warn` hairline, its reason on the live line.
  The Drop task tray is a dashed `--line-2` pill reading Drop task; under the pointer it turns `--danger` on `--danger-dim`.
  Esc lets go and writes nothing; near an edge, the body scrolls.
- **Asking on the tile**: a move that asks once draws the tile dashed (`--line-2`) in the column it landed on, or on its own row when the view does not draw that column, its status unchanged, with the sentence under a `--line-1` hairline in `--text-sm` `--fg-2`, then Cancel (small secondary, focused) and the confirm (small primary Queue it or Start, small danger Drop task), side by side or stacked in a narrow column.
  Nothing is written before the confirm; Cancel or Esc puts the tile back, and a live change to the task cancels the move and says so.
- **The ⋯ menu**: Open record; Show the card while a decision waits; Continue on interrupted work; Queue it or Back to backlog, and Start now, on open work, each with a sub-line ("May start at once · asks once", "Asks once · the record's Start"); a separator; Drop task last, in danger.
  An entry that cannot run stays listed, dim, its reason as its sub-line (RowMenu, `RowMenu.prompt.md`).
- Focus follows an accepted move to the tile's new lane, or the nearest row when the view does not draw it, and comes back to the tile after a refusal or a cancel.
