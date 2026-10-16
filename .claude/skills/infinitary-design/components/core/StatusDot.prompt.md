A 6px status dot for a dense list row, replacing a per-row Badge.
```jsx
<StatusDot tone="ok" label="signed in"/>
<StatusDot tone="ring" label="signed in · no reading yet"/>
```
Tones: ok (filled cyan: signed in with a reading) · ring (hollow: signed in, nothing read yet - not measured, rate limited, unavailable) · warn (ember: a stale last-known-good) · danger (lava: sign in again) · idle (grey: paused) · busy (ember: work in flight on this row - a panel header while the task building it is still active, in the working crewmate's own heat) · captain (violet, `--captain`: the captain's own hold on this row - a task's browser while he has control of it).
Always pass `label`; it is the dot's only text.
Pass `nativeTitle={false}` only where those same words are already shown; the accessible name stays.
Pass `focusable` on a row whose state the dot alone says (an account, a forge sign-in): the dot is a Tab stop of its own and its words show in the label the app draws for an icon button, on the pointer's rest and the keyboard's focus alike, in place of the native title (readme, "Facts shown on rest").
Never pass it inside a control, which names the dot already.
Use it where a Badge per row would repeat the same word down the page; keep Badge for one-off states with room.
