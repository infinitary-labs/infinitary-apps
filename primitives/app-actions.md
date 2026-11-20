# App actions

The app action catalog is the one door through which the captain's own controls and the first mate change an app or project setting, with the same checks, the same trail and the same refusals.

## Intended use

Every changing core channel that is an app setting is a catalog line in `src/shared/actions.ts`: its area, a strict value schema, how to read its current value, its permission tier, the request it sends and the words its feed line uses.
Settings, the View menu, keys, command search and the first mate's `app_change` all reach a setting through that line and the core dispatcher, so a change behaves the same whoever makes it.
The first mate reads the catalog through `app_state` (value, tier, `captainAllowed` / `firstmateAllowed`, and `allowedNow` for the current wake) and changes it through `app_change` with an action, a value and evidence.
Presentation preferences (theme, size, wash, default card size, rails and panels) are app settings like the rest, held by the core.

## When to use it, and when not

Add a catalog line when a new feature has a setting or an act either actor may run; claim each field of a claimed request object with `fields`, or name it in `ACTION_FIELD_EXCEPTIONS` with its ground.
Do not add a private IPC setter, a panel-only write path, or a first mate tool that writes one setting: that is the parallel system the catalog replaced, and the parity check refuses it.
Do not keep a presentation preference in `localStorage` or the shell store alone: presentation preferences live in the core (`src/shared/preferences.ts`), never in `localStorage` or the shell store alone.
Conversation, card clicks, sign-in interaction and a crewmate's own work are not settings; they stay outside the table as named `ACTION_EXCEPTIONS` in `src/shared/actionCoverage.ts` (see "What stays outside the catalog").
Task, card and panel-removal abilities keep their own execution paths ([tasks.md](tasks.md), [cards-and-consent.md](cards-and-consent.md), [panels.md](panels.md)).
Panels and plugins gain no change ability through the catalog.
A panel reads a line only through its panel value (`PANEL_SETTINGS`, `src/shared/panelSettings.ts`, served as `settings.current`, [live-reads.md](live-reads.md)); a new line names its panel value or a ground for having none, or the catalog does not compile.
Keyboard commands are a separate catalog (`KEYBOARD_COMMANDS` in `src/shared/keyboard.ts`, `docs/keyboard.md`) with their own resolver and handlers, not this dispatcher; a key that changes a setting makes the same catalog change as the control it mirrors (the size keys make the `window-size` change the Size picker makes).

## What stays outside the catalog

Every changing core request is a catalog line or an excuse in `ACTION_EXCEPTIONS`, and every changing request the window's own program answers (`surface: "host"`) is an excuse in `HOST_ACTION_EXCEPTIONS`.
Each excuse, and each field excuse in `ACTION_FIELD_EXCEPTIONS`, names its ground from the closed set `EXCEPTION_GROUNDS`, then why in words.
The grounds are a credential (a sign-in, key, secret value or joining link), the captain's consent the app holds for their own click, an act that cannot be undone or ends running work (`destructive`), another computer's own report or act, a recorded captain ruling, a request only the crew or a panel's own code sends (`crew-only`), the window's own program on the computer the captain is at (`window`), and a report, view stamp or conversation nobody chooses (`not-a-setting`).
The captain's click alone is no ground: a control with none of these is a catalog line.

## Owner and entry points

- The catalog: `ACTIONS`, `ActionTier`, `ActionLine`, `actionRefusal` and `actionActors` in [`src/shared/actions.ts`](../src/shared/actions.ts).
- The appearance lines and the one-off acts: [`src/shared/appearanceActions.ts`](../src/shared/appearanceActions.ts) and [`src/shared/settingsActs.ts`](../src/shared/settingsActs.ts), spread into `ACTIONS`.
- Coverage and exceptions: `EXCEPTION_GROUNDS`, `ACTION_EXCEPTIONS`, `ACTION_FIELD_EXCEPTIONS`, `HOST_ACTION_EXCEPTIONS`, `unaccountedChanges`, `groundlessExcuses` and `uncoveredSettings` in [`src/shared/actionCoverage.ts`](../src/shared/actionCoverage.ts).
- The one dispatcher: `createCoreDispatcher` in [`src/core/dispatcher.ts`](../src/core/dispatcher.ts), whose catalog change (`createCatalogDispatch` in [`src/core/dispatcher/catalogDispatch.ts`](../src/core/dispatcher/catalogDispatch.ts)) enforces actor permissions independently of any tool and writes the trail (`SETTLE_MS`).
- The first mate's tools: `app_state` and `app_change` in `createAppTools` ([`src/core/pi/appTools.ts`](../src/core/pi/appTools.ts)), with `handoverOffer` for hand-over cards.
- Presentation preferences: the schemas in [`src/shared/preferences.ts`](../src/shared/preferences.ts), and `ShellPreferencesService` ([`src/core/preferences/shellPreferences.ts`](../src/core/preferences/shellPreferences.ts)) as the one writer over appearance/layout/panels, pushing the whole value as `inf:shell:preferences`.
- Project changes the first mate proposes: `ProjectChanges` ([`src/core/workspace/projectChanges.ts`](../src/core/workspace/projectChanges.ts)).

