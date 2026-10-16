---
name: tasks-and-feed
description: Show work and activity in a personal panel - the row tones, the feed line, what the app's own panels already do, and the honest state of the app-data path. Read with the personal-panel skill.
---

# Tasks and activity in a panel

Read `personal-panel` first.

## Before you build

The app already ships two panels on this data: **Tasks** (the right rail:
counts, "waiting on you", "underway", the rest collapsed) and **Activity**
(the left rail: the event log). An ask like "show me my tasks" is usually
already answered, and a second copy of a panel that exists is worse than none.

What a personal panel is genuinely for here is a SLICE: one project, one
repository, the crewmate reports only, work that failed today.

## Where the data comes from

Two reads, declared in `manifest.json` and subscribed in the panel:
`tasks.board` is the live board the app's own Tasks panel paints (open and
underway rows, recently closed ones, the projects with their counts), and
`feed.recent` is the activity log, oldest first, exactly the lines the
Activity panel shows. Both are pushed as they change; a panel filters and
renders, and keeps no copy of either in the store.

```json
{ "title": "Reports", "reads": ["feed.recent"] }
```

```tsx
const [lines, setLines] = useState<PanelFeedLine[]>([]);
useEffect(() => reads.subscribe("feed.recent", setLines), [reads]);
```

Never open the app's database file from `server.ts`: it would break the first
time a migration landed. When a slice needs more than these two reads carry -
a task's timeline, what happened last week - query the published views
(`v_tasks_v1`, `v_task_events_v1`, `v_feed_v1`) through the `sql` read; the
`usage` skill is its guide.

For waiting, use `task.waitingCardId`: non-null means a live task has a
reachable ready choice in the shown card stack, even behind another card.
Hidden replies, Working cards, notes and closed tasks do not count. Count a
task once, however many ready cards it has. Project `counts.waitingOnYou`
carries that count; `flags.needsYou` and `counts.needsYou` are broader
attention facts (holds and dead dependencies too), not waiting labels.
A waiting child remains separate from an underway parent and siblings;
never count or relabel the whole tree as waiting. Existing work holds remain
in force when a waiting signal disappears.

Everything below is how this data should LOOK.

## A row of work

`Row`, with the dot saying one thing only: what the worker on that task is
doing, in the colors the character paints by.

| The row | tone |
|---|---|
| running | `busy` (the ember: something is working now) |
| idle, still open | `ok` |
| interrupted | `danger` |
| nobody on it | `ring` |
| closed | `idle` |

"Waiting on you" is a GROUP, never a color. "Blocked" and "held" are one dim
word after the title, through `Row`'s `word`. The key (`FM3K-12`) is the
trailing datum, in mono.

```tsx
<Row title={task.title} tone={toneOf(task)} word={task.blocked ? "blocked" : undefined} trailing={task.key} />
```

Nothing else in a rail row: no chips, no meters, no model names, no ages.
Everything richer hides behind a click, and a personal panel usually has no
click at all.

## A line of activity

`FeedLine`, oldest to newest with the newest at the BOTTOM, the age already
formatted the app's way (`now`, `3m`, `2h`, `1d`), the task key as a dim mono
prefix, and the kind carrying the only color.

```tsx
<FeedLine kind="report" tone="ok" time="4m" taskKey="FM3K-9">
  Test matrix green across three machines
</FeedLine>
```

Take the tail, not the history: ten or fifteen lines in a rail panel. A feed
line is a finished sentence written by whoever wrote it - render it as it is,
never re-word it, never add a prefix of your own.

## Rules

- A panel never writes a task. No start, drop, land, merge or steer control,
  not even one that "just asks the first mate". Every write happens in
  conversation.
- A slice filters on what a row already carries. Do not keep a second copy of
  the app's state in the store to filter it differently later; when the real
  source arrives it would disagree with the first.
- Closed work ages out. A panel shows what IS; the record is the record.
