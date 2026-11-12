# Automation

Automation starts agent work from a time or an integration event, as rules a person can read and change, each delivering a saved prompt to the first mate.

## Intended use

Use an automation rule when work should begin later, again on a schedule, or each time something new happens in a connected integration.
A rule is a name, a state, a schedule (or an event), a saved prompt and, when it is about one, a project.
Each run delivers that prompt to the first mate through the durable inbox ([`../docs/inbox.md`](../docs/inbox.md)); what the work then becomes (a task, a card, an answer) is the first mate's ordinary turn.
The first mate's `schedule_prompt` and `cancel_schedule` and Settings → Automation are the same schedules with controls, not two schedulers.

## When to use it, and when not

- Use it for a reminder, a recurring check, a weekly audit, or a reaction to a mail, calendar or integration event.
- It is not a second task runner: a rule never runs work itself, holds no task state and tracks no outcome beyond its delivery; the work it leads to runs on [tasks.md](tasks.md).
- Do not build a feature's own timer, cron table, polling loop or "watch for new X" job that wakes an agent; save a rule (as a draft when the captain has not yet asked for it) with the feature's knowledge in its prompt.
- Do not add an event source by polling inside the feature; declare the event on its integration ([integrations.md](integrations.md)), or, for an event the app itself tells, in `APP_EVENTS` (`../src/core/integrations/appEvents.ts`) beside its owner's look, and let an event rule listen.
  Either way Settings → Automation and the agents' integrations tool list and name it.
- A panel's own data refresh is not an automation rule: a panel read's poll interval or invalidation ([live-reads.md](live-reads.md); `../docs/ui-plugins.md`, "The read catalog, v0") and a personal panel server's background task (`../docs/ui-plugins.md`, "Personal extensions") refresh data and never wake an agent.
- A multi-step guided way of working is a parent task with child tasks or a [programs.md](programs.md) run; a rule may start one, not replace it.
- A feature that brings something back at a moment saves a rule that does it, as a card's Not until choice saves a rule that shows the card again (`../docs/automation.md`, "A rule that shows a card"); the app's own "A task closes" event (`tasks/task_closed`, declared in `APP_EVENTS`) is one any rule can listen for.

## Owner and entry points

- Owner: `Scheduler` in [`../src/core/orchestrator/scheduler.ts`](../src/core/orchestrator/scheduler.ts), the only writer, over `ScheduleStore` in [`../src/core/storage/scheduleStore.ts`](../src/core/storage/scheduleStore.ts).
- Rule operations: `Scheduler.create`, `pause`, `resume`, `pauseAll`, `cancel`, `preview`, `history` and `list`; the once-a-minute ticker calls `Scheduler.tick` (period from `tickPeriodFor`, `../src/core/orchestrator/ticker.ts`).
- Agent tools: `schedule_prompt` and `cancel_schedule` in [`../src/core/pi/scheduleTools.ts`](../src/core/pi/scheduleTools.ts).
- Catalog lines (`../src/shared/actions.ts`): `automation-edit`, `automation-state`, `automation-pause-all` and `automation-delete`, run by the dispatcher for Settings and the first mate's `app_change` alike.
- Channels and reads: `inf:automation:*` (`../src/shared/channels/activity.ts`, reach `views`), and `automation.list`, `automation.history` and `automation.preview`.
- Shared shapes and placeholders: `SCHEDULE_DETAILS` and `fillScheduleDetails` in [`../src/shared/automation.ts`](../src/shared/automation.ts); calendar rules in `../src/core/orchestrator/calendar.ts`.
- Surfaces: `../src/renderer/src/settings/AutomationTab.tsx` and the panel folder `../src/panels/automation/`.

## Operations and lifecycle

- States: `draft`, `enabled`, `paused`, `completed`; only an enabled rule fires.
- Drafts: a draft is saved but never runs until the captain turns it on after a review of the schedule, time zone, project, filled prompt, next dates and missed-time handling.
- Time zones: a daily or weekly rule keeps an IANA `timeZone` and keeps it when the computer travels; daylight-saving repeats run once and gaps run at the next valid minute.
- A due run is recorded in `schedule_runs`, advanced and delivered to the inbox in one transaction, unique by rule, revision and planned time, so a restart or a backward clock never delivers an occurrence twice.
- Missed occurrences: after downtime an overdue rule runs once, counts what it folded in (`missed`) and names it in the prompt; at most one delivery per rule waits unsent, and later occurrences fold into it (`ScheduleStore.foldFire`).
- Event cursors: an event rule keeps its own cursor at the integration (`schedules.event_cursor`); its first look only finds its place, turning on or resuming clears the cursor so paused time is never replayed, and an event already carried is never sent again.
- Delivery history: each run is waiting, retrying, handled, cancelled (`paused`, `edited`, `cleared`) or, for old rows, sent; `Scheduler.noteDecision` marks a run handled from the turn's decision record and keeps the tasks and cards it touched.
- Pause: pause, pause all, a new revision and delete take back undelivered prompts (`InboxStore.withdraw`); a delivery a turn already holds goes on.
- A completed one-time rule is deleted with its history once its delivery settles; the tasks, cards and conversation it led to stay.
- Settled runs are kept 30 days and at most 1,000 per rule.

