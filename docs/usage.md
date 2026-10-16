# Usage

Settings → Usage reports the model usage the first mate records across the fleet: the first mate's own conversation, every crewmate's task work, and the model calls made for neither.
It answers how much, on which models, where it went and how much work finished, in tokens or in estimated US dollars.
The captain chose the Overview direction of FI3-925's prototypes, with estimated dollars offered and quiet milestones on (FI3-926).
How it looks and reads is the design skill's `components/usage/UsageTab.prompt.md`.

| Piece | Where |
| --- | --- |
| The ledger and its one writer | `usage_events`, `UsageStore.record` (`src/core/storage/usageStore.ts`) |
| The summary the tab reads | `UsageStore.summary`, served as `services.usage.summary` on `inf:usage:summary` |
| The read the tab subscribes to | `usage.summary` in the read catalog (`src/shared/reads.ts`) |
| Its recent tasks | `UsageStore.tasks`, served as `services.usage.tasks` on `inf:usage:tasks`, read as `usage.tasks` |
| Its shapes and pure math | `src/shared/usage.ts` |
| The tab, its words and numbers | `src/renderer/src/settings/UsageTab.tsx`, `usageWords.ts`, `usage.css` |
| The remembered unit | `appearance.usageUnit` (`src/shared/preferences.ts`), written through `setAppearance` |
| The two commands | `settings.usage` and `usage.unit` (`src/shared/keyboard.ts`, `docs/keyboard.md`) |

## What the ledger records

Each session's `turn_end` carries the turn's usage (`FmUsage`, `src/shared/events.ts`), and `UsageStore.record` writes it.
A completed Pi context-shortening call carries its reported usage on the progress tool's `tool_end`, not a conversational turn end.
The session delivers one completion per call, including manual, threshold and overflow recovery; failed, aborted and unreported calls supply no usage.
The first mate and crewmate owners record it under the serving task, account and requested model, including calls settling while a task closes.
Usage subscribers refresh on these completions as well as ordinary replies.

- **Models.**
  Claude reports a running total for every model a turn called (`modelUsage`: the main loop, subagents, compaction).
  The normalizer (`claudeEvents.ts`) subtracts each model's last totals and reports each model's own share in `usage.models`; the ledger writes one row per model, named by the model Claude says served it, `model_source = 'served'`.
  Claude books a refusal fallback's retry under the model that answered it, so the turn a fallback happened in has a row for each model (`docs/claude-client.md`, "The model that answers").
  A reported total below its previously reported value means the client started counting over for that model, so its reported figures are the turn's own and its old baselines are discarded; a result reported twice spends nothing.
  An omitted field stays unknown for that result and retains its last known baseline until it returns, rather than resetting or charging its previous total again.
  Pi names the model the session asked for, so its rows carry `model_source = 'requested'`.
  An OpenRouter decision is the exception: its reply names the model that answered, recorded as `served` (`docs/decision-models.md`).
  A row written before migration 66 has no source: it names the model recorded then, and an older Claude row may sum several models.
  The app never splits such a row after the fact.
- **Known and missing.**
  A token category the session did not report stays null, never zero.
  Custom-provider turns carry an empty usage object when the server reports nothing, so the record still contributes to coverage.
- **Estimates.**
  `cost` is the session's own estimate in US dollars: Pi prices a message from the model's listed per-category rates (`cost_source = 'listed-prices'`, with `cost_input`, `cost_output`, `cost_cache_read` and `cost_cache_write`), and Claude makes its own estimate per model and turn (`cost_source = 'claude'`, no split).
  An OpenRouter decision records the cost its reply states for the call (`cost_source = 'reported'`, no split).
  A model with no listed rates prices a message at zero, which proves nothing, so Pi's normalizer records no cost at all for it.
  The summary counts a record as priced only when its cost is above zero, so an older zero is never read as free.
  Custom models borrow listed price metadata only from an exact model-id match in the local catalog (`docs/custom-api.md`); unmatched ids or unreported counts stay unavailable.
  Nothing is repriced: a record keeps the estimate it was written with.

## The summary

`UsageStore.summary(query, { now, names })` answers one period (`7d`, `30d`, `all`) and one kind of work (`all`, `task`, `firstmate`, `other`) in tokens and dollars at once, so switching the unit asks nothing new.

