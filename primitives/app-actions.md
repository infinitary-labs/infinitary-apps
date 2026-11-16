# App actions

The app action catalog is the one door through which the captain's own controls and the first mate change an app or project setting, with the same checks, the same trail and the same refusals.

## Intended use

Every changing core channel that is an app setting is a catalog line in `src/shared/actions.ts`: its area, a strict value schema, how to read its current value, its permission tier, the request it sends and the words its feed line uses.
Settings, the View menu, keys, command search and the first mate's `app_change` all reach a setting through that line and the core dispatcher, so a change behaves the same whoever makes it.
The first mate reads the catalog through `app_state` (value, tier, `captainAllowed` / `firstmateAllowed`, and `allowedNow` for the current wake) and changes it through `app_change` with an action, a value and evidence.
Presentation preferences (theme, size, wash, default card size, rails and panels) are app settings like the rest, held by the core.

## When to use it, and when not

Add a catalog line when a new feature has a setting either actor may change; claim each field of a shared request object with `fields`, or name it in `ACTION_FIELD_EXCEPTIONS` with a reason.
Do not add a private IPC setter, a panel-only write path, or a first mate tool that writes one setting: that is the parallel system the catalog replaced, and the parity check refuses it.
Do not keep a presentation preference in `localStorage` or the shell store alone: presentation preferences live in the core (`src/shared/preferences.ts`), never in `localStorage` or the shell store alone.
Conversation, card clicks, sign-in interaction and a crewmate's own work are not settings; they stay outside the table as named `ACTION_EXCEPTIONS` in `src/shared/actionCoverage.ts`.
Task, card and panel-removal abilities keep their own execution paths ([tasks.md](tasks.md), [cards-and-consent.md](cards-and-consent.md), [panels.md](panels.md)).
Panels and plugins gain no change ability through the catalog.
Keyboard commands are a separate catalog (`KEYBOARD_COMMANDS` in `src/shared/keyboard.ts`, `docs/keyboard.md`) with their own resolver and handlers, not this dispatcher; a key that changes a setting makes the same catalog change as the control it mirrors (the size keys make the `window-size` change the Size picker makes).

## Owner and entry points

- The catalog: `ACTIONS`, `ActionTier`, `ActionLine`, `actionRefusal` and `actionActors` in [`src/shared/actions.ts`](../src/shared/actions.ts).
- Coverage and exceptions: `ACTION_EXCEPTIONS`, `ACTION_FIELD_EXCEPTIONS` and `uncoveredSettings` in [`src/shared/actionCoverage.ts`](../src/shared/actionCoverage.ts).
- The one dispatcher: `createCoreDispatcher` in [`src/core/dispatcher.ts`](../src/core/dispatcher.ts), which enforces actor permissions independently of any tool and writes the trail (`SETTLE_MS`).
- The first mate's tools: `app_state` and `app_change` in `createAppTools` ([`src/core/pi/appTools.ts`](../src/core/pi/appTools.ts)), with `handoverOffer` for hand-over cards.
- Presentation preferences: the schemas in [`src/shared/preferences.ts`](../src/shared/preferences.ts), and `ShellPreferencesService` ([`src/core/preferences/shellPreferences.ts`](../src/core/preferences/shellPreferences.ts)) as the one writer over appearance/layout/panels, pushing the whole value as `inf:shell:preferences`.
- Project changes the first mate proposes: `ProjectChanges` ([`src/core/workspace/projectChanges.ts`](../src/core/workspace/projectChanges.ts)).

## Operations and lifecycle

- Read: `app_state` returns each line's current value from its `current` channel.
- Execute: the dispatcher checks the actor, parses the request, reads the value before, runs the handler and, for an applied change, writes one attributed feed line and one operation (never a card).
- Unchanged values and refusals leave no success trail; acts rather than values (`alwaysTrail`) always leave one.
- Settle: a run of the captain's own steps on one setting is one feed line and one operation, rewritten in place until `SETTLE_MS` (10 seconds) pass, another line enters Activity, or another setting changes; a run that returns to its start is withdrawn (`TaskService.archive.withdrawOperation`).
- Each first mate change stays its own line and operation, so the answer check finds one action per captain message (`docs/task-capture.md`).
- Propose: a `proposes` line (such as `project-setup`) changes nothing; the host puts up its own card from typed facts, and only that card's button runs the change.
- Hand over: a `hands` line the first mate asks for becomes a host-written card (`HandoverOffer`) whose button opens the relevant Settings section; it never submits credentials.
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
- Settings → Automation's Remove for good on a job kept running (`kept-job-remove`).
- The first mate's `project-setup` proposal card and `device-invite` hand-over card.

## Checks

- [`src/shared/actions.test.ts`](../src/shared/actions.test.ts): action permissions, channel parity and per-field claims.
- [`src/core/core.settings.test.ts`](../src/core/core.settings.test.ts): dispatch, refusals and settled runs.
- [`src/core/preferences/shellPreferences.test.ts`](../src/core/preferences/shellPreferences.test.ts): the one presentation writer.
- [`tests/e2e/activity-runs.spec.ts`](../tests/e2e/activity-runs.spec.ts): a run of steps is one Activity line.

## Where the detail lives

- [`docs/orchestrator-contract.md`](../docs/orchestrator-contract.md) "App action catalog (4.54, pieces 1–4)" and "Settled runs".
- [`docs/fleet.md`](../docs/fleet.md) "Changing a project" and "Asking the first mate to add a project".
- [`docs/automation.md`](../docs/automation.md) "One owner".
- [`docs/keyboard.md`](../docs/keyboard.md) "Handlers" for the size keys.
- [`docs/principles.md`](../docs/principles.md) "Standing product principle (captain, 2026-09-19)".
