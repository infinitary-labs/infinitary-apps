The ⋯ at the end of a list row: every action the row offers, out of the glance path.
```jsx
<RowMenu label="Work #2 actions" items={[
  {id:"prefer",label:"Prefer for crew work",trailing:<span style={{color:"var(--accent)"}}>✱</span>},
  {id:"rename",label:"Rename"},
  {id:"pause",label:"Pause"},
  {separator:true},
  {id:"disconnect",label:"Disconnect",tone:"danger"},
]}/>
```
A 28px IconButton kebab opening a `--bg-2` popover (hairline `--line-2`, `--radius-m`, `--shadow-2`) anchored bottom-right, flipped above the kebab when it would run past the window's bottom edge, clamped at either horizontal edge, and scrollable when taller than the window (a menu is never off-screen); closes on Escape, an outside click, or a pick.
It grows from the kebab and fades out as it closes, like every popover (Motion in the readme).
Sentence-case labels, one destructive item at most and it goes last behind the separator.
Use it when a row would otherwise carry three or more controls; the one action that must stay inline is the one nothing moves without (a "Sign in" on a row that needs it).
In a row of chrome whose other controls are words, a word may stand in for the kebab as a small ghost Button (`word="More"`, a task's browser view); the popover is the same, right-aligned under it.
An item that cannot run now stays listed, dim (`--fg-3`), with its `detail` saying why, and a pick on it does nothing; any item may carry a `detail` sub-line in `--text-xs` (`--fg-3`) under its label saying what it does ("Asks once").
Where its row opens the menu by a key of its own (a task board tile's Space), the kebab leaves the Tab order (`triggerTabIndex={-1}`) and shows on the row's hover or focus, and focus returns to the row on close (`restoreFocus`).
