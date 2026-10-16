---
name: usage
description: Put the crew's tokens in a personal panel, live - the query over the app's own record, the honesty rules a number must keep, and how it should look. Also the general guide to the `sql` read and its views. Read with the personal-panel skill.
---

# Tokens, and the app's record, in a panel

Read `personal-panel` first.

## Where the data comes from

The app's own record, through one read-only SQL query. Declare the views the
panel reads in `manifest.json` under `sql`, by their exact names, and
subscribe with the query:

```json
{ "title": "Tokens", "sql": ["v_usage_v1"] }
```

```tsx
const [answer, setAnswer] = useState<SqlAnswer | null>(null);
useEffect(
  () => reads.subscribe("sql", { sql: QUERY, params: [since] }, setAnswer),
  [reads, since],
);
```

The answer arrives at once and again whenever the record changes - within a
few tens of milliseconds of a request finishing - and an answer that says the
same thing is not sent twice. `server.ts` asks the same question once with
`await context.sql(QUERY, [since])`. Never open the app's database file
yourself: the views are the one way in, and they are what survives the app
changing underneath.

## The views

Every name ends in its version, and you write it exactly that way:
`v_usage_v1`, never `v_usage`. When a view has to change shape the app ships
`v_usage_v2` beside it and keeps `v_usage_v1` for two releases, so a panel
keeps working until it is moved over; adding a column never changes a name.
Name the columns you use - never `SELECT *` into a fixed shape.

| View | One row per | Columns |
|---|---|---|
| `v_usage_v1` | model request (Pi) or turn (Claude) | id, at, task_id, key, title, status, activity, provider, model, account_label, input, output, cache_read, cache_write, cost |
| `v_tasks_v1` | task | task_id, key, project_key, parent_id, kind, status, activity, closed_reason, title, goal, priority, repo_name, branch, assignee, model, provider, tier, deliverable, rigor, delivery, created_at, updated_at, started_at, closed_at |
| `v_task_events_v1` | line on a task's timeline | task_id, key, at, kind, text, feed |
| `v_feed_v1` | line of the activity feed | at, kind, text, task_key |
| `v_quota_windows_v1` | window of an account's plan | provider, account_label, plan, status, stale, measured_at, window_id, label, percent_remaining, pace, resets_at |
| `v_routing_v1` | model the app chose for a task | at, task_id, key, provider, model, bucket, served, rule |
| `v_projects_v1` | project | id, key, name, archived |
| `v_repos_v1` | managed project on disk | id, name, kind, delivery, autonomy, rigor |
| `v_version_v1` | (one row) | version, major, minor |

Times are milliseconds since the epoch. A query sees nothing else: no table,
no other view, no write. One statement runs; at most 2,000 rows and 256 KB
come back, and `truncated` says when the host cut it; a statement still
running after 250 ms is stopped.

When the host will not run a query the answer is a refusal instead of rows -
check `"refused" in answer` first. `sql_view_not_declared` means the query
reads a view the manifest does not name; `sql_not_readonly` that it is not a
read; `sql_invalid` that SQLite could not run it (the message says why);
`sql_timeout` that it ran too long - narrow it with a `WHERE` on `at`;
`sql_too_large` that the query or one row is over the caps. A refusal is your
bug, not the captain's news: render nothing rather than the message.

## The tokens query

```ts
const QUERY = `
  SELECT key, title, activity, SUM(input) AS input, SUM(output) AS output, MAX(at) AS last_at
  FROM v_usage_v1
  WHERE at > ?
  GROUP BY task_id
  ORDER BY COALESCE(SUM(input), 0) + COALESCE(SUM(output), 0) DESC
  LIMIT 8`;
```

`since` is a parameter, fixed when you subscribe: for a sliding window, keep it
in state and move it on a minute's timer, which re-subscribes. The first mate's
own conversation is its own row, keyed `FIRSTMATE` and titled `First mate`.

## The honesty rules

- **Unknown is never zero.** A request that recorded no count has `null`
  there, and `SUM` over nothing but nulls is `null`: render `–`. Never
  `COALESCE(input, 0)` a number you will show; a missing count is not a
  request that read nothing.
- **Tokens, not money.** `cost` is the provider's own figure for the request;
  on a subscription the captain pays for the plan, not the request, so a
  dollar figure is notional. Show tokens. If a panel shows cost at all, say
  "at list price" beside it.
- **Say what a row counts.** One row is one model request on Pi and one whole
  turn on Claude, so row counts do not compare across providers - tokens do.
- **The first mate is not a crewmate.** Show its row apart from the crew's,
  labelled First mate, never folded into "the crew".
- **Never an account's id.** The views carry `account_label` - the name the
  captain gave the account - and never its internal id. `account_label` is
  `null` when the latest reading of the plan's allowance does not name that
  account: render the provider's name alone.
- **Quota is the allowance, with its own rules.** For a plan's allowance keep
  to the `quota` skill and its `quota.snapshot` read, which carries the
  sensor's own sentence for a read with no window. `v_quota_windows_v1` has
  the same numbers and the same honesty in its columns - only a `status` of
  `auth_required` says "sign in again", a `stale` row says its age from
  `measured_at`, and a null `percent_remaining` is `–` - but not that sentence.

## Shape

A `MicroLabel` naming the window with the fleet's total as its count, then one
`Row` per task, busiest first: the title, the dot saying what its crewmate is
doing, and the tokens as the trailing datum in mono with their unit.

| `activity` | tone |
|---|---|
| running | `busy` |
| idle | `ok` |
| interrupted | `danger` |
| anything else | `idle` |

```tsx
<MicroLabel count={formatTokens(total)}>Tokens · last hour</MicroLabel>
<Row title={row.title} tone={toneOf(row.activity)} trailing={`${formatTokens(tokens)} tokens`} />
```

Counts read the way people say them: `940`, `12.4k`, `1.2M`. With nothing spent
in the window, one `Empty` line - "No tokens in the last hour" - never a list
of zeros. No charts, no per-request log, no model names in the row: a rail
panel answers "who is spending right now" at a glance, and the record pane is
one click away for everything else.