- **Work.**
  `firstmate` is the first mate's own task id; `task` is any record whose task is on the record, its supporting model calls (classifiers, decisions made for it) included; `other` is everything else, a call made for no task or for a task the record no longer has.
  Usage is never dropped for want of a task.
- **Days.**
  The ledger is grouped by local calendar day; a period covers every day through today, which is still partial, and all time starts on the first day anything was recorded.
  A day with no records is no activity, not a measured zero.
- **Amounts.**
  Every amount carries the four token categories, each counted once, the records it sums, how many reported tokens, per-category reporting counts (`tokenReported`), the known estimate over the priced records, and how many were priced and split by category (`usageAmountSchema`).
  A token category no record reported reads Not available, distinct from a reported zero.
  Coverage counts include explicit zeros and use all records as their denominator, independently of pricing.
  Older homes may omit `tokenReported`; clients disclose unavailable coverage rather than inferring it from the any-token `counted` flag.
  An amount with nothing priced has a null estimate, which the tab shows as Not available.
  The total, the days and the models each add up to the same aggregate (`usageStore.test.ts`).
- **Models.**
  One row per provider and recorded model, never the newest model of a task, named by the name Settings gives it (`modelNames`) and its provider's name, a connected custom API by its connection name.
  `attribution` is the weakest naming among its records, and `priceSources` where its estimates came from.
- **Where it went.**
  `where` holds the first mate, each project's task work, and other work.
  A project carries its subtotal and the same usage by the kind of work its tasks' shapes saved (`tasks.shape_json`): plan, research, retrieval, reproduce, teach, implement, fix, chore or review.
  A task with no saved kind, `unclear`, or a kind the list does not know is null, other task work in its project; nothing guesses a kind from a title.
  A task whose project the record no longer has sums under a null project.
  The first mate, the project subtotals and other work add up to the total, and a project's kinds add up to its subtotal, never to more.
  Each model's `where` is the same grouping over that model's records alone.
  `places` still names the first mate, other work and the largest tasks by tokens and by estimate, for the published summary's clients; the tab reads `where`.
- **Finished work.**
  A task counts as finished when it is done, not an operation, has a crewmate and started, closed within the period; `finishedEver` counts the same over all retained history.
  Dropped tasks and unstarted grouping parents never count.

## Recent tasks

`UsageStore.tasks({ period, scope, limit }, { now })` answers the tasks with recorded usage in the period and work, newest created first.
Only `all` and `task` work has tasks; the first mate and other work are never one.
A tie on the moment a task was created breaks by task id, so a longer read lists a shorter one's tasks first, in the same order, and a refresh neither repeats nor skips one.
It answers the first `limit` of them, at most `USAGE_TASKS_MAX`, and `matching`, how many there are.
Each task carries its key, title and project, when it was created, its amount over the period alone (its supporting model calls included once), and how many records reported each token category (`reported`) and how many priced records split their estimate into each (`costReported`), so a category no record reported is told from a measured zero.

## The tab

The captain's design (FI3-925, Overview): the header with the Tokens / Estimated $ switch, Period and Work, a coverage notice, three readouts, the daily bars with their Daily values table, tokens per model beside Where it went, a model's details, and the milestone strip.
FI3-993 took the lines from between rows, grouped Where it went by project, and added Recent tasks under the milestone strip.

- Where it went lists the first mate first whenever the work includes it, "No activity" when it has no record, then each project by its subtotal with its kinds of work beneath it under category names (Plans, Research, Lookups, Issue reproduction, Implementation, Fixes, Maintenance, Reviews, Other task work), then other work.
  Projects and kinds go largest first in the unit shown, those with no value in it after, and names break ties.
- Recent tasks lists ten tasks, then ten more each time See more is chosen, each with Input, Output, Cache read, Cache write and Total in full in the unit shown.
  A category no record reported reads "Not available", and one some records reported says how many; in dollars only an estimate's recorded parts appear, never a total split after the fact.
  The list starts over at ten when the period or the work changes and stays as it is when the unit does; a read that fails keeps the tasks shown and offers Try again.

