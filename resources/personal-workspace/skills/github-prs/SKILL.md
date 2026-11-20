---
name: github-prs
description: Put the captain's open proposed changes (GitHub pull requests and GitLab merge requests) in a personal panel - the app's own forge.changes read, the checks as one status dot, and what the panel shows when there are none or the app is not signed in. Read with the personal-panel skill.
---

# Proposed changes in a panel

Read `personal-panel` first. This skill is only where the data comes from and
how it should read.

## Where the data comes from

The app's own read, `forge.changes`. Declare it in `manifest.json` and
subscribe to it through `PanelProps.reads`; there is no `server.ts` to write.

```json
{ "title": "Open changes", "reads": ["forge.changes"] }
```

```tsx
import type { PanelForgeChanges, PanelProps } from "@infinitary/contracts";

export default function Panel({ reads }: PanelProps) {
  const [value, setValue] = useState<PanelForgeChanges | null>(null);
  useEffect(() => reads.subscribe("forge.changes", setValue), [reads]);
  // ...
}
```

Things that save a round trip:

- The app reads the changes with the captain's own sign-in where his projects
  live (Settings -> Projects). The panel never reaches the network, never
  holds a sign-in, never reads one out of a file, and never shells out to a
  program for it - the read is the whole data source.
- The rows arrive already shaped and newest first, from every host he signed
  in to: `host`, `project` (`owner/name`, or a GitLab project's whole
  `group/subgroup/name`), `number`, `label` (the host's own name for it:
  `#12` for a GitHub pull request, `!4` for a GitLab merge request), `title`,
  `url`, `draft`, `checks`, `updatedAt`. Render them; do not re-sort unless
  the captain asked.
- The read re-arrives on its own - when the sign-in changes and every few
  minutes while the panel is on a rail - so a panel needs no timer of its own.
- `signedIn: false` is not a failure: the captain keeps his projects on this
  computer, or has not signed in yet. `reachable: false` means the host could not
  be read this time; the rows are empty until it can. Neither is an error
  state with a red colour.

## The checks are a status dot

One dot per row, in `StatusDot`'s language, from `checks`:

| checks | tone |
|---|---|
| `passed` | `ok` |
| `failed` | `danger` |
| `pending` | `warn` |
| `none` | `ring` |

That is the whole vocabulary. No badges saying "passing", no check marks, no
percentages, no emoji - the dot IS the state.

```tsx
<Row
  title={change.title}
  tone={TONES[change.checks]}
  toneLabel={`checks ${change.checks}`}
  word={change.draft ? "draft" : undefined}
  trailing={change.label ?? `#${change.number}`}
/>
```

The label is mono and trailing - `!4` on GitLab is a merge request, where
`#4` would be an issue - and the title is the row. Key each row by its `url`:
two hosts can share a project's name and number. A panel at rail width
has room for the title and one datum, so resist adding the project, the
author and the age as well.

## When there are none

Render the fact with `<Empty>`: "No open proposed changes". When `signedIn`
is false, one calm line that says where the sign-in lives ("Sign in where
your projects live, in Settings") - never a button, never a warning, never
anything that suggests the captain must keep his projects anywhere but this
computer.

## What not to build

No merge, close or approve control. A panel is display and pointing; putting
work in happens by talking to the first mate, which knows the task, the posture
and the checks.
