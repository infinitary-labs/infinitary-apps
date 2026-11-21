# Live reads and published views

A live read is a named, read-only projection of the app's current facts that a surface subscribes to and the host keeps fresh, so no feature needs a second copy of the truth.

## Intended use

Show app state (tasks, the feed, quota, usage, knowledge, automation, a computer's resources) on any surface by subscribing to a read by name, with arguments its schema bounds.
The host runs the read, re-runs it on the invalidation the entry declares, and pushes the new value to every subscriber.
A read is a projection computed from the owner's stored state at read time; it is never stored state of its own.
Derived facts such as "waiting on you" (`waitingCardId`, `counts.waitingOnYou`) are read-time projections, not stored readiness or permission to start held work ([task record](../docs/task-record.md), "Ready waiting is a presentation projection").
For ad hoc questions over the record, a plugin queries the published, versioned SQL views through the one `sql` read.

## When to use it, and when not

Use a read whenever a surface displays something the core already owns and must stay current while it is open.
Do not copy app data into a feature's own table, store slice, shell-store field or `localStorage` to display it later: subscribe to the read, and add a catalog entry if none serves the shape.
Do not add a bespoke IPC channel plus a hand-rolled poll or event listener for one panel: declare the channel once as a catalog entry with its invalidation, and every surface gets coalescing, delta folding and resync.
Do not persist a derived flag ("needs you", "ready", a count) beside the facts it derives from; compute it in the read.
Do not let a frame or panel compose SQL over tables: the `sql` read reaches only the published views the plugin was granted.
Do not use a read to change anything; a change goes through its owner, usually as an app action ([app-actions.md](app-actions.md)).

## Owner and entry points

- The catalog: `readCatalog`, `READ_NAMES`, `ReadEntry`, `ReadInvalidation` and `ReadGrant` in [`../src/shared/reads.ts`](../src/shared/reads.ts), beside the protocol and never in a plugin-only namespace.
- The executor: `ReadExecutor` in [`../src/renderer/src/plugins/reads/executor.ts`](../src/renderer/src/plugins/reads/executor.ts), with the app's one instance from `appReadExecutor()` in [`../src/renderer/src/plugins/reads/appExecutor.ts`](../src/renderer/src/plugins/reads/appExecutor.ts) and `resyncReads()` in [`../src/renderer/src/plugins/reads/resync.ts`](../src/renderer/src/plugins/reads/resync.ts).
- The published views: `PUBLISHED_VIEWS`, `registerViewFunctions`, `dropViews`, `createViews` and `migratePublishedViews` in [`../src/core/storage/views.ts`](../src/core/storage/views.ts); the version numbers `SQL_VIEWS_MAJOR` and `SQL_VIEWS_MINOR` in [`../src/shared/sql.ts`](../src/shared/sql.ts).
- The query engine: `SqlService` in [`../src/core/sql/sqlService.ts`](../src/core/sql/sqlService.ts) over [`../src/core/sql/sqlEngine.ts`](../src/core/sql/sqlEngine.ts), behind the `sql` catalog entry over `inf:sql:query`.
- The panel allowlist: `PANEL_READ_NAMES` and `undeclaredReadMessage` in [`../src/shared/personal/manifest.ts`](../src/shared/personal/manifest.ts).

One writer each: `src/core/storage/views.ts` over view SQL.
No other file writes a view's SQL, and a plugin's query reaches those names and nothing else.

## Operations and lifecycle

Each catalog entry maps one name onto a `surface: "core"` channel of [`../src/shared/ipc.ts`](../src/shared/ipc.ts), a strict args schema (a subscriber chooses a parameter, never composes a query), a `toRequest`, and a declared invalidation.
An invalidation is any of: an `inf:event` predicate (`events`), a push channel (`pushes`), a push whose payload is the value (`valueFromPush`), a push carrying a change folded onto the held value (`deltaFromPush`), a presentation overlay (`presentation`), or a poll (`pollMs`); `sameValue` keeps a re-run that says the same thing from being delivered twice.
`ReadExecutor.subscribe(name, args, listener, grant)` validates the name and args synchronously, reads, and re-reads on each declared invalidation, coalescing bursts to one read per `COALESCE_MS` with exactly one follow-up for an invalidation that lands mid-read.
A read that started before a pushed value landed is dropped as stale; a delta that cannot apply (a gap, no value yet) falls back to a full read.
A pushed read (`valueFromPush` or `deltaFromPush`) runs once however many subscribe to the same request: they share one read and one held value, and a subscriber that arrives while it runs is handed that value with no read of its own.
An entry may declare `narrows`: arguments that ask for less of the same value (`tasks.board` with `{ closed: false }`).
Readers asking less share the whole readers' source; while only they read, it reads the lesser value, and the first whole reader to join makes it read the whole value once.
A resync (the source of truth could not replay a gap, [the view](../docs/view.md)) re-runs every read the window holds.
Names are frozen once landed: adding an entry is additive, renaming one is a protocol change, and every core shape is published in `docs/contract.json` under the version rule ([contract](../docs/contract.md)).

The views are the record's contract while the tables keep migrating underneath.
Every name carries its version and is queried exactly (`v_usage_v1`; no plain name, no aliasing).
An additive change keeps the name and bumps `SQL_VIEWS_MINOR`; a breaking one ships `_v<N+1>` beside the old view, bumps `SQL_VIEWS_MAJOR`, and keeps the old view published for two releases.
Views are derived, so they are re-created rather than altered: every migration after the one that published them drops them first and re-creates them last, and every open reconciles them against `views.ts`.
`v_feed_v1` is authored by the feed's own function (`taskFeedLine`) registered as SQL functions on every reading connection, so a panel's feed can never say something the app's feed does not.

## Authority

Reads are read-only; no read changes state.
Access is declared, and the host enforces it: a plugin manifest's `capabilities.reads`, a panel `manifest.json`'s `reads` (a subset of `PANEL_READ_NAMES`), a crewmate card's `reads` and `sql` on `emit_card` (the same subset and published views, checked when the card is emitted and granted only while it is open), and the `sql` grant naming the views a query may reach.
The grant is added by the host from the manifest or the card's saved lists (`ReadGrant`, passed to `toRequest`), never by the subscriber, whose args are strict.
An undeclared read throws at the call in one wording for both realms (`undeclaredReadMessage`), and a frame's undeclared read is refused as `read_not_declared`.
The catalog deliberately has no card-content read (a plugin must not read other emitters' cards) and nothing account- or auth-shaped; no published view carries an account id or a path.

## Compositions

- Panels declare reads and receive them as `PanelProps.reads` ([panels.md](panels.md)).
- Frames (card bodies, Observe, framed panels) subscribe over the bridge's `inf.subscribe` ([cards-and-consent.md](cards-and-consent.md) for the card side).
  A crewmate's card mounts with the reads and views it declared while it is open, through the same `frameReads` shaping a framed panel uses; an ended or past card mounts with none ([the UI plugin system](../docs/ui-plugins.md), "A card's reads").
- Paired views and a home on another computer reach the same channels by their declared `reach` ([connection](../docs/connection.md)).
- The task record's facts come from their one writer ([tasks.md](tasks.md)); a read only projects them.

## Failure and recovery

An unknown name or arguments that do not parse throw `ReadSubscriptionError` (`read_unknown`, `bad_args`) at subscribe; every later failure reaches `listener.onError`.
A `sql` query answers `{ refused, message }` with `sql_view_not_declared`, `sql_not_readonly`, `sql_invalid`, `sql_timeout` or `sql_too_large`, never a partial write or a hang.
The engine proves names by compiling the query on a scratch schema of only the declared views before it runs on a read-only connection, and runs in its own process that is killed past 250 ms, because one native SQLite step cannot be interrupted from JavaScript.
A manifest naming a view this version does not publish mounts nothing, with a plain line saying the panel was written for another version of the app's data.
Unknown values stay unknown in a read and in a view column (a count nobody recorded is null), never zero.

## Uses

- The Tasks panel and the task board read `tasks.board`, `tasks.detail` and `tasks.search` (`src/panels/now/manifest.json`).
- The Activity panel reads `feed.recent`, a view over the task record's timeline (`src/panels/activity/manifest.json`).
- Settings → Usage reads `usage.summary` and `usage.tasks` (`src/renderer/src/settings/UsageTab.tsx`).
- The Automation panel and Settings → Automation read `automation.list`.
- The task card's Crewmate tab reads `tasks.crewmate` and `tasks.crewmate.live` (`src/renderer/src/cards/CrewmateView.tsx`).
- The Knowledge browser reads the `knowledge.*` entries ([knowledge](../docs/knowledge.md), "The reads").
- Personal panels query `v_usage_v1` through `sql`, taught by the seeded `usage` skill with the `token-watch` fixture.
- A crewmate's card reads what its `emit_card` declared while it is open ([`../tests/e2e/card-live-reads.spec.ts`](../tests/e2e/card-live-reads.spec.ts)).
- Panels read the app's settings through `settings.current`: each action catalog line's panel value (`PANEL_SETTINGS` in [`../src/shared/panelSettings.ts`](../src/shared/panelSettings.ts)), answered in core over `inf:settings:current`; a line without one, such as anything naming a project, computer or account, is refused.
  A window on another computer reads the settings its own look holds from that look, and asks the first mate only for the rest (docs/view.md, "The switch and the layout").

## Checks

- [`../src/shared/reads.test.ts`](../src/shared/reads.test.ts): the frozen names, every entry's request parsing against its channel, and nothing account-, auth- or card-shaped.
- [`../src/shared/panelSettings.test.ts`](../src/shared/panelSettings.test.ts): every action catalog line has a panel value or a ground, and the readable lines are the names `settings.current` takes; `src/core/core.settings.test.ts` reads them through the real core, and [`../tests/e2e/panel-settings.spec.ts`](../tests/e2e/panel-settings.spec.ts) shows a panel following Settings.
- [`../src/core/storage/views.test.ts`](../src/core/storage/views.test.ts): every view's column list, and `v_feed_v1` saying what `feed.recent` says.
- [`../src/renderer/src/plugins/reads/executor.test.ts`](../src/renderer/src/plugins/reads/executor.test.ts), [`appExecutor.test.ts`](../src/renderer/src/plugins/reads/appExecutor.test.ts) and [`sharedPush.test.ts`](../src/renderer/src/plugins/reads/sharedPush.test.ts): coalescing, deltas, staleness and shared pushes.
- [`../src/core/sql/sqlEngine.test.ts`](../src/core/sql/sqlEngine.test.ts) and [`../src/core/sql/sqlService.test.ts`](../src/core/sql/sqlService.test.ts): name proving, read-only refusal and the timeout kill.
- [`../tests/e2e/token-dashboard.spec.ts`](../tests/e2e/token-dashboard.spec.ts): a turn's usage reaching a painted panel through the views.

## Where the detail lives

- [The UI plugin system](../docs/ui-plugins.md): "The read catalog, v0", "The record, through SQL (plugin data surface, Phase B)", "A card's reads".
- [Writing panels](../docs/personal-panels.md): "The app's own data: the reads a panel declares".
- [The task record](../docs/task-record.md): "Ready waiting is a presentation projection".
- [Knowledge](../docs/knowledge.md): "The reads"; [running work for another Mac](../docs/helper.md): "Shared live readings".