- The unit switch changes every amount together, within Usage only; counts stay counts.
  The core keeps it (`appearance.usageUnit`); Usage opens in tokens until the captain picks dollars.
  Period and Work start over at the last 30 days and all work on every opening.
- Token totals count known categories only; incomplete coverage turns the notice into a warning with reporting counts for input, output, cache read and cache write.
  Model details show each category’s reporting count beside its value, including zero reporting records.
  Complete token selections also disclose the four category reporting counts in the notice.
- Estimated dollars are approximate pay-as-you-go value, never a bill, a share of a subscription, an allowance or savings; a partial total says how many records it covers.
- Milestones count finished tasks at 1, 10, 25 and 50 over all retained history, and keep the last reached after 50.
  There are no streaks, scores, notifications, token targets or anything that rewards spending more.
- Usage is this Mac's own: a Mac that controls another has no Usage tab, and its two commands refuse there.
- It re-reads after every model response and task change while it is open.

## Keys

Usage works from the keyboard (`docs/keyboard.md`).
Open Usage (`settings.usage`) opens Settings at Usage from anywhere with focus on the unit switch; Switch Usage units (`usage.unit`) switches the unit and opens Usage.
Neither has a default key.
In the tab the unit switch takes the arrows, Tab reaches Period, Work, Daily values and each model; Enter or Space on a model opens its details with focus on Close details, and Escape closes them and puts focus back on the model, leaving Settings open.
Each recent task's key is a link to that task, a Tab stop of its own (FI3-1271; the design skill's core rule "Task keys"): resting on it or focusing it opens the task's summary, and a click or Enter leaves Settings and opens the task on the main view.
Tab reaches See more under the recent tasks, past their keys; Enter or Space adds the next ten and puts focus on the first of them, and the count under the list is announced.

## Tests

- `src/core/claude/claudeEvents.test.ts` ("a turn's usage, model by model"): each model's share, running totals, a result reported twice, a client that starts over, a turn that names no model.
- `src/core/pi/piEvents.test.ts`: the listed-prices estimate and its split, and no cost for a model with no listed prices.
- `src/core/storage/usageStore.test.ts`: one row per served model; the summary reconciles days, models and where it went to one total, names models and places, groups by project and saved kind, counts finished work, filters, and answers an empty ledger; recent tasks in order, ties, limits, the period and each category's reporting.
- `src/core/storage/db.test.ts` ("migration 66").
- `src/renderer/src/settings/usageWords.test.ts`: every printed word and number.
- `src/renderer/src/settings/UsageTab.test.tsx`: the recent tasks while a read is out, after one fails, with nothing to list, and with more to show.
- `tests/e2e/usage.spec.ts`: a real first mate turn lands in the ledger, and the captain opens Usage, switches units, filters, opens and closes a model's details and finds the unit kept after a reload, all by keys; over a seeded ledger, Where it went lists the first mate, each project and other work, and See more adds ten tasks at a time by keys, kept across a unit switch and started over by a new period.
  `tests/e2e/usage.ts` holds its hooks and the seeded ledger.

## Historical context-shortening records

The recording fix applies to new completed calls only; opening an existing session does not replay or import its saved usage.
Historical recovery requires a separately approved import, not a migration or an automatic rewrite.
A recovery proposal must inventory app-owned saved compaction entries read-only, identify each call by session and entry ID, and verify its task, serving account, requested model and original completion time from saved facts.
Duplicate copies of a session or branch must resolve to the same call identity; a new call with identical usage is still a different call.
Only original reported token categories and cost parts may be imported, with absent categories left unknown and unpriced zero estimates left unpriced.
No model, account, tariff or completion time may be guessed from a task's current settings.
Ambiguous attribution, malformed entries and calls already represented in the ledger must be held out and listed with reasons.
The proposed import must preview affected task, day, model and project totals, retain provenance per call and demonstrate an idempotent second run on a disposable database before approval.
The current ledger has no historical compaction identity, so equal amounts or nearby timestamps alone cannot prove a call is missing or already recorded.
No historical import is implemented or authorized by the live recording fix.

## Reported thinking counts

Pi's optional reasoning count crosses the shared turn event and is stored in `usage_events.reasoning`.
It is already part of output tokens, so existing category totals and price calculations never add it again.
Missing remains null in saved records; there is no separate Usage column or historical repricing.
