# Panels

A panel is one folder shape (`panel.tsx` taking `PanelProps`, a `manifest.json`, optional card views) that draws a reusable, persistent view of app or personal data on a rail, registered through the host's one door.

## Intended use

Give the captain a lasting view beside the stage: the app's own Tasks, Activity, Knowledge and Automation, a built-in runbook's panel such as Batches, a panel a crewmate builds in the personal workspace, or a panel added from elsewhere.
Every panel is the same plugin shape, and the source decides the privilege: the app's own, the captain's own ("yours"), or installed from elsewhere.
A panel reads app data through declared reads ([live-reads.md](live-reads.md)), keeps its own state in its store slice, may put up cards on the main stack, and is drawn inside host chrome it never renders itself.
How a panel looks is not this page's business: visual rules stay in the design skill ([`../.claude/skills/infinitary-design/`](../.claude/skills/infinitary-design/)), and the panel library is that skill's components exported from `src/renderer/src/design/index.ts` as `@infinitary/ui`.

## When to use it, and when not

Use a panel for a view that stays on screen and updates as the facts change.
Do not add a hard-coded rail, sidebar or React-only dock for a new view: the rails draw registered side panels, and the app's own panels are ordinary panel folders under `src/panels/` or in a built-in runbook's folder.
Do not add a new card kind, settings tab or panel by editing a switch: a contribution is a manifest entry plus a binding through `registerPlugin`.
Do not give a panel its own fetch of app data, its own poll, or `window.infinitary`: declare reads, and use `server.ts` only for the captain's own panel's background work.
Do not give a panel its own sign-in, key or host list for a service outside your projects: it names the integrations it uses in its manifest and reaches them through `integrations` ([integrations.md](integrations.md)).
Do not create a second plugin shape or a second manifest for a new source: one plugin shape, one manifest (`personalManifestSchema`).
A one-off answer the captain reads once is a card ([cards-and-consent.md](cards-and-consent.md)), not a panel.

## Owner and entry points

