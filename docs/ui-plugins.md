# The UI plugin system

Design record for the captain-accepted proposal (`firstmate/data/fm3000-ui-plugin-system-study-s1/report.md`, revised 2026-08-31; the board the captain reviewed) and its phase-0, phase-1, and phase-2 implementations (captain's go 2026-09-05: "emphasize clean, maintainable, scalable and durable architecture").
Read this before touching `src/renderer/src/plugins/`, `src/shared/plugins/`, `src/shared/reads.ts`, or `src/main/frames/`.

Personal extensions - the workspace, the compiler, the host modules, the store and how a panel mounts - are "Personal extensions" below (talk-to-personalize Step 2).
Their AUTHORING half - the component library a panel builds from, the skills seeded beside it, and the adherence lint - is `docs/personal-panels.md` (Step 3).
Both build ON this system's rails and its one registration door; the third-party capability model is unchanged and still gated.

## Why, in one paragraph

Infinitary hides its machinery behind one agent and a few settings (standing product principle).
A plugin system fits that only if it adds no concept a person has to learn: contributions render through the host's own chrome, visibility is data, and nothing installable exists until someone actually wants it.
The phase-0 payoff is internal and immediate - the renderer had no registry anywhere, so every card kind and settings tab was a hard-coded switch - and every later phase is an addition to these registries, never a rewrite.

## The four slots

`CONTRIBUTION_SLOTS` in `src/shared/plugins/manifest.ts`: `card-kind`, `settings-section`, `side-panel`, `agent-pack`.
The first three are hosted by the renderer today.
`agent-pack` has no renderer manifest entry: guidance runbooks reach the agents through `runbook.json`, `Runbooks` and the existing installer instead (see `docs/runbooks.md`).

## The manifest

A manifest is data, never code.
`pluginManifestSchema` is strict at every level, so an unknown key anywhere - a capability the host has never heard of, a stray `main`/`entry`/`script` - is refused loudly at parse time.
The `capabilities` block is required even when empty.
`parsePluginManifest` turns zod's issue list into one `PluginManifestError` that names the plugin.

The schema lives in `src/shared/` because it is protocol-shaped: JSON-serializable, zod-validated, readable by the core and by any client.
That is the reconciliation the proposal asked for (below).

## The registries and the built-in plugin

`PluginHost` (`src/renderer/src/plugins/host.ts`) owns one `ContributionRegistry` per hosted slot and the single door in: `registerPlugin(manifest, bindings)`.
It refuses any grant the host cannot serve (`PluginCapabilityError`; the host serves the read catalog and nothing else), requires a binding for every declared section and panel and no stray binding, registers atomically (a refusal anywhere unwinds what landed), and returns the function that removes the plugin again.

The app's own UI is the first plugin: `src/renderer/src/plugins/builtin/manifest.ts` declares the three card presentations a wire card derives (cards/tasks/agents P1: `decision`, `note`, `attention` - nothing on the wire declares a kind) plus the host-owned task record, and the three settings tabs; `builtin/index.ts` binds the React, and `main.tsx` registers it before the first render.
Consequences:

- A card presentation's chrome and body policy is a manifest row, read by the card layer through `describeCardKind` with the presentation it derived (`cardPresentation` in `src/shared/cards.ts`: actions = decision, host author = attention, none = note; an undescribed name gets the neutral note dress, never a crash).
  A row says only how a STREAMING body is shown; there is no body profile since the sanitizer was removed (captain decision, 2026-09-15).
  `builtin/index.test.ts` fails if a presentation in `CARD_PRESENTATIONS` ships without a row.
- A settings tab is a manifest entry plus a binding; `SettingsScreen` renders the registry in `order`, resolving each binding's `enabled` gate (Observe's development and alpha gate) before offering it.
  A binding is a React component (Tier 1: General, Subscriptions) or a frame template (Tier 2: Observe, since phase 1); the registry never knows which.
- The built-in manifest declares `capabilities.reads` for the three reads Observe's frame subscribes to, like any plugin would; a host serving no catalog refuses it, and `builtin/index.test.ts` pins that every read the frame script names is declared.
- The left rail carries the activity feed as a Tier-2 side panel (phase 2, below; the crew strip that shipped beside it was removed on 2026-09-13); the right rail carries the now panel (task-system P4, below), the one panel the captain chose for it.
  Once a task has finished and no panel of the captain's own exists, the left rail opens with the create-your-own-panel slot, the app's own chrome rather than a panel (`docs/first-launch.md`).

## D5: the two side rails

Home view: `[rail-left] [stage] [rail-right]` as one flex row (`App.tsx`); the stage holds the fixed geometry the app always had.
Six rules, each with its test:

| Rule | Where it holds | Test |
|---|---|---|
| Empty means invisible and zero-width; the window is pixel-identical to today's | `Rail` renders an empty element when no panel has content; `[data-rail]:empty` (design/styles.css) sets width and padding to 0 | `Rail.test.tsx`; `tests/e2e/side-rails.spec.ts` compares a screenshot with the rails present and empty against one with the rail nodes removed, byte for byte |
| The stage insets; it is never covered | the stage is `flex: 1` beside fixed-width rails, and is a container (`cqw`) for anything that must not assume it is the window | `side-rails.spec.ts` lets the first feed line dock the real panels and measures stage x/width and the character and input centres |
| One rail width token, not resizable | `--rail-width` (skill and app `tokens/spacing.css`); `resize: none`; no resize affordance exists | `side-rails.spec.ts` |
| A rail is a vertical stack of panels; the host owns title, attribution, and collapse; the plugin styles only the body | `SidePanelChrome` renders title/attribution from manifest data and the collapse control; the body sits in `[data-side-panel-body]`; collapse state is host-owned (`railStore.ts`) and kept by the CORE, in the `layout` preference (`src/shared/preferences.ts`), so it survives a relaunch; the host's own panels carry no attribution (the app never names itself) | `Rail.test.tsx`; `railStore.test.ts`; `side-rails.spec.ts` collapses a real panel and finds no attribution on the built-in ones, and `preferences.spec.ts` relaunches with a fresh window profile |
| Home view only in v1 | `App.tsx` renders rails only when `view === "home"` | `side-rails.spec.ts` |
| A rail holds every panel placed on it; expanded panels share its height evenly and scroll their bodies | the side-panel registry admits any number of panels, and the first mate's move check counts none; the stylesheet shares the rail's height (design/styles.css) | `personalPlugins.test.ts` docks the app's panels and the tests' five personal panels, four on the right rail, in placement order |

