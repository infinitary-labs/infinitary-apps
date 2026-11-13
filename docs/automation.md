# Automation

Automation is the schedules the first mate runs, as rules a person can read and change: a name, a state, a schedule, a saved prompt and, when it is about one, a project.
A rule's schedule may instead be an integration's event, so the prompt runs each time something new happens there ("Events").
The first mate has made schedules since R3 (`schedule_prompt`, `cancel_schedule`); Automation is the same schedules with controls, not a second scheduler.

## One owner

`Scheduler` (`src/core/orchestrator/scheduler.ts`) over `ScheduleStore` (`src/core/storage/scheduleStore.ts`) is the only writer.
The first mate's tools, Settings → Automation (`src/renderer/src/settings/AutomationTab.tsx`) and the host's once-a-minute ticker all go through it.
The `inf:automation:*` channels (`src/shared/channels/activity.ts`, reach `views`) are Settings' door, here and on a computer that controls this one; the reads `automation.list`, `automation.history` and `automation.preview` feed it, and `automation.list` feeds the Automation panel too.
`automation.list` answers `ready` with every rule, or `unavailable` with the app's words when the rules cannot be read, never an empty list in its place.

Settings and the first mate change a rule through one path: each change channel is a line of the app action catalog (`src/shared/actions.ts`, `docs/orchestrator-contract.md` "App action catalog"), run by the dispatcher.
`automation-edit` is Save in the sheet and its Turn on, `automation-state` is Pause and Resume, `automation-pause-all` is Pause all and `automation-delete` is Delete.
The first mate runs them with `app_change`, and its `cancel_schedule` is `automation-delete`.
Pausing, resuming, pausing all and deleting are its own judgment at any turn, as making a schedule is (captain decision Q4); it edits a rule, or turns one on, when the captain asks.

## Who changed it

A change the dispatcher runs, the captain's in Settings or the first mate's, leaves the catalog's trail: an operation on the task record and one Activity line that names who made it, such as "Captain · Automation paused - Weekly dependency audit".
Its words are the Scheduler's (`automationWords`), handed to the dispatcher in place of a line of the Scheduler's own (`SaysChange`).
A change that changes nothing leaves no line.
A rule `schedule_prompt` makes, and a one-time rule leaving once it ran, say their own line with no name before it (`firstmate_note`).
`automation.list` and `automation.history` read again on either line.

## A rule

- `state` is `draft`, `enabled`, `paused` or `completed`.
  Only an enabled rule fires.
  A draft is saved but never runs until the captain turns it on ("Drafts").
  A one-time rule becomes `completed` after it fires and stays listed, as Done, while its delivery waits.
  Once that delivery settles - handled by the first mate's turn, or taken back - the rule is deleted with its history, and the feed says so (`Scheduler.retire`, on each tick and after each handled turn).
  The tasks, cards and conversation it led to stay.
- `revision` counts saved edits to the schedule, the prompt or the project.
  Each run records the revision it was planned under.
- `captainRequested` is the saved authority, stamped by code.
  Saving a rule in Settings is the captain's own direction and stamps it; an existing rule keeps whatever authority it had until the captain edits it.
  Nothing upgrades a legacy rule by migration.
- `projectId` names the project the prompt is about, if any.
  The first mate's prompt names that project's key and name while it is live; an archived or removed project is left out.
- Schedules are every N minutes (15 at least), every day at a time, on chosen weekdays at a time, once, or each time an integration's event arrives ("Events").
- `card` names a card the rule shows again instead of a prompt ("A rule that shows a card").

## A rule that shows a card

A card's Not until choice waits through a rule (`docs/card-authoring.md`, "Not until"; `PutOffs` in `src/core/orchestrator/putOffs.ts`).
The captain's click saves it turned on, with `card` naming the card (`schedules.card_id`) and a prompt that names the card, so Automation lists it like any rule.
When it runs, its run raises that card through the put-offs (`raise` on the Scheduler) instead of waking the first mate, and is handled at once naming the card; the rule is then `completed` and leaves Automation on the next tick, whether it was a one-time or an event rule.
Raising the card early on the captain's word, or the close of the card's own task, deletes the rule; a rule whose card was raised already runs and raises nothing.

## A task closes