## Operations and lifecycle

- Read: `app_state` returns each line's current value from its `current` channel, trimmed by its `readValue` to what the action needs: never an install ID, a sign-in code, a login, an address or what a server runs.
  With `read` it returns one named read that `area: "reads"` lists (`APP_READS` in [`src/core/pi/appReads.ts`](../src/core/pi/appReads.ts)), on demand, through the read catalog's own entry where it has one ([live-reads.md](live-reads.md)).
- Execute: the dispatcher checks the actor, parses the request, reads the value before, runs the handler and, for an applied change, writes one attributed feed line and one operation (never a card).
- Unchanged values and refusals leave no success trail; acts rather than values (`alwaysTrail`) always leave one.
- Acts: a line whose request does something besides set a value, such as Check for updates or Stop keeping a copy, writes its trail from the request and the handler's answer (`trailOf`), or none when the act found nothing to do; `app_change` answers what the handler said (`answers`) beside the value read after.
- A line that runs only part of its request's acts names the others in `refuses`, and the dispatcher refuses them for the first mate: turning a decision model use on, any secret action but ending a read, starting to keep a copy.
- Settle: a run of the captain's own steps on one setting is one feed line and one operation, rewritten in place until `SETTLE_MS` (10 seconds) pass, another line enters Activity, or another setting changes; a run that returns to its start is withdrawn (`TaskService.archive.withdrawOperation`).
- Each first mate change stays its own line and operation, so the answer check finds one action per captain message (`docs/task-capture.md`).
- Propose: a `proposes` line (such as `project-setup`) changes nothing; the host puts up its own card from typed facts, and only that card's button runs the change.
- Hand over: a `hands` line the first mate asks for becomes a host-written card (`HandoverOffer`) whose button opens the relevant Settings section; it never submits credentials.
- A hand-over card opens the exact place: its open effect names the Settings `section` and the `item` that section shows on arrival, a project in Projects, a computer in Devices, a page in Secrets, `inbox` in Integrations or `kept:<id>` in Automation, the same `item` a panel's `point.openSettings` passes.
- Only a card's own arrival carries an act the captain's click starts, such as `phone` (make a phone's link) or a computer's GitHub sign-in; an `item` only chooses and shows, so every control there stays the captain's.
- The hand-over lines for acts that stay the captain's are `device-invite` (a computer or a phone), `device-change-address`, `home-move`, `standby-keep`, `device-forge-sign-in`, `keep-home`, `kept-job-forget`, `secrets-page` and `integration-add` (kind inbox opens the Infinitary command's switch).
- Point: `show-task` and `show-settings` are `asked` lines that open a task's record or a Settings section and item in the captain's desktop windows, as `point.openRecord` and `point.openSettings` do; they change nothing, and each leaves one feed line.
  `show-settings` and `point.openSettings` take one shape and meet one check where they open: a section this window offers now, registered, shown on this kind of window and with its own gate open, and one it does not offer opens nothing.
  Each moves a window once, as it arrives: the same ask sent again after a connection drop moves nobody.
  Infinitary on iPhone and iPad does not follow either.
- A hand-over card whose act Settings shows only on the first mate's own computer (moving it, keeping a copy, keeping one of two first mates, its Secrets) carries `fromHome`; on a computer that controls the first mate its button sends nothing, and the card stays up and names the computer to choose it on.
  The first mate refuses that click from any paired window, an older one or a phone included, so the card stays up wherever it was sent from.
  A computer card is offered only where its row shows the act, read by the row's own checks (`src/shared/deviceActs.ts`).
