# The project focus

The window can be focused on one project, so the captain sees that project's work while the rest keeps running.
One focus serves every surface: the top bar's project pill, the Tasks panel's project chip and the task board's chip are the same choice (the captain's answer to INF-1091).
How the pill looks and moves is the design skill's `components/core/ProjectFocus.prompt.md`.

| Piece | Where |
| --- | --- |
| Which projects get a pill, what each counts, which saved focus holds, and the tail's count | `src/shared/projectFocus.ts` (`projectPillsOf`, `pillShown`, `heldFocus`, `waitingElsewhere`, `elsewhereWords`) |
| The focus as the window reads it, the row's open state and the pill a rest lights | `src/renderer/src/app/projectFocus.ts` (`projectFocus`, `useProjectFocus`, `heldProjectFocus`) |
| Where the choice is saved | the layout's `focusedProjectId` (`src/shared/preferences.ts`), written by `railStore.focusProject` |
| The pill and its row | `src/renderer/src/app/ProjectFocusControl.tsx`, drawn by `TopBar.tsx` between its two groups |
| A panel's view and pointing | `PanelProps.view.focusedProjectId` and `point.focusProject` (`src/renderer/src/plugins/panelPoint.ts`, `docs/ui-plugins.md`) |
| The stage's light | `src/renderer/src/character/crew/focusLight.ts` (`lightFrame`), `docs/crew-orbits.md` "The project focus" |
| The first mate's hint | the turn's `focusedProjectId` (`inf:converse`), read by `buildContextBlock` as `focused_project` |
| The keys | `project-focus.open` and `project-focus.clear` (`docs/keyboard.md`) |

## Which projects get a pill

Every project set up in Settings gets one, in the task board's order, and Scratch (the project with no repository) gets one while it has a task the Tasks panel lists.
An archived project gets none.
The pill shows only while there are two projects or more; with one there is nothing to choose.
A pill counts its project's tasks that wait on the captain and that work, each task once by its own state (`nowGroupOf`), so a pill and the Tasks panel's collapsed summary narrowed to its project always agree.
A project with nothing waiting and nothing working reads dimmer.

## What the focus does

- The Tasks panel lists only the focused project's tasks, its search open or closed, and its collapsed summary counts only them.
  Closing the search lets go of its words and keeps the focus.
- The task board opens on the focused project, and Hide keeps it.
- On the stage every crewmate of another project keeps a quarter of its light; nothing hides or moves.
- The first mate gets a hint on every turn the captain sends, below the record the window shows: new work they ask for belongs to the focused project unless they name another.
  It is a hint, never a limit.
- Every project still notifies, and the card stack and Activity are unchanged.

Focused, the pill names the project, wears the accent border and has a × beside it, Show all projects.
A quiet mono tail after it says how many tasks wait on the captain in other projects ("2 waiting elsewhere"), and a press on it opens the row.

## Opening and closing the row

The pill carries an arrow pointing right, because the row opens to the right (the captain's words on INF-1091).
A press on the pill, Enter or Space on it, the tail or Focus on a project (⇧⌘P) opens the row: All projects, then a pill per project, each gliding out to the right from where the pill was, its counts a beat after.
The row ends in the same arrow turned back, Close the project row, which folds it again.
Esc, a press outside the row, the window changing size or losing focus, and a pick fold it too, playing the glide back into the pill.
A row too wide for the bar's room ends in a +N pill that lists the rest in a menu; the focused project always keeps its pill in the row.
A pointer or the keyboard resting on a pill lights that project's crew on the stage before anything is picked.
The row is a radio group: the arrows, Home and End move along it, and Enter or Space picks.
Opened by a key or the command, focus lands on the checked pill; folded, focus goes back to the pill.

## Where it is kept

The choice is saved with this computer's layout, so it survives a restart, and a Mac that controls another keeps its own (`docs/view.md`).
A saved project that is archived or removed lets go of the focus without anyone writing it: the focus that holds is the saved one only while its project still has a pill (`heldFocus`).
Before the board is read at launch the saved focus holds, so a restart never shows All projects on the way to the focused project.

## Tests

- Unit: `src/shared/projectFocus.test.ts` (pills, Scratch, archived, the held focus and the tail), `src/renderer/src/character/crew/focusLight.test.ts` (the light on the orbit's own frames), `src/panels/now/rows.test.ts` (the narrowed summary), `src/renderer/src/plugins/panelPoint.test.ts` (`focusProject` only from the captain's click or key) and `src/core/orchestrator/firstmateAgent.test.ts` (the hint).
- Journey: `tests/e2e/project-focus.spec.ts` drives the pill by keys, the Tasks list, the stage's light, a restart and Show all projects; `tasks-search.spec.ts` and `task-board.spec.ts` cover the chips as the one focus.
