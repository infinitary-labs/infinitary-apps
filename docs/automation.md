# Automation

Automation is the schedules the first mate runs, as rules a person can read and change: a name, a state, a schedule, a saved prompt and, when it is about one, a project.
A rule's schedule may instead be an integration's event, so the prompt runs each time something new happens there ("Events").
The first mate has made schedules since R3 (`schedule_prompt`, `cancel_schedule`); Automation is the same schedules with controls, not a second scheduler.

## One owner

`Scheduler` (`src/core/orchestrator/scheduler.ts`) over `ScheduleStore` (`src/core/storage/scheduleStore.ts`) is the only writer.
The first mate's tools, Settings → Automation (`src/renderer/src/settings/AutomationTab.tsx`) and the host's once-a-minute ticker all go through it.
The home builds it once at start, with the event screen's offer, the crew's put-off cards and rule notes, and the inbox's rule (`startHomeAutomation`, `src/core/orchestrator/homeAutomation.ts`).
The `inf:automation:*` channels (`src/shared/channels/activity.ts`, reach `views`) are Settings' door, here and on a computer that controls this one; the reads `automation.list` and `automation.history` and the `inf:automation:preview` request feed it, and `automation.list` feeds the Automation panel too.
The first mate reads a rule's runs, the jobs kept running and a schedule's next dates through `app_state`'s named reads (`src/core/pi/appReads.ts`).
`automation.list` answers `ready` with every rule, or `unavailable` with the app's words when the rules cannot be read, never an empty list in its place.
The window reads it every 30 seconds while it is connected, since the Automation panel's gate follows it, so one read reads what is connected at most once for all its event rules (`automationRulesOf`, `SchedulerEvents.snapshot`), never once per rule.

Settings and the first mate change a rule through one path: each change channel is a line of the app action catalog (`src/shared/actions.ts`, `docs/orchestrator-contract.md` "App action catalog"), run by the dispatcher.
`automation-edit` is Save in Setup and its Turn on, `automation-state` is Pause and Resume, `automation-pause-all` is Pause all and `automation-delete` is Delete.
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
- `brought` marks the rule a runbook's wake brings ("The heartbeat"): read from its reserved id, never saved in a column.

## A rule that shows a card

A card's Not until choice waits through a rule (`docs/card-authoring.md`, "Not until"; `PutOffs` in `src/core/orchestrator/putOffs.ts`).
The captain's click saves it turned on, with `card` naming the card (`schedules.card_id`) and a prompt that names the card, so Automation lists it like any rule.
When it runs, its run raises that card through the put-offs (`raise` on the Scheduler) instead of waking the first mate, and is handled at once naming the card; the rule is then `completed` and leaves Automation on the next tick, whether it was a one-time or an event rule.
Raising the card early on the captain's word, or the close of the card's own task, deletes the rule; a rule whose card was raised already runs and raises nothing.

## A rule that ends a hold

