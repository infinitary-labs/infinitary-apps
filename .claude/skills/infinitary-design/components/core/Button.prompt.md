The standard action button; primary is an ice-cyan fill with dark text, everything else is quiet.
```jsx
<Button variant="primary" onClick={go}>Submit</Button>
<Button variant="ghost">Not now</Button>
```
Variants: primary / secondary (hairline) / ghost / danger (outline).
Sizes sm/md/lg.
Sentence case labels, never uppercase.

A button may show the key that presses it (`keys`), inside the button after its label: quiet mono at `--text-sm`, in the button's own text color at six tenths, with no keycap, border or extra padding.
The key sits on the label's own baseline near the button's right edge; the label moves left to make most of the room, and the button widens by six pixels, the air the key needs: ten before the label, six before the key and eight after it.
A key too long for that room, such as Ctrl+1 on Linux, widens the button only by what it still needs.
It is not a control and is hidden from assistive technology; the button names the key in `aria-keyshortcuts`.
Only a card's footer choices opt in.
Other buttons stay bare.
The key reads the installed map, in this computer's key words.
A pending button shows its pending label alone.

Action feedback: acknowledge a click before the next paint.
Close/commit the surface immediately when possible.
If it must remain while waiting, set `pending` synchronously before starting the request, disable competing actions, and clear it on completion.
No pending-paint delay or spinning chrome.
A pending Button is disabled and `aria-busy`, immediately dimmed, with a static `pendingLabel` (default "Working...").
Reserve both labels in the same grid cell so neither the button nor its row shifts; the hidden label is excluded from accessibility.
Only opt in where an asynchronous wait actually exists, not on local toggles or navigation.

```jsx
<Button pending={refreshing} pendingLabel="Refreshing..." onClick={refresh}>Refresh</Button>
```

Pending acknowledges the request, never its success.
Card work that continues after dismissal must report its result or refusal through the persistent activity feed.
An unaccepted request leaves its card available with a concise inline error (`--danger`, `--text-sm`, `role="alert"`).
Settings requests keep failures beside the control in the existing error/description area.
Never drop rejected promises.
