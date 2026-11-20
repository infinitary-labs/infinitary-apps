---
name: quota
description: Put subscription quota in a personal panel - the app's own QuotaMicroMeter and the honesty rules that must not be broken (unknown is never zero, stale says its age). Read with the personal-panel skill.
---

# Quota in a panel

Read `personal-panel` first.

## Where the data comes from

The app's own reading, through the `quota.snapshot` read: declare it in
`manifest.json` and subscribe in the panel. It is the same snapshot Settings
renders - one row per signed-in account, its windows, what the sensor
established - pushed whenever the app refreshes it, and `null` before the
first reading (render the empty state, never a bar at zero).

```json
{ "title": "Quota", "reads": ["quota.snapshot"] }
```

```tsx
const [snapshot, setSnapshot] = useState<PanelQuotaSnapshot>(null);
useEffect(() => reads.subscribe("quota.snapshot", setSnapshot), [reads]);
```

Never fetch a provider's usage yourself from `server.ts` when the app already
senses that provider: two readings of one allowance disagree, and the app's
is the one with the honesty rules built in. `server.ts` is for a source the
app does not sense.

Everything below is how quota should LOOK. It is the app's own instrument and
its own honesty rules, and both apply to every row the read carries.

## The instrument

`QuotaMicroMeter` is the app's one-line meter: label, a 56px bar, the percent.
Use it. A hand-drawn bar will not match it, and a panel that invents its own
quota visual is the clearest sign of an incoherent surface.

```tsx
<QuotaMicroMeter
  label={window.label}
  percentRemaining={window.percentRemaining}
  pace={window.pace}
  resetText={window.resetText}
  stale={provider.stale}
/>
```

`QuotaMeter` is its bigger sibling and wants the width of a settings row; at a
rail's width its reset line truncates. In a panel, reach for the micro meter.

## The honesty rules

These are not style. The app's quota sensor is careful about what it
established, and a panel that flattens that is lying to the captain about his
own money.

- **Unknown is never zero.** A window with no percentage renders `–`, never
  0%, never an empty bar, never "unlimited". `QuotaMicroMeter` already does
  this; do not "fix" it with `?? 0`.
- **Stale says its age.** A carried-forward reading is dimmed and says `as of
  3h ago` where a verdict would go. Never present a last-known-good number as
  current.
- **Only a proven sign-out says "sign in again".** Every other failure is
  transient: it could not be read this time, and the next tick may recover.
  "Rate limited", "unavailable" and "error" mean not read, not signed out.
- **A read with no window renders what happened, verbatim.** If the source
  said why, show that sentence. Do not paraphrase it, shorten it, or replace
  it with "unavailable".
- **Never render an internal account id.** The label the captain gave the
  account and the provider's name are what a person recognises.
- **"Ahead" is the warning.** Pace follows the app's vocabulary: `ahead` means
  burning faster than the reset clock (conserve); `behind` is calm. Do not
  invert it, and do not turn it into a percentage.

## Shape

One line per window, grouped under a `MicroLabel` naming the provider and,
when there is more than one account, the account's own label ("Claude ·
Personal") - two rows both reading "Personal" tell the captain nothing.

A panel is not the Subscriptions tab: no plan details, no model lists, no
actions. If the captain wants to act on quota, he says so and the first mate
opens the tab.
