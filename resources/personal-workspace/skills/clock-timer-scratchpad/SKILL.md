---
name: clock-timer-scratchpad
description: The three small panels that carry no app data - a clock, a countdown timer, a scratchpad - and what each one teaches about local state, the store and calm motion. Read with the personal-panel skill.
---

# A clock, a timer, a scratchpad

Read `personal-panel` first. These three are the small asks, and each is a
different answer to "where does this state live".

## A clock: derived, stored nowhere

A clock comes from the machine's own time. Nothing to fetch, nothing to
persist, no server half at all.

```tsx
import type { PanelProps } from "@infinitary/contracts";
import { MicroLabel } from "@infinitary/ui";
import { useEffect, useState } from "react";

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
});

export default function Panel(_props: PanelProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <MicroLabel>Tokyo</MicroLabel>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-lg)", color: "var(--fg-1)" }}>
        {clock.format(now)}
      </span>
    </div>
  );
}
```

- `Intl.DateTimeFormat` with a `timeZone` is the whole implementation. Never
  hand-roll an offset, and never fetch a time API.
- Tick only as often as the display changes: a clock showing hours and minutes
  repaints twice a minute, not sixty times. A repaint for nothing is not calm.
- Time is data, so it is mono.
- `presence` is `{ "always": true }`: a clock is useful precisely when nothing
  is happening.

## A timer: the store, because it must survive

A countdown has to survive a collapse, a reload and a restart. Store the
DEADLINE, never the remaining seconds - a stored countdown drifts, an instant
cannot.

```tsx
const left = endsAt ? Math.max(0, endsAt - now) : 0;
```

- Start and stop through `invoke("start", { minutes: 25 })`, which writes
  `endsAt`; the panel derives everything else from it.
- At zero the panel says so quietly: the title at `--fg-1`, the dot `warn`. It
  does not flash, it makes no sound, and it never raises a card - a card is
  for a decision the captain must make, and a timer reaching zero is a fact on
  a panel he is looking at.
- No pulsing and no spinner. A number counting down IS the motion.

## A scratchpad: the store, and nothing clever

A few lines the captain types and finds again tomorrow.

- Local state while typing; write the store on blur (and on a debounce if he
  types for a long time). Never write the store on every keystroke.
- Prose is `--font-ui`, not mono. Mono is for data.
- The field is the app's own input styling: `--surface-input`, a `--line-1`
  hairline, `--radius-m`, `--text-sm`.
- No markdown rendering, no formatting toolbar, no autosave indicator. It is a
  piece of paper.
- `presence` is `{ "always": true }`: an empty scratchpad is still a
  scratchpad.

## What all three share

They carry no app data, so they need no data source - which is why they are
the right shape to copy when an ask is small. They are also the panels most
likely to sit on the rail all day, so they must be the calmest things on it.
