Quiet log of major crewmate events (spawned, reported back, decommissioned) shown above the CrewStrip — a chromeless "thread": 1px rail, tiny state dots, mono hh:mm timestamps, rows fading with age, newest at the bottom.

On the home shell the feed is the `Activity` panel of the left side rail: it docks to the bottom and hugs its content, with the feed body capped at 320px (plus the host header and padding), at the rail's width (`--rail-width`), inside the host's panel chrome (title and collapse are the host's; the feed styles only the body).
Rows fill the column; overflow-y auto when there are more than fit.
Every row stays on one line: the colored type dot is at the far left, overflowing text ellipsizes, and the relative timestamp aligns at the right.
The dot, the words' x-height and the timestamp's x-height share one centre (readme, Type: one line beside a dot or an icon).
The dot shows nothing on rest and is no Tab stop: the line's own words say what its color does.
Newest stays at the bottom; pin to the bottom as events arrive unless the user has scrolled up, and re-pin when the column itself resizes.
With no events there is no panel and no rail.
While the window is focused on a project (`components/core/ProjectFocus`), lines about other projects' tasks leave the list and the collapsed header at once, with no marker: the top bar's pill is the one place that says focus is on.
Lines about no task (the captain's own turns, the first mate's, the app's) stay; letting focus go brings the hidden lines back in their places.
The list is one stop for the keyboard (Tab, or F6 to the panel): the arrows and the page keys scroll it, the focus ring draws inside its edge (`--focus-ring-inset`), since the list fills the frame that would cut it, and while it has the keyboard's focus every line wraps to read in full, as resting the pointer on one shows it.

Overflow does not use the default right-side OS scrollbar.
The 1px `border-left` rail stays; a thin (~3px) `--fg-3` thumb sits on that left edge (the overflow container is mirrored with `scaleX(-1)`, and the inner content is mirrored back).
Track is transparent.
Older lines dissolve at the clip with a ~40px overlay from the surface the feed sits on (`--bg-1` inside a rail panel; `--bg-0` when it sits on the stage) → transparent.
Per-row age opacity rises quadratically from 0.1 (90% transparent) to 1.0, newest at the bottom.
The top dissolve appears only when history overflows; short feeds have no overlay.

```jsx
<ActivityFeed events={[
  {time:Date.now()-540000, kind:"spawn",  text:"crewmate spawned — refactor auth middleware"},
  {time:Date.now()-120000, kind:"report", text:"test matrix green across 3 machines"},
  {time:Date.now(),        kind:"done",   text:"crewmate decommissioned — lint sweep complete"}
]} style={{height:"33vh",maxWidth:"calc(50vw - 320px)"}}/>
```

Never a focal point: no container, no background of its own.
Pass events oldest→newest.
Optional `max` keeps only the most recent N rows; omit it so history can fill the column.
In the app this is the Activity panel's folder (`src/panels/activity/`), drawn in a page of its own, not this JSX; the look is the same.

**Closing a card with the cross writes one line** (FI3-579, the captain's 5 "yes"), the one place the captain learns where the card went: `You closed "<title>". It stays on FI3-569's record.` (the key of the task the card is about, a first mate decision's own record included).
A card with no record to point at keeps the plain `captain dismissed the card "<title>".`.
A choice, a merge, a withdrawal or the app taking a card down writes no such line (a merge already has its own), and opening the card again from the Cards row (`components/cards/TaskRecord`) writes none.