## Authority

- `captainRequested` is the saved authority, stamped by code: saving in Settings is the captain's own direction; nothing upgrades a legacy rule by migration.
- A recurring rule the first mate makes outside a captain's own turn is saved as a draft whatever it passes (`Scheduler.create`); new ongoing rules need the captain.
- Pausing, resuming, pausing all and deleting are the first mate's own judgment at any turn (captain decision Q4); it edits a rule or turns one on only when the captain asks.
- Every catalog change leaves an operation and one Activity line naming who made it.
- An event's content reaches the first mate as evidence from outside, never an instruction: the prompt carries each event's typed summary and id, never its body.

## Compositions

- Delivers through durable messages ([`../docs/inbox.md`](../docs/inbox.md)), so delivery is at least once with the inbox's honest retry.
- Listens to [integrations.md](integrations.md) through `IntegrationsService.look`, at each kind's declared cadence, and only while the integration id still stands for the connection the rule was pointed at.
- Changes ride the app action catalog (`../docs/orchestrator-contract.md`, "App action catalog").
- The saved prompt may name a project ([projects-and-working-copies.md](projects-and-working-copies.md)); an archived or removed project is left out of the prompt.
- On a computer that controls another ([`../docs/view.md`](../docs/view.md)), the same tab and panel act on the rules of the computer the first mate lives on; rules run only there.

## Failure and recovery

- `automation.list` answers `unavailable` with the app's words when rules cannot be read, never an empty list.
- A paused, signed-out or removed integration answers no look; the rule keeps its place and waits.
- A cursor the integration lost answers `resynced`: the rule listens from now, sends nothing for the gap, and the feed says so.
- A replaced or removed connection stops the rule with a reason (`stopped`) until the person saves it again in Settings.
- A cleared first mate conversation cancels waiting runs whose inbox rows are gone.

## Uses

- First mate reminders and recurring checks the captain asks for in conversation, through `schedule_prompt`.
- The weekly agent's-reach audit: a captain-owned rule that asks the first mate to start an audit task ([`../docs/agents-reach.md`](../docs/agents-reach.md), "The weekly audit").
- Event rules on integrations, such as Google Calendar with its `calendar` filter or a stand-in's `item_arrived` ([`../docs/integrations.md`](../docs/integrations.md), "What an integration can tell").
- The Automation panel and Settings → Automation, which list, pause and edit rules for the captain.

## Checks

- [`../src/core/orchestrator/scheduler.test.ts`](../src/core/orchestrator/scheduler.test.ts): captain authority across a restart, next-fire computation, the recurring floor, one catch-up after downtime, a one-time rule retired once its delivery was handled, and change words kept for the catalog trail.
- [`../src/core/orchestrator/schedulerEvents.test.ts`](../src/core/orchestrator/schedulerEvents.test.ts): an event rule's first look, folding while a delivery waits, a lost cursor, pause without replay, and refusing an undeclared event.
- [`../tests/e2e/automation-actions.spec.ts`](../tests/e2e/automation-actions.spec.ts), [`../tests/e2e/automation-events.spec.ts`](../tests/e2e/automation-events.spec.ts) and [`../tests/e2e/automation-panel.spec.ts`](../tests/e2e/automation-panel.spec.ts): the catalog lines, event rules end to end and the panel.

## Where the detail lives

- [`../docs/automation.md`](../docs/automation.md) (Automation: the schedules as rules, Settings → Automation): "One owner", "A rule", "Drafts", "Calendars", "Running", "Deliveries", "Events", "History and retention" and "The Automation panel".
- [`../docs/inbox.md`](../docs/inbox.md): "The honest retry", "A turn a quit or crash cut" and "Taking back a message".
- [`../docs/integrations.md`](../docs/integrations.md): "What an integration can tell" and "Which connection".