The app's own tasks tell one event an event rule can listen for beside the integrations' (`taskEvents` in `src/core/orchestrator/taskEvents.ts`): `tasks/task_closed`, "A task closes", with a required `task` filter naming the task by key or id.
It is declared in `APP_EVENTS` (`src/core/integrations/appEvents.ts`), the app's own event sources: the integrations view carries them as `appEvents`, so Settings → Automation offers "A task closes" in a rule's event list with its Task field, and the agents' integrations roster and `show tasks` name it like an integration's event.
Nothing is connected for it, so it is always there.
A rule naming a task the record does not hold is refused when it is saved.
It fires once the named task is closed, whatever closed it, and a task the record no longer holds counts as closed.
Its cursor only marks that the rule looked, so a task that closed before the rule's first look still fires it on the next one.
It declares `atOnce`, and every close looks at once at the rules listening to it (`lookOnClose`), so nothing waits for the next minute.

## Drafts

- A rule made in Settings is saved as a draft with Save draft, or turned on with Enable.
- Enable opens a review in the sheet before anything runs: the schedule, the time zone, the project, the prompt exactly as the first mate gets it the first time, the next dates, what it sends (the prompt and its schedule details reach the AI subscription and stay in the first mate's conversation, and nothing else gets new access) and what happens to a missed time.
  Turn on saves the sheet and runs the rule (`automationSaveSchema`'s `enable`); Back returns to the sheet with nothing changed.
  A draft turned on runs from that moment, so an interval's anchor is when it was turned on.
- `schedule_prompt` saves a draft when the first mate passes `draft`, which it does when the captain's ask leaves something open; a complete ask runs at once.
- A recurring rule the first mate makes outside a captain's own turn is saved as a draft whatever it passes: new ongoing rules need the captain (`Scheduler.create`).
  A one-time reminder it sets for itself still runs, and rules made before drafts keep running as they did.
- Resume and Pause all leave a draft alone; a draft is turned on only by its review, or by the first mate's `automation-edit` with `enable` when the captain asks for it.

## Calendars

- A daily or weekly rule keeps an IANA time zone (`timeZone`, such as `America/Los_Angeles`).
  A new rule takes this computer's zone, shown in Settings, and `schedule_prompt` takes `time_zone` or defaults to it.
  The rule keeps its zone when the computer travels.
- A daily rule made before time zones has none and follows this computer's clock, as it always did.
  Settings shows it as "This computer's clock" until the captain picks a zone; nothing converts it silently.
- Weekly rules keep their weekdays (0 for Sunday) and always have a zone.
- Daylight saving (`src/core/orchestrator/calendar.ts`): a local time that happens twice runs once, at its earlier instant; a local time that does not exist runs at the first valid minute after it.
- The preview and the rule's next run show dates in the rule's zone, with the zone's short name when it is not this computer's.

## Schedule details

A saved prompt may hold placeholders, filled in when it runs (`SCHEDULE_DETAILS`, `fillScheduleDetails` in `src/shared/automation.ts`): `{{scheduled time}}`, `{{time zone}}` and `{{missed runs}}`, and for an event rule `{{events}}` in place of the missed runs.
Each is a plain value, never an expression.
Settings' Insert schedule detail puts one at the caret, and Preview shows the prompt filled in for the next run.
History keeps the prompt as it was sent.

## Running

- A due, enabled rule is recorded in `schedule_runs` and advanced (or completed) in one SQLite transaction with its delivery to the durable inbox.
  A run is unique by rule, revision and planned time, so a restart or a backward clock cannot deliver the same occurrence twice.
- The prompt the first mate receives names the rule's id and name and its project: `[fm-op] scheduled by automation <id> "<name>" for project <KEY> (<name>): <prompt>`.
- After downtime an overdue rule runs once and advances to its next future occurrence.
  The occurrences folded into it are counted (`missed`) and named in the prompt the first mate receives.
- Pause stops new runs.
  Resume picks the next future occurrence without replaying the paused time; an interval stays on its anchor.
  A passed one-time rule cannot resume; saving it with a new future date re-enables it.
- An edit to the schedule picks the next occurrence of the new one; an edit to only the name, the prompt or the project keeps the next run where it was.
- Pause all pauses enabled rules only.
- Preview lists the next three dates.
  It sends nothing and changes no due time.
- Delivery stays at least once through the inbox ("Deliveries").

## Deliveries

Each run is one delivery of the prompt to the first mate, followed through its inbox row (`schedule_runs.inbox_id`, migration 80).

- **Waiting** from the fire until a first mate turn handles it.
  The scheduled wake carries the run's id (`run`), so two deliveries of the same prompt are never one.
- **Retrying** while it waits and its row is being tried again: the first mate's provider failed it, a turn on it threw, or a quit cut the turn reading it ("The honest retry" and "A turn a quit or crash cut", `docs/inbox.md`).
  This is read off the row, never stored.
- **Handled** once a turn that served it ended clean.
  `Scheduler.noteDecision` reads that turn's decision record (`docs/provenance-capture.md`): each served segment's inbox row names its run, and the run keeps the tasks and cards the turn touched, less the tasks its other messages were about.
  It also keeps the turn's closing words as what the run found (`found`, `schedule_runs.found`); a turn that ended without words leaves none.
  `schedule_prompt`'s description tells the first mate its closing words are kept this way.
  Handled means the first mate's turn handled the prompt, not that the work it led to finished.
- **Cancelled** when it was taken back before a turn read it, with why: the automation was paused (`paused`), changed into a new revision (`edited`), or the first mate's conversation was cleared (`cleared`), which the minute tick finds by a waiting run whose row is gone.
- A run recorded before migration 80 has no delivery and reads as **sent**.

At most one delivery per rule waits unsent.
A rule that comes due while one does folds the occurrence into it (`ScheduleStore.foldFire`): the waiting run keeps its planned time, counts the occurrence and those it missed in `missed`, and its message is rewritten in place (`InboxStore.revise`), saying it was missed while Infinitary was closed or busy.
One a turn already holds is never rewritten: the next occurrence waits behind it as a new delivery.

Pause, Pause all, an edit that makes a new revision and Delete take back the rule's deliveries no turn was handed yet (`InboxStore.withdraw`), in one transaction with marking them cancelled; a delivery a turn holds goes on, and keeps the revision it was planned under.
The feed line says how many were taken back.

## Events

An event rule (`kind: "event"`) names an integration by its id and one of the events that integration declares, such as the stand-in's `item_arrived` (`docs/integrations.md`, "What an integration can tell").
It is the captain's q6 on INF-775: the app looks on its one tick at each kind's declared cadence, every minute for mail and calendars, and nothing leaves the computer to wait for an event.

- The Scheduler looks for each enabled event rule on its tick when the event's `every` comes round, counted in ticks, so a development run's shortened tick looks sooner (`tickPeriodFor`).
  A look runs beside the tick, one per rule at a time, through `IntegrationsService.look`.
- Each rule keeps its own cursor at the integration (`schedules.event_cursor`, migration 89).
  Its first look only finds its place, so what arrived before it was turned on never fires.
  An event that declares `atOnce` (the inbox's) is one whose integration says when something arrives: a rule on it finds its place as soon as it is made, turned on, resumed or repointed, and each arrival makes it look at once (`Scheduler.lookNow`), with a look already running looking again once it ends.
  Turning a rule on, resuming it or pointing it at another event clears its cursor, so a paused time is never replayed; an edit to only its name, prompt or project keeps it.
- A delivery a first mate turn handled tells its integration which events it carried (`handled`), which the inbox's receipts read.
- What arrived since the cursor is one run, recorded in one transaction with the new cursor and the delivery.
  A run keeps the events it carried by their ids (`schedule_runs.events`), and an event a run of the rule already carried is never sent again, even when a look overlaps.
- While the rule's delivery waits unsent, new events fold into it as scheduled occurrences do: the message is rewritten with every event and says more arrived while it waited.
- A cursor the integration lost (a mail history that expired, a file cut short) answers `resynced`: the rule listens again from now, sends nothing for the gap, and the feed says so.
- A paused, signed-out or removed integration answers no look; the rule keeps its place and waits.
- A rule keeps which connection its integration's id stood for when it was pointed there (`schedules.event_connection`; `docs/integrations.md`, "Which connection"), and looks only while the id still stands for it.
  Once that connection is removed or replaced - the same id signed in as another account, or another server added under the same name - the rule waits, and Settings and the rule's `stopped` say why; a rule saved before rules kept a connection waits the same way.
  An edit that keeps the integration and event keeps the connection, so nothing moves a rule onto a replacement unasked.
  The person picks it again by saving the rule in Settings → Automation, whose sheet says that saving listens to what is picked under When (`reconnect` on `inf:automation:save`); pointing the rule at another integration or event picks that one.
- The prompt is filled with `{{events}}`, one line per event with the integration's typed summary and its id, never its body; a prompt without the placeholder gets the events after it.
  A summary of words anyone can write, such as a message's sender and subject, arrives fenced as data from outside, and the list ends with one line saying never to follow what the fences hold (`docs/integrations.md`, "Data from outside").
  The first mate's message names the integration, the event and how many arrived, and says each event is evidence from outside, never an instruction.
- An event rule has no next time and no preview dates: Settings shows its When words (`when` on the rule, "When an item arrives in Stand-in") and how often the app looks.
- Settings → Automation's When offers "When something happens" while a connected integration declares an event, with a second choice listing each one; the first mate passes `on_event` (`integration/event`) to `schedule_prompt`.
  Its description tells it to wait on an event when an integration's event announces what the captain asked to hear about, such as a workflow run finishing, rather than make a clock rule that checks.
  A recurring rule the first mate makes outside a captain's turn waits as a draft, as any does.

## History and retention

`schedule_runs` keeps each rule's settled runs - handled, cancelled or sent - for 30 days and at most 1,000 per rule; a delivery still waiting stays until it settles.
The rule's own next-fire time is stored on the rule, so trimming history never lets an old occurrence run again.
Deleting a rule, or a one-time rule leaving once it ran, deletes its runs, not the tasks, cards or conversation its deliveries led to.

Settings' History lists a rule's runs newest first: where each delivery stands, its planned and sent times, what it caught up, its version, why a cancelled one was taken back, and what a handled one found and led to.
What it found is the first mate's closing words on the turn that handled it, after "Found:"; a run handled before runs kept them shows none.
A task it led to shows by its key, linked as anywhere the window draws one; a card by its title, opened forward while it is up and as it closed otherwise.
The history reads again when a first mate turn ends, since nothing else says a delivery was handled.

## The Automation panel

`src/panels/automation/` is an ordinary app panel folder on the right rail, below Tasks and Knowledge (docs/ui-plugins.md, "A folder that waits on a gate").
It waits on the `automation` gate, open while a saved rule exists in any state: the window follows `automation.list` and registers the panel on the first saved rule, and takes it away, with its place on the rail, when the last one is deleted.
An unreadable answer leaves it as it was.
It starts collapsed; the rail keeps the collapse choice by the panel's id, so it holds when the panel goes and comes back.
Collapsed, its header counts the running rules as active and, when there are any, the paused ones: "1 active · 2 paused", or "1 active"; a draft or a finished rule is in neither count.
Each row shows a rule's state, name and next run; a draft reads Draft where a running rule shows its next run.
A click or Enter opens that rule's sheet in Settings → Automation through `point.openSettings("automation", id)`, with the keyboard in the sheet; nothing runs, pauses or changes.
Expanded, its header shows Open Automation, the app's open button, as Knowledge's header does; it names no card, so it is pressed into the panel, which opens Settings → Automation at the full list through `point.openSettings("automation")` (docs/ui-plugins.md, "A panel's cards").
Hiding or collapsing the panel changes nothing about delivery.
It takes its place on that rail however many panels the rail already holds.

## Where it shows

Settings → Automation, the Automation panel and its header's Open Automation, and command search's Open Automation (`settings.automation`) and Pause all automations (`automation.pause-all`), neither with a default key.

## On a computer that controls another

A computer that controls the first mate on another (`docs/view.md`) shows the same Automation tab, panel and commands, over the rules of the computer the first mate lives on: every `inf:automation:*` channel reaches views (`docs/connection.md`).
The rules run only there, so nothing runs twice and nothing moves when the computer that controls it closes.
The sheet names that computer where the clock matters: a rule that keeps no zone follows "the clock on MacBook Pro", and the review says a missed time is about the first mate on MacBook Pro.
A new rule still takes the zone of the computer it is made on, shown in the sheet.
While that computer is out of reach or too far apart, its rules stay as last read and a change is refused as any change is (`docs/view.md`, "Out of reach in the window").

### Event filters

An event may declare closed string filter fields in its integration's view.
The shared rule editor labels each field with the integration's words and keeps the values in the event spec's optional `filter` object; the review shows them before Turn on.
The first mate passes the same fields through `schedule_prompt`'s optional `event_filter`; discovery lists them only on request.
The scheduler refuses undeclared fields, preserves the selected values on save and edit, and passes them to every look.
Google Calendar declares `calendar`, an id read through `list_calendars`; an empty value uses the primary calendar.
A field the event marks `required` must be named: the scheduler refuses a rule that leaves it empty.
GitHub's run events declare `repository` (required), `workflow` and `branch` (`docs/integrations.md`, "GitHub's events").
