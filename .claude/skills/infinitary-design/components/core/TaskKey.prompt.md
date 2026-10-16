# Task keys (FI3-594, FI3-1271)

A task key the app shows as text - `FI3-572` - is a link to that task wherever a person reads it: a card's body, its title and its thread, the task record, Activity, Knowledge and Settings.
Resting on it shows the task's summary, and a click or Enter opens the task.
One rule, one summary and one way of opening serve every place; a card body's keys are linked by its frame's bridge (`../cards/ResponseCard`, "Task keys in a body"), a panel's through its pointing (`PanelTaskKeyText`), and the window's own through `TaskKeyLink`.

- **Which words.**
  Only a key that is exactly a recorded task's key: a word shaped like a key that names no task (`F13-572` where no project F13 exists), a lowercase key, or part of a longer word (`FI3-594-plan`) stays text.
  Nothing near is guessed.
  A task's own key on its own card, record, summary or task browser stays text: opening it would only bring the same task forward.
- **Where a key stays text.**
  A key inside a control that already does one thing stays text, so the control keeps its one action: a button, a toggle's summary (an Activity line's, whose opened text links), a `role=button` element, a draft button, a link, a Tasks row or a board tile, a Knowledge list row, a Cards row title, an action label, a collapsed panel's newest line and a thread's collapsed cue.
  The last turn above the input is plain text, never a link, so its keys stay text too (`VoiceInput.prompt.md`).
  A confirmation sentence - Drop task's, a board move's - stays text, since following a link would abandon the confirmation.
  The summary never takes the pointer, so its keys stay text; so do the board's passing status line, Diagnostics' raw records, inputs, menus, notifications and what a screen reader announces.
- **How it reads.**
  In words - a card's body or title, a thread line, the record's Now line, its Waiting on box and the words of a task, a refusal, a finding's statement - as the body's other links: `--accent`, underlined, in the font around it, with a pointer cursor; resting on it gives it the row hover surface (`--bg-3`, `--radius-s`).
  In a dense list - an Activity line, the record's Activity and Details, a Usage row, Knowledge's who-and-when lines - it keeps the list's own type and color (the dim mono a key has there), underlined, and turns `--accent` while it is rested on or focused, so a column of keys never outshouts the words.
- **Rest.**
  Resting on a key opens the crew summary for its task (`../mate/Crewmate`, Reading a crewmate) after the same beat (130ms): the same panel and the same shared facts, in the same order and words, as its Tasks row (`../now/NowPanel`, Row hover).
  A key on a card - its body, title, thread, or the record - sits outside the card, level with the key (`../cards/ResponseCard`, "Task keys in a body"); a key in a panel on its rail sits beside the panel, as a Tasks row's summary does; a key in Settings sits outside the Settings section.
  It is in the window-wide layer above the rails and the cards, and never takes the pointer.
- **The keyboard.**
  Every key is a Tab stop with the `:focus-visible` ring; the keyboard's focus on it opens the same summary as the pointer's rest, once the key is in view, and Enter opens the task as a click does.
  In Activity the list stays one stop that the arrows scroll, and each key after it is a stop of its own; F6 leaves for the next part of the window.
- **Closing.**
  A cut, as for a row: when the pointer leaves the key, on Esc, on a press on the key, when what it is in scrolls or takes a new revision, when the window resizes or loses focus, on any other key press in the window, when focus leaves the key, or when the key leaves.
  After Esc or a press it stays closed until the pointer leaves that key, or focus does.
  Esc closes only the summary, never the card or the Settings under it.
- **Click.**
  A click on the key, or Enter on it, opens the task exactly as a click on its Tasks row does: its waiting decision comes forward, or its record opens at the front of the stack.
  A key in Settings leaves Settings for the main view first.
  Only the captain's own click or key opens a task; resting needs none.
  It is navigation, never a card action: it runs no effect, sends nothing to an author, and works on a past card too.
