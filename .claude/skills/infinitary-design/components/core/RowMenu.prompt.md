The ⋯ at the end of a list row: every action the row offers, out of the glance path.
```jsx
<RowMenu label="Work #2 actions" items={[
  {id:"prefer",label:"Prefer for crew work",checked:true,trailing:<span style={{color:"var(--accent)"}}>✱</span>},
  {id:"pause",label:"Paused",checked:false},
  {separator:true},
  {id:"rename",label:"Rename"},
  {separator:true},
  {id:"disconnect",label:"Disconnect",tone:"danger"},
]}/>
```
A 28px IconButton kebab opening a `--bg-2` popover (hairline `--line-2`, `--radius-m`, `--shadow-2`) anchored bottom-right, flipped above the kebab when it would run past the window's bottom edge, clamped at either horizontal edge, and scrollable when taller than the window (a menu is never off-screen); closes on Escape, an outside click, or a pick of an action.
It grows from the kebab and fades out as it closes, like every popover (Motion in the readme).
Sentence-case labels, one destructive item at most and it goes last behind the separator.
Settings: an item that is an on/off setting rather than a one-time action passes `checked`, keeps one fixed label that names the setting (Paused, never Pause and Resume), and draws a small switch at its end in the Switch's look at menu size (28 by 16, `--accent` when on).
It is a `menuitemcheckbox` with `aria-checked`; a pick, by click, Enter or Space, flips it and the menu stays open with focus on it, so the person sees the switch move.
Settings come first, then a separator, then the actions, then the one destructive item behind its own separator.
A setting that cannot change now keeps its state's fill, dimmed, with its `detail` saying why (Switch's "off").
A glyph that belongs to the setting (the ✱ of Prefer for crew work) sits beside its label, since the switch holds the end.
Use it when a row would otherwise carry three or more controls; the one action that must stay inline is the one nothing moves without (a "Sign in" on a row that needs it).
In a row of chrome whose other controls are words, a word may stand in for the kebab as a small ghost Button (`word="More"`, a task's browser view); the popover is the same, right-aligned under it.
An item that cannot run now stays listed, dim (`--fg-3`), with its `detail` saying why, and a pick on it does nothing; any item may carry a `detail` sub-line in `--text-xs` (`--fg-3`) under its label saying what it does ("Asks once").
Where its row opens the menu by a key of its own (a task board tile's Space), the kebab leaves the Tab order (`triggerTabIndex={-1}`) and shows on the row's hover or focus, and focus returns to the row on close (`restoreFocus`).
Where a command opens the menu too (the task board's Move the selected task), the kebab passes that command's key as `keys`, which its label draws after the words as an icon button's does (`IconButton.prompt.md`), and names it in `aria-keyshortcuts`.
It passes the command itself as `data-key-command` too, so a mouse click on the kebab shows the key reminder (`KeyReminder.prompt.md`).

**A right-click opening.**
Where a right-click on a thing means "what can I do with this" (the picture viewer's picture), the same panel opens at the pointer instead of under a kebab: its top left corner at the press, kept `8px` inside the window, flipped to the left of the press or above it where it would run past the right or bottom edge.
It is the same `--bg-2` panel, items, separators, `detail` lines and dim items, growing from the press and fading out as it closes.
Each item may carry its key at its end, in mono `--text-xs` / `--fg-3` (`⌘C`), the way a control's key hint reads.
Focus lands on the first item; the arrows walk the items, `Enter` or `Space` picks, and `Esc` closes the panel alone, leaving what it opened over in place, with focus back where it was.
A press outside closes the panel and does nothing else, so a click beside it never also presses what lies under it.
`Shift+F10` or the menu key opens it at the middle of the thing focused; a Mac has no such key, so every item keeps its own key.
In the app this is `PointMenu` (`src/renderer/src/design/core/PointMenu.tsx`), sharing the panel and items with the kebab's (`MenuPanel.tsx`).