- Catalog writes are ordered, so overlapping Settings calls cannot duplicate a change or attribute the next value to the previous call.

## Authority

- The captain may run every line.
- `asked` and `own-words` are the first mate's at any wake, with the captain's ask as evidence (INF-751): `asked` takes the captain's message, choice on any card or a schedule the captain set; `own-words` takes only the captain's typed words.
- `judgment` is the first mate's own judgment, with its reason as evidence (INF-638); standing directions are such a line ([standing-directions.md](standing-directions.md)).
- `hands` delegates to the captain through a hand-over card; `yours` is captain-only.
- Whether an ask is the captain's is the first mate's judgment; the host does not read the wake's words to decide it.
- The first mate cannot run a change outside the catalog, and a shared request object may change only in the fields its named action claims ("Only the named ... action may change").
- Settings writes through the same action-catalog dispatcher as `app_change project-settings`, and a refused configure is a feed line, not a silent revert.
- A project change from a click applies only on the app's exact-change card (Apply change), which refuses if the saved project changed since the offer ([projects-and-working-copies.md](projects-and-working-copies.md), `docs/fleet.md` "Changing a project").
- Sharing switches and purge, panels consent, recovery and ask-first merge stay the captain's.

## Compositions

- Settings → Projects and the first mate's `project-settings`, `project-runs-on` and `project-name` share this path ([projects-and-working-copies.md](projects-and-working-copies.md)).
- Settings → Automation's edits are catalog lines over `inf:automation:list` ([automation.md](automation.md)).
- Settings → Intelligence (first mate model and account, crew slots, pins, routing, decision answerer) is catalog lines ([intelligence-buckets.md](intelligence-buckets.md)).
- Proposal and hand-over cards are ordinary host cards under [cards-and-consent.md](cards-and-consent.md); `show-card` brings a card forward and runs no effect.
- The trail is the task record's `operation` rows and Activity's feed lines ([tasks.md](tasks.md)).

## Failure and recovery

- A refusal is returned as text naming what is missing (evidence, typed words, the captain's own Settings) and changes nothing.
- A refused project configure from Settings is a feed line, never a silent revert in the window.
- A settled run lives in memory: a restart ends it, and the record keeps what it settled.
- Account writes are acknowledgements; the value is read back through the account view.

## Uses

- Settings → Projects and `app_change project-settings`, through one dispatcher.
- The window Size picker, the size keys, the View menu and command search, all making the `window-size` change.
- Theme, wash and panel arrangement from Settings → Appearance or the first mate (`theme`, `panel`).
- Settings → Automation's edit, pause and delete (`automation-edit`, `automation-state`, `automation-pause-all`, `automation-delete`).
- Settings → Automation's Remove for good and Check on a job kept running (`kept-job-remove`, `kept-job-check`).
- Settings' undo and repair buttons, run by the first mate when asked: Keep it, Cancel a move, Stop keeping a copy, Fix it, Try again, Retry and Ask again on a panel, End now on a read of secrets, Remove on a private site, and turning a decision model use off.
- The first mate's `project-setup` proposal card and its hand-over cards.
- The first mate's `show-task` and `show-settings`, beside a panel's `point.openRecord` and `point.openSettings`.

## Checks

- [`src/shared/actions.test.ts`](../src/shared/actions.test.ts): action permissions, channel parity and per-field claims.
- [`src/core/core.settings.test.ts`](../src/core/core.settings.test.ts): dispatch, refusals and settled runs.
- [`src/core/core.settingsParity.test.ts`](../src/core/core.settingsParity.test.ts): the first mate's Settings acts and their refusals in the whole core.
- [`src/core/preferences/shellPreferences.test.ts`](../src/core/preferences/shellPreferences.test.ts): the one presentation writer.
- [`tests/e2e/activity-runs.spec.ts`](../tests/e2e/activity-runs.spec.ts): a run of steps is one Activity line.

## Where the detail lives

- [`docs/orchestrator-contract.md`](../docs/orchestrator-contract.md) "App action catalog (4.54, pieces 1–4)" and "Settled runs".
- [`docs/fleet.md`](../docs/fleet.md) "Changing a project" and "Asking the first mate to add a project".
- [`docs/automation.md`](../docs/automation.md) "One owner".
- [`docs/keyboard.md`](../docs/keyboard.md) "Handlers" for the size keys.
- [`docs/principles.md`](../docs/principles.md) "Standing product principle (captain, 2026-09-19)".