**Visibility is data, not a verb.**
A side panel binds a `PanelSource<T>` (`subscribe` + `get`, framework-free); `null` means nothing to show, and the host renders no chrome for it.
There is no `show_panel` / `hide_panel` anywhere, and none is planned.
Placement: a contribution declares a `preferredPlacement` (`x`: left/right rail, `y`: top/bottom of that rail's stack), an order, and a `size` (`content` hugs what it shows; `fill` takes the rail height its siblings leave); `placeSidePanels` stacks each rail's top group above its bottom group, in the order the captain's one saved arrangement lists them ("Preferences by talking"), and puts a panel the arrangement does not list yet in the slot its `preferredPlacement` asks for.
A collapsed panel keeps its whole header height when a sibling overflows; expanded panels share the remaining space evenly, each capped at its own content, so a short panel shows all of it and a long one scrolls its body.
The bottom group docks together: only its first shown panel consumes spare height above it, and later panels keep only the rail's normal gap.
Hidden bottom panels do not consume the group's leading margin.
The focused browser stylesheet contracts are `tests/renderer/railDocking.spec.ts` for docking and `tests/renderer/collapsedRailPanel.spec.ts` for collapsed headers beside overflowing content, and `tests/renderer/railExpandedPanels.spec.ts` for two expanded panels sharing an overflowing rail.
A personal or added panel that names no placement lands at the top of the left rail (`DEFAULT_PERSONAL_PLACEMENT`).
Above the left rail's top group, `Rail` draws the create-your-own-panel slot while it shows (`docs/first-launch.md`): it docks the rail as a panel does and counts toward no cap.

## D6: the capability posture

The finding stands as the proposal put it: letting a Jira plugin fetch Jira needs a mediated verb, not a relaxed sandbox.
That verb is the integrations (INF-2334; the captain's principle of 2026-11-02, `docs/principles.md`): a panel reaches a service outside your projects only through a connection the captain made, as one more caller of `IntegrationsService`, never through hosts or keys of its own (`docs/integrations.md`, "How a panel reaches them").

What stands:

- The grant model as schema (`capabilitiesSchema`): `integrations` (each connection a panel uses, with its actions, events and why), `storage.kv` (a byte cap, at most `STORAGE_KV_MAX_BYTES`), `reads` (dotted read-catalog names), `sql` (published views) and `moves`.
- The retired `net.origins` and `secrets` keys are refused wherever they are declared, saying to name an integration instead (`retiredGrantWords`).
- Refusal of anything a host cannot serve: `unservableGrants` lists them read by read; `PluginHost.registerPlugin` throws on a non-empty list.
  A plugin never runs believing it has a grant it does not.
- The consent unit as a pure derivation: `consentSummary` yields what the panel reads, the integrations it uses with their actions, events and why, its moves and its storage cap, for the consent card to render and to diff on update.
- One definition of the frame boundary for every frame the host opens: `FRAME_SANDBOX` (`allow-scripts` alone), `FRAME_ALLOW` (no focus without the captain's gesture, "Focus and the frames" below) and `FRAME_CSP` (`default-src 'none'`, inline styles, the hash-pinned bridge) in `src/shared/plugins/containment.ts`; card bodies consume them.
  `containment.test.ts` walks `STRUCTURALLY_IMPOSSIBLE` and pins one assertion per entry.

The mediated fetch service (`src/core/plugins/mediatedFetch.ts`) still answers the `inf:plugins:fetch` core channel, which stays for older readers of the contract, and refuses every call with `capability_not_granted`, saying to name an integration instead.

**The honest ledger** is unchanged for third-party plugins: plugin code never runs in the renderer or main realm, no same-origin access, no direct IPC, no reading another plugin's data or the accounts, no undeclared host, never holding or seeing a credential.
Residual risk stays prompt-injection-shaped (response bodies and card content the agent reads back), which the write-boundary threat scan and host-stamped provenance exist to catch.
A panel's integration answers carry the same fence as every caller's, and words of a kind kept for a while leave its store with that kind's days.

A panel the captain ADDED from elsewhere is inside the ledger (one plugin vehicle, captain's A1a): its code runs only in the frame realm - a sandboxed frame at a host of its own, loading the app's React and components from a pinned lib - its data comes through the reads, views and store slice the host serves its mount, and nothing it ships runs in the core ("The frame realm" below).

**Personal extensions are outside that ledger, on purpose** (captain decision Q7, 2026-09-18; "Personal extensions" below).
A panel the captain asked for and the app's own crewmate wrote is trusted like the crewmate that wrote it - which already holds unjailed bash on the machine by a captain KEEP call (`docs/architecture.md` section 4) - so its `server.ts` runs with the captain's privilege, in a process of its own.
Its drawing still runs in the frame realm, like every panel's (INF-2205 piece C): a panel that hangs or throws stops only its own frame, never the app's window.
Nothing about the third-party posture moved: the frame vehicle, `FRAME_CSP` at `default-src 'none'`, and the consent ceremony are untouched, and a panel of either source reaches outside your projects only through the integrations, and `containment.test.ts` and `tests/e2e/card-containment.spec.ts` keep proving it.
The app's own CSP admits no panel code: no panel module is a script source of the window.

## Phase 1: the frame vehicle v2


### The vehicle, and why it is a served document

The bridge has one host-to-frame channel that is not a read: `inf.state` / `inf.onState`, pushed by `FrameController.setState` and re-pushed on every document birth beside the theme.
It carries VIEW state the host owns and the core knows nothing about - a panel's header presses and focus asks, what the captain has open, whether its dock is collapsed, and a panel card's data, revision and kept place ("A panel's cards" below).
It is deliberately not a read: a read is app data the core serves over its own channel, with declared invalidation, and none of that is true of "which row does the captain have open".
A frame that ignores the push loses nothing.
The bridge also keeps the first state the host pushed at the document's birth, `inf.birthState`, which later pushes never replace, so a page that starts reading late can still tell what was pushed after it was born.
Adding it changed the bridge script, so `FRAME_BRIDGE_SHA256` moved with it (`frameBridgeHash.test.ts` pins the pair, and every frame CSP carries the new hash); `docs/live-prototype-security.md` is the review that covers the bridge's surface.

A panel's action now also learns WHERE its frame was when the gesture was made: `onAction(id, value, frame)` carries the iframe's rect, because only the host knows a frame's place in the window.
A panel's `point.peekTask` uses it: the panel names a row's box in its own page, and the host adds the frame's rect to place the crew summary beside a row it cannot see.

A srcdoc document inherits the app's CSP, whose `script-src` admits `'self'` and one hash: a template's own script could never run there, and with `font-src 'self'` no font could load in an opaque-origin frame either.
So a template mount is a document the host **serves** over its own privileged scheme, `app-frame:` (`src/main/frames/`; the voice model's `app-model:` is the pattern), with the frame's CSP as a response header: `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '<bridge hash>' '<this mount's script hash>'` (`frameCsp` in `src/shared/plugins/containment.ts`).
The renderer hands the host a template over `inf:frames:mount` (a `surface: "host"` channel - a shell without a desktop frame would answer with its own vehicle), gets back `app-frame://mount/<random id>`, and loads it in an `<iframe sandbox="allow-scripts">`; `inf:frames:unmount` forgets it, and a renderer navigation forgets them all.
`FrameMountRegistry` (`frameMounts.ts`) is plain Node and bounded (`FRAME_MOUNT_CAP`); the scheme handler (`frameProtocol.ts`) is the thin Electron half.
A plugin template runs only its one `template.script`; inline scripts inside its markup remain unhashed and do not run.
A card body without a script stays on srcdoc: it is data, so the inherited policy plus the bridge hash is exactly right for it - and it gets the same document builder, stylesheet, and bridge.
A card body carrying the agent's own inline script (WI-16) rides this vehicle instead, as a `kind: "card"` mount at a host of its own (`app-frame://card-<id>/`, its own renderer process and its own cap); each inline script in the card markup is hash-pinned in place, and the frame is watched by the watchdog.
`docs/live-prototype-security.md` is its review.

One assembler for every frame: `buildFrameDocument` (`src/shared/plugins/frameDocument.ts`), pure and shared, called by the renderer for a card body and by the host for a mount.
`frameTemplateSchema` bounds plugin templates and refuses text that would close an embedding element early; the card-specific schema keeps the size bound but accepts the body's markup verbatim.

### Bridge v2

One app-owned, hash-pinned script for every frame (`src/shared/plugins/frameScript.ts`, `FRAME_BRIDGE_SHA256` on the app CSP and every frame CSP; `src/main/security/frameBridgeHash.test.ts` pins the pair).
Inside the frame it exposes `window.inf` and nothing more:

| Verb | Shape | Bound by |
|---|---|---|
| `inf.subscribe(read, args, onValue, onError?)` | a read-catalog subscription; the host pushes the first value and every later one as `data` messages | the plugin's declared reads; the catalog's own args schema; `FRAME_MAX_SUBSCRIPTIONS` per mount |
| `inf.action(id, value?)` | a declared action with a bounded value | the mount's declared action ids; `ACTION_VALUE_MAX_BYTES` |
| `inf.fetch(alias, request)` | kept for older pages: a request of the page's own | forwarded to `inf:plugins:fetch`, which refuses every call; a panel calls its integrations through the `integrations` action instead |
| `inf.theme` / `inf.onTheme(cb)` | theme as data; the bridge applies `data-theme` itself | - |
| `inf.store(request)` / `inf.onStore(cb)` | the mount's own store slice (a panel in the frame realm's `PanelProps.store`): get, set, delete, list by key; `onStore` hears its keys change | the slice the HOST bound to the mount (`FrameMountSpec.store`); refused on a mount bound to none |
| `inf.stage(name, value)` | a JSON snapshot staged under a name beside a card body's form; local, it leaves with a footer click or author-directed reply | the answers' 64 KiB bound at submission |

Every verb is request/response with a correlation id (`FrameRequest` / `HostMessage`), so a later verb is an addition to the same envelope.
`resize` and `link` stay as one-way notifications, and `data-inf-action` clicks plus `window.infAction` stay for agent-authored card bodies.
`draft` is the link's sibling for the message box (FI3-1164): a click on a `data-inf-draft` control posts its words, one line, which a card's host puts at the start of the message box only from the card on screen whose frame holds the window's focus (`FrameMountSpec.onDraft`, `docs/card-authoring.md` "Style"); a mount that takes none ignores it, and adding it moved `FRAME_BRIDGE_SHA256`.
`image` is their sibling (card pictures, phase 3): a click on any `<img>` - or on a `figure.inf-pictures` group's `+N` tile - posts the clicked index and the pictures of its group, and a card body's host opens the picture viewer on the ones it may show (`docs/card-authoring.md`, "The viewer").

Every hook reads in either spelling of the app's code names (the Infinitary rename; `src/shared/codeNames.ts`), so a card or panel written before the rename works here.
The bridge is `window.inf` as well as `window.fm`, and `window.infAction` as well as `window.fmAction`.
As each element arrives, and again as one of its attributes changes, the bridge gives a Firstmate 3000 hook - `data-fm-action`, an `fm-mono` class - this build's own beside it, `data-inf-action` or `inf-mono`, so the stylesheet and the bridge read it unchanged; the author's own attributes and classes stay as written, and an element that arrives with a hook in both spellings keeps this build's value.
The host's own readers of a body - the card lint, its pictures and demos, its width, its parts and its fact strip - read either spelling the same way (`hasHook`, `hasHookClass`).
Adding it moved `FRAME_BRIDGE_SHA256` once more.
A card body's FORM is the bridge's to read (inline decisions, contract 4.22; `docs/card-authoring.md` "Questions in the body"): after the host's `form` message - which only a card mount sends (`FrameMountSpec.form`), carrying the shell's draft to reapply by name - the bridge watches the named controls and posts the one-way `answers` message (`answered`, `of`, `changed`, `picked`, the answers); the host's `collect` asks for a fresh reading, answered by an `answers` message carrying its `seq`.
A panel or section never has its controls read.
That moved the hash again.
A card body's TASK KEYS are the bridge's to link (FI3-594, FI3-1271; `docs/card-authoring.md` "Task keys"): after the host's `tasks` message - which only a card mount or a task's record sends (`FrameMountSpec.taskKeys`), naming the keys the body writes that are recorded tasks other than its own task's - the bridge wraps each where text writes it, outside links and controls (a toggle's summary, a `role=button` element and a draft button among them), in `<a data-inf-task>` and posts the one-way `task` message (`rest` with the key's box, `leave`, `open`).
The host takes a gesture only on a key it told that document, so a frame can point at no task its body does not name.
Linking moves no text, so it is not a live change; it too moved the hash.
A card body's KNOWLEDGE REFERENCES are linked the same way (FI3-1150; `docs/knowledge.md` "References in an answer"): after the host's `entries` message - which only a card mount sends (`FrameMountSpec.entryRefs`), naming the entry ids the body writes that the window reads, each with the words it is read by and its standing's mark (`ok`, `warn`, `none`) - the bridge wraps each where text writes it in `<a data-inf-entry>`, and a click or Enter posts the one-way `entry` message; a reference has no rest.
The host takes one only for an id it told that document, and opens it only from the captain's own gesture; that moved the hash once more.
A card body's KEYBOARD is the bridge's to complete (FI3-800 piece 6; `docs/keyboard.md` "Cards and frames"): after the host's `keys` message - sent to a mount that opens pictures (`onImage`) or hears Escape (`FrameMountSpec.onEscape`), so a panel's pictures stay off the Tab order - each picture a click would open is a Tab stop that Enter or Space opens, and an Escape nothing in the body used posts the one-way `escape`.
A task key the keyboard moves focus to posts `rest` as the pointer's does.
A card's page is born HELD (FI3-871; `docs/renderer.md` "Held preparation"): its builder marks it, its scripts and animations wait for the host's `activate` (`FrameController.activate`, which only a card body calls), and a held page's `resize` carries `held`.
A panel's page is never held; this too moved the hash.
The bridge keeps the element that last had focus in its document and a text field's caret; the host's `focus` message, sent right after the host gave the frame focus back, puts focus back there, in a panel's frame as in a card's.
The host counts a gesture that opens something over the window or in the browser, or moves the captain's focus (`image`, a task's `open`, a card body's `link`, `escape`), only from a frame that holds the window's focus (`whenFrameHoldsFocus`).
That moved the hash again.
A document's MARKUP can be refreshed in place (FI3-1093): the host's `markup` message carries it anew (`FrameMountSpec.markup`, pushed after every `ready` and on every change), and the bridge rewrites only what differs - an attribute, a text, an element that is not the one in its place - so every node the refresh leaves alone is the same node afterwards.
Only a card's fact strip asks for it (`CardFactsFrame`): the host rewrites its facts every minute while the checks' running time grows, and a new document under a press on its pull request link ended that press in another document, so no click came.
While the original document is loading, the bridge keeps only the latest refresh and applies it after `DOMContentLoaded`, including a refresh received before the body exists.
Morphing before that point would let the original parser append the same facts again; `tests/e2e/card-facts-link.spec.ts` holds that parser order before exercising the retained press.
The markup is parsed inert, so nothing in it runs; a card body is still a new document per revision.
That moved the hash again.
`ready` is posted the moment the bridge is installed - **before any template code runs** - so it marks a document's birth: every request a document makes follows its own `ready`, and a second `ready` from the same frame is a new document (a card body rebuilt) whose predecessor's subscriptions and unanswered requests are void.
Each document numbers its requests from 1, so a `response` names the document that asked, and a document's bridge ignores one that names another; that moved the hash again.
That ordering was a real bug for a day: posting `ready` at `load` dropped the subscriptions the template had already opened while parsing.

The host side is `FrameController` (`src/renderer/src/plugins/frames/frameController.ts`), framework-free and one per frame whichever vehicle carries it: source-identity is checked by the caller, the closed envelope is zod-parsed, every request of the current document gets exactly one correlated response, refusals carry a code from `FRAME_ERROR_CODES`, and `FRAME_MAX_IN_FLIGHT` caps unanswered async requests.
An answer finished after the document that asked was replaced (`expectDocument`, or a new `ready`) is dropped, but its request counts against `FRAME_MAX_IN_FLIGHT` until it settles, so a document that replaces itself cannot escape the cap.
`FrameMount` (React) owns a template mount's lifetime; `HtmlCardBody` uses the same controller over srcdoc.

### The read catalog, v0

`src/shared/reads.ts` - beside the protocol, never in a plugin-only namespace.
Eight names, frozen: `observe.sessions`, `observe.session`, `observe.live`, `quota.snapshot`, `feed.recent`, `crew.counts`, `repos.list`, `update.status`.
Task-system P3 (2026-09-09) added three, frozen the same way: `tasks.board` (re-reads on the `inf:tasks` push, never per task event), `tasks.detail` (re-reads on a `task_changed` / `task_event` for its own id and either board push, including presentation-only changes) and `projects.list` - over `inf:tasks:board`, `inf:tasks:detail`, `inf:projects:list` (`src/shared/tasks.ts` carries the shapes, contract 1.2.0).
Git integration PR 1.2 (contract 1.28.0) added `forge.changes` over `inf:forges:changes`: the captain's open proposed changes, read with the captain's in-app sign-in, re-read on the `inf:forges` push and every five minutes.
The Knowledge browser reads collections, graphs, concepts, findings, entries and standing directions in every build over its `home` channels, re-reading on `knowledge_changed` and project changes (`docs/knowledge.md`, "The browser").
The task card's Crewmate tab (contract 2.14.0; `docs/task-card-tabs.md`, "The Crewmate tab") added two: `tasks.crewmate`, a task's crewmate's sessions as a transcript, re-read on its task's events, its calls and each second while subscribed, delivered only when its `revision` moves, and `tasks.crewmate.live`, what that crewmate is writing in its running turn, re-read on its stream - over `inf:tasks:crewmate` and `inf:tasks:crewmate:live`; no panel declares them.
A panel read that takes arguments has its listener third (`reads.subscribe(name, args, listener)`), in either realm, whatever its name.
The same phase made `feed.recent` a view over the task record: a task's line is authored by the core from its timeline row (`src/core/tasks/taskFeed.ts`), carries `taskKey`, and the activity frame paints the key as a dim mono prefix; only task-less lines still persist through `activity_events`.
A captain's settled run, or a copy's count of what it sent so far, rewrites its one task-less line in place, and `feed.recent` re-reads on that rewrite and on the line's withdrawal (`changesFeed`; `docs/orchestrator-contract.md`, "Settled runs").
Each entry maps a name onto a `surface: "core"` channel of `src/shared/ipc.ts`, a strict args schema (a frame chooses a parameter, never composes a query), and an invalidation - an event predicate, a push channel, a push whose payload is the read's own value (`valueFromPush`, task-system P4), or a poll interval.
`reads.test.ts` pins the names, that every entry's request parses against its channel, and that nothing account-, auth-, or card-shaped is in it.
The one new read channel is `inf:observe:live`: the core now holds a session's in-flight turn (`src/core/observe/liveBuffer.ts`, fed at the `broadcastEvent` seam), so a frame that never sees raw events can render the stream, and an Observe pane opened mid-turn shows it - something the React tab could not do.

The `computers.resources` read serves shared live CPU and memory observations, with receiver-owned age and unknown reasons, through `inf:computers:resources` and its same-named value push (`docs/helper.md`, "Shared live readings").
Its polling only renews a bounded demand lease; the core's `ComputerResourceFeed`, not a subscriber's executor, owns the single per-computer sampling cadence.
The renderer shares its upstream resource push and fans the same frozen value out to every local subscriber.
Personal panels may declare this read; no undeclared frame or panel can subscribe.
No resource refresh writes the task record or the panel store.

The host executes and pushes: `ReadExecutor` (`src/renderer/src/plugins/reads/executor.ts`) validates args, runs the read over `window.infinitary.plugins.read` (the preload maps the name to its channel and validates the response like any invoke), re-runs on each declared invalidation, and coalesces bursts to one read per `COALESCE_MS` with exactly one follow-up for an invalidation that lands mid-read.
The plugin host serves the catalog as its one capability (`new PluginHost({ reads: READ_NAMES })`) and keeps each plugin's admitted capabilities so a controller can enforce `read_not_declared` per mount.
Read values are immutable projections: a subscriber receives the complete value, and unchanged rows may retain their identity between deliveries.
A frame whose `ready` declares `reuseReads` receives unchanged array members by their positions in that subscription's previous value, with only new members crossing the message boundary (`src/shared/plugins/readTransfer.ts`).
The encoder and the verbatim bridge decoder share that transport owner; they preserve the sender's order and fields without deriving task or read semantics.
Every subscription and document starts with a full value, errors leave the last successful base intact, and a frame without the capability receives full values as before.
This compaction is local to the frame carrier; the catalog's core deltas, gap recovery and presentation overlays remain the executor's.

The task reads distinguish ready waiting from durable attention (protocol 1.39.0): `waitingCardId` is a reachable shown ready decision on a live task; project `counts.waitingOnYou` counts those tasks once.
`flags.needsYou` and `counts.needsYou` remain broader attention, including operational holds.
The shell projects immediate reply hides/restorations onto delivered values; the executor keeps unprojected values for delta application and gap recovery.
Presentation-only changes advance the board through TaskService, without creating timeline or feed events.
See `docs/task-record.md` for the full rule.

### Fonts in frames

The papercut is closed for every frame, cards included: `frameStylesheet()` (`src/renderer/src/plugins/frames/frameStylesheet.ts`) carries the tokens, the base rules, and the vendored `fonts.css` with each face pointed at `app-frame://fonts/<file>`, which the host serves with CORS from the one vendored copy (`src/main/frames/fontFiles.ts`, electron-vite `?asset` imports - no second copy of the binaries).
`font-src app-frame:` is the one network-shaped directive a frame CSP carries, and `containment.test.ts` allows it with that sole source, narrowed to `app-frame://fonts` for a card body on the srcdoc vehicle (`docs/card-authoring.md`, "Fonts by reference"); `frameStylesheet.test.ts` pins that every face names a file the directory holds, and `frame-vehicle.spec.ts` plus the card sandbox probe check the faces actually load inside a frame.

### Focus and the frames

A frame's own script cannot take the window's focus.
Every plugin frame, a card body's and a panel's alike, carries `allow="focus-without-user-activation 'none'"` (`FRAME_ALLOW` in `src/shared/plugins/containment.ts`), and the main process turns on the Blink feature that makes Chromium honour it, `BlockingFocusWithoutUserActivation`, for every renderer before the app is ready (`src/main/app.ts`).
A `focus()`, `window.focus()`, `select()`, label click, `showModal()` or `reportValidity()` that a frame's script runs while focus is elsewhere does nothing, so the main message keeps its focus, its caret and the keys typed next.
The captain's own click or key in the frame, and the shell's own move, still put focus there, and a script may move focus inside a frame that already holds it.
So when the shell asks a frame to focus something inside it, the shell gives the frame focus first, as a click on it would: a panel's header button pressed into it and F6 into a panel (`FramedPanelBody`, `Rail.tsx`), a card's unanswered question when its waiting default is pressed (`useCollect` in `PrototypeBody.tsx`), and the field a frame held before an overlay took focus (`giveFocusBack`).
When focus left a panel's frame straight for another frame, the window's page may still name the panel's frame as its active element, and focusing it again would move nothing, so a header button's press lets go of the frame first and then focuses it (`focusFrame` in `frameFocus.ts`).
It is also what keeps the gesture rule honest (`whenFrameHoldsFocus`, "Bridge v2" above): a script cannot take focus first to make its own picture, task, link or Escape count.
The policy counts a frame's own user activation, which lasts about five seconds after the captain's last click or key inside it, so the shell spends it as focus leaves the frame.
Each time focus comes back to the window's own page, by a press, a window key, Tab or the shell's own move, the shell spends the page's user activation, and Chromium spends it in every frame of the page at once (`guardFrameActivation`, `src/renderer/src/plugins/frames/frameActivation.ts`).
It calls Web Share with empty data: Blink consumes activation before rejecting the data with `TypeError`, without asking the browser or the OS to share anything.
The app window enables `WebShare` on every desktop platform; task browsers and media probes do not enable it, and sandboxed frames have no web-share grant.
The guard never calls `window.open` or waits synchronously for the main process, and it handles the expected rejected promise locally.
The page hears its own focus before it tells Chromium where focus went, so a frame's script that tries the moment its frame loses focus already has nothing left to take focus with.
Focus that moves from one frame straight to another passes the page by, and the frame left learns it lost focus before the page could hear of the move.
So while a frame holds focus, the shell spends the activation as soon as the pointer moves over the page's own content, which it crosses on its way to a click in any other frame.
It spends it again when it sees that focus moved from one frame to another: it reads where focus is each time a frame speaks, and each frame's bridge says when its own window gains or loses focus (`focused`), heard before any script of the body's and sent through what the bridge held from its start.
Each frame's bridge says the same way when a press begins in its own window (`pressed`), which the window's page does not hear either: the window counts the captain's presses, and a card he pointed at takes focus once it appears only if he began none since (`docs/keyboard.md`, "Cards and frames").
A frame's script that sends `pressed` itself can only keep a card from taking focus.
A panel's pointing asks its frame to answer a ping before that card decides (`FrameController.heard`), so a `pressed` the frame's process sent late, just after the pointing, still counts.
Where the pointer never crossed the page, a script may still take focus back in the task right after its frame lost it; for the activation's lifespan after focus left a frame for another, focus that lands back in it while no click or key of the captain's holds the page goes back to the frame the captain moved to (`giveFocusBack`).
The window's own gates read the captain's gesture through `windowGesture`, which keeps counting a spent one for as long as it would have lasted, so a press that brings focus back from a frame still counts as the captain's.
When the window's own page takes focus off a frame without the captain's doing, as a page in a new process does the first time the window is focused, the shell gives it back, whether the page's focus then rests on the frame or on nothing (`guardFrameFocus`, `docs/keyboard.md` "Cards and frames").
Focus the captain's own click had put there goes back through the frame's window, so the page still sees the captain click from that frame straight into another, and the guards above still hold.
`tests/e2e/frame-focus.spec.ts` proves the rule for a card body and an added panel, also right after the captain's own click or key in a card, whether the captain goes from the card to the main message or straight to a panel's field, and that the captain's key and click and the shell's own move still work.

### A frame's links

A link in a frame opens only through the host: the bridge turns a click or Enter on an `a[href]` into the one-way `link` message, and a card frame's host opens it in the browser (`openFrameLink` in `src/renderer/src/plugins/frames/frameLink.ts`).
Every step that can stop it leaves one quiet line on the console, `[infinitary] link <address>: <what happened>`, and nothing on a surface.
The window says it heard the frame (`FrameController.receive`), or why it dropped the message first: outside the envelope, from a document the frame no longer shows, or after the frame was gone.
A card frame's host then says why it did not open it - not an address a card may open (`isSafeCardHref`), its card not the one on screen, or its frame not holding the window's focus, naming what held it (`whenFrameHoldsFocus`) - or that it is opening it, and why the system could not.
The main process says when `inf:app:open-external` refuses an address or the system fails to open it.
A click that leaves no line at all never became a `link` message in its frame.
The window's lines are on its developer console, and on the Terminal for an app started from it with `ELECTRON_ENABLE_LOGGING=1`; the main process's are on the Terminal it was started from.
`frameLink.test.ts` and `frameController.test.ts` pin each line, and `tests/e2e/card-facts-link.spec.ts` presses a fact strip's pull request link while the host refreshes the strip.

### Frame scripts are their own compilation

A template script runs in its frame, not the renderer's realm: it sees `window.inf` and nothing of the app.
`tsconfig.frames.json` checks `src/renderer/src/plugins/**/*.frame.js` as JavaScript against the bridge's own types (`FrameBridgeApi`) and the shared schemas, and the renderer project never sees them.
Since the one plugin vehicle (Phase A item 6) only Observe and the task record are templates; the rail panels are ordinary panel folders ("The app's own panels are ordinary folders" below).
Vitest loads the design tokens as text for the stylesheet (`css: true` in `vitest.config.ts`); without it every `.css?raw` import is blank.

## Phase 2: the two rails carry the dogfood


### A side panel on the frame vehicle

`SidePanelBinding` grew a `frame` arm exactly as `SettingsSectionBinding` did: a panel binds a `PanelSource` plus either a React `Body` (Tier 1) or a `FrameTemplate` (Tier 2), and the registry never knows which.
`Rail` mounts a Tier-2 panel as `FrameMount` inside `SidePanelChrome`, with the plugin's declared reads as the frame's whole data surface and no actions - a panel is display.
The manifest entry's `size` decides the vehicle's layout: a `fill` panel's frame takes the body's height (the feed), a `content` panel's frame follows the document's own height as the bridge reports it, from zero, rounded up to fit the pixel-rounded viewport.
Auto-height panel documents leave vertical scrolling to the host from birth, preventing a fractional-height inner scrollbar from narrowing fluid content; fill documents retain their own scrolling policy (`docs/renderer.md`, "Task record and content-panel sizing").

**Whether a panel shows is its own code's.**
A Tier-2 panel's frame paints its own data over the bridge; what the host needs to know is only whether there is anything to show, because a hidden panel takes no width and an empty rail is zero-width.
The host no longer reads a panel's data to decide: a panel whose manifest says `presence: { "code": true }` starts off its rail, its page running, until its own code says `rail.show(true)` ("A collapsed panel speaks for itself" below), so its own subscription is the one read.
The Tasks panel says it while the board has a row it would list; Activity declares no presence and is always docked - the dock is present and collapsed on a fresh window, its collapsed header reading its title and `quiet` until the first line (`79a59c2`, `af06b16`; captain-confirmed 2026-09-19; `tests/e2e/side-rails.spec.ts` pins it).
From the first line on, the collapsed header shows the newest line in the title's place, with its age at the right, and keeps it until a newer one comes, after a relaunch too (FI3-1223; the captain approved the plan of FI3-1222: "when there is a line shown, can we remove the "ACTIVITY" prefix?").
Every line shows there, the captain's own included.

The host's own panels carry no attribution: `registerPlugin(manifest, bindings, { firstParty: true })` marks the built-in plugin, and `SidePanelChrome` renders the title alone for it.
Every other plugin is attributed by its manifest name, as D5 rule 4 says.

### Feed paint work

The frame script records `feed:lag` and `feed:render`.
Every run prints the durations; only a perf run (`verify.yml`'s on-demand `perf` input, the `@perf`-tagged specs, `tests/e2e/perf.ts`) grades a wall-clock budget, because a loaded machine measures the machine and not the frame (captain's B1, 2026-09-24: "one clock, budgets measured").
What every run grades is the work: a growing feed never rebuilds a row and builds each line exactly once, the boot paint builds all two hundred rows in one go, and a new line on a full window removes the oldest row and appends one, with the other rows the same nodes.

## Task-system P4: the now panel and the record card


### The now panel

The panel is the folder `src/panels/now/` ("The app's own panels are ordinary folders" below): whether it shows, what its collapsed header says, its search and every gesture it makes are its own code's, on the API every panel gets.
The paragraphs that follow describe the behavior every shape it has had shares.

It is the right rail's one `side-panel`, fed by `tasks.board`.
It shows once the board holds an ask's record or a row it would list (`onRail` in `src/panels/now/rows.ts`, said with `rail.show`; FI3-1164), so a new profile's welcome, whose record is an answered question, docks it collapsed on the right, while a window with no tasks, or only the trail of app changes, keeps the rail zero-width, and `side-rails.spec.ts` stays pixel-identical with nothing open.
Which rows it lists, and under which of its five groups (waiting on you, working, queued, backlog, done · 7d), is the one shared rule, `nowGroupsOf` in `src/shared/nowPanel.ts`, which the folder imports from `@infinitary/ui`.
Its collapsed header counts each task by its own state (`nowGroupOf`), not the contextual tree rows the expanded Working group shows (`summaryOf` in `rows.ts`, said with `rail.summarize`).
Dropped rows and closed question/operation rows are deliberately outside the panel: an answered question is not landed work, and every plain captain turn files one (P1).

Minimal by default: a counts line, a Search tasks button in its header (a key/title search and project chips, the document's own state, so the header is never rebuilt), rows for the two open groups, the other three collapsed to a count.
Typed text opens every group that holds a match, so a key or title the search finds is always a row in view.
Close search beside the field, Esc once its words are empty, and Search tasks close the search, and closing lets go of its words and project, so every task is listed again.
A row is a status dot, the task key in dim mono at the start of the title, and the project name in dim mono (ellipsized so the title is not crushed), with at most one dim word (`blocked`, `held`, `checks`, `waiting`); a child indents under its parent when both are in the same group.
The task key also stays on hover, search, and the row locator; project chips keep the project key as the filter handle.

**A row's gestures are pointing.**
The panel points with the calls every panel that reads the board gets ("Pointing and the view" below), which the host checks like any input from across the frame boundary.
A click on a row is `point.openTask`: a row waiting on you has its decision card come to the front while that card is on the stack; otherwise the task's record card opens.
Resting on a row is `point.peekTask` with the row's box in the panel's page, or `null`; the host adds the frame's rect and opens the crew summary beside that row (FI3-565 piece 3, `docs/crew-orbits.md` "From a Tasks row").
A panel that reads `feed.recent` may also send `point.peekLine` with the line exactly as read and its box, or `null` to let go.
The host checks the line against the feed it presented and opens its full recorded words and time in the same window-wide summary layer, with the task title and project when known.
A `PanelSummaryLine` may carry `feed`, that recorded line, so the host's collapsed header opens the same summary on rest or keyboard focus without trusting the shortened header words.
The Activity panel uses both paths; its keys keep `peekTask`, its list keeps keyboard wrapping, and its line summaries never read a task's whole report in place of the feed's recorded words.
Nothing a row's gesture does mutates app data.
Activity points from each recorded line and from the task keys on its lines (FI3-1271): it reads `tasks.board` and `tasks.search` to know which keys name tasks, and a key is pointed at as a row is.

**The board push is the read's value.**
`tasks.board` now declares `valueFromPush: "inf:tasks"` (`src/shared/reads.ts`): the executor hands the pushed board to every subscriber as it lands, with no second coalescing window and no round trip, and drops a read still in flight from before it as stale (`executor.test.ts`).
The push is the board the core brought up to date after the commit, equal to a fresh read by construction (`taskProtocol.push.test.ts`), so the shortcut is exact.
For the same reason every subscriber of the board shares one held value: a hover summary that opens on each row, or a Tasks panel remounted on the way back from Settings, takes the board the window already holds instead of asking the core to rebuild it (INF-1860).
It crosses the preload bridge once per push, as text (`tasks.onBoardJson`), and is parsed once and shared, deep-frozen, by every subscriber (`src/renderer/src/plugins/reads/sharedPush.ts`): contextBridge copies an object into the page value by value on the renderer's main thread - the thread that draws the character - and a copy per subscriber of a few-hundred-row board cost 3-11 ms a push, several pushes per crewmate spawn or dispose (character-jank scout, 2026-09-22; a string crossing cut it 78-86%).
Measured on the captain's MacBook against the mock provider: a row paints 36-56 ms after the core's write (`now:lag`, from the row's own `updatedAt` to its paint; the 40 ms board coalescing window is most of it), one paint of the groups under 1 ms.
`now-panel.spec.ts` reads both User Timing measures back from inside the frame, asserts them against budgets, and prints them; the task board's own, `board:lag` and `board:render`, are `task-board-moves.spec.ts`'s.

### The task-record card

`task-record` is a fourth row in the built-in manifest's card-kind slot (`chrome: record`, the design system's "Task" chip) and NOT something the wire can carry: since cards/tasks/agents P1 the wire card has no kind field at all (`cardSchema` is strict), so the card store cannot persist one and `emit_card` cannot produce one (`builtin/index.test.ts`).
It is a VIEW the shell holds - `records` in the store (`src/renderer/src/app/stackActions.ts`), the stack's front entry while open, so the pager, close, and the working layout treat it like any card - rendered by `src/renderer/src/cards/RecordCard.tsx`: host chrome (chip, title, a meta line of key and state in the panel's own words via `taskStatusWord`, close) around a template body, `plugins/builtin/record/`, instantiated per opened task with the task id stamped on the template's root (`recordTemplate(taskId)`) so the frame subscribes to `tasks.detail` for exactly that task.
Goal, the captain's words verbatim, graph, timeline tail with "earlier · N more" (each report's line opens to its whole text), delivery, crew - and no button anywhere: the card's only control is close (captain's second note; superseded 2026-09-28, see "The record's action bar").
The chrome subscribes to the same read for the title and meta, so a state change re-titles the card the moment the record changes.

While the record is the shown entry, a turn carries its task as `taskId` on `inf:converse` - the hint P1 reserved for it - the way a persisted card's id rides `visibleCardId`; the core's about line and the host fallback attach the ask to that task (`now-panel.spec.ts`; the about line's words are `firstmateAgent.capture.test.ts`'s).
Closing the last stack entry is a shell-only act that reveals the character.

### The record's action bar (2026-09-28; one bar since FI3-565 piece 4)

The captain's picks on the task popup board (2026-09-28: "1C 2B 3C 4A", then "ship") reversed the read-only record: **the record's buttons are lifecycle toggles only; judgment calls stay on cards.**
FI3-565 direction A piece 4 gave them one shape: every open record's footer is the action bar (`RecordPaneFooter`, `cards/RecordPaneChrome.tsx`) - one row of buttons under the fact strip, the end slot at its left edge and the next slot at its right (FI3-948, the captain's layout B), so neither button moves between states.
The bar says nothing of its own: the status reason beside the pill says what happens next, and the body's attention box carries what the reason cannot - a blocker, a dropped dependency, a parent whose parts do the work, a hold or another need.
Its state is read only from the task's typed fields through the shared `recordBarOf` (`src/shared/recordBar.ts`), never its prose; Done records and rows with no button have no bar; eligible dropped work offers Start again in the next slot (`docs/task-record.md`, "Starting dropped work again").
The design skill's `TaskRecord` owns the layout and the attention box's words.

| Task (typed, through the shared status) | End slot | Next slot |
|---|---|---|
| Backlog: open work on request, held or not, no parts, no blockers | Drop task | Start (primary) |
| Backlog or Queued with live blockers, or a dropped dependency edge | Drop task | Start, disabled; the attention box names what it waits on |
| Backlog or Queued with parts of its own | Drop task. Open parts refuse the drop. | empty: the status reason and the attention box say the parts do the work |
| Queued: when-ready work, held for a later start or not | Drop task | empty: no Start now |
| Working or Idle | Drop task | empty: nothing needs the captain |
| Interrupted | Drop task | Continue (primary) |
| Waiting on you: a ready decision card | Drop task | Show the card (primary) |
| The first mate's own decision or operation rows, or work returned to the queue after it started | empty: no host op ends it | as above |
| Dropped without a replacement or parts | empty | Start again |
| Done | no bar | no bar |

Drop task is the one end verb (the captain's `end_verb`): on never-started work it runs the footer's own `drop-task` (FI3-243), captain-attributed `dropped/cancelled` with reason "No longer wanted"; once started it runs the host op `stop-task` (the captain's cancel; unlanded work is kept under `refs/infinitary/kept/<id>`).
It asks once, inline, and the confirm sentence between the slots says whether unfinished work is kept (`dropConfirmLead`): Cancel takes the end slot and focus, and the danger Drop task the next slot.
An accepted Drop task closes the record, as an accepted Start does; the task stays dropped on its record, which the Tasks panel opens again with Start again.
Tab reaches the buttons in the order shown.
Continue and Start run the host ops `continue-task` (the ladder's nudge with the captain's authority, which the stall card's Nudge also runs) and `start-task`, which runs `startQueuedNow` - the first mate's `update_task start_now`, which also clears a hold.
A click goes through `inf:task:run` (`window.infinitary.task.run`), lands on the task's history as the captain's with `via: "task-card"` (a Continue here reads apart from the stall card's Nudge), and wakes nobody: the first mate's next context block lists it beside the captain's card choices (FI3-695, `docs/inbox.md`).
On never-started work, open parts are refused and nothing is written; tasks waiting on it stay waiting, and the blocks edge stays.
A refusal is inline text; a Start the host refuses at once also comes back inline beside its feed line, and stop and continue refuse as a feed line.
The task board runs the same ops on a tile, plus its own `queue-task` and `unqueue-task` on never-started work (`docs/task-board.md`, "Moves").
Nothing resolves a card as an answer; a dropped task's outstanding cards come down as obsolete.
Put in, discard and keep are not here.
An accepted Start dismisses the record card, as Hide does (`closeTaskRecord`, by task, so a record the captain paged away from still goes); the row reopens it.
The top-right minus is Hide and only puts the record card away.
Show the card is a pointing gesture: the host refreshes the task's waiting association and brings its decision card forward with `focusCard`, writing nothing.
The record body declares no actions and carries no buttons.
`record-controls.spec.ts` drives every bar state against the built app through the shared `expectRecordBar` (`tests/e2e/rails.ts`).

The same ship made the model a chip app-wide (1C): wherever a container's top row names a model - the record card's chrome, a crewmate card's head (the card's typed `model`, migration 56, beside its meta line instead of inside it), Observe's session rows and header - it is the outline Badge in mono (`design/core/ModelChip.tsx`), which never truncates and is never pushed out of view: the neighbor (the key, the meta line) takes the ellipsis, and a name longer than all the room there is wraps inside the chip.
(Since FI3-565 piece 2 the record card's top row names no model: the record shows it in the shared facts' fact strip, through the one model-name lookup.)

### The stage on a narrow window

Both rails docked on the minimum window (960px) leave a 360px stage.
The input is `min(560px, 100vw - occupied rails - 32px)` wide (`HomePrompt.tsx`), so it fits between them.
That holds at 100%; a larger Size makes the page narrower, and where the rails would leave the input under 328px they fold for it as well, with no card up (`docs/renderer.md`, "Docked rails and the input's room").
Every card asks for more room than that stage has, so while one is up the rails fold and the card takes the window, and they come back when it leaves (`cardPlacement` in `src/renderer/src/cards/cardGeometry.ts`; `docs/card-authoring.md`).
A lone card at that window offers no Show panels edge tabs: returning it to regular would still fold the rails.
Where regular fits beside the expanded panels, either edge tab returns the card to regular and restores the panels.
A card's `maxHeight` keeps its top clear of the 52px top bar at the shortest window (`ResponseCard.tsx`).
`now-panel.spec.ts` checks both themes and that window: an open record folds the rails, and with no card up they stay docked around the stage.

## Task-system P5: the delta carrier through the read executor


## The record, through SQL (plugin data surface, Phase B)


**The views** (`src/core/storage/views.ts`, their one writer) are the contract; the tables keep migrating underneath.
Ten in v1: `v_version_v1`, `v_tasks_v1`, `v_task_events_v1`, `v_usage_v1`, `v_feed_v1`, `v_quota_windows_v1`, `v_routing_v1`, `v_placements_v1`, `v_projects_v1`, `v_repos_v1`.
Not published: cards and their threads, memories, settings, the inbox, captain asks, jobs, schedules - and no view carries an account id or a path.
The honesty the typed reads carried lives in the columns (B4 b): a count nobody recorded stays null, `v_quota_windows_v1` carries `status`, `stale`, `measured_at` and a nullable `percent_remaining`, the first mate's own usage is keyed `FIRSTMATE`, an account is named by its label from the latest quota reading.
`v_feed_v1`'s lines are authored by the feed's own function (`taskFeedLine`, registered as the SQL functions `fm_feed_text` / `fm_feed_kind` on every connection that reads the views), so it says exactly what `feed.recent` says (`views.test.ts` compares them).
Migration 42 created them; every later migration drops them first and re-creates them last, and every open reconciles them against `views.ts`, so an edit there reaches an existing database.

**Versioning** (B5 b): every name carries its version and a query names it exactly - there is no plain `v_usage` and no aliasing.
`v_placements_v1` contains bounded historical start commitments without the private preparation origin, not live capacity; it requires its own declared and granted view like every other SQL read.
An additive change keeps the name and bumps `v_version_v1`'s minor (`SQL_VIEWS_MINOR`); a breaking one ships `_v<N+1>` beside the old view, which stays published for two releases.
A manifest naming a view this version does not publish mounts nothing, with the plain line "this panel was written for an older version of the app's data" (or a newer one, or data the app does not publish).
`views.test.ts` pins every view's column list.
1.1 appended `v_tasks_v1.basis`, the task the work builds on as the record names it (`docs/task-record.md`).

**The read**: catalog entry `sql` (`src/shared/reads.ts`), args `{ sql, params? }` strict (4 KB of SQL, 32 params) over `inf:sql:query` (`PROTOCOL_VERSION` 1.29.0).
The views a query may reach are the plugin's GRANT, added by the host - `ReadGrant`, passed by the read executor to `toRequest` - never by the subscriber.
The answer is `{ columns, rows, truncated, elapsedMs }` (rows keyed by column, cut at 2,000 rows or 256 KB at a whole row) or `{ refused, message }` with `sql_view_not_declared`, `sql_not_readonly`, `sql_invalid`, `sql_timeout` or `sql_too_large`.
Liveness (B3 a): the entry re-runs on any `inf:event` and on the `inf:quota` push (a quota reading is not an event), on the executor's 40 ms coalescing tick; the query process answers from what it has until `PRAGMA data_version` moves; and `sameValue` keeps an answer that says the same thing from being delivered twice.
`tests/e2e/token-dashboard.spec.ts` measures a first mate turn's usage reaching the painted panel (~50 ms here).

**The engine** (`src/core/sql/`): `node:sqlite` (verified inside Electron 43's own Node, 24.18.1, SQLite 3.53.1 - no fallback needed) on a connection opened `readOnly` with `PRAGMA query_only`, no extensions and the defensive flag.
Names are PROVEN before anything runs: the query is first compiled on a scratch in-memory database holding only the declared views, as empty tables with the same columns, under an authorizer that admits SELECT, functions, recursion, reads of those names, the JSON table functions and the query's own CTEs - so SQLite's own resolver is the allowlist, and a CTE the query names like a published view can never reach a table behind it (an authorizer keyed on the "innermost view" argument would let exactly that through).
A statement with no result columns is not a read (VACUUM never meets the authorizer).
The real connection's authorizer then admits only read actions.
**It runs in a process of its own, never a worker thread** (the captain's call on the vehicle, 2026-09-24): one native SQLite step cannot be interrupted from JavaScript, and a worker whose statement never ends keeps spinning after `terminate()`, holds its WAL read snapshot and blocks the app's quit.
`SqlService` (`services.sql`) starts the process on the first query, hands it one query at a time with the database path in its first message, and KILLS it when a statement passes 250 ms - the caller gets `sql_timeout` and the next query a fresh process.
The process is Electron's `utilityProcess` in the app (`HostCapabilities.sqlProcess`, `src/main/host/sqlProcess.ts`; the build's own `sqlProcess` entry beside `keychainProcessMain`) and Node's `fork` in tests and a headless core (`forkChildProcess`), because the packaged binary's run-as-node fuse is off.

**The grant**: `capabilities.sql: ["v_usage_v1"]` on the plugin manifest (`unservableGrants` refuses an unpublished view as `sql:<name>`, and `reads: ["sql"]` as a bare read; `consentSummary` lists the `views`), and `sql` beside `reads` on a personal `manifest.json` until Phase A folds both into the one manifest's capability block.
A personal panel runs `reads.subscribe("sql", { sql, params }, listener)`; a `server.ts` runs `await context.sql(sql, params)` over the views its manifest names at the time of the call; a frame runs `inf.subscribe("sql", ...)` with its plugin's grant.
The authoring guide is the seeded `usage` skill (`resources/personal-workspace/skills/usage/`), with `tests/fixtures/personal-skills/token-watch` as its fixture.
The typed reads stay for now; retiring them, one at a time once their consumers read the views, is a follow-up.

## The one plugin vehicle (Phase A)


| | The app's own (Tasks, Activity) | The captain's own | Added from elsewhere |
|---|---|---|---|
| comes from | the app bundle, as lib files | `userData/fleet/personal/<id>`, written by a crewmate | `userData/plugins/<id>`, pinned at install |
| where it runs | the frame realm | the frame realm; its `server.ts` in a process of its own | the frame realm |
| data | declared reads | declared reads, views, integrations, its store slice, its own `server.ts` | the reads, views, integrations and store slice the captain agreed to; no server |
| can it act? | the host's own gestures (`open`, `point`) and view state | its server's actions, its cards on the stack, pointing, and its moves | its cards on the stack, pointing, and the moves the captain agreed to, nothing else |
| chrome | no attribution | "yours" | the plugin's name |
| control | `personalize` moves or hides it | the switch, safe mode, `personalize remove` | consent, the switch, safe mode, `personalize remove` |

**One manifest** (items 1 and 5; PR 326): the personal `manifest.json` is the plugin manifest (`personalManifestSchema`); its capability keys `reads`, `sql`, `integrations`, `storage` and `moves` are the grant block `manifestCapabilities` reads, and the retired `net` and `secrets` are refused for every source.
The host stamps `source` (`yours` | `installed`) from the root it found the plugin in.
`personalPlugins.ts` registers both sources from one snapshot through `registerPlugin`, attributed "yours" or by the plugin's name, with the grants it is served.

**Two roots, one scan** (item 2): `PersonalExtensions` scans `userData/plugins/<id>` from the `plugins` table (migration 43, `PluginRecords` its one writer: id, source, pinned version, installed-at, the consented capabilities).
An added plugin is served only what the captain consented to: a tree on disk asking for anything else, or holding a `server.ts`, mounts nothing, with the reason named.

**Install by talking** (item 3): `install_plugin` (the first mate's 25th tool) -> `PluginInstaller` (`src/core/plugins/`): fetch as plain files (npm `pack --ignore-scripts`, git with hooks off, or a folder; links refused; pinned) -> `checkPluginTree`, the same check the scan runs (the manifest, no server code, the tidy-up's refusals, a compile for the frame realm) -> one host consent card (`card-plugin-<id>`, host ops `add-plugin` / `decline-plugin` only the captain's click on card chrome runs; only Don't add declines, while the minus keeps the staged offer pending) -> one feed line.
A top-level `runbook.json` instead takes guidance admission through the same installer and consent effects, with no panel mounted; `docs/runbooks.md` owns that contract.
An update asks again only on a capability diff; `personalize remove` uninstalls.

**One switch** (item 5): the `panels` preference and safe mode take back both roots in the same tick.

### The frame realm (item 4)

Every panel runs in a sandboxed frame - the app's own, the captain's own and one added from elsewhere - and the frame needs what the app's window would give a panel in-process.
Four pieces:

- **The lib** (`scripts/frame-lib.ts`, run by the main build): React, the JSX runtimes, `@infinitary/ui` (the design barrel, `src/renderer/src/design/index.ts`), the runtime, and the app's own panel modules, built as ES modules into `out/frame-lib/`.
  Every file's SHA-256 is baked into the main bundle (`virtual:fm-frame-lib`, read by `src/main/frames/frameLibFiles.ts`).
  The shell serves `app-frame://lib/<file>` only for a pinned name whose bytes still match its pin (`frameProtocol.ts`); nothing else exists under the host.
  It is a production build in dev too, and a change to it needs the app restarted.
- **The mount** (`FrameMountRegistry.mountPanel`, `inf:frames:mount` with `kind: "panel"`, `PROTOCOL_VERSION` 1.31.0): a document at a host of its own, `app-frame://panel-<random id>/` - its own site, so its own renderer process, like a scripted card.
  For an added panel or one of the captain's own the shell asks the core for the compiled graph (`PersonalExtensions.framePanelDir`: only a panel of that source it serves right now, at exactly that version, and a crewmate's draft only when the mount asks for the draft), reads its `.mjs` files once and serves exactly those bytes under the mount's host.
  The document carries the bridge, an inline import map whose `integrity` pins every lib file and every one of the mount's files, a JSON config block, and one module script, the lib's `boot.mjs`.
  Its policy is `panelFrameCsp` (`src/shared/plugins/containment.ts`): the frame policy with `script-src` = the bridge's hash, the import map's hash, `app-frame://lib/` and `app-frame://panel-<id>/`.
- **The runtime** (`src/renderer/src/frameRealm/`): `bootPanel` reads the config, imports the panel module, and renders it with `PanelProps` built over the bridge (`framePanelProps`): `reads.subscribe` is `inf.subscribe` (an undeclared read throws at the call, in the app window's words), `store` is the bridge's `store` verb, `invoke` is the host's `server.invoke` action for a panel with a `server.ts` (the captain's own; an added panel has none, so its `invoke` rejects), `theme` follows `inf.onTheme`.
  A module that will not import or a render that throws shows the quiet line (`personal/panelBoundary.tsx`), and a panel's own page tells the host how its body fared (`panel.body`: drawn, or stopped and why), which is what `place_panel` reads back.
- **The host side**: `FrameMount` given `panel` instead of `template`, with the panel stylesheet (`panelStylesheet()`: the tokens, the typefaces, and exactly the side panel body's context - not `FRAME_BASE_STYLE`, which dresses a card's bare markup).
  The controller binds the store verb to the mount's extension id (`FrameMountSpec.store`, a crewmate's draft to its draft slice) - the frame names a key, never whose slice - and an added panel declares only the card actions every panel has and receives only its header buttons' presses as view state ("A panel's cards" above).
  Its watchdog is armed: a panel whose page is showing and leaves four pings unanswered is torn down and mounted again once on its own; a second stop after that start shows "This panel stopped responding." with a Retry, and its header says that instead of the counts the page last sent.
  A collapsed panel, one off its rail, or any frame while the window is hidden is not stopped for missed pings, so it keeps refreshing when it can run again.
  Every message between the window and a frame passes through the main process, so each tick also asks the main process (`inf:frames:alive`); a tick whose question it has not answered counts against no frame, and a pause of the app's own main process never stops a page (INF-935).
  The bridge reports a body's exact height, and a panel mount takes it unrounded, so it lays out exactly as the panel's own content does.

The compiler points every panel's host imports at `app-frame://lib/<file>`; the allowlist is the same for every source.
`FramedPanelBody` is that frame for every panel, and for the captain's own it also draws the host's line when its background work stopped (`BackgroundStopped`, with Retry), above the frame.
`capture_panel` photographs a framed panel by reading each frame's own markup and CSS inside that frame and setting it back as a script-free `srcdoc` frame in the hidden capture document (`src/main/host/panelCapture.ts`).

The evidence: `tests/e2e/installed-panels.spec.ts` (an added panel drawn in its frame from its consented view), `tests/e2e/installed-panel-containment.spec.ts` (a hostile panel refused at every way out, and a runaway one torn down while its sibling draws), and `docs/live-prototype-security.md` ("The frame realm") for the review.

### The app's own panels in the plugin shape (item 6)

Item 6 first moved Tasks and Activity into the plugin shape as modules of the app's bundle, with host-only bindings for their visibility, header and gestures.
Since piece 7 of a panel's cards they are ordinary panel folders with no binding of their own ("The app's own panels are ordinary folders" below).
F6 (`docs/keyboard.md`, "Parts of the window") asks a panel for focus in its body through `railStore.askBodyFocus`: once the document is born, the host gives the panel's frame focus and the panel hears it on `asks.onFocus`, and Tasks and Activity put focus on their list; an ask a document was born with is never a new one.
Their templates (`now.html`, `now.frame.js`, `activity.html`, `activity.frame.js`) are retired; Observe and the task record stay templates.

## A panel's cards (FI3-1014)

The captain's words that started it: "a generic facility for plugins to render a card in the main card stack. ideally, this kanban board should be able to be fully migrated to the generic facility once it's done".
The captain's approved plan (FI3-1014) builds one way for any panel, whoever made it, to put up any number of cards on the main stack, in seven pieces that merged in order (each below); in piece 7 the task board moved onto them.
The plan's answers: moving tasks is asked for once and agreed when the panel is added, a collapsed panel says what it holds from its own code in a page kept running, and a panel may put up a card without the captain's click, behind the card the captain is reading, marked new.

**One call.**
`PanelProps.cards.emit({ id?, view, title, width?, height?, data? })` puts a card up and answers its id (`src/shared/personal/contracts.ts`); an open id is revised in place, its view hearing the new data, and `cards.close(id)` and `cards.open()` complete it.
`view` names a file of the panel's folder, `cards/<view>.tsx`, a card view: a component taking the same `PanelProps` plus `card` (`{ id, data, revision, kept, keep }`), so a card can put up cards of its own.
`revision` counts the times the card was put up, from 1, so a card hears each press of a button or command that names it even when its data is the same: the board answers a focus ask once per revision.
`height` is `content` (the default: the card follows its page's own height) or `fill`: the card takes the stage's height and its page scrolls inside it, for a card such as the board whose own row and foot stay while its body scrolls (`PANEL_FILL_STYLE`).
A `wide` card gives way to the docks as a task's record does.
The compiler builds every card view into the panel's own graph (`compilePersonalModule`, `CompiledModule.views`), so a panel and its cards are one version, and a panel added from elsewhere has its cards pinned with it at install.
A panel may have 16 card views and 50 cards open at once (`PANEL_OPEN_CARDS_MAX`, the plan's assumption); data is at most 3,072 bytes of JSON, so it fits one frame message beside the title.

**Declared as data.**
`manifest.json` gains three keys the host reads and draws as its own chrome (`src/shared/plugins/panelCards.ts`): `cards` names cards by name (`{ view, title, width?, height?, data? }`, the name is the card's id); `header` holds up to three buttons (`{ id, icon, label, emits?, data? }`, the icon from the app's own set) drawn beside the chevron; `commands` adds up to sixteen commands to command search (`{ id, label, emits | presses, data?, key?, words? }`, `words` being up to eight more one-word terms command search matches, as `kanban` finds Open task board).
A button or command that `emits` is sent by the app itself (`emitNamedCard`), so it works while the panel is collapsed, and its button is drawn in both header states; a button that emits nothing, or a command that `presses` it, opens the panel and is pushed into it as an ask (`PanelProps.asks`), so its button is drawn only while the panel is expanded, leaving a collapsed header its room for what the panel says.
An ask says how it came, `click` or `key` (`asks.subscribe((button, via) => ...)`): the Tasks panel's search opens and closes on a click and opens with the caret in it on Find a task.
A name that points at nothing the folder has is the panel's error: the captain's own panel draws without its cards, buttons and commands, and one from elsewhere is refused at install (`panelCardsProblem`).
`api` names the panel API a folder is written for; this app serves 1, and a folder naming another mounts nothing.

**On the stack.**
A card is a shell-held entry, `OpenRecord`'s `{ panelCard: { panel, id, view, title, width, data } }` (`src/renderer/src/app/stack.ts`), any number per panel, never saved.
From the captain's own click or key - the app's header button or command, or inside the panel or a card - it comes to the front; otherwise it waits behind the entry the captain is reading, marked new (`emitPanelCard`).
That is the panel's frame holding the window's focus (`framePanelCardAction`, `frameHoldsFocus`); a header button or command is the window's own gesture (`windowPanelCards`, `windowGesture`).
The stage draws `PanelCardView`: the app's one row of chrome - the title, `yours` or the maker's name, Hide - and the panel binding's `CardBody` under it.
A card runs where its panel runs, in a frame of its own (`framedCardBody`, a `kind: "panel"` mount whose `panel.view` names the card view - the module `cards/<view>.mjs` beside `panel.mjs` - and whose config carries the card's id; its data rides view state).
Only the shown card runs a page: the stage prepares no held entry, so waiting cards cost nothing and the 16-mount cap is never met by them.
Hide or an Escape nothing in the card used hides it (the bridge's `escape`), F6 lands on it and gives the card's page focus (`enterCard`), and a panel that leaves the core's snapshot - removed, or every panel taken back by the switch or safe mode - takes its cards with it (`PersonalPlugins.closeCards`).

**What the frame realm gained.**
A frame's action is now answered with its handler's plain data (`FrameController`; the bridge already resolved `inf.action` with the response's `result`, so its script and its hash are unchanged).
Every panel mount declares only the actions its grants allow (`framePanelActions`, `plugins/panelActions.ts`): the three card actions, `card.keep` on a card's own page, `point.*` for one that reads `tasks.board`, `tasks.run` for one the captain agreed may move the captain's tasks, `rail.*` on the panel's own page, and for the captain's own panels `panel.body` on that page and `server.invoke` (its value at most a store value's size, 256 KiB).
A page drawn for a crewmate's build is declared the same actions bound apart: its draft's rail copy and store slice, cards that reach no stack, and no click or key of the captain's.
Its view state carries the presses of its header buttons, counted, with how the latest came, and F6's focus asks, counted, so the runtime hears only an ask made after the document was born, counted from `inf.birthState`, and the view, whether it is collapsed, and a card's data, revision and kept place (`frameRealm/panelProps.ts`).

**Its commands are the window's.**
A panel's commands are `panel:<panel>/<command>` (docs/keyboard.md, "A panel's commands"), installed with the catalog's in the order the panels were added, each suggested key given only where nothing else uses it.
The app's own Tasks keeps ⌘B and ⇧⌘F that way (`panel:now/board`, `panel:now/find`), because the app adds it before any other panel, and keys the captain saved under the commands it had before, `tasks.*`, are read as these (`RETIRED_COMMANDS` in `src/shared/keymap.ts`).

### Each card's kept place (piece 2)

Only the shown card runs a page, so a card the captain pages away from is born again when the captain pages back.
`PanelProps.card.keep(value)` keeps the card's place - its scroll, a tab, its Find - on its stack entry (`PanelCardEntry.kept`), at most 4,096 bytes of JSON (`PANEL_CARD_KEPT_MAX_BYTES`), until Hide takes the card away; a revision of the card keeps it.
`card.kept` is what the card last kept, as its page was born: the value in the first view state the host pushes, which the runtime waits for before it draws a card (`firstState`).
A later `keep` is for the next page, never a re-render of this one.
A card's own page declares `card.keep` beside the card actions (`PANEL_CARD_VIEW_ACTIONS`); the host knows the card from the mount, so the value is the action's whole value.

### Pointing and the view (piece 3)

A panel that reads `tasks.board` gets `PanelProps.point` (`src/renderer/src/plugins/panelPoint.ts`), in either realm:

- `openTask(taskId)` opens a task as a Tasks row does: its waiting card forward, or its record at the front (`openTask` in `plugins/point/openTask.ts`).
- `openRecord(taskId)` opens the task's record at the front even while a card waits for it, as the board's Open record does.
- `peekTask({ taskId, box } | null)` rests on a task: the box is in the page's own pixels, the host adds where the page's frame currently sits, and the crew summary opens beside the panel on its rail, as a Tasks row's does, or on the stack beside the box itself, as the task board's tiles' always have (`PanelPeek` in `plugins/point/taskPeek.ts`, drawn by `PeekSummary` as `[data-point-summary]`).
  A frame resizing after the page reports its row repositions the summary from those page coordinates, so a shorter row moving into Backlog keeps its hairline.
- `showCard(cardId)` brings a task's waiting card forward, by the `waitingCardId` the read gave, and answers whether it came forward.
- `aim(taskId | null)`, in a card view only, aims the captain's next message: while that card is the shown entry, `submit` sends its aim as the turn's task, as a shown record does (`PanelCardEntry.aim`).
- `draft(text)` starts the captain's next message: one line of at most 500 characters at the head of the main message field, the keyboard there and the caret after it, what the captain had typed kept after it (`beginDraft`, as the Create panel slot starts one); nothing is sent until the captain sends it.
  It names nothing of the app's, so every panel has it, whatever it reads (`PANEL_DRAFT_ACTION`); it answers false while the message field is held, a recording for one.
  The Knowledge browser's Ask about this uses it (`docs/knowledge.md`).
- `openSettings(section, item?)` opens Settings at a section this window offers, by its id, and hands that section `item`, at most 128 characters on one line, to show on arrival (the shell's `settingsItem`, which the section reads once and clears); it answers false for a section the window does not offer, a view's hidden sections among them.
  Like `draft` it names nothing of the app's record, so every panel has it (`PANEL_OPEN_SETTINGS_ACTION`), and it counts only from the captain's own click or key.
  The Automation panel's rows use it to open a rule's sheet, and its header's Open Automation, an ask, to open the full list (`docs/automation.md`).
- `focusProject(projectId)` focuses the window on a project the board lists, or on every project with null: the same focus as the top bar's project pill, saved with this computer's layout (`docs/project-focus.md`).
  It counts only from the captain's own click or key; the Tasks panel's and the board's project chips use it.

The host checks every id against the board it presented (`boardOnScreen`): a task or a card the board does not list does nothing - except a closed task the panel's own `tasks.search` found, which it may open and point at, so a board's Find reaches done and dropped work.
Opening, bringing forward, aiming, focusing a project and drafting move the captain's focus or the captain's words, so they count only from the captain's own click or key in that page - the window's own gesture for a panel of the captain's own (`windowGesture`), the frame holding the window's focus for one from elsewhere - and answer false otherwise; resting, and letting go of an aim with `aim(null)`, need no click.
`PanelProps.view` is what the captain has open, pushed in for a panel that reads the board: `openTaskIds` (the records on the stack), `shownTaskId` (the task of the shown entry - a record, a task's browser, the board's selected tile, or a card's aim), `litTaskId` (the task a rest anywhere in the window lights, or null; `plugins/point/litTask.ts`, `docs/crew-orbits.md` "The lit task") and `focusedProjectId` (the project the window is focused on, or null for every project; `docs/project-focus.md`).
A panel draws `litTaskId` as its own rest, without the summary: the Tasks panel marks the row `data-now-lit` and lights its blocker edges, the board marks the tile `data-board-lit`, and `PanelTaskKeyText` takes `litTaskId` and lights its keys of that task (`litTaskIn` lets a memoized row hand it on only where it writes that key).
A card body's and a record's frame hears the same through the bridge's host-to-frame `lit` message, the key of the lit task or null, pushed only to a mount whose `taskKeys` name that key and again to every new document: the bridge sets `data-inf-lit` on each `a[data-inf-task]` for that key, and the frame stylesheet draws it as the hover surface.
A panel that does not read the board gets an empty view, and its `point` throws at the call - every call but `draft`.

A panel links the task keys its words write with the library's own pieces (FI3-1271; the design skill's core rule "Task keys"): `usePanelTaskKeys(reads, texts)` finds which keys name tasks from the panel's own `tasks.board` read, and from one exact `tasks.search` for a key the board does not list, and `PanelTaskKeyText` draws the words with each such key a `TaskKey` link - a rest is `point.peekTask` with the key's box, a click or Enter is `point.openTask`.
Activity links every key on its lines and the Knowledge browser the keys in its inspector, outside its rows; neither changes the shape of a read.

### Moving tasks (piece 4)

The captain's answer on FI3-1014: "Asked for once, agreed when you add it, then each move on your click or key".
`manifest.json` `"moves": true` is a capability like `reads` (`capabilitiesSchema.moves`, `PLUGIN_HOST_SUPPORT.moves`): the consent card of a panel from elsewhere says "It can queue, start and drop your tasks, each only when you click or press a key in it.
It can never merge or discard.", and an update that adds it asks again, because the canonical block differs.
A panel with the grant gets `PanelProps.tasks.run(taskId, move, review?)` (`panelTasks.ts`): one of the lifecycle moves (`TASK_LIFECYCLE_OPS`), run through the task record's own `inf:task:run` and its write-time checks, answering `{ ok: true }` or the app's words with nothing written.
A move counts only from the captain's click or key, gated as pointing is; one made otherwise answers "Only your own click or key in this panel moves a task.
Nothing was written."
It lands on the task's record as the captain's, naming the panel: `inf:task:run` carries `{ panel: <title> }`, every history entry the move writes records it (`data.panel`), the record's Activity line says so ("From the Task desk panel.", `condenseActivity`), and the first mate's context names it ("from the Task desk panel").
The app's own panels name none, as they carry no maker's name: their moves read as the record's own buttons' do (`panelTasks`'s `own`).
`tasks.detail` joins the panel reads with its `{ id }` argument (`reads.subscribe("tasks.detail", { id }, listener)`), so a never-started Drop task can send the `review` its `dropEffects` list.
`tasks.search` joins them too, with its `{ query }` argument: the app's own search over every task, closed ones included, so a panel's Find lists done and dropped work the board no longer carries.
Each live or dropped work row of the board says which lifecycle moves it allows now, and why not (`TaskView.moves`, `taskMovesOf` in `src/shared/taskMoves.ts`, from `recordBarOf` and the task service's queue guard), and whether its waiting card settles with a merge (`waitingCardMerges`); `presentTask` recomputes both when the stack shows another card for the task, or none.

### A collapsed panel speaks for itself (piece 5)

The captain chose "Its own code, in a page kept running while it is collapsed".
Every panel of the one shape keeps its body mounted while its dock is collapsed (`SidePanelBinding.rail`, `SidePanelChrome` `keepBody`), so its page runs on, and `PanelProps.rail` (the panel itself, never a card view) carries `collapsed` and two calls (`panelRail.ts`):

- `rail.summarize(parts | null)`: at most three parts of at most 32 characters, drawn by the app in the collapsed header as its own chrome (`[data-panel-summary]`), a `strong` part in the primary color as the Tasks panel's waiting count is.
  One part may be a line instead (`PanelSummaryLine`: `line` of at most 500 characters, a `lead` of at most 32 such as a task key, and a `tone` from the feed's own five).
  The line takes the title's place while it shows (`SaidLine.tsx`, `[data-panel-summary-line]`), drawn as the activity feed draws a row: a dot in its tone, the lead in mono, the words cut with an ellipsis, the short parts after it at the right.
  The section keeps its title as its name, and the chevron still reads Expand and the title.
  The line is a button named Open and the title, the whole line its description, so resting the pointer reads it whole and a click or Enter opens the panel.
  A line with new words rises in over `--dur-med` by `--move-stack` while the one it replaces lifts out over `--dur-fast`; each holds the header at least 0.7 seconds and a burst keeps its newest two, the removed whisper's timing (`git show 2044d5ca^:src/renderer/src/app/wisp.ts`).
  The line on mounting rests, and reduced motion makes both moves a cut.
- `rail.show(shown, why?)`: only a panel whose `presence` is `{ "code": true }` decides; it starts off its rail until it says `show(true)`, and off it, its section stays in the rail, `hidden`, its page running.
  Off its rail, `why` (at most 60 characters) is what command search says beside a command that would press into it, as the Tasks panel's "There are no tasks yet"; without one the app says the panel has nothing to show.

The rail docks only while it holds a shown panel (`[data-rail]:has(> [data-side-panel]:not([hidden]))` in `design/styles.css`), so a hidden panel takes no width.
In a frame the two calls are actions (`PANEL_RAIL_ACTIONS`) and `collapsed` rides view state.

### The panel library grows (piece 6)

`@infinitary/ui` exports what a panel that draws tasks draws them with: `TaskStatusMark`, the status words (`taskStatusOf`, `taskStatusLabel`, `waitRecordedTime`), the shared grouping (`NOW_GROUPS`, `NOW_GROUP_LABELS`, `nowGroupOf`, `nowGroupsOf`), `focusWithRing` and `useInPlaceReveal` (docs/personal-panels.md, "The library is the panel library").
Piece 7 added the app's own words for what such a panel says: a task's search folded the app's way (`foldForSearch`), a feed line's age (`feedRelativeAge`), Drop task's question in the task record's own sentences (`DROP_TASK_LABEL`, `dropConfirmLead` and the rest of `src/shared/recordDrop.ts`), and the panel's expand chevron (`PanelExpandChevron`).
The compiler admits a panel's own stylesheet as text: `import styles from "./board.css"` makes `board.css.mjs`, whose default export is the file's contents, which the panel puts in a `<style>` of its own; a stylesheet imported without a name, or from server code, is refused, and the lint reads it like any panel file.

### The app's own panels are ordinary folders (piece 7)

Tasks and Activity are `src/panels/now/` and `src/panels/activity/`, each the folder a panel from elsewhere is: a `manifest.json`, a `panel.tsx`, card views under `cards/`, its own stylesheets, and files of its own, importing only React, `@infinitary/ui`, its own files and `@infinitary/contracts` for types.
The task board is the Tasks panel's card `board` (`docs/task-board.md`), its header button and its commands the manifest's.
No code of the app's names either: the app reads each folder's manifest once (`APP_PANEL_FOLDERS` in `src/shared/surfaces.ts`) for the rails' titles and places and the first mate's "your surfaces", and registers each as a side panel exactly as it registers a panel from elsewhere (`FramedPanelBody`, `framedCardBody`), served the reads and moves its manifest asks for, with one difference, a label: the app's own carry no maker's name.
The main build compiles each folder with the panel compiler for the frame realm (`compileAppPanels` in `scripts/frame-lib.ts`, through Vite's `runnerImport`) into the lib as `builtin/<id>/panel.mjs` and `builtin/<id>/cards/<view>.mjs`, pinned like every lib file; a mount names one with `{ source: "builtin" }`.
`src/core/personal/appPanels.test.ts` holds each folder to what a panel from elsewhere passes - its manifest parses, it compiles for the frame realm, every card, button and command it names is one it has, and the panel lint finds nothing - and to the list the app registers.
`tests/e2e/tasks-from-elsewhere.spec.ts` adds the Tasks folder from elsewhere under another id and a maker's name, and runs the board's journey on it by keys, drag and menu.

The panel API gained what the two needed, each generic: `tasks.search` as a panel read, `point.openRecord`, an ask's `via` and `asks.onFocus`, a card's `revision` and `height`, a command's `words`, header asks drawn only while expanded, wide cards that give way to the docks, closed tasks a panel's own search found as ones it may point at, and a panel's own words for why it is off its rail (each above).
What a person does with them did not change (the captain, on FI3-1043: "I want all user-facing behaviors to stay unchanged, unless there's a very concrete reason we can't achieve it").
So the app's own panels read as the app: their commands are the window's own in command search and Keyboard settings (`PanelCommand.own`), their moves name no panel, and a card's summary sits beside the tile it rests on.
The one change is the board's title row: the app draws Tasks and Hide for every panel's card, where it names who made a panel from elsewhere, so the board's count, chips and Find sit on its own row beneath.

#### A folder that waits on a gate

Knowledge, `src/panels/knowledge/`, is an app panel folder available in every build when Knowledge has something to show (`docs/knowledge.md`, "The browser"), and Automation, `src/panels/automation/`, one that exists only while a saved automation rule does (`docs/automation.md`, "The Automation panel").
Each entry in `APP_PANEL_FOLDERS` names the gate it waits on (`gate: "knowledge"`, open while the build keeps knowledge and has some to show; `gate: "automation"`, open while `automation.list` holds a rule), and nothing about them is special beyond that: the built-in plugin registers the ungated folders before the first render as before, and once the captain's own panels have their places the window registers each folder whose gate is open as one more first-party plugin of its own gate, `firstmate-gated-<gate>` (`registerGatedPanels`, `startGatedPanels`, `gatedPluginId`), with its own reads as that plugin's grant, so one gate coming or going never remounts another's panel.
For Knowledge the window asks `inf:knowledge:enabled`, again after each `knowledge_changed` and each project that comes or goes; for Automation it follows the `automation.list` read, and an `unavailable` answer leaves the gate as it was.
It takes a folder - its panel, cards and command - away when its gate shuts.
Registered after the captain's own panels, a gated folder takes no suggested key from a panel added before it and takes its place on its rail however many panels the rail already holds; where its gate is shut - or, for Knowledge, on a view of another Mac, which is refused Knowledge's question - it registers no panel, card or command.
A view of another Mac follows that Mac's `automation.list`, so it shows the Automation panel as that Mac does.
The core lists a gated folder among the first mate's surfaces only where its gate is open (`builtinSurfacesFor`, `listSurfaces`), and every app folder's id stays reserved from panels added from elsewhere either way.


## Personal extensions (talk-to-personalize Step 2)


**The workspace** (`src/core/personal/workspace.ts`) is a git repo the app seeds at every boot and never prunes: the managed files - `AGENTS.md`, `tsconfig.json`, and `infinitary-env.d.ts` - are force-copied when their text differs (a stray edit is restored, a new app version ships a new contract), committed under the app's identity only when the staged text differs from HEAD, and nothing else is ever deleted.
`infinitary-env.d.ts` is GENERATED from the type-only contracts in `src/shared/personal/contracts.ts` by `pnpm generate:personal-env` into `src/core/personal/seed/firstmateEnv.generated.ts`; `firstmateEnv.test.ts` renders it again and compares, and type-checks a sample panel and server against it with no node_modules, so a contracts change without regeneration fails CI.
The managed set is data (`MANAGED_FILES`): Step 3 adds the app-owned skills under `.claude/skills/` as rows.

**The compiler** (`src/core/personal/compiler.ts`) is where coherence is enforced, at admission rather than display (design section 6, layer 3).
It transpiles the entry and every local file it reaches with `typescript` at runtime (now a runtime dependency, as in baby-menu) and walks the emitted imports on the AST: a panel may import `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `@infinitary/ui`, and files inside its own directory; a server module `node:*` built-ins and local files; either `@infinitary/contracts` type-only (the transpile elides it; one that survives was a value use and is refused).
Anything else - an npm package, a `..` or a symlink that leaves the directory, a dynamic `import()`, a re-export of a host module, a syntax error - is a `PersonalCompileError` naming the file as `<id>/<relative>` and the import.
Output is content-addressed, `userData/cache/personal/<id>/<hash>/<relative>.mjs`: identical sources are the same version; any edit is a fresh one, which IS the hot reload - a new frame for the panel, and the cache bust for the core's `import()` of `server.mjs`.

**The host modules.**
The compiler rewrites an admitted host import into a default import of the frame lib's module plus a destructuring (`app-frame://lib/<file>`, "The frame realm" below), so **the `@infinitary/ui` surface is list-free: Step 3 adds a component by exporting it from `design/index.ts` and nothing else moves** - the lib builds that barrel as it stands.
No panel code is imported by the app's window.

**Mounting** goes through the host's one door: `src/renderer/src/personal/personalPlugins.ts` registers every extension in the core's snapshot with `registerPlugin` as a plugin `personal-<id>` whose one side-panel contribution binds a Tier-1 `Body` (`FramedPanelBody`, the frame every panel draws in), so the rails learn no new concept; its attribution reads `yours` (`PERSONAL_ATTRIBUTION`), never a plugin name.
Two things ride sources rather than registration: the panel's content (`null` while its presence rule is unsatisfied or it has no compiled panel, so the rail shows no chrome - visibility stays data, D5) and `running` (a new optional `PanelSource<boolean>` on `SidePanelBinding`: the host draws a `busy` `StatusDot` in the header while true - the design skill's StatusDot gained that tone, ember, the working crewmate's heat).
A change to the manifest data (title, placement, order, size) re-registers; a rail holds every panel placed on it, and only a real error in registering a panel, such as an id another plugin holds, is a refusal, which the window logs, keeps with its own words (`railRefusals`) and reports to the core with its answer about every panel, so the crewmate that placed the panel and the first mate both read why it is missing (`docs/personal-panels.md`, "Placed on the rail").
`FramedPanelBody` mounts the panel's pinned version in a frame of its own (`code.source: "personal"`), whose runtime hands the component `PanelProps` (`id`, its `store` slice through the bridge, `invoke` through the host's `server.invoke` to `inf:plugins:invoke`, the theme), and keeps a throw - or a module that will not import - inside one boundary that shows the design system's quiet line (`This panel stopped drawing.`, `[data-personal-stopped]`, inside the frame) with the chrome staying; the next version is a new frame, never a timer.
Each body on a rail says how its version fared - drawn, or stopped with the error's first line (`panel.body`, kept in `panelBodies`) - for the same answer, and a frame that stops answering is a stopped body too.

**The core service** (`src/core/personal/personalExtensions.ts`, `services.personal`) seeds, scans (`<id>/` directories holding a `panel.tsx` or a `server.ts`), compiles, starts every `server.ts` in its own process (`PanelRuntimes`, `src/core/panels/`: a real `import()` of the compiled entry in that process; actions callable by name; background tasks on that process's timers with the cadence clamped up to `MIN_BACKGROUND_INTERVAL_MS` = 60 s, a run in flight skipped rather than overlapped, a throw logged and the timer kept), watches the workspace with `fs.watch` recursive, a 150 ms debounce, and a short source-mtime poll so a dropped event still hot-reloads, and pushes ONE snapshot (`inf:plugins:personal`, `PersonalExtensionView[]`): title, placement, the compiled panel's version (`frame`; `panel` stays null, kept so an older reader parses), what the server exports after clamping, `present` (the presence rule's verdict - `{ always }` or `{ store, when: "nonEmpty" }` evaluated against the store in the core, `presenceSatisfied`, one home and one test), `running` (`manifest.origin.taskId` names an `active` task; Step 4 stamps it), and any `error` with its stage.
While a crewmate builds an extension the snapshot carries its last commit and the working files as `drafts`, run apart (`docs/personal-panels.md`, "Built apart"), so the hot reload above reaches the rails for an edit made by hand and, for a build, at its report.
The extension store is `plugin_kv` (migration 33; `PersonalStore`): JSON values namespaced by extension id, a key at most 128 characters, a value at most 256 KiB, a slice at most 1 MiB, refused over a cap with the cap named; `context.db` server-side and `window.infinitary.plugins.db` in the renderer are the same table, every write pushes one `inf:plugins:db` notice and re-evaluates presence.
The D-13 purge clears the store and the compiled cache; the workspace's files stay, like a repo's.

Frozen surfaces: no new top-level `window.infinitary` key (`plugins` gained `personal`, `invoke`, and `db`), no new tool, three core invoke channels and two core pushes, `PROTOCOL_VERSION` 1.5.0.
The word "extension" and the word "plugin" reach no user surface (`tests/e2e/personal-panels.spec.ts` asserts it the way `report-sort.spec.ts` does).
The e2e drives two of the three fixtures under `tests/fixtures/personal/` through the built app: a panel built from `@infinitary/ui` renders on the rail while its presence key holds data and disappears when a server action empties it; a background task declared at 1 s reads 60 s in the snapshot and has written through the bound store; a thrown render shows the quiet line with the chrome and the rail staying, and rewriting the file on disk reloads it.
The third, `bad/panel.tsx`, has its `lodash` import refused with the path named, and nothing mounts for it (`src/core/personal/personalExtensions.test.ts`).

Built since, by the plan's own sequencing and documented in `docs/personal-panels.md`: the component library, the skills and `pluginLint` (Step 3); the `personal` workspace kind, the crewmate brief, the stamp and the commit at turn end, `lint_panel` and `capture_panel`, the declared app-data reads, "your surfaces" and `personalize remove` (Step 4); the host-owned switch, the safe-mode boot and Observe's Panels group (Step 5, the last).
Rail overflow follows the measured fold ladder below.

## Preferences by talking (talk-to-personalize Step 1)


**One writer, one read.**
`ShellPreferencesService` (`src/core/preferences/shellPreferences.ts`, `services.preferences`) is the only thing that writes the `appearance` and `layout` rows Step 0 introduced.
The window's own controls reach it over `inf:settings:appearance|layout:set`, the first mate over `personalize`, and every write pushes the WHOLE value as `inf:shell:preferences` - the value of the new read-catalog entry `shell.preferences` (`valueFromPush`, like the board), so a pushed value equals a fresh read by construction and the window applies it with no round trip (`renderer/src/app/preferences.ts`: `applyPreferences` seeds the theme, never through `setTheme`, which would write it straight back).
`PROTOCOL_VERSION` 1.6.0: one core channel, one core push, `settings.getPreferences`/`onPreferences` under the existing key.

**The layout record carries one deviation and one arrangement** (`src/shared/preferences.ts`): `hiddenPanels` (`true` keeps a panel off its rail whatever its data says - the rail is zero-width for it, exactly as if its source were `null`) and `arrangement` (INF-2344), which lists every panel the app knows in each of the four slots, each rail's top and bottom group, top to bottom as the rails draw them.
`hiddenPanels` defaults to empty so a Step 0 row still parses.
The arrangement is the one source of every panel's slot and order: the rails, Settings → Panels, a header drag, a More pick and the first mate's `panel` action all read and write it through `src/shared/panelArrangement.ts`.
A slot's edge is the end at the window's edge, the top of a top group and the bottom of a bottom group; its middle is the end facing the other group.
The core writes the arrangement in once from where the rails drew each panel before it existed, so nothing moves (`ShellPreferencesService.reconcile`, run at start and with each personal snapshot, before the window hears of it).
After that a new panel lands at its slot's middle, and a panel the app stops serving keeps its place until `remove` forgets it.
Before the arrangement, a panel's slot came from `placements` and a full rail's More picks from `panelOrder`; nothing writes them now, and they place only a panel the arrangement does not list yet.
`SettingsStore` keeps the arrangement and the More pick in a row of their own, `panel-arrangement`, so an older build still parses the `layout` row it reads (`docs/saved-data-compatibility.md`).
`placeSidePanels(panels, layout)` applies the arrangement and `hiddenPanels` over every registered panel, returning the placement actually used so the chrome's docking follows a move; the registered contribution is never written back.
A hidden panel is skipped, not unregistered, so "show tasks again" is a record deletion and nothing re-mounts.

**Surfaces have ids.**
`src/shared/surfaces.ts` declares the app's own panels once (`activity` "Activity", `now` "Tasks", with their default placements); the built-in manifest declares its side panels FROM it, and the first mate's context block gains a bounded "your surfaces" section (`FirstmateContext.renderSurfaces`, with `renderSurfacesSection` in `src/core/pi/personalizeTool.ts` its plain-text form): the theme, each app panel, each personal extension from Step 2's snapshot (marked `(yours)`, capped at twelve with a count for the rest), listed in the arrangement's order, with its rail, its end of that rail, its place in that slot (`2 of 3`) and its state.
The state is the window's own word on the panel (`surfaceState`: drawn, collapsed, folded for room, in its rail's More row, loading, stopped, off, hidden or refused, with the reason), never read from the layout alone, and "no word from the window" until a window has answered (`docs/personal-panels.md`, "Placed on the rail").
`personalize` resolves a surface by that id (a title is accepted too) and refuses an unknown one WITH the list, never guessing.

**The tool** (`createPersonalizeTool`): `theme` (dark|light; an already-set theme is text, no feed line); `panel` (surface plus any of rail, position, above, below, visible; rail and position move the panel to that slot's middle, and above or below, which name the slot themselves, put it just above or below another panel; a move onto either rail is allowed however many panels it holds; the create-your-own-panel slot is never moved and never a neighbour); `remove` (an app panel is hidden and every record about it forgotten - it cannot leave; a personal extension leaves the workspace through `PersonalExtensions.remove`: `git rm` and one commit under the app's identity, its store slice cleared, the snapshot pushed without it, which is what unregisters the panel).
`remove` acts only on the captain's own turn (the same wake stamp `remember`'s create gate uses); the theme and a panel's place may follow a schedule the captain set ("dark in the evening").
Every outcome is one `personalized` FmEvent - the feed line's text verbatim (`switched to the light theme`, `Tasks hidden`, `Activity moved to the right rail, top, above Tasks`, `Open PRs removed`); a change that moves several panels at once, such as Settings → Panels' Reset to defaults, is one line (`Panels put back where each asks to be`, `Panels rearranged`) - and the tool files an `operation` task through the same helper as the other operate tools.
Refusals are text, never throws.

**Panel instructions are standing directions** (INF-1054): "always use compact rows in my panels" is one `app_change` `direction` add scoped to the personal workspace, which is registered as a project at startup.
Every crewmate working there, building a panel or teaching a lesson, receives it with each turn, and the captain sees, revises or retires it in the Knowledge browser like any direction (`primitives/standing-directions.md`).
The seeded `AGENTS.md` and both personal briefs tell the crewmate to follow the directions its turns carry.
An older build kept these lines in `.claude/skills/captain/SKILL.md`; `carryPanelInstructions` (`src/core/personal/panelInstructions.ts`) carries them to directions once at startup and removes the file.

**The contract moved to v2.8**: personalization is the operate move's case for the app itself, stated in the prompt with the boundary (a new panel or a change to how one draws is crewmate work), so the six moves and the extractor's classes are unchanged (`personalize` joins the extractor's operate tools).
The replay gate stamps the new prompt sha and its baseline is unmoved: no recorded session called the tool, so the engine builds its first mate without it.
Frozen surfaces: no new top-level `window.infinitary` key, one new tool (24 in the self-map), the read catalog gains `shell.preferences`.
The words "preference", "extension" and "plugin" reach no user surface; `tests/e2e/personalize.spec.ts` drives the three acceptance asks through the mock provider and asserts the feed line, the applied change, the zero-width rail, the committed skill, and the absence of any card.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The UI plugin system (phase 0, captain's go 2026-09-05; design record and phase gates in `docs/ui-plugins.md` - read it before touching `src/renderer/src/plugins/` or `src/shared/plugins/`).
  Three of the four contribution slots are hosted (`card-kind`, `settings-section`, `side-panel`; `agent-pack` is reserved) behind one door, `pluginHost.registerPlugin(manifest, bindings)` (`src/renderer/src/plugins/host.ts`), and the app's own UI is the first plugin (`plugins/builtin/`): a new wire card kind is a manifest row (the built-in test fails without one) and a settings tab is a manifest entry plus a binding, never a hard-coded list again.
  The manifest schema (`src/shared/plugins/manifest.ts`) is strict at every level and requires `capabilities` even when empty; it is the D6 grant model's DECLARATION side - the reads, the views and the store are served since the one plugin vehicle (below), and the integrations since INF-2334; the retired fetch and secret slots are refused.
  Frame containment is one definition for every frame (`src/shared/plugins/containment.ts`; `containment.test.ts` pins the structurally-impossible ledger).
  The home shell is two dock rails framing a stage: an empty rail is an empty element that `[data-rail]:empty` makes zero-width, visibility is data (a `PanelSource` returning null) and never a verb, and `tests/e2e/side-rails.spec.ts` proves the rail-less window is pixel-identical and a docked rail insets the stage.
  Phase 1 (frame vehicle v2, read catalog v0, ObserveTab as the first Tier-2 plugin) names the catalog as `surface: "core"` channels in `src/shared/ipc.ts` - D0/D1 landed, nothing blocks it - and is its own PR.
- Phase 1 of the plugin system (landed 2026-09-05; "Phase 1" in `docs/ui-plugins.md`): a Tier-2 contribution is a TEMPLATE (`FrameTemplate`: markup plus at most one script) the shell serves at `app-frame://mount/<id>` with the frame CSP as a header pinning the bridge and that mount's script by hash (`src/main/frames/frameMounts.ts`, node-only; `frameProtocol.ts`, the Electron half); DATA is pushed over bridge v2 (`src/shared/plugins/frameScript.ts`: `inf.subscribe/action/fetch/onTheme`, every verb correlated) from the read catalog (`src/shared/reads.ts`: eleven frozen names - eight at phase 1, three task reads from task-system P3 - each over a `surface: "core"` channel, strict args, declared invalidation; executed by `src/renderer/src/plugins/reads/executor.ts`, coalesced).
  `FrameController` is the host side for every frame; `FrameMount` owns a template mount and `HtmlCardBody` uses the same controller over srcdoc.
  Observe is the first contribution on it (`plugins/builtin/observe/`, a `.frame.js` checked by `tsconfig.frames.json` against the bridge's types) and `src/core/observe/liveBuffer.ts` holds a session's in-flight turn for its `observe.live` read.
  Fonts reach every frame from `app-frame://fonts/<file>` (`src/main/frames/fontFiles.ts`, electron-vite `?asset` over the one vendored copy; `font-src app-frame:` is the sole network-shaped frame directive), and a preview's project fonts from its kept copies at `app-frame://typefaces/<name>` (`docs/card-authoring.md`, "Fonts by reference").
  The mediated fetch seam is `src/core/plugins/mediatedFetch.ts` over `inf:plugins:fetch`, refusing everything: a panel reaches outside your projects through its integrations.
  Agent scripts in card bodies (WI-16, review in `docs/live-prototype-security.md`): a body with `<script>` is a `kind: "card"` mount at `app-frame://card-<id>/` - its OWN host, because a site shares one renderer process and a runaway card under `mount/` froze every sibling frame - with the sandbox and CSP unchanged beyond that mount's script hashes; `FrameController`'s ping/pong watchdog tears a wedged frame down to a Retry line.
  Figures: the bridge is the ONLY host-owned script a frame carries - the `fm.viz` recipe helper was deleted at contract v2.5 (the first mate cannot call a script and it was never used), so a scripted body hand-writes its SVG and a scripted card's `script-src` is the bridge plus its own hashes.
  The design skill states how a figure should LOOK to belong in the app (`components/viz/Viz.prompt.md`: scaling, token color, StatusDot's state-color semantics, type, weight) and prescribes no shape.
  Sharp edges paid for: the bridge posts `ready` at INSTALL, before any template code, so it marks a document's birth (posting it at `load` dropped the subscriptions a template opened while parsing); `protocol.registerSchemesAsPrivileged` may run once per process, so the window's schemes go through `src/main/schemes.ts` and the work mode registers the frame scheme alone when its module loads; vitest blanks every `.css?raw` import unless `css: true`; Chromium drops native clicks into a hidden window's sandboxed frames, so e2e dispatches clicks in-frame; an iframe fires `load` even for a 404, so a served mount's presence is asserted with Electron's `session.fetch`, which speaks the scheme.
- Phase 2 of the plugin system (landed 2026-09-05; "Phase 2" in `docs/ui-plugins.md`): the activity feed is a `side-panel` of the built-in plugin on the LEFT rail (the folder `src/panels/activity/`, in the frame realm since Phase A item 6); the crew strip shipped beside it and was removed on 2026-09-13 (`9949d70`) because the crew orbit around the character already says who is working; the shell store holds no feed lines or crew counts, and the design library has no React feed, strip, or crewmate glyph - the frames are the reference now.
  A panel's own code says whether it shows (`presence: { "code": true }` and `rail.show`).
  The now panel shows only once the board has a row, so a fresh window has no right rail; the Activity dock is DELIBERATELY present and collapsed even with no feed lines (captain-confirmed 2026-09-19; `79a59c2` kept it visible, `af06b16` collapsed it with the compact header, which reads `quiet` until the first line) and `tests/e2e/side-rails.spec.ts:107` pins that - never hide it until the first line, and never make a panel of your own render chrome to say it is empty.
  A manifest side panel carries `size` (`content` | `fill`); the host's own panels are registered `firstParty` and carry no attribution.
  The streaming probe passed (a line paints ~37 ms after the core writes it; 200 lines in ~10 ms) and `tests/e2e/rail-panels.spec.ts` asserts the work each paint did (rows added and removed, node identity across a slide) and measures the durations from the User Timing marks the frame script records through `tests/e2e/perf.ts`.
  Every e2e that reads a feed line or a now-panel row goes through `tests/e2e/rails.ts` - a page-level locator cannot see inside the frame, and both docks start collapsed (`DEFAULT_COLLAPSED_PANELS`, `railStore.ts`) with their frames running out of sight, where they never paint, so `expandDock` there is the one awaited, deduped expand (the chevron is a toggle; two overlapping clicks close it again, and presses on two docks take turns) and a frame-side measurement such as the now panel's write-to-paint lag can only see writes that land after the expand, never the row that docked it.
  The right rail carries the now panel (task-system P4, below) and nothing else.
- The collapsed Tasks header counts each task by its own state, not the contextual tree rows the expanded Working group shows (`summaryOf` in `src/panels/now/rows.ts`).
- The now panel and the record card (task-system P4, design section 10, captain decisions D3/D4 and the two panel notes; "Task-system P4" in `docs/ui-plugins.md`): the right rail's ONE panel is the folder `src/panels/now/` (the Tasks panel, id `now`; an ordinary panel folder in the frame realm, "The app's own panels are ordinary folders" above) over `tasks.board` - minimal by default (counts, "waiting on you" and "working" rows, the other groups collapsed to a count, filters behind the header), visible once its `onRail` (`src/panels/now/rows.ts`, on the one grouping rule in `src/shared/nowPanel.ts`; `tests/e2e/now-panel.spec.ts` pins what it paints) says the board holds an ask's record or a row it lists - dropped rows and closed question/operation rows never show as rows, and an ask's record docks the panel collapsed, with its counts (FI3-1164: Tasks shows from the welcome on).
  A row's gestures are POINTING, never a mutation: a click is `point.openTask`, which brings a waiting row's decision card to the front or opens the task record, and a rest is `point.peekTask`, which opens the crew summary beside the row the pointer rests on.
  Hover-only view updates reuse the Tasks panel's grouped rows, navigation and measured row positions; memoized row components repaint only changed row inputs.
  A pushed board is reconciled against the one the panel holds (`src/panels/now/reconcile.ts`, INF-2105 on INF-2078's accepted plan): a task or project whose fields read the same keeps its object, so a change paints only the rows it touched, and a push that moves nothing listed paints nothing; every row stays in the page.
  A group's derived row list also keeps its identity while its tasks, order and nesting stay unchanged, and its body reuses the actual row elements until a row input changes rather than rebuilding them on another group's crew write.
  A changed board, filter or expanded group refreshes the positions, and a retained ResizeObserver follows layout changes; the group's reveal ending refreshes its settled positions too.
  The positions measured are only those a dependency line needs - the ends of each listed blocked-by pair - never the whole list; each paint's `now:render` measure carries the rows it built in its `detail`, which `tests/e2e/now-changes.spec.ts` reads with the rows' rect reads.
  Dependency inspection reads those positions without measuring the list again (`tests/e2e/now-hover.spec.ts`).
  That record is host-owned, and its buttons are the action bar's lifecycle toggles only (the captain's 4A, 2026-09-28, reversing the read-only, no-buttons call; one bar since FI3-565 piece 4; "The record's action bar" below) - judgment calls stay on cards and every other write happens by talking to the first mate; it is a manifest card-kind row (`chrome: record`) that is NOT a wire kind (`cardKindSchema` refuses it: never persisted, never agent-emitted) and a per-task template body (`recordTemplate(taskId)`, `builtin/record/`) subscribed to `tasks.detail`.
  The accepted FI3-309 answers replace the former gutter pane with one shell-held entry per task (`cards/RecordCard.tsx`), in the normal main stack, opened at the front and shown immediately.
  Hide or Esc closes only the shown record; outside clicks do nothing.
  Records page with cards, count for Working and character hiding, keep the action bar, and have normal width/drag/scroll with no thread.
  Only the shown entry supplies `taskId` or `visibleCardId`, never both.
  The panel receives all open task ids as selected-row view state; no record anchor, tie or notch remains, and the one row box the panel reports is the rested row's, for its summary.
  The bridge, read contracts and core card store are unchanged.
- The captain's presentation choices are the CORE's, not the window's (`src/shared/preferences.ts`): the theme is the `appearance` KV and rail collapse the `layout` KV, both on `SettingsStore` behind `inf:settings:appearance|layout:get|set`.
  The renderer reads them once BEFORE the first render (`renderer/src/app/preferences.ts`, awaited in `main.tsx`) and writes every change through, so nothing paints a default it is about to replace.
  Never put a preference back in `localStorage` or the shell store alone: `tests/e2e/preferences.spec.ts` relaunches with Chromium's own storage wiped and the app's userData kept, which is exactly what those copies could not survive.
- Preferences by talking (talk-to-personalize Step 1, landed 2026-09-18; captain decision Q5; "Preferences by talking" in `docs/ui-plugins.md`): `ShellPreferencesService` (`src/core/preferences/shellPreferences.ts`) is the ONE writer of the `appearance`/`layout` rows - the window's controls and the first mate's `personalize` tool both go through it, and every write pushes the whole value as `inf:shell:preferences`, the `shell.preferences` read the renderer applies (`applyPreferences`: theme seeded, never through `setTheme`; layout into `railStore`).
  The layout record carries `hiddenPanels` beside `collapsedPanels`, each a deviation only, and the one `arrangement` of every panel's slot and order (INF-2344); `placeSidePanels(panels, layout)` applies them and `src/shared/surfaces.ts` names the app's panels once for the built-in manifest and the first mate's bounded "your surfaces" context section alike.
  `personalize` (`src/core/pi/personalizeTool.ts`: `remove`; theme and panel are `app_change`) refuses an unknown surface with the list, hides an app panel on `remove` (it cannot leave) and takes a personal extension out through `PersonalExtensions.remove` (one commit; git keeps the history); `remove` is captain-turn only, the theme may follow a schedule.
  A panel instruction is a standing direction scoped to the personal workspace (`app_change` `direction`), never a file in the workspace.
  Every outcome is one `personalized` FmEvent, the feed line verbatim; the words "preference", "extension" and "plugin" reach no user surface (`tests/e2e/personalize.spec.ts`).
- Personal extensions (talk-to-personalize Step 2, landed 2026-09-18; captain decision Q7; "Personal extensions" in `docs/ui-plugins.md` - read it before touching `src/core/personal/`, `src/renderer/src/personal/`, `src/shared/personal/`, or `src/main/plugins/`): a personal panel is a `<id>/panel.tsx` (+ optional `server.ts`, `manifest.json`) in the seeded git workspace `userData/fleet/personal/` (`paths.personalWorkspaceDir`, the name reserved in `RepoRegistry`), compiled by the core at runtime (`typescript` is a runtime dependency for it) drawn in a frame like every panel and its server module run in a process of its own - trusted like the crewmate that wrote it; third-party plugins keep the frame vehicle and D6 unchanged.
  The compiler (`src/core/personal/compiler.ts`) is the coherence gate: `react`, the JSX runtimes, `@infinitary/ui`, type-only `@infinitary/contracts`, and local files for a panel, `node:*` and local files for a server, everything else refused as `<id>/<file> imports "x"...` - never relax it at display time.
  `@infinitary/ui` is `src/renderer/src/design/index.ts`, built into the frame lib; host imports are rewritten to destructure the lib's module, so adding a component is exporting it there, with no list to maintain.
  Output is content-addressed under `userData/cache/personal/<id>/<hash>/` and the hash IS the version: a new hash is the hot reload, a new frame, and the core's module-cache bust.
  Visibility stays data: the core evaluates `presence` against the store and pushes `present` in one snapshot (`inf:plugins:personal`); the renderer's `personalPlugins.ts` registers each through `registerPlugin` (attribution `yours`, `running` source for the busy dot, a Tier-1 `FramedPanelBody` whose frame holds the error boundary and the quiet line).
  `src/shared/personal/contracts.ts` is TYPE-ONLY and generates the workspace's `infinitary-env.d.ts` (`pnpm generate:personal-env`; `firstmateEnv.test.ts` fails on drift) - a change there is a contract change.
  `plugin_kv` (migration 33, `PersonalStore`) is the one store, namespaced and capped, cleared by the D-13 purge with the compiled cache; the workspace's files are never deleted by the app.
  The words "extension" and "plugin" reach no user surface (`tests/e2e/personal-panels.spec.ts`).
- The record, through SQL (plugin data surface, Phase B, captain's locked plan 2026-09-24; "The record, through SQL" in `docs/ui-plugins.md` is the one home): a plugin reads the app's record with one read-only query over the ten published views `v_*_v1` - the `sql` read over `inf:sql:query`, the views a query may reach being the plugin's GRANT the host adds (`ReadGrant`), never the subscriber's args.
  `src/core/storage/views.ts` is the ONLY writer of view SQL; names carry their version and are queried exactly (no plain name, no aliasing - captain's B5 b); additive changes keep the name and bump `SQL_VIEWS_MINOR`, a break ships `_v<N+1>` and keeps the old view two releases; `views.test.ts` pins every column list.
  Every migration after 42 runs with the views dropped and re-creates them last, and every open reconciles them, so a migration test that reverses a column a view reads must `dropViews` first.
  The engine (`src/core/sql/`) proves names by compiling the query on a scratch schema of the declared views before running it read-only - never trust the authorizer's "innermost view" argument, a query's own CTE can carry a published view's name - and runs in a PROCESS, never a worker thread: `Worker.terminate()` cannot stop one native SQLite step, and the 250 ms cap is a kill (`utilityProcess` via `HostCapabilities.sqlProcess` in the app, `forkChildProcess` in tests, where `tests/helpers/sqlProcessBundle.ts` builds the entry because Node cannot resolve `@shared` aliases).
  `v_feed_v1` is authored by `taskFeedLine` through SQL functions every reading connection registers (`registerViewFunctions`).
  The authoring guide is the seeded `usage` skill; retiring the typed reads is a follow-up, one read at a time.
- One plugin vehicle (Phase A, captain's locked plan 2026-09-24, calls A1a-A4a; "The one plugin vehicle" in `docs/ui-plugins.md` is the one home, `docs/personal-panels.md` "Panels for others" the author's guide): every panel is ONE shape (`panel.tsx` taking `PanelProps` + `manifest.json`) and the source decides the privilege.
  The personal `manifest.json` is THE plugin manifest (`personalManifestSchema`; capability keys `reads`/`sql`/`integrations`/`storage`/`moves`; the retired `net`/`secrets` are refused for every source).
  `PersonalExtensions` scans a second root, `userData/plugins/<id>`, from the `plugins` table (migration 43, `PluginRecords`) and stamps `source: yours | installed`; an installed plugin is served only what the captain CONSENTED to and a tree holding `server.ts` mounts nothing.
  Install by talking: `install_plugin` (the first mate's 25th tool) -> `PluginInstaller` (npm pack `--ignore-scripts`, git hooks off, a folder; pinned) -> `checkPluginTree` -> one host consent card (`card-plugin-<id>`) -> one feed line; `personalize remove` uninstalls; the `panels` switch and safe mode cover both roots.
  Every panel runs ONLY in the frame realm (`src/renderer/src/frameRealm/`), the captain's own included (INF-2205 piece C): a sandboxed document at its own host `app-frame://panel-<id>/` (`FrameMountRegistry.mountPanel`, `inf:frames:mount` `kind: "panel"`) loading React, the JSX runtime and `@infinitary/ui` from `app-frame://lib/` - built by `scripts/frame-lib.ts` inside the MAIN build into `out/frame-lib/`, every file's SHA-256 baked into main (`virtual:fm-frame-lib`) and served only while its bytes match - with its own compiled files (`compilePersonalModule`, read once at mount from `PersonalExtensions.framePanelDir`) pinned in the document's import map `integrity`, under `panelFrameCsp` (the frame policy plus `script-src app-frame://lib/ app-frame://panel-<id>/`; reviewed in `docs/live-prototype-security.md` "The frame realm").
  `PanelProps` there is built over the bridge (`framePanelProps`: reads -> `inf.subscribe`, store -> the bridge's `store` verb whose slice the HOST binds, `invoke` -> the host's `server.invoke` for the captain's own and a rejection for an added panel).
  The app's own Tasks and Activity are ordinary panel folders (`src/panels/now/`, `src/panels/activity/`), compiled by the same compiler into the lib and registered first-party exactly as a panel from elsewhere is, on the same API.
  A frame panel's header press reaches its page once the page is born, drawn or not: Chromium drops focus handed to an out-of-process frame still being born, and a page that lists nothing draws nothing until the press opens something in it.
  A press the page hears before its panel listens is held for the panel's first listener.
  `tests/e2e/installed-panel-containment.spec.ts` (a hostile panel refused at every way out, a runaway torn down), `installed-panels.spec.ts` and `pluginInstaller.test.ts` are the binding tests.

## Arranging the panels

Every panel's place is one saved arrangement ("Preferences by talking"), and the captain arranges it three ways, each a write through `railStore` to the core's one writer (INF-2344, captain: "Both: the tab, and arranging on the rails").

- **On the rails.**
  Every panel header is a handle, with no arrange mode to turn on (captain: "make all panel headers draggable. there shouldn't be a toggle").
  A press on a header that travels a few pixels picks the panel up (`pressPanel`, `src/renderer/src/plugins/panelDrag.ts`); a ghost follows the pointer, the nearest place it could land on either rail is drawn as a line, or as an outline over an empty rail or group, and letting go there moves it (`movePanel`).
  Letting go anywhere else, or Escape, puts it back, and the release is never a click on the header's buttons.
  Pressing ⌥ and an arrow on a header's chevron moves the panel one place, as on a Settings row (`docs/keyboard.md`, "Lists and Settings").
- **Settings → Panels** (`src/renderer/src/settings/PanelsTab.tsx`, the design skill's `components/core/PanelsSettings.prompt.md`) lists each rail's top and bottom groups in order, every panel the app knows among them, with the window's word on why one does not draw (`panelRowState`), a switch that hides or shows it, the keys, and Reset to defaults.
  A row drags as a header does, and the keyboard moves it.
  Reset to defaults asks once more on the same button, then puts every panel where it asks to be in its declared order (`defaultArrangement`), clears the placements and More picks saved before the arrangement, and keeps each panel's collapse and visibility.
  The tab is offered only where the window's layout writes reach the first mate's computer (`settings.panels` refuses on a Mac that controls another, `docs/view.md`).
- **The first mate's `panel` action** moves one panel to a slot's middle, or just above or below another ("Preferences by talking").

A move names one panel on the Activity feed, with where it now sits ("Tokyo moved to the right rail, top, above Tasks"); a change that moves several at once is one line.
Two neighbours that trade places read the same either way, so the window's write names the panel the captain moved (`LayoutMove`, the optional second part of `inf:settings:layout:set`), and the first mate's `panel` action names its own.
Settings' tabs run down a column on its left (the design skill's `components/core/SettingsTabs.prompt.md`), since the tabs no longer fit one row.

## When a rail runs out of room

`Rail.tsx` measures the rail’s available height, excluding padding and the create-panel invitation, and reads the minimum from the design skill’s `--rail-body-min-height` token.
`railRoom.ts` folds panels nearest the middle first, keeping an explicit expand (the existing false collapse record) until unpinned panels fold.
Top and bottom groups keep their anchored ends; equal distances fold the top panel first.
Bodies with less than four rows of content need only their full content height.
A fold never writes collapse or visibility settings, and room returning restores the panel.
When headers alone cannot fit, the ladder reserves one header for More and hides as many middle panels as needed, leaving their pages mounted.
More uses the existing keyboard RowMenu, shows the hidden titles and their last summaries, and moves a picked panel to its slot's edge in the saved arrangement (`pickToEdge`), where Settings → Panels shows it first in a top group and last in a bottom group (INF-2344, captain: "Yes, to the end of its slot, saved in the layout where you can see it").
The layout also keeps that panel as `morePick`, and a reset of the panel forgets it.
The More row participates in F6 as a panel region, and its menu takes arrows and Escape.
The narrow-window fold and each panel’s own presence remain independent.
The ladder's folds are kept in one window store (`railFolds.ts`), written by the rail's measure and cleared when the rail is not drawn; the rail draws from it, and the window's answer about its panels reads it to name a panel `folded` or `gathered` (`docs/personal-panels.md`, "Placed on the rail").

The `morePick` panel keeps a remaining header ahead of earlier pins, so choosing it really returns it to the rail.