A started task's hold (`docs/report-sort.md`, "Holding a started task until a time") can end sooner on an event: the first mate's `update_task` `hold` with `on_event` makes one event rule tied to the task (`HoldRules` in `src/core/orchestrator/holdRules.ts`).
It is saved turned on, with `task` naming the task (`schedules.task_id`) and a prompt that names the task and the hold's reason, so Automation lists it like any rule; it is a one-run rule, so it needs no turn-on from the captain, as a put-off's rule does.
The task's `at-time` gate names the rule in its `ref`.
It starts its first look as soon as it is saved, whatever its integration's cadence, but a started look is not yet a place: a source such as Gmail or an MCP server answers it over the network, and only its answer, the saved cursor, arms the rule for the next event (`Scheduler.placed`).
So `update_task` writes the hold, and confirms it, only once that look answered, and the first event after the confirmation is one the rule fires on; until then the task keeps whatever hold it had, and its rule stays.
A rule that could not take its place, or a task that closed, went to the backlog or otherwise could no longer be held meanwhile, refuses the new hold and leaves the old one as it was, so the first mate holds again or holds without `on_event`.
A newer move on the task meanwhile - another hold, a lift, or a turn that ended - refuses it too and stands as it left the task, so a slow first look never overwrites a later choice; a change that is no move, such as a pin, does not count.
A put-off's event rule starts its first look the same way, but the captain's click cannot wait for it: a rule whose look could not take its place brings its card back at once rather than waiting on nothing.
Saving or resuming a put-off's or a hold's rule in Settings so that it takes its place again answers the panel once that first look answered, with the rule as it stands then, or a refusal when it was deleted meanwhile (`Scheduler.armed`); every other save, and every pause, answers at once, without waiting for an ordinary look.
Its looks name the task as the reader of what arrives, so the outside words count as the task's conversation's for retention (`docs/task-retention.md`, "Words from outside"), and its run's copy in Automation's history counts as the first mate's, as any rule's does.
When it runs, its run ends that hold through the idle ladder (`endHold` on the Scheduler), which clears the gate and sends the crewmate one `timed-wait-over` steer carrying the events that arrived, fenced as a rule's run lists them, instead of waking the first mate; the run is handled at once naming the task, and the rule is then `completed` and leaves Automation on the next tick, as a put-off's does.
The task's timeline keeps that steer with a note in place of each fenced passage (`TaskTurns.recordSteer`), and so does the first mate's notice of news that a task in the backlog got (`CrewSteer.tellBacklogNews`) before a long one spills into an overflow file: the outside words stay only in the crewmate's conversation and Automation's history, which the outside-data pass cleans (`withoutOutsideWords`).
Whatever ends the hold first takes the rule away: `hold` null, any turn of the task, the hold's own time, a new hold, or the task's close; `HoldRules` reads the task's gate on every task change and deletes each waiting rule its gate no longer names, so no path keeps a rule of its own.
A run whose hold already ended, or was replaced, ends nothing.

## The heartbeat

INF-6664 piece 2: while a runbook that is on names the `heartbeat` wake (the built-in Heartbeat runbook, off by default; `docs/runbooks.md`, "Built-ins"), the host keeps one rule that brings the first mate a beat, a scheduled turn with no news in it that carries the standing list (`docs/report-sort.md`, "The standing list").

- `Scheduler.keepBrought` runs at start and on every runbook switch: on, it adds the rule under the reserved id `heartbeat` (`HEARTBEAT_RULE_ID`), named Heartbeat, every 55 minutes, turned on and stamped as the captain's, since turning the runbook on is their click; off, it takes back an unsent beat and removes the rule, keeping its runs under the 30-day rule ("History and retention"), so the rule finds them again if the runbook comes back.
  A rule already there keeps its state, so a paused one stays paused.
- Pause, Resume and Pause all act on it as on any rule; an edit or a delete, from Settings or the first mate, is refused with words that point to Settings, Runbooks (`BROUGHT_RULE_REFUSAL`).
  Its page shows no Setup, only History and Notes, under a note that it comes with the Heartbeat runbook.