- Registration: `PluginHost.registerPlugin(manifest, bindings, options)` in [`../src/renderer/src/plugins/host.ts`](../src/renderer/src/plugins/host.ts), the single door for every card kind, settings section and side panel; `placeSidePanels` applies the captain's one saved arrangement of every panel's slot and order, read and written through [`../src/shared/panelArrangement.ts`](../src/shared/panelArrangement.ts) (INF-2344).
- Panel folders: `PersonalExtensions` in [`../src/core/personal/personalExtensions.ts`](../src/core/personal/personalExtensions.ts) (its crewmate tools `lint_panel`, `capture_panel` and `place_panel` are `PanelBuildTools` in [`../src/core/personal/panelBuildTools.ts`](../src/core/personal/panelBuildTools.ts)) seeds, scans, compiles, serves and removes the captain's own panels, installed ones and the panels of runbooks that are on (`../docs/runbooks.md`, "Panels"; checked in [`../src/core/personal/framedPanels.ts`](../src/core/personal/framedPanels.ts)), and pushes one snapshot on `inf:plugins:personal`.
- The compiler: `compilePersonalModule` and `PersonalCompileError` in [`../src/core/personal/compiler.ts`](../src/core/personal/compiler.ts).
- The contract a panel is written against: `PanelProps`, `ServerContext` and `PersonalManifest` in [`../src/shared/personal/contracts.ts`](../src/shared/personal/contracts.ts) (type-only; it generates the workspace's `infinitary-env.d.ts`); the manifest schema and `PLUGIN_HOST_SUPPORT` in [`../src/shared/personal/manifest.ts`](../src/shared/personal/manifest.ts).
- Mounting: `PersonalPlugins` in [`../src/renderer/src/personal/personalPlugins.ts`](../src/renderer/src/personal/personalPlugins.ts) (every source, in a frame through `FramedPanelBody`) and the frame realm in [`../src/renderer/src/frameRealm/`](../src/renderer/src/frameRealm/) (`framePanelProps`), mounted by `FrameMountRegistry.mountPanel`.
- The app's own folders: `APP_PANEL_FOLDERS` in [`../src/shared/surfaces.ts`](../src/shared/surfaces.ts), under `src/panels/` or, for a built-in runbook's panel, its folder from `builtinPanelSource` and `RUNBOOK_FRAME_PANELS` in [`../src/shared/plugins/frameLib.ts`](../src/shared/plugins/frameLib.ts).
- Installing panels and guidance runbooks: `PluginInstaller` and `checkPluginTree` in [`../src/core/plugins/pluginInstaller.ts`](../src/core/plugins/pluginInstaller.ts), with `PluginRecords` the one writer of the `plugins` table.
- The store: `PersonalStore` over `plugin_kv` in [`../src/core/personal/personalStore.ts`](../src/core/personal/personalStore.ts).
- The switch: `ShellPreferencesService.setPersonalPanels` in [`../src/core/preferences/shellPreferences.ts`](../src/core/preferences/shellPreferences.ts); safe mode in [`../src/core/personal/safeMode.ts`](../src/core/personal/safeMode.ts).

## Operations and lifecycle

Registration is atomic: `registerPlugin` refuses any grant the host cannot serve (`PluginCapabilityError`), requires a binding for every declared contribution and no stray one, and unwinds everything on a refusal.
Visibility is data, never a verb: a panel's content source returns null while its presence rule is unsatisfied, and `presence: { "code": true }` lets a panel's own code say whether it shows.
The manifest declares title, placement, order, size, reads, views, integrations, store cap, card views, header buttons and commands; the host draws them as its own chrome and attributes the panel ("yours", the maker's name, or nothing for the app's own).
A personal panel lives in `userData/fleet/personal/<id>/` and is built by a crewmate on a personal task that builds in place ([projects-and-working-copies.md](projects-and-working-copies.md)); the rails keep the last commit while working files run apart as a draft.
The compiler output is content-addressed, so a new hash is the version, the hot reload (a new frame) and the core's cache bust.
A captain's own `server.ts` runs in a process of its own, owned by the core's `PanelRuntimes` for every source: actions are callable by name, its store answers asynchronously one ask at a time, background tasks run on its own timers clamped up to `MIN_BACKGROUND_INTERVAL_MS`, a run in flight is skipped rather than overlapped, and a throw is logged with the timer kept.
A panel whose loop goes silent past `PANEL_SILENCE_MS`, whose process does not start within `PANEL_START_MS`, or whose process ends, is stopped alone and stays stopped until the captain's Retry (`docs/personal-panels.md`, "Background work runs apart" and "A stopped panel").
`personalize remove` takes a panel out in one commit (or uninstalls an installed one); a runbook's panel goes with its runbook's switch instead, and the `panels` switch and safe mode take back all three roots in the same tick.

## Authority

Personal panels and plugins (`docs/ui-plugins.md`, `docs/personal-panels.md`): one plugin shape; every panel draws only in the frame realm; never relax the compiler's import list at display time; the first mate never writes the panels switch.
The trust difference between sources is intentional.
The captain's own panel draws in a frame of its own like every panel, and may have a `server.ts`, trusted like the crewmate that wrote it, which runs in its own process; a hang in either stops only that panel.
An installed panel runs only in a sandboxed frame at its own host with a pinned lib, is served only the reads, views, storage and moves the captain consented to on the host's consent card (`card-plugin-<id>`), and a tree holding `server.ts` mounts nothing.
A runbook's panel is drawn the same way: a personal runbook's is served what its manifest asks, an added runbook's only what the captain agreed to on that runbook's add card, and neither runs a `server.ts`; it keeps its saved data under its own runbook's name (`runbookPanelSlice`), never the id it shows under.
A panel of either source reaches a service outside your projects only through the integrations its manifest names, each action under its rule in Settings, with one ask per panel and action at a time and a host line with Ask again meanwhile ([`../docs/integrations.md`](../docs/integrations.md), "How a panel reaches them").
An installed panel's consent card lists each integration it names with its actions, events and why, and an update that names more asks again.
The retired `net` and `secrets` keys are refused for every source, saying to name an integration instead.
The compiler is the coherence gate at admission: a panel may import only `react`, the JSX runtimes, `@infinitary/ui`, type-only `@infinitary/contracts` and its own files; a server only `node:*` built-ins and its own files.
The panels switch is one preference row written only by `ShellPreferencesService.setPersonalPanels` (the Settings control and the safe-mode boot); the first mate's `personalize` has no action for it, because the switch exists for when a panel is what went wrong.
The words "extension" and "plugin" never reach a user surface.

## Compositions

- Data through declared reads and the `sql` grant over published views ([live-reads.md](live-reads.md)).
- Cards on the main stack through `PanelProps.cards` ([cards-and-consent.md](cards-and-consent.md)), and pointing at tasks through `point` with `tasks.board`.
- Task moves (`tasks.run`) on the captain's click or key for a panel whose manifest asks for `moves` ([tasks.md](tasks.md)).
- Services outside your projects through `context.integrations` and `props.integrations` ([integrations.md](integrations.md)), and their events through the store keys the app writes them to.
- Commands in command search as `panel:<panel>/<command>` ([keyboard](../docs/keyboard.md), "A panel's commands").
- The personal workspace as a project kind that builds in place ([projects-and-working-copies.md](projects-and-working-copies.md)).

## Failure and recovery

A compile refusal is a `PersonalCompileError` naming `<id>/<file>` and the import, and that panel mounts nothing.
A throw or a module that will not import shows the quiet line "This panel stopped drawing." with the chrome staying; the boundary resets on the next version.
A framed panel that leaves four pings unanswered is torn down and mounted once more; a second stop shows "This panel stopped responding." with a Retry.
A mounted-again page that then answers four pings in a row has a fresh start, so its own later stop mounts it once more too (`docs/ui-plugins.md`).
A registration refusal is logged, kept in its own words and reported to the core, so the crewmate and the first mate read why a panel is missing.
Two launches that never settled turn the switch off with reason `safe-mode`; off disposes every server host, forgets every compiled panel and pushes one empty snapshot.
The store refuses a write over its cap with the cap named.

In the personal workspace one rule decides what a panel is: a top-level folder named like a panel id that holds `panel.tsx` or `server.ts`, in the working files or in the last commit (`isPanel`, `src/core/personal/liveWorkspace.ts`).
Loading (`discover`), change attribution (`changedExtensionIds`, which feeds the stamp, the lint and the place), and the last-commit copy (`committedTrees`) all call it, so a record folder such as `lessons/` is never loaded, stamped or copied.
The install name check is wider on purpose: every workspace folder name is taken, so an unfinished build keeps its name.

## Uses

- The app's own Tasks, Activity, Knowledge and Automation panels are ordinary folders under `src/panels/`, compiled into the frame lib and registered first-party.
- A built-in runbook's panels, such as the Batched pull requests runbook's Batches panel, are compiled into the frame lib the same way and shown while their runbook is on ([runbooks](../docs/runbooks.md), "Built-in panels").
- Panels the captain asks for, built by a crewmate in the personal workspace and checked with `lint_panel`, `place_panel` and `capture_panel` (`src/core/pi/panelTools.ts`).
- Panels added from elsewhere by talking (`install_plugin`), contained in the frame realm.
- The task board is the Tasks panel's card `board` ([task board](../docs/task-board.md)).

## Checks

- [`../src/renderer/src/plugins/host.test.ts`](../src/renderer/src/plugins/host.test.ts) and [`../src/renderer/src/plugins/builtin/index.test.ts`](../src/renderer/src/plugins/builtin/index.test.ts): the one door and the built-in manifest.
- [`../src/core/personal/compiler.test.ts`](../src/core/personal/compiler.test.ts), [`personalExtensions.test.ts`](../src/core/personal/personalExtensions.test.ts), [`appPanels.test.ts`](../src/core/personal/appPanels.test.ts) and [`infinitaryEnv.test.ts`](../src/core/personal/infinitaryEnv.test.ts).
- [`../src/core/panels/panelRuntimes.test.ts`](../src/core/panels/panelRuntimes.test.ts) and [`panelRuntimes.integration.test.ts`](../src/core/panels/panelRuntimes.integration.test.ts): the watch on a controlled clock, and the real panel process across every source.
- [`../src/core/plugins/pluginLint.test.ts`](../src/core/plugins/pluginLint.test.ts), [`personalFixtures.test.ts`](../src/core/plugins/personalFixtures.test.ts) and [`pluginInstaller.test.ts`](../src/core/plugins/pluginInstaller.test.ts).
- [`../src/shared/plugins/containment.test.ts`](../src/shared/plugins/containment.test.ts) and [`../src/shared/personal/contracts.test.ts`](../src/shared/personal/contracts.test.ts).
- End to end: [`personal-panels.spec.ts`](../tests/e2e/personal-panels.spec.ts), [`personal-panels-hardening.spec.ts`](../tests/e2e/personal-panels-hardening.spec.ts), [`installed-panels.spec.ts`](../tests/e2e/installed-panels.spec.ts), [`installed-panel-containment.spec.ts`](../tests/e2e/installed-panel-containment.spec.ts), [`panel-cards.spec.ts`](../tests/e2e/panel-cards.spec.ts) and [`side-rails.spec.ts`](../tests/e2e/side-rails.spec.ts).

## Where the detail lives

- [The UI plugin system](../docs/ui-plugins.md): "The registries and the built-in plugin", "D5: the two side rails", "D6: the capability posture", "The one plugin vehicle (Phase A)", "A panel's cards (FI3-1014)", "Personal extensions (talk-to-personalize Step 2)".
- [Writing panels](../docs/personal-panels.md): "The library is the panel library", "The skills", "The lint", "The build loop (Step 4)", "Hardening (Step 5)", "Panels for others (the plugin author's guide)".
- [Live-prototype security](../docs/live-prototype-security.md): "The frame realm (one plugin vehicle, Phase A item 4)".
- The design skill: [`../.claude/skills/infinitary-design/`](../.claude/skills/infinitary-design/), `components/panel/Panel.prompt.md`.
