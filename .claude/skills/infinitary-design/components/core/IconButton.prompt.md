A circular icon-only button; used for voice-input controls and card actions.
```jsx
<IconButton label="Abandon" tone="danger"><XIcon/></IconButton>
```
Tones: neutral / accent / danger / ok.
Always pass label: it is the accessible name and the label the app draws under the button while the pointer or the keyboard's focus rests on it (never the native title).
The label is `--bg-3` on a `--line-2` hairline, `--radius-s`, `--text-sm` `--fg-1`, centred 6px under the button (over it near the window's bottom edge) and kept 8px inside the window.
The first one waits `--delay-label` (500ms) and fades in over `--dur-fast`; resting on another icon button while one shows, or within 400ms after it went, moves it there at once; leaving, a press or a key takes it away at once.
It is decoration, hidden from assistive technology, and never takes the pointer.
A button that does what a window command does (Settings, the card pager's arrows, Search tasks, Open task board) passes the command's first key as `keys`: the label draws it after the words, in mono `--fg-3`, `--space-2` apart (`Settings ⌘,` on a Mac, `Settings Ctrl+,` on Linux), and the button names every key in `aria-keyshortcuts`.
On Linux the top bar's window controls (Minimize, Maximize or Restore, Close window) are neutral icon buttons too (readme, "Linux desktop conventions").
Icons: Lucide, 16px, currentColor.

An icon button that cannot be pressed for a reason is marked `off` rather than `disabled`: dimmed the same way, it stays a Tab stop (`aria-disabled`), a press does nothing, and its label says why (`Back · the crewmate is driving`; readme, "Facts shown on rest").

The host may pass `ref` and `onFocus` to retain usable keyboard focus when a paged control becomes disabled or disappears.