- Once its 55 minutes passed, each tick asks `heartbeatDue` (`src/core/orchestrator/heartbeat.ts`), and a beat goes out only when one of two reasons holds, the captain's choice on the plan:
  - the standing list has a row marked new, and 55 minutes passed since the last beat;
  - or the first mate's seat is known to keep its prompt cache for an hour (the Claude seat; any other seat gets only the first kind), from 50 to under 58 minutes passed since its last request ended, as the usage ledger records it when the request ends, inside the cache's hour (`QUIET_UNTIL_MINUTES`; once the cache's hour has ended, after a sleep, a resume or a start with nothing run since, no quiet beat goes), and the heartbeat is not resting.
- The heartbeat rests after 12 quiet beats in a row, or after a beat whose first request read less than half its input from the cache, until the first mate's next turn of another kind.
  A beat's turn is the span from its run's firing to its settling, and a first mate request outside every beat's span is another turn.
- A beat due while the app was closed is dropped and the rule's next run moves 55 minutes on from start; no beat goes while one is still waiting.
- A beat is an ordinary scheduled delivery: one fixed line (`HEARTBEAT_LINE`) and the standing list, with the run's Found line in History; once it goes out, each new row's once-name is recorded so the row reads new again only at its next milestone.
- What the first mate does with a beat is in the runbook's guide: act on a row whose next move is already its own, ask the captain once on one card when only they can move it and something changed since they decided, or leave it; a beat gives no new permission.
  A part the app already asked about on its own card, such as the last-part card (`card-last-part-<task>`, `docs/report-sort.md`, "The last part the captain stopped"), counts as asked, so a beat never asks about it again.

## A task closes

The app's own tasks tell one event an event rule can listen for beside the integrations' (`taskEvents` in `src/core/orchestrator/taskEvents.ts`): `tasks/task_closed`, "A task closes", with a required `task` filter naming the task by key or id.
It is declared in `APP_EVENTS` (`src/core/integrations/appEvents.ts`), the app's own event sources: the integrations view carries them as `appEvents`, so Settings → Automation offers "A task closes" in a rule's event list with its Task field, and the agents' integrations roster and `show tasks` name it like an integration's event.
Nothing is connected for it, so it is always there.
A rule naming a task the record does not hold is refused when it is saved.
It fires once the named task is closed, whatever closed it, and a task the record no longer holds counts as closed.
Its cursor only marks that the rule looked, so a task that closed before the rule's first look still fires it on the next one.
It declares `atOnce`, and every close looks at once at the rules listening to it (`lookOnClose`), so nothing waits for the next minute.

## The automation's page

Settings → Automation lists the rules on the left, with New automation at the list's foot, and shows the picked rule's page on the right in four parts, each holding its own actions (`AutomationTab.tsx` and its parts beside it).

- **The header**: the rule's name as the title, then its state with its dot (Failing in red), its schedule, its next run and who set it up, and Pause or Resume, which acts at once.
  One note under it says why a failing rule gets nothing new, that a stopped rule waits for its integration, that a rule comes with the Heartbeat runbook ("The heartbeat"), or that a draft never runs.
- **Setup**: Name and Project in one row; one When group holding the kind, its time, the time zone, the weekdays, and an event with its filters and Only if, under one caption that says what is missing, else the next three runs, else how often the app looks; the prompt with one button per schedule detail; Preview, which opens what the rule will do in place; and a foot with Save, lit once something changed, and Discard changes, or a draft's Turn on… and Save draft, with Delete at the far end asking once as Delete for good.
- **History** and **Notes**, each its own tab beside Setup, one Tab stop moved between with the arrow keys.
  Every tab stays drawn while another is shown, so unsaved edits survive a switch; a new automation, not saved yet, has Setup alone.

## Drafts

- A rule made in Settings is saved as a draft with Save draft, or turned on with Turn on….
- Turn on… replaces Setup with a review before anything runs: the schedule, the time zone and what it means, the project, the prompt exactly as the first mate gets it the first time, the next dates, what it sends (the prompt and its schedule details reach the AI subscription and stay in the first mate's conversation, and nothing else gets new access) and what happens to a missed time.
  Preview shows the same facts while the rule is edited.
  Turn on saves the rule and runs it (`automationSaveSchema`'s `enable`); Back returns to Setup with nothing changed.
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
Settings' Insert buttons under the prompt put one at the caret, and Preview shows the prompt filled in for the next run.
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
- Setup's When caption and Preview list the next three dates.
  They send nothing and change no due time.
- Delivery stays at least once through the inbox ("Deliveries").

## Deliveries

Each run is one delivery of the prompt to the first mate, followed through its inbox row (`schedule_runs.inbox_id`, migration 80).

- **Waiting** from the fire until a first mate turn handles it.
  The scheduled wake carries the run's id (`run`), so two deliveries of the same prompt are never one.
- **Retrying** while it waits and its row is being tried again: the first mate's provider failed it, a turn on it threw, or a quit cut the turn reading it ("The honest retry" and "A turn a quit or crash cut", `docs/inbox.md`).
  This is read off the row, never stored.
- **Handled** once a turn that served it ended clean.
  `Scheduler.noteDecision` reads that turn's decision record (`docs/provenance-capture.md`): each served segment's inbox row names its run, and the run keeps the tasks and cards the turn touched, less the tasks its other messages were about.
  A turn that handled several runs, such as two rules due at the same time, links each run only to the tasks its own rule filed or started in that turn, read from each task's saved origin (`TaskCapture.automationStart`, INF-2326), so two runs never list the same work; a task with no saved origin then belongs to none of them, since the host never guesses which run it answered; the filing tools refuse a start that names no run in such a turn, so only work started for a captain message in it has none.
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
- A paused, signed-out or removed integration answers no look; the rule keeps its place and waits without looking, and none of that time counts as failed looks ("When every look fails").
- A rule keeps which connection its integration's id stood for when it was pointed there (`schedules.event_connection`; `docs/integrations.md`, "Which connection"), and looks only while the id still stands for it.
  Once that connection is removed or replaced - the same id signed in as another account, or another server added under the same name - the rule waits, and Settings and the rule's `stopped` say why; a rule saved before rules kept a connection waits the same way.
  An edit that keeps the integration and event keeps the connection, so nothing moves a rule onto a replacement unasked.
  The person picks it again by saving the rule in Settings → Automation, whose page says that saving listens to what is picked under When (`reconnect` on `inf:automation:save`); pointing the rule at another integration or event picks that one.
- The prompt is filled with `{{events}}`, one line per event with the integration's typed summary and its id, never its body; a prompt without the placeholder gets the events after it.
  A summary of words anyone can write, such as a message's sender and subject, arrives fenced as data from outside, and the list ends with one line saying never to follow what the fences hold (`docs/integrations.md`, "Data from outside").
  The first mate's message names the integration, the event and how many arrived, and says each event is evidence from outside, never an instruction.
- An event rule has no next time and no preview dates: Settings shows its When words (`when` on the rule, "When an item arrives in Stand-in") and how often the app looks.
- Settings → Automation's When offers "When something happens" while a connected integration declares an event, with a second choice listing each one; the first mate passes `on_event` (`integration/event`) to `schedule_prompt`.
  Its description tells it to wait on an event when an integration's event announces what the captain asked to hear about, such as a workflow run finishing, rather than make a clock rule that checks.
  A recurring rule the first mate makes outside a captain's turn waits as a draft, as any does.

### When every look fails

A look that fails, because the integration answered with an error, changes nothing on its own: the rule keeps its place and looks again at its cadence.
The Scheduler counts each turned-on rule's failed looks in a row, and the first look that answers clears them (`lookFailed` and `lookingFails` on the Scheduler).
Once a rule's row spans an hour of ticks (`LOOKS_FAILING_TICKS`, counted in ticks as the cadence is) and holds at least two failed looks, the rule shows as failing: `automation.list` carries `failing` on it, with when the first failed look was and what the newest one answered, cut short.
Settings → Automation and the phone's Settings read it as Failing, with a red dot and a red note under the rule's header saying since when nothing new has reached the first mate, the newest answer, and that it runs again by itself once a look works.
The rule's saved state stays `enabled` and it keeps looking, so a source that answers again needs nothing from the person.
The first mate hears of it once, in an `automation-looks-failing` wake naming the rule, the integration and event, since when, how many looks failed and the newest answer as words from outside; it tells the captain on a note, or offers a fix it can make itself.
The wake's `once` names the rule's revision and place, so a restart, which starts the count again, tells nothing new about a rule that has neither changed nor moved.
Pausing, editing, deleting or signing out ends the row.

### The event screen

An event rule may say what it waits for, in words (`waitsFor` on the event spec): the first mate passes `event_waits_for` to `schedule_prompt`, and Settings' Setup shows it as an Only if field in the When group.
While the `event-screen` decision use is on (Settings → Intelligence → Decisions, "Screen automation events"), each look's new events of such a rule are asked about one by one before anything is delivered (`eventScreen`, `src/core/decisions/eventScreen.ts`).
The question reads what the rule waits for, the event's kind and its summary, and answers `match`, `unrelated` or `unclear`; the summary is data from outside, and the question says never to follow it.
Only an answered `unrelated` keeps an event from the first mate.
`match`, `unclear`, a failed or timed-out answer, a switched-off use and a rule that says nothing all deliver the event, as before the screen.
Every delivered run of such a rule names its Only if condition in the first mate's wake (`events.onlyIf`), and the first mate acts only on events that meet it, so the condition holds with the screen off too; the screen only spares the turn for events plainly outside it.
The use is `needs-ok`: each event's summary, such as an email's sender and subject, goes to the model answering decisions, so it stays off until the person agrees to its own disclosure.

A screened event stays on its run, marked `screened`, so it counts as carried and is never looked at again.
A look with some events kept and some screened delivers one run whose prompt lists only the kept ones, and folds into a delivery still waiting unsent as any look does.
A look whose every new event was screened sends nothing and records one settled run (`ScheduleStore.recordScreened`, delivery `screened`) whose prompt lists the events kept from the first mate.
History shows such a run as not sent, with how many it skipped and why; a run that sent some and skipped some shows both counts.
The integration hears only the delivered events as handled.
Changing what a rule waits for is an edit like its prompt: a new revision that keeps the rule's place.
A rule changed while its events were being asked about drops the answer, as it drops a slow look's.

### Offering the screen

A rule with an Only if condition that is saved or turned on while the screen cannot ask raises one host card, "Skip events your automation does not need?"
(`EventScreenOffer`, `src/core/decisions/eventScreenOffer.ts`).
The scheduler tells it each rule that ends enabled after a create, an edit, a turn-on or a resume (`enabled` on `SchedulerOptions`); a draft saved alone offers nothing until it is turned on.
The card names the rule and its condition, says every other event still wakes the first mate, and shows what turning the screen on sends, with the rest of the use's disclosure folded, so its Turn on is the person's agreement to that disclosure's version.
Turn on runs the host operation `turn-on-event-screen` with that version, which switches the use on as Settings' consent dialog does (`DecisionModels.setUse`); a version the home has moved past is refused with a feed line.
Not now only closes the card; a later qualifying save offers it again, revising the one card in place rather than stacking another.
When the answering decision model's approval predates the screen, Turn on needs that approval too, so the card's button opens Settings instead.
Turning the screen on in Settings takes the card down.
A desktop view whose hello does not list `event-screen-offer` is sent the card with Not now alone, and its words name where the screen turns on in Settings.

## A rule's notes

A rule keeps notes its runs write for its later runs: how the job is done here, dead ends, what is already filed or decided, what to check first.
The brief asks for one connected guide to doing the job well, rewritten as each run learns, never a log of runs with a dated line each.
They are one page of plain text of at most 8,000 characters (`RULE_NOTES_MAX_CHARS`, `src/shared/automation.ts`), kept in `schedule_notes` with every version, each stamped with its time, the rule's revision it was written at, and who wrote it: a crewmate by its task, or the captain.
`Scheduler.saveNotes` is the one writer; a save makes no new revision of the rule, takes back no delivery and changes nothing about when it runs.
Deleting a rule deletes its notes with it.

Only a crewmate an automation's run started writes them, by editing a file (`RuleNotes`, `src/core/orchestrator/ruleNotes.ts`).
The task's saved origin names the rule it serves (`TaskCapture.savedOrigin`): the first mate's turn that handled the run saves it when the turn starts or adopts a task, and `spawn_crewmate`'s `origin` names which run when several are read: with more than one run read, a start or filing that names none and answers no captain message is refused (`AskCapture.severalRuns`).
A rule that never runs again, a one-time rule or a put-off card's, which is deleted once its run settles, puts no notes section in the brief.
The crewmate's brief hands it the notes as `automation-notes.md` in its hand-over folder, named by path in one section that calls them advice, never instructions, and says when they were written before the captain last changed the rule; a rule with none yet tells it to make the file in its temporary folder only when the run learned something.
The crewmate edits the file in place and names it in its report's files; the report is kept only once the app has replaced the notes with it.
The app refuses the report, with words the crewmate acts on and nothing cut, when the page is past the limit, is not text, holds text that looks like planted instructions, a credential or a link that sends data out, or the rule's notes changed since it was handed them; then it hands the newer page to carry its changes into.
A rule deleted since its run started keeps nothing: the report stands, and the task's timeline says the notes were not kept.
A file named for the notes from a task no automation started is refused too.
A run the first mate handles alone leaves the notes as they are: the first mate has no tool or sentence for them, and the catalog line `automation-notes` stays with the captain.

Settings → Automation shows a saved rule's notes in its Notes tab, where the captain edits them, saves them, clears them (an empty version) and reads earlier versions with who wrote each, all by keyboard (`inf:automation:notes`, `inf:automation:notes-save`).
The tab reads only the newest version, and Earlier versions reads every version only while it is open, since versions are never pruned.
A captain's save leaves an operation and an Activity line, as every catalog change does; a rule itself carries no notes, so a view on an older build reads rules unchanged.
The notes are the rule's own page, not knowledge: they reach only the rule's own crewmates, never the knowledge graph, the first mate or standing directions.

## History and retention

`schedule_runs` keeps each rule's settled runs - handled, cancelled or sent - for 30 days and at most 1,000 per rule; a delivery still waiting stays until it settles.
The rule's own next-fire time is stored on the rule, so trimming history never lets an old occurrence run again.
Deleting a rule, or a one-time rule leaving once it ran, deletes its runs, not the tasks, cards or conversation its deliveries led to.

Settings' History tab lists a rule's runs newest first, each leading with when it was sent and where its delivery stands, then what a handled one found, or why it stands so, and what it led to; its Details fold its planned and sent times, what it caught up, its version and the prompt as sent.
What it found is the first mate's closing words on the turn that handled it, after "Found:"; a run handled before runs kept them shows none.
A task it led to shows by its key, linked as anywhere the window draws one; a card by its title, opened forward while it is up and as it closed otherwise.
The history reads again when a first mate turn ends, since nothing else says a delivery was handled.

## The Automation panel

`src/panels/automation/` is an ordinary app panel folder on the right rail, below Tasks and Knowledge (docs/ui-plugins.md, "A folder that waits on a gate").
It waits on the `automation` gate, open while a saved rule exists in any state or a job is kept running (`docs/leftover-programs.md`, "Kept running"): the window follows `automation.list` and `automation.kept`, registers the panel on the first saved rule or kept job, and takes it away, with its place on the rail, when the last one goes.
An unreadable answer leaves it as it was.
It starts collapsed; the rail keeps the collapse choice by the panel's id, so it holds when the panel goes and comes back.
Collapsed, its header counts the running rules as active and, when there are any, the paused ones: "1 active · 2 paused", or "1 active"; a draft or a finished rule is in neither count.
It adds the jobs kept running when there are any, "1 active · 2 kept", and with no rule saved counts only them: "2 kept".
Each row shows a rule's state, name and next run; a draft reads Draft where a running rule shows its next run.
A click or Enter opens that rule's page in Settings → Automation through `point.openSettings("automation", id)`, with the keyboard in its Setup; nothing runs, pauses or changes.
Under Kept running, a row per kept job shows its last check, label and computer; a click or Enter opens Settings → Automation at that job with the keyboard on its Check, through `point.openSettings("automation", "kept:<id>")`.
The rule rows and kept rows are one stop the arrows move through.
Expanded, its header shows Open Automation, the app's open button, as Knowledge's header does; it names no card, so it is pressed into the panel, which opens Settings → Automation at the full list through `point.openSettings("automation")` (docs/ui-plugins.md, "A panel's cards").
Hiding or collapsing the panel changes nothing about delivery.
It takes its place on that rail however many panels the rail already holds.

## Where it shows

Settings → Automation with its Kept running list, the Automation panel and its header's Open Automation, and command search's Open Automation (`settings.automation`) and Pause all automations (`automation.pause-all`), neither with a default key.

## On a computer that controls another

A computer that controls the first mate on another (`docs/view.md`) shows the same Automation tab, panel and commands, over the rules of the computer the first mate lives on: every `inf:automation:*` channel reaches views (`docs/connection.md`).
The rules run only there, so nothing runs twice and nothing moves when the computer that controls it closes.
The page names that computer where the clock matters: a rule that keeps no zone follows "the clock on MacBook Pro", and the review says a missed time is about the first mate on MacBook Pro.
A new rule still takes the zone of the computer it is made on, shown in Setup.
While that computer is out of reach or too far apart, its rules stay as last read and a change is refused as any change is (`docs/view.md`, "Out of reach in the window").

### Event filters

An event may declare closed string filter fields in its integration's view.
The shared rule editor labels each field with the integration's words and keeps the values in the event spec's optional `filter` object; the review shows them before Turn on.
The first mate passes the same fields through `schedule_prompt`'s optional `event_filter`; discovery lists them only on request.
The scheduler refuses undeclared fields, preserves the selected values on save and edit, and passes them to every look.
Google Calendar declares `calendar`, an id read through `list_calendars`; an empty value uses the primary calendar.
A field the event marks `required` must be named: the scheduler refuses a rule that leaves it empty.
GitHub's run events declare `repository` (required), `workflow` and `branch` (`docs/integrations.md`, "GitHub's events").
