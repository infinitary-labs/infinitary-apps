# Writing panels: the library, the skills, the lint, the build loop, the switch, and panels for others

Steps 3, 4 and 5 of the talk-to-personalize plan (captain-approved 2026-09-18; the plan is `infinitary-ui-plugin-system-reconcile-state-9e/ report.md`, sections 5.3, 5.5, 6 and 7).
Step 3's subject is **coherence by construction**: a panel the captain asks for is built from the app's own components, guided by the app's own design skill, and checked by a lint that names the token it should have used.
Step 4 is the build loop that produces one; Step 5 is the switch that takes them all back.

The RUNTIME is Step 2's and is documented in `docs/ui-plugins.md` ("Personal extensions"): the workspace, the compiler and its import allowlist, the frame every panel draws in, the host modules, the store, server actions, background tasks, presence and mounting.
This document is the authoring half - and, since the one plugin vehicle (the captain's locked plan of 2026-09-24, Phase A), the guide for anyone writing a panel for someone ELSE to add: "Panels for others", at the end, is what differs, and everything before it applies unchanged.

## The library is the panel library

`@infinitary/ui` is `src/renderer/src/design/index.ts`, built into the frame lib every panel loads (`scripts/frame-lib.ts`).
Firstmate 3000's names for the two modules, `@firstmate/ui` and `@firstmate/contracts`, are the same modules to the compiler (`ownHostModule`, `src/shared/codeNames.ts`), and `infinitary-env.d.ts` declares the contracts under both, so a panel written before the rename compiles and type-checks here.
The workspace's types file was `firstmate-env.d.ts` before the rename; the next seed removes it (`RETIRED_MANAGED_FILES`), since the two side by side would declare every type twice.
There is no second list to keep: **a component is available to a personal panel when it is exported from that barrel**, and nothing else moves.

Step 3 added the five looks that existed only inside the built-in frames, so a panel can build a list that reads exactly like the app's own (`src/renderer/src/design/panel/`):

| Component | What it is |
|---|---|
| `Row` | A status dot, a title, one trailing datum in mono; `word`, `depth`, `selected`, an optional click |
| `FeedLine` | An event line: the text, and the kind over its relative age in a 48px mono column |
| `MicroLabel` | The uppercase tracked label that names a region, with an optional mono count |
| `Empty` | One quiet line where a list would be |
| `Disclosure` | A region that shows only its count until it is clicked |

Their spec is the design skill's `components/panel/Panel.prompt.md`, beside the `NowPanel` and `ActivityFeed` specs they were extracted from; the skill is the rule, the components are the implementation.

FI3-1014 piece 6 added what a panel that draws tasks draws them with, so its rows read as the app's own Tasks panel and task board:

| Export | What it is |
|---|---|
| `TaskStatusMark` | The task's status mark, one shape at every size, from a reading |
| `taskStatusOf`, `taskStatusLabel` | A task's reading (`mark`, `word`, `reason`) and its words, from the task's fields |
| `waitRecordedTime` | When a started task's wait was recorded, in the person's local time |
| `NOW_GROUPS`, `NOW_GROUP_LABELS`, `nowGroupOf`, `nowGroupsOf` | The shared grouping the Tasks panel and the board name their lanes by: a task's own group, or the panel's, which keeps a working parent's live tree together |
| `focusWithRing` | Focus an element with the keyboard's ring, as the app's lists do |
| `useInPlaceReveal` | The drift a group's rows open with |
| `foldForSearch` | A task's key or title folded the way the app's own search folds it |
| `feedRelativeAge` | A feed line's age in the Activity panel's words |
| `DROP_TASK_LABEL`, `dropConfirmLead`, `dropPartsRefusal`, `dropReviewKeys`, `dropUnderwayLine`, `dropWaitingLine` | Drop task's question, in the task record's own sentences |
| `PanelExpandChevron` | The chevron a group or a strip opens with |

The app's own Tasks and Activity panels are folders built on exactly this library and API (`src/panels/now/`, `src/panels/activity/`; `docs/ui-plugins.md`, "The app's own panels are ordinary folders"), so either is a working example of a panel that lists tasks or lines.

A panel may bring a stylesheet of its own: `import styles from "./board.css"` reads the file as text (the compiler's `board.css.mjs`), which the panel puts in a `<style>`; the lint reads it like any panel file, so a raw color in it is named with its token.
The workspace's `infinitary-env.d.ts` types such an import as a string.

## The skills

`resources/personal-workspace/skills/` holds the authoring skills.
`src/core/personal/workspaceSkills.ts` seeds them into the workspace's `.claude/skills/` together with **the app's own design skill**, copied whole from the self-source tree - the crewmate personalizing the app follows the same rules as the crewmate building it.
It is called from Step 2's `seedPersonalWorkspace`, so a heal rides the same commit as the managed files.

| Skill | What it teaches |
|---|---|
| `personal-panel` | The one copy of a panel's shape, imports, store, actions, cards and presence, plus what a panel is (its title is host chrome), the library, tokens only and why, one accent per panel, sentence case, mono for data, no emoji, the shapes that stay calm, where a panel's data comes from, the checks before every report (lint, place, capture), what is refused, fixing forward |
| `github-prs` | the app's own `forge.changes` read (the captain's open proposed changes, read with the captain's in-app sign-in), the checks as one status dot, the honest empty and not-signed-in states |
| `quota` | `QuotaMicroMeter` and the honesty rules (unknown is never zero, stale says its age, only a proven sign-out says "sign in again", a no-window read renders what happened) |
| `tasks-and-feed` | The row tones and the feed line, and not rebuilding the panels the app already ships |
| `usage` | The crew's tokens through the read-only `sql` view `v_usage_v1`, and the honesty rules a number must keep; its fixture is `token-watch` |
| `clock-timer-scratchpad` | The three small panels: derived state, the store (a deadline, never a countdown), calm motion |

The seed is **exact**: every boot makes the managed skill directories match their source, restoring what was deleted and removing what was added, so the rules cannot be quietly rewritten from inside.
The extensions themselves are never touched.
The captain's panel instructions are not files here: each is a standing direction scoped to the personal workspace, served to every crewmate there, once per conversation and again after a change (`primitives/standing-directions.md`).

**One home, twice enforced.**
`src/core/personal/skillText.test.ts` pins that no persona prompt and no card contract repeats a sentence of an authoring skill, AND that the skills and the workspace's own `AGENTS.md` do not repeat each other: the personal-panel skill owns a panel's mechanics and its look, and `AGENTS.md` keeps the common workspace rules and points there.
A rule written in both would drift in one.

The Lessons runbook supplies the lesson skill and its tested card parts through the third skill root, not the workspace seeder (`docs/runbooks.md`).

### The app's own data: the reads a panel declares

The plan has a personal panel read the app's own data (the task board, the feed, quota) through the read catalog (captain decision Q3).
Step 4 serves it: `manifest.json` `reads` names any of `quota.snapshot`, `tasks.board`, `feed.recent` and - since git integration PR 1.2 - `forge.changes`, the captain's open proposed changes read with the captain's in-app sign-in (`PANEL_READ_NAMES`, `src/shared/personal/manifest.ts`), the core carries the declaration on the snapshot, and `PersonalPanelBody` hands the panel a `reads` prop (`bindReads`) whose `subscribe` rides the same read executor the built-in frames use - coalesced, pushed on change - for exactly the declared names: an undeclared name, or a catalog entry the panel contract does not list, throws, so the declaration is the grant and nothing else in the catalog (Observe, repos, cards) reaches a panel.
In every build `reads` may name `knowledge.collections`, `knowledge.graph`, `knowledge.concepts`, `knowledge.findings`, `knowledge.entry`, `knowledge.directions` and `knowledge.direction` (`docs/knowledge.md`, "The browser"), which take arguments as `tasks.detail` does.
The value types a panel sees are the structural `PanelQuotaSnapshot`, `PanelTaskBoard` and `PanelFeedLine` in `src/shared/personal/contracts.ts` (so `infinitary-env.d.ts` stays self-contained), and `contracts.test.ts` pins that the wire schemas are assignable to them.
Assignable is not the same as equal, so `quota.snapshot` reaches a panel or a card through `panelQuotaSnapshot` (`src/shared/quota.ts`), which the read executor applies in a desktop window and on the phone alike and which builds `PanelQuotaSnapshot` field by field.
Each account's internal id, the identity the provider reports (an email or an organization), credits, saved resets and the sensor's machine reasons stay on the reading Settings draws, and a field later added to the reading reaches no panel until the panel contract names it.
The `quota` and `tasks-and-feed` skills teach the read beside the instrument and the honesty rules; their fixtures (`quota-glance`, `crew-reports`) are written on it, and the e2e feeds the quota one through the fixture seam (`INFINITARY_QUOTA_FIXTURE_DIR`).

Task panels use `PanelTaskRow.waitingCardId`, not `flags.needsYou`, for "waiting on you".
It names a reachable shown ready decision on a live task, or null (including hidden, Working and closed rows).
`PanelProject.counts.waitingOnYou` counts those tasks; `counts.needsYou` remains broader durable attention.
The generated workspace declarations carry both; update them only with `pnpm generate:personal-env`.
These are read-time projections, not stored readiness or permission to start held work.

`settings.current` reads the app settings a panel may show, by their action catalog names, `reads.subscribe("settings.current", { names }, listener)`: the music's state (on, paused, style and volume), the look and a few switches (`PanelSettingValues`).
Each catalog line has a panel value or a ground from a closed set for having none (`PANEL_SETTINGS`, `src/shared/panelSettings.ts`), and a name without a value is refused before anything is read.
It re-reads when the preferences are pushed or a catalog change leaves its `personalized` line.

`computers.resources` reads current CPU and memory observations for the home and each paired work computer, including receiver-owned age or an explicit unavailable reason (`PanelComputerResources`, `docs/helper.md`, "Shared live readings").
A panel declares it in `reads` and calls `reads.subscribe("computers.resources", listener)`; no server module or polling background task is needed.
All subscribing screens and panels use the same core source and cache, not one sampler per panel.
A fresh reading gives a panel installed memory, the one memory-used figure and, on a Mac, pressure.
Show the figure as RAM used, and installed memory minus the figure as free.
A missing figure is unknown, never zero and never a panel's own math.
Render unknown as unavailable, never zero usage or spare capacity.
The values are physical-system facts rather than process limits or scheduling capacity, and must not be written into the panel store as live history.

`batches.list` reads each project on batched pull requests from the app's own record: its line, its open batch with the checks the batch pass last read, the changes left out and the batches that ended in the last day (`PanelBatchRepo`; `docs/forge.md`, "The Batches panel").
A panel declares it like any read; nothing in it asks where the project lives.

`tasks.detail` (FI3-1014 piece 4) reads one task in full by the id the board gave it, `reads.subscribe("tasks.detail", { id }, listener)`: its row, brief, latest report, and while Drop task applies the `dropEffects` a drop sends back as its review.
`tasks.search` (piece 7) is the app's own search over every task, closed ones included, `reads.subscribe("tasks.search", { query }, listener)`: the rows it found, so a panel's Find reaches done and dropped work the board no longer lists, and the panel may open and point at what it found.
A live work row also says which of the six moves it allows now and why not (`PanelTaskRow.moves`), and whether its waiting card merges (`waitingCardMerges`); a panel that asked for `moves` makes one with `tasks.run` on the captain's click or key, and a panel that reads the board points at tasks with `point` and sees what the captain has open in `view` (`docs/ui-plugins.md`, "A panel's cards").
A row another computer runs says where (`PanelTaskRow.place`): that computer by name, where after its project ("on Mac mini"), and `outOfReach` while open or underway work's computer is out of reach (`docs/helper.md`, "Runs on").
`connecting` comes with `outOfReach` while that computer's connection is being made, and a panel reads it first.

## The lint

`src/core/plugins/pluginLint.ts`.
It **rewrites nothing**: it returns findings the author reads and fixes, which is the training signal.

| Rule | Severity | Says |
|---|---|---|
| `emoji` | refuse | Emoji never appear, in code or in a manifest title; a `StatusDot` says what a green check would |
| `external-url` | refuse | A panel loads nothing from the network; fetch in `server.ts`, render the store (a URL in `server.ts` is the point, and is allowed) |
| `host-bridge` | refuse | Extension code never reaches for `window.infinitary`, or Infinitary's `window.infinitary`; it is handed props |
| `raw-color` | warn | Names the nearest color token for a hex or rgb literal (a three-digit hex counts only where the line is about color: `#186` is a PR) |
| `raw-font-size` | warn | Names the nearest step on the type scale |
| `off-scale-radius` | warn | Names the nearest radius (3 / 6 / 10 / 16 / pill) |
| `off-scale-shadow` | warn | Names the nearest of the three shadow steps |
| `two-accents` | warn | One accent per panel; names both families it found |
| `undeclared-integration` | refuse | A literal `integrations.call`, `.on` or `.show` names a connection, action or event the manifest does not name under `integrations`, in the words the app refuses the call with (`undeclaredIntegrationMessage`) |
| `list-without-empty` | note | A list that renders nothing when empty reads as broken (`.tsx` only: a `.ts` helper renders nothing) |

Naming the nearest token needs the scale as data, which a stylesheet cannot give Node: `src/shared/designTokens.ts` mirrors it, and its test parses `src/renderer/src/design/tokens/*.css` and fails the moment the two drift.
There is one fixture directory per rule (`tests/fixtures/personal-lint/`) plus `clean/`, which must produce nothing, and a test that the fixtures cover every rule the lint can raise.

## The evidence

- **Every library component a panel may use is in the gallery.**
  `src/renderer/src/design/fixtures/UiKitGallery.test.tsx` renders every library export a panel may use, so a new one joins the gallery or fails there.
  Whether a component looks the same inside a panel and outside one is judged by eye and by the pictures a crewmate attaches, as every look is (`docs/testing.md`, "The e2e assertion contract").
  The gallery panel is registered through the same `registerPlugin` door and the same `SidePanelChrome` body region a personal panel is mounted in.
- **Each data skill has a fixture extension the e2e mounts.**
  `tests/fixtures/personal-skills/` holds one per skill, written the way that skill teaches.
  The same spec seeds them into a personal workspace and lets the REAL host compile and mount them, so a skill that taught an import the compiler refuses fails here; `src/core/plugins/personalFixtures.test.ts` runs the real lint over them and requires no findings at all.

The gallery rides the design-fixture seam, `src/renderer/src/design/fixtures/`, which is off unless the window's own `localStorage` carries `infinitary.designFixtures`.
No product path writes that key, so nothing there reaches a captain's app.

## The build loop (Step 4)

Step 4 of the plan (landed 2026-09-18, report section 5.3) is the integration: an ask becomes a panel, live, and the build ends the way any work with nothing to merge does (INF-1677).

**The door.**
Once a task of the captain's has finished and no panel of their own exists, the create-your-own-panel slot at the top of the left rail starts the ask: a click puts "Make me a panel that shows " in the message box for them to finish (`docs/first-launch.md`).
A panel whose manifest names no placement lands at the top of the left rail (`DEFAULT_PERSONAL_PLACEMENT`, `src/shared/personal/manifest.ts`), where the slot was, once its build reports ("Built apart" below), and the slot leaves while a panel of theirs exists.

**The `personal` workspace kind.**
The personal workspace is a workspace KIND, not a delivery posture (`repoKindSchema` in `src/shared/repos.ts`, `repos.kind`, migration 37; the crew-posture rationalization's Task A, 2026-09-20 - it shipped as a third `live` delivery from Step 4 until then, which made `delivery` answer two questions at once).
`delivery` now says only where a change lands, and this workspace lands none: a crewmate builds in place.
There is exactly one `personal` row, and `RepoRegistry.configure` refuses its whole policy patch with one message - delivery, autonomy and rigor are not questions it answers - while unregistering it is refused as before.
The workspace becomes a managed repo on first need (`RepoRegistry.ensurePersonal`: name `personal`, the seeder's directory, `kind: personal`, autonomy on; its `delivery` column is written `local-only` and never read), which also births its project, so a task there has a key like any other.

**Dispatch.**
`spawn_crewmate` carries `personal_ui: true` when the ask is about the user's own panels (the intent's `kind: "personal-ui"`, `SpawnIntent`); the supervisor binds it to the personal repo itself, whatever `repo_id` came with it, and `renderIntentBrief` writes NO `Delivery:` line for it and appends the workspace's facts to the fixed template: that you build in place and the host commits, the workspace path, which skill to start from and that the standing directions its turns carry, once and again on change, hold the captain's panel instructions (`personal-panel` - every crewmate's session already carries the workspace's `AGENTS.md` and lists its skills, `src/core/session/projectResources.ts`, so the brief never lists them again), the checks before reporting a panel change, and the surfaces that already exist so a change resolves to its directory.
The Lessons runbook tells the first mate to name the lesson skill and learner records in the brief, with ongoing work and requested intelligence declared as generic facts.
No rigor section is written either: rigor exists only where a change lands through a gate, so a personal task has no tier at all rather than a quick one.
`startTask` creates NO worktree for a personal task: the crewmate's cwd is the workspace, the record's `worktreeDir` and `branch` stay empty (`workspaceState: "none"`, so no close ever tries to remove one), and `resumeTask` falls back to the repo dir the same way.

**Build, live.**
A panel is a top-level folder named like a panel id that holds `panel.tsx` or `server.ts`, in the working files or in the last commit; `isPanel` (`liveWorkspace.ts`) is that one rule, and loading, the stamp, the lint, the place and the last-commit copy all read it.
Any other folder, such as `lessons/` or a folder of notes, holds records: nothing stamps, lints or copies it, and a folder with only a `manifest.json` becomes a panel when its `panel.tsx` lands.
The last commit keeps a deleted or renamed panel, or one whose entry file is mid-rewrite, attributed until the turn's commit.
`PersonalExtensions.beginLiveTask` opens a stamp window: every reconcile the watcher triggers stamps the task onto the `manifest.json` `origin.taskId` of each panel with uncommitted changes (`changedExtensionIds`), which is what lights the running dot on the panel's rail the moment the crewmate's first save lands - the Step 2 rule (`origin.taskId` names an active task) is unchanged.
That read of what changed runs while the host commits the turn, so it never takes git's index lock (`--no-optional-locks` in `changedPaths`), which the turn's `git add` and `git commit` need.
Only a live crewmate holds `lint_panel`, `place_panel` and `capture_panel` (`src/core/pi/panelTools.ts`, entries of the crewmate tool spec both runtimes generate from; `CrewmateSpec.onLintPanel` / `onPlacePanel` / `onCapturePanel`, absent on every other workspace): the lint runs the real `pluginLint` over the extension's files and adds the compiler's verdict on the files as they are now; the place puts the working files on the captain's rail ("Placed on the rail", below); the capture asks the host (`HostCapabilities.capture`, Chromium's own screenshot command on a hidden copy of the panel with that copy's token theme set, which draws a fresh frame for the picture without ever showing the copy) for both themes - the draft while there is one, else the docked panel, and it says which - writes the PNGs under `crewmates/<taskId>/captures/`, and returns them as image content beside the paths.

**Built apart.**
The build runs apart from the captain's rails, and the captain's panel takes the new version only when the build is ready (the captain, 2026-10-07: "it should work in isolation and flip it into my live panel only when it's ready").
Ready is the crewmate's word: `place_panel` puts its version on the captain's rail to be looked at there before the report ("Placed on the rail"), and the report's commit is the build's unit, so a turn's report keeps the new version whether or not the task then closes.
While a crewmate is building an extension, the snapshot's `extensions` carry it as its last commit holds it - compiled from a copy of that commit under `userData/cache/personal/.committed/<id>/<tree>/` (`committedTrees`, `writeCommittedTree`), which compiles to the same version as the same files in place, so the rail's panel, its server module and its store do not move as files are saved.
While any crewmate's session on the workspace is live, the rails take every panel from the last commit, or from the tree a crewmate placed, so a save landing mid-scan can never reach them; a new extension is on no rail until it is placed or committed.
A window on another computer is told of no draft and is answered none of its files (`docs/view.md`, "Panels in every window").
The working files ride the snapshot's `drafts`, each compiled and run apart: its own store slice (a copy of the panel's, taken as the build starts, so what the build writes never reaches the rails) and its own `server.ts` on that slice.
The window draws each draft out of sight at rail width in a rail's chrome (`PanelDrafts`, `[data-panel-draft]`), under `personalDraftPanelId` (`<id>.draft`), inert and hidden from assistive technology, in a frame of its own like every panel; its page reaches its own store and server through the `draft` flag of `inf:plugins:db` and `inf:plugins:invoke`, which the host sets from the mount, its cards and header asks reach nothing, and pointing and moves never count, because no click or key of the captain's is ever on it.
Until the build is placed, `capture_panel` photographs that copy, and `lint_panel` names its compile verdict, so a draft that does not compile is the crewmate's to see and never the captain's.
The report's commit ends the build: the working files are the last commit again, the rails take the new version in one push (the version already placed, when the crewmate placed it), and the draft, its server and its store go.
A build whose session is gone - the app restarted mid-build, or the task was dropped before its report - stays apart: an uncommitted manifest naming a task that has not finished keeps the rails on the last commit, with no draft running, until a later report commits the files.
A placed version goes with its session: the task's end without a report, a restart, a removal or the switch turned off takes it off the rails, back to the last commit.
An edit made by hand, with no task behind it, reaches the rails as it is saved, as in Step 2.
The supervisor's brief tells the crewmate so (`renderIntentBrief`), and the `personal-panel` skill says what the capture shows.
`personalExtensions.test.ts` ("builds apart from the rails") pins the held version, the separate server and store, the swap at the commit and the stopped build; `tests/e2e/personal-panels.spec.ts` records the rail and the draft in order through both builds.

**Placed on the rail.**
A build is looked at on the captain's own rail before it reports (INF-607): the crewmate places its version there, photographs it docked, and hears from the window whether the panel mounted and, when it did not, why.
`place_panel` (`PersonalExtensions.place`) writes the working files of the extension it names, or of every one with uncommitted changes, to a git tree through a scratch index (`workingTree` in `liveWorkspace.ts`, `GIT_INDEX_FILE`, so the workspace's own index is never touched).
For the rest of the session the rails take that tree in place of the last commit, compiled from the same committed copy a commit's tree is, and a draft whose working files are the placed tree is dropped, so the panel is drawn once, on the rail, with the running dot.
The window that answers is the one on the first mate's own computer: a window on another computer draws the captain's panels too and says what it did with each, and the first mate keeps none of that, since the rail a crewmate photographs is the one beside it (`docs/view.md`, "Panels in every window").
That window answers for every panel it knows (`startPanelMounts`, `src/renderer/src/plugins/panelMounts.ts`), read from the records the rails draw from: the registered panels, the captain's layout, the panel's own `rail.show`, a refusal at registration (`railRefusals`: a real registration error, such as a panel of the captain's named after one of the app's whose id the app's panel already holds, kept with its words), each body's own word (`panelBodies`: imported and drawn, or stopped with the error's first line), and what each rail's room ladder did as the rail last measured it (`railFolds`, which `Rail.tsx` draws from too; `docs/ui-plugins.md`, "When a rail runs out of room").
Its states are `drawn`, `collapsed`, `folded`, `gathered`, `loading`, `stopped`, `off`, `hidden` and `refused`, each with its version, its rail and the reason (`src/shared/personal/mounts.ts`).
`folded` is a panel the rail folded to its header because it is too short for its body, and `gathered` one it gathered into its More row because it is too short even for its header; a gathered panel reads gathered whatever its collapse choice, since nothing of it is on the rail.
A body that stopped reads stopped wherever it sits, and a panel out of sight reads by where it went even before its frame drew, since a frame out of sight may not draw until it is shown again; only a panel in sight whose body has not spoken for its version reads `loading`.
Each panel is named by its kind - the app's own, the captain's own, or one the captain added - as well as its id, since a refused panel of the captain's and the app's panel holding its id share the id, and every reader matches both (`mountOf`).
The window sends the answer on `inf:plugins:personal:mounts` whenever it changes, and the core keeps the newest (`PanelMountsHolder`, `src/core/personal/panelMounts.ts`).
`place_panel` waits for the window's word on the version it placed, one that is no longer loading, for at most `PLACE_WAIT_MS` (10 s, the window's time to open a frame and draw the module in it, a physical limit), and answers with it, or with the window's last word and the fact that it did not answer.
`capture_panel` then photographs the docked panel, and when it is not on screen it says why in the same words; a refused panel is never photographed, since what the rail holds under its id is another panel, and a gathered one has nothing on screen to photograph.
The supervisor puts each place's answer on the task's timeline, never the feed.
What the crewmate does with an answer is its judgment, written in the `personal-panel` skill: a reason in its own files it fixes and places again, renaming a folder whose id another panel holds; a reason outside them (the captain's layout, the captain's panels switched off) it reports in plain words with `waiting_on_captain`, which keeps the task open ("Report, commit, close"), and it never moves or hides the captain's other panels; a panel folded for room or gathered into More is built and on the captain's rail, so it reports where the panel sits and never collapses, moves or hides another panel to make room.
The host holds no close of its own.
The captain can see a placed version on the captain's rail, with the running dot, before the report: that is the cost of checking it where the captain sees it.
The first mate's "your surfaces" read the same answer ("Fix forward, remove").
`personalExtensions.test.ts` ("places a build on the rail") pins the place, the wait, a refusal's words in the place and the capture, and the take-back at the task's end; `src/renderer/src/plugins/panelMounts.test.ts` pins the window's answer over the real host and reconciler; `tests/e2e/personal-panels.spec.ts` records the placed panel on the rail before the report and the window's word reaching the crewmate.

**Report, commit, close.**
A live crewmate's report (`turnComplete`) is the turn's commit: `commitTurn` stamps, lints the touched extensions (findings go on the task's timeline, never the feed), and commits the workspace under the app's identity with the report as the message - the first sentence the subject, the rest the body - and only when the tree changed.
The workspace's git writes - the seed's heal, a turn's commit, a removal - run one at a time (`PersonalExtensions.serialWrite`), because two turns can end together: a captain's choice queued behind a turn starts the next while the last one's commit runs, and two commits at once fail on git's index lock.
Once the commit lands, the report routes like any other report (`sortReport`, `docs/report-sort.md`); the host holds no close of its own and no exception for a personal task.
Before that report the crewmate shows what it built on a note marked answering, with no actions, which answers the captain's message (`docs/task-capture.md`, "How a message ends").
A note is not a decision, so the report wakes the first mate, which closes the verified build with `settle_task` done, why `finished` (`DoneClose`, the one close as done): the task closes `done`/`finished`, and the feed line is `built in place - <title>` (`taskFeed.ts`, keyed on `delivery.mode === "in-place"` - the task delivery's own mode, `taskDeliveryModeSchema`).
The note stays on the captain's screen after the task closes; reading it acknowledges the already-completed build's message without ending work (`docs/card-authoring.md`, "Work that closed without the captain's click").
A commit that fails closes nothing (`CrewTurns.commitFailed`): what the crewmate changed stays in the workspace uncommitted, git's words go on the task's timeline, and the task stays open, its build apart from the rails.
The first mate hears git's words in a `commit-failed` wake, on any personal task, whatever card is up, and steers the crewmate or tells the captain; the crewmate's next report commits again, and routes once that commit lands; a report whose commit failed never routes, so it never reads as finished work.
A report with a captain-turn witness routes as any other: an open decision card or a declared wait on the captain keeps the task open.
It stays quiet while a card of the task is on the captain's screen; a declared wait with no card up wakes the first mate, which owes that card (`docs/report-sort.md`).
A note alone never holds the turn, and stays on the captain's screen after the task closes done.
Every other settle mode is refused on a personal task with the reason, and a crewmate card carrying a settle effect is refused at `CrewmateCards.addCrewmateCard` - there is nothing to merge, land, or discard.

**Fix forward, remove.**
The first mate's context block lists "your surfaces" in the saved layout's order (id, title, rail, position, its place in its slot, and the window's own word on its state - drawn, collapsed, folded for room, in its rail's More row, loading, stopped, off, hidden or refused, with the reason, or "no word from the window"); a follow-up resolves to the surface's id, rides a second `personal_ui` spawn naming it, and produces a second commit on the same directory.
"Remove it" is Tier A: Step 1's `personalize` tool (`src/core/pi/personalizeTool.ts`, action `remove`) has the host delete the directory and commit the removal (`PersonalExtensions.remove`), one feed line and no card; Step 4 makes it refuse while a task is building the extension.

The whole flow is `tests/e2e/personal-panels.spec.ts`'s second half, through the mock provider: the ask, the files the mock crewmate writes with Pi's own `write` tool, the draft drawn out of sight while the rail has nothing of it, the lint and the draft's capture landing in the tool results, the place that puts the panel on the rail with the running dot and the window's word on it, the report as a feed line, the commit, persistence across a relaunch, the second ask built apart while the rail keeps the panel as it was with the running dot until its place, its capture of the placed version, its second commit, the removal, and screenshots in both themes.
Each build's place waits until the journey has read the draft (`scenarios/panelPlaceHeld.ts`), so the draft the journey promises is read before the place drops it, however slow the computer.

## Hardening (Step 5)

Step 5 of the plan (landed 2026-09-18, report section 5.5 and the section 7 Step 5 row) is the last one.
A personal panel runs as a React module in the renderer and, when it ships a `server.ts`, as a module in a process of its own with the core's privilege - the trust the app already extends to the crewmate that wrote it ("Background work runs apart", below).
Everything here exists so that trust has a way back.

**The switch is host-owned and it is one row.**
`panels` joins `appearance` and `layout` on `ShellPreferences` (`src/shared/preferences.ts`: `{ enabled, offReason }`, defaulted so a value written before Step 5 still parses), written only by `ShellPreferencesService.setPersonalPanels` - the window's control over `inf:settings:panels:set`, and the safe-mode boot.
**The first mate never writes it**: `personalize` has no action for it, and its context says where the switch is instead (below), because the switch's whole point is to be reachable when a panel is what went wrong.

**Off is the core's, not the rails'.**
`PersonalExtensions.setEnabled(false)` disposes every `server.ts` process, forgets every compiled panel, stops the watcher and pushes ONE empty snapshot - which is what unmounts the panels, through the same reconciler a removal goes through.
An in-flight rescan cannot push over that empty snapshot, and a rescan that did not change anything is silent, so a dropped or delayed filesystem event cannot emit a stale copy of the panels on the way to off.
So a background task stops ticking and a server action is unreachable, not merely hidden; the switch takes back the privilege, not the pixels.
Started off, the service seeds nothing, scans nothing and compiles nothing, and `lint_panel`, `place_panel` and `capture_panel` say so rather than answering blankly.
On again seeds and scans, which is the only way back.
`ShellPreferencesService.subscribe` is the wire between the two (`createServices`), so the preference and the empty snapshot land in the same tick.

**Safe mode is a marker, because a crash writes no report.**
`src/core/personal/safeMode.ts`: every launch writes `pending` into the `launch` settings row before anything a panel could reach, and clears it once the app has been up `EARLY_LAUNCH_MS` (10 s) or on a clean quit (`LaunchWatch.dispose`, called from `startCore`'s dispose).
A launch that finds the marker still set knows the previous one ended before it settled - a crash, a force quit of a wedged window, a kill: the same fact.
Two in a row (`SAFE_MODE_AFTER_CRASHES`) and the third writes the switch off with reason `safe-mode`, which is a feed line, the Settings row's own words, and a line in the first mate's context.
A safe-mode boot starts the count over.
`INFINITARY_EARLY_LAUNCH_MS` widens the window in dev/e2e only, so the crash-loop fixture kills on a signal rather than racing a slow boot.

**The reason is the point.**
An off switch with no reason reads as a setting the captain forgot.
So `offReason` travels: Settings says "Turned off after the app closed twice just after starting", the feed says it once at boot, `panelsOffLine` (`src/core/pi/personalizeTool.ts`) puts it in the context block with "Only the switch in Settings turns them on - you have no tool for it, so say where it is", and `personalize`'s surface refusals add it, so an id naming a personal panel is refused with the reason rather than as a typo.

**Observe's fourth kind.**
A mount is not a session - it has no transcript and no turns - so it is a group of its own in Observe's list ("Panels"), rows rather than selectable sessions, each carrying its state, its compiled version, what its `server.ts` exported, and the refusal that kept it off a rail.
With the switch off the group says so instead of showing nothing, which would read the same as having no panels at all.
It rides one new read (`personal.mounts` over the existing `inf:plugins:personal:list`, its value the snapshot the core already pushes) plus `shell.preferences`; no new IPC channel.
Development and alpha builds only, like the rest of Observe.

Frozen surfaces: one new core channel (`inf:settings:panels:set`, `PROTOCOL_VERSION` 1.7.0), one new read-catalog entry, no new top-level `window.infinitary` key (`settings` gained `setPanels`), no new tool.
The words "extension" and "plugin" still reach no user surface: the control is "Your panels".

**The evidence.**
`tests/e2e/personal-panels-hardening.spec.ts` is the acceptance: the switch unmounts every fixture in exactly one pushed snapshot while the app's own panels stay, and the server action is gone with it (what the first mate's context then says is `personalizeTool.test.ts`'s); then the app is SIGKILLed twice before it settles - what a force quit of a wedged window leaves behind - and the third launch comes up with the panels off, says why in the feed and in Settings, and is one click from back on.
`safeMode.test.ts` drives the marker directly, `personalExtensions.test.ts` pins the one-tick unmount and the stopped background task, and `observe.frame.test.ts` pins the Panels group.

## Background work runs apart

A panel's background module never runs in the app's own process (INF-2205 piece B, the captain's "separate programs and isolated drawing").
`PanelRuntimes` (`src/core/panels/panelRuntimes.ts`) is the one owner of every panel's background work, whatever its source: the app's own, the captain's, or one added from elsewhere.
The source decides only whether a panel may have background work at all and the identity it runs under; how it runs, how it is watched and how it is stopped are the owner's alone.
Today only the captain's own `server.ts` is admitted: the app's own panels have none, and an added panel's tree is refused with one.
Each running panel version, on the rail (`live`) or built apart (`draft`), gets one process through `HostCapabilities.panelProcess`: a utility process in the app (`src/main/host/panelProcess.ts`), a Node fork in tests, both running `src/core/panels/panelProcess.ts`.
The owner lives in the core, so the computer that runs the home owns the background work, with a window or without one (`docs/run.md`).
A panel with no background module starts no process.
The process imports the module, keeps its module state between calls, answers actions by name and runs its background tasks on its own timers, clamped up to `MIN_BACKGROUND_INTERVAL_MS`, a run in flight skipped and a throw logged with the timer kept.

**The store answers asynchronously (panel API 2).**
`context.db` is the same slice as before, through the store's one writer (`PersonalStore`), but each call is a message the core answers, so it returns a promise (`ServerStore`, `src/shared/personal/contracts.ts`).
One ask is in flight per process: the next waits in the panel's process until the core acknowledged the last, so a panel that fires a thousand writes queues them in its own memory, never in the app's.
Its integration calls (`context.integrations`) wait the same way in a lane of their own, so a slow call to a place never holds a store write behind it; the core answers them through `IntegrationsService.forPanel`, and hands the events the manifest names to `context.integrations.on` as they arrive (`docs/integrations.md`, "How a panel reaches them").
Every message is JSON and at most `PANEL_MESSAGE_MAX_BYTES` (`src/core/panels/panelProtocol.ts`), refused in words past it.
A runtime that was stopped or replaced is answered nothing, so a late write never lands; a write the core acknowledged stays, whatever happens to the process after.
A `server.ts` runs only when its manifest says `"api": 2`.
One written for the store that answered at once is refused before any of it runs, with the line saying what to change (`olderServerApiLine`), and its panel still draws.
Nothing transforms saved data and nothing runs older code in the app's process: the captain's existing panels are updated by personal-workspace tasks.

## A paused panel

A `server.ts` written for a panel API this version no longer serves (`SERVED_PANEL_APIS`) is paused, not stopped (INF-2470).
The panel log ("The panel log" below) gets one line the first time each version of the file's text is refused.
The snapshot carries `paused`: the API the manifest names (1 when it names none), the APIs served, and whether the captain already asked for the update.
The panel's status mark says so ("The status mark" below), and its details hold the host's line with an Update panel button, outside the panel's code; a draft's details draw no Update panel.
Update panel (`inf:plugins:update`) tells the first mate once, as the `panel-update-asked` wake, and the first mate starts one personal-workspace task to update the panel; a second press, or a press while the panel is being built, tells no one.
Once the task that built the update closes with the panel still paused, the press is free again.
The first mate's surfaces context says which panels are paused.
The update steps for each older API have one home, the personal-panel skill's "Updating a panel written for an earlier panel API", which the refusal line names.
When the files are fixed, the next reconcile accepts the file, the line goes and the background work starts, with no Retry.
Nothing starts an update without the captain's press, and no notice is sent after an app update: the mark on the panel is the notice.

**The watch.**
The process beats every `PANEL_BEAT_MS` (250 ms) from the event loop the panel's code runs on, and starts beating before it imports the module; it sends everything else from that loop too.
So a module, action or task that never gives its loop back - a loop, a native wait - stops the beats.
A loop silent for `PANEL_SILENCE_MS` (10 s, forty missed beats) is stopped; a slow `await` keeps beating and never is.
That deadline counts from the first thing the process sends: until then it is still starting, which runs none of the panel's code and on a machine short of memory can take longer than the deadline.
A process that sends nothing within `PANEL_START_MS` (a minute) of its spawn is stopped the same way.
A gap the owner's own check also slept through - the computer asleep, or the app's own loop held - blames no panel: the watch starts over.
The deadline is not the freeze recorder's threshold (`docs/freeze-recorder.md`): that one measures the app's own main thread, this one a panel's own process.

## A stopped panel

A stop is written to the record before the process is killed (`PanelStops`, the `panel_stops` table), so an app that ends mid-stop keeps it.
Its fields follow the freeze record's incident: an `incidentId`, the wall-clock `at` as a label, how long the loop was silent on a monotonic clock, and whether the process was seen to end.
The owner kills the process, waits `PANEL_KILL_WAIT_MS` for its end, and kills it by its process id when it is still there; `termination` says whether the end was seen.
A process that ends on its own is stopped the same way, with reason `exited`.
Every call waiting on it is refused with the stop's words; an unconfirmed outside effect is never replayed.

A stop is keyed by source, panel id, `live` or `draft`, and the code version stopped.
The live runtime stays stopped at any version: a reload, a restart, a reconnect or the crewmate's next save does not start it.
Only the captain's Retry (`inf:plugins:retry`) or the panel's removal clears it.
A draft is stopped only at its version, so the next save is tried apart.
The snapshot carries `stopped` (why, when, and which version).
The panel's status mark says so, and its details hold the host's line with a Retry ("The status mark" below), outside the panel's code.
`lint_panel` says the panel is stopped, and its actions are refused.
Stopping is targeted: the panel's data, its drawing and every other panel stay; the `panels` switch and safe mode above remain the broad fallback.

## The status mark

What the host knows about a panel that its code cannot say is one small dot by the panel's name in the host's header, open or folded (`PanelStatusMark`, `src/renderer/src/personal/PanelStatusMark.tsx`; design skill `Panel.prompt.md`, "The status mark"): its background work stopped or paused, reads that keep failing (below), or an integration call waiting on the captain's approval card or turned down (`docs/integrations.md`, "How a panel reaches them").
Nothing above the panel's body moves it down: the frame's own line for a page that stopped answering stays where it was (`PanelStoppedLine`).
On rest and on Tab focus the mark says its most urgent line (`docs/keyboard.md`, "Facts shown on rest"), in this order: stopped, failing, waiting on you, paused, declined; its tone is the warning color for stopped or failing, the captain's for a call waiting on them, and idle for paused or declined.
A press, Enter or Space opens its details (`[data-panel-status-details]`), most urgent first, each section with the host's sentence and its one button: Retry, Ask the first mate, Ask again or Update panel; Esc or a press outside closes them and focus goes back to the mark.
A draft shows its own mark, without Update panel or Ask the first mate.
The phone draws the same mark with the same details as a popover (`docs/ios.md`, "Panels").

## Reads that keep failing

The app counts the reads of the captain's own live panels that it sees fail itself, one row per read, kept in memory (`PanelReadFailures`, `src/core/personal/panelReadFailures.ts`; the panels service's side is `PanelReadCounting`): a background job of the panel's own whose run threw, an integration action it called whose answer was refused or whose connection could not get ready, and an integration event the app looked for on its behalf and could not read.
A call waiting on the captain's approval or declined, a paused or switched-off integration, an app refusal such as an undeclared action, and paused or stopped background work are never failures: each has its own section.
Whether a panel's numbers look old is never judged: the count reads only what failed.
A panel added from elsewhere, a runbook's panel and a draft are their makers' to fix and are not counted.

A row is failing on the automation's rule for a look that keeps failing (`docs/automation.md`, "When every look fails"): at least `LOOKS_FAILING_LOOKS` failures in a row whose span, each failure counting for its read's whole cadence, reaches `LOOKS_FAILING_TICKS` of the app's tick period, an hour on the minute tick.
So an hourly job is failing at its second failed run, and a job every five minutes after an hour of failed runs.
The first read that works clears its row; new background code or a new drawing starts the panel's rows over, and a panel that leaves takes them with it.
The snapshot carries `failing` for each failing row: the read (`background` with its task, `call` with its place and action, or `event` with its place and event), the first failure's time, the tries, the newest answer cut to `PANEL_FAILING_ANSWER_MAX`, and whether the captain asked.

The first mate hears a row turn failing once (the `panel-reads-failing` wake, once per panel, code version and read), with the newest answer as words from outside, and puts up a card only when there is something to decide: a fix it can make, or a step only the captain can take, such as signing in again.
The mark's failing section says since when each read fails, that the panel still shows what it last read, and that it clears by itself, with Ask the first mate (`inf:plugins:ask-firstmate`): that tells the first mate once per row (`panel-reads-asked`), which finds the cause and starts one personal-workspace task to fix the panel's code, or names the captain's step on one card; the button then reads Asked, and the section says the first mate is looking into it.
The first mate's surfaces context lists each failing read on the panel's row: since when, the tries, whether the captain asked, and the newest answer under a key that names it words from outside.
`panelReadFailures.test.ts` pins the rule on an hourly job that hits a read limit.

## The panel log

Every panel's lines go to one file in the app's data folder, `logs/panels.log` (`AppPaths.panelLogPath`), with a window or without one (INF-2817).
An app opened from the Dock keeps none of its console, so a panel line sent there was lost: a panel whose saves were refused looked as if GitHub had stopped answering.
The file holds what a panel's code hands `context.log`, a throw its process logs, every line its process prints on either stream, and the host's own lines about panels: a stop, a paused `server.ts`, a workspace the app could not seed or watch.
A line starts with its ISO time, then `personal <id>:` for a captain's panel; a printed line says `stdout:` or `stderr:` after that, and a message of several lines keeps its later lines indented.
The panel process's spawner reads both of its streams line by line (`HostChildProcess.onOutput`, `src/main/host/panelProcess.ts`), always, so a panel that prints a lot never waits on a full pipe, and the last lines of a process that ended on its own still reach the file after its stop.
`PanelLog` (`src/core/panels/panelLog.ts`) is the one writer: it appends each line at once, makes only its own folder, and drops a line it cannot write, so the log never stops a panel or the app.
Past `PANEL_LOG_MAX_BYTES` (1 MiB) the file moves aside to `panels.old.log`, replacing the one before.
The personal-panel skill tells a crewmate building a panel where to read it.

## Panels for others (the plugin author's guide)

One plugin vehicle, Phase A (the captain's A1a-A4a; the runtime is `docs/ui-plugins.md`, "The one plugin vehicle").
A panel someone else adds is written EXACTLY like one a crewmate writes in the personal workspace: a directory with a `panel.tsx` whose default export takes `PanelProps`, built from `@infinitary/ui` and React alone, and a `manifest.json`.
The library, the skills, the tidy-up and the look above all apply.
What differs is where it runs and what it is served, and that is the host's call, never the author's.

**The manifest** is the same file with two more things a panel for others must carry: `name` (the maker, shown as the panel's attribution) and `version` (semver; an update is a new version).
A panel inside a runbook, a folder its `runbook.json` lists under `panels`, carries neither: its runbook's name is its attribution and its runbook's version is its version (`docs/runbooks.md`, "Panels").
Its card views (`cards/<view>.tsx`) are checked and pinned with its panel when it is added, and a card, button or command its manifest names that the folder does not have refuses the whole folder.
The capability keys are the grant it asks for and the consent card words: `reads` (the app's own reads, `PANEL_READ_NAMES`), `sql` (published views, by their exact versioned names: `v_usage_v1`), `integrations` (each connection it uses, with its actions, events and why, listed on the card), `storage` (a byte cap under the store's own), `moves` (it queues, starts and drops the captain's tasks on the captain's click or key, in a line of its own on the card), and `actions` (the settings it may change by their action catalog names, each while the captain's click or key is in the panel, each on a line of its own on the card; `docs/ui-plugins.md`, "Changing settings").
The retired `net` and `secrets` are refused for every panel, saying to name an integration instead: a panel reaches a service outside your projects only through the captain's own connections, each action under its rule in Settings (`docs/integrations.md`, "How a panel reaches them").
There is no `server.ts`: a tree holding one is refused.
A runbook's panels are agreed on that runbook's own add card, which lists each with its grants, rather than on a card of their own; a runbook in the captain's workspace is served what its panels ask, as the captain's own panels are.

**Where it runs.**
In the frame realm: a sandboxed frame at a host of its own, loading the app's own React and `@infinitary/ui` from the shell's pinned lib (so it looks like the app), with `PanelProps` built over the bridge:

| `PanelProps` | In the captain's workspace | Added from elsewhere |
|---|---|---|
| `reads.subscribe(name, cb)` | the reads its manifest lists | the reads the captain agreed to |
| `reads.subscribe("sql", query, cb)` | its manifest's views | the views the captain agreed to |
| `store` | its slice | its slice, bound by the host - a panel names keys, never whose slice |
| `invoke` | its `server.ts` actions | rejects: no server code runs |
| `theme` | the shell's theme | the same, pushed over the bridge |
| `cards` | its cards on the stack (`docs/ui-plugins.md`, "A panel's cards"), through the card actions, at the front only while its frame holds the captain's focus | the same |
| `asks` | its header buttons' presses, with how each came (`click` or `key`), and F6 into it (`onFocus`) | the same, counted in its view state |
| `card` (a card view) | the card it draws, its data as last put up, how many times it was put up (`revision`), and the place it kept (`kept`, `keep`) | the same, its data, revision and kept place pushed as view state |
| `point`, `view` | pointing at tasks and the stack's open tasks, with `tasks.board`; `point.draft`, starting the captain's next message, whatever it reads | the same, through the actions declared for it, at work only while its frame holds the captain's focus |
| `keys` | the keys its own commands have now, by command id, drawn as this computer draws them with their `aria-keyshortcuts`, for the controls that do the same (`docs/keyboard.md`, "A panel's commands"); none in a crewmate's draft | the same, pushed as view state again whenever a key changes |
| `tasks` | its moves, when its manifest asks | the moves the captain agreed to, the same way |
| `settings` | `change` for the settings its manifest's `actions` names, while the captain's click or key is in the panel; this computer's own window only | the settings the captain agreed to, the same way |
| `integrations` | `list`, `show`, `call` and `on` over the integrations its manifest names, each action under its rule in Settings | the integrations the captain agreed to, the same way |
| `rail` (the panel itself) | whether it is collapsed, what it says it holds, and with `presence` `{ "code": true }` whether it shows and, off its rail, why | the same, its page running while collapsed or off its rail |

Nothing else is reachable, and the frame proves it rather than asks for it: no network (fetch, beacons, sockets, images or frames from a host), no `window.infinitary`, no parent page, no storage, no top-level navigation or popups, no `eval` or `new Function`, no module that is not its own or the lib's (`docs/live-prototype-security.md`, "The frame realm").
A panel that wedges its event loop is torn down to a quiet line with a Retry; one that throws shows "This panel stopped drawing."

**Shipping it.**
The captain adds it by talking ("add the panel from ...") from an npm package (packed with its scripts never run), a git repository (hooks off, pinned to the commit) or a folder on the captain's Mac; links are refused.
The app checks it exactly as it checks its own - the manifest, the import allowlist, the tidy-up's refusals, a compile - and then asks the captain once, on its own card, in the words of what the panel can read.
Nothing is added before the captain's click.
An update asks again only when what it can read or do changes - moves and settings included; the captain takes it back with "remove my panel ...", and the one switch in Settings takes every panel back at once.

**Writing and trying one.**
Write it in the personal workspace first - the build loop, `lint_panel` and `capture_panel` all work there, in the same kind of frame - then add the folder from elsewhere to see it contained: the same files, the same pixels, served only what the captain agrees to.
The one thing that works in the workspace and not contained is `invoke`: a panel for others brings no server code, so it reads its data through the reads and views it declares and keeps its own state in its store slice.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The build loop (talk-to-personalize Step 4, `docs/personal-panels.md` "The build loop"): the personal workspace is a workspace KIND (`repos.kind: personal`, `repoKindSchema`, migration 37 - the crew-posture rationalization's Task A, 2026-09-20, lifted it out of `delivery`, where it had been a third `live` posture) - `RepoRegistry.ensurePersonal` registers the workspace as repo `personal` on first need (`kind: personal`, autonomy on, its own project; its `delivery` column is written `local-only` and never read) and refuses its WHOLE policy patch with one message, and refuses to unregister it.
  A `spawn_crewmate` with `personal_ui: true` (intent `kind: "personal-ui"`) is bound to it by the host whatever repo_id came along; `renderIntentBrief` writes no `Delivery:` line for it and appends the in-place sentence, the workspace path, what to read first, the checks before every report and the existing surfaces, and `deriveRigor` stamps no tier (rigor exists only where a change lands through a gate).
  A personal task has NO worktree (`worktreeDir`/`branch` empty, cwd = the workspace; `resumeTask` falls back the same way), holds `lint_panel`/`place_panel`/`capture_panel` (`src/core/pi/panelTools.ts`, entries of the crewmate tool spec both runtimes generate from, `docs/claude-client.md`; `CrewmateSpec.onLintPanel`/`onPlacePanel`/`onCapturePanel`, absent elsewhere), and every settle mode but `finished` and any settle-effect card is refused on it.
  `PersonalExtensions.beginLiveTask` stamps the task onto `manifest.json` `origin.taskId` of every extension with uncommitted changes on each reconcile (the running dot follows the first save; `src/core/personal/liveWorkspace.ts` is the git plumbing), and the rails keep the last commit, or the tree the crewmate placed, while the working files run apart as a draft ("Built apart", "Placed on the rail"); a report on a personal task is the commit (`commitTurn`: stamp, lint to the timeline, commit under the app identity with the report as subject+body, only when the tree changed), and once it lands the report routes as any other; the first mate closes the verified build with `settle_task` done, why `finished` (`done`/`finished`, feed line `built in place - <title>` (`TaskDelivery.mode: "in-place"`)); a commit that fails routes nothing and wakes the first mate (`commit-failed`); a note alone does not hold the turn and stays after the done close.
  The capture is `HostCapabilities.capture` (Chromium's screenshot command, `Page.captureScreenshot`, on a hidden themed copy of the docked panel, which draws a fresh frame before it copies one; the live window's theme is never written), PNGs under `crewmates/<taskId>/captures/`.
  The panel's own drawing is in its frame, so the copy reads each frame's markup and CSS inside that frame and sets it back as a script-free frame of the same size.
  App data reaches a panel only through declared reads: `manifest.reads` ⊆ `PANEL_READ_NAMES` (`quota.snapshot`, `tasks.board`, `feed.recent`), served by `bindReads` over the read executor as `PanelProps.reads`; undeclared throws.
  Step 1's `personalize remove` deletes and commits and refuses while a personal task is building the extension; the words extension/plugin still reach no user surface.
  `tests/e2e/personal-panels.spec.ts`'s second half is the binding flow through the mock provider.
- Personal panels, the authoring half (talk-to-personalize Step 3, `docs/personal-panels.md`): the app's design library IS the panel library, so Step 3 adds a component by exporting it from `src/renderer/src/design/index.ts` and nothing else moves (Step 2's `hostModules.ts` publishes that namespace as `@infinitary/ui`).
  It gained the five frame-era looks as components - `design/panel/`: Row, FeedLine, MicroLabel, Empty, Disclosure - spec'd in the design skill's `components/panel/Panel.prompt.md`.
  The authoring skills are `resources/personal-workspace/skills/` (`personal-panel`, plus one per data source) and are seeded into the workspace's `.claude/skills/` together with the app's OWN design skill, copied whole and self-healed EXACTLY (`src/core/personal/workspaceSkills.ts`, called from the workspace seeder): an app-owned skill a crewmate edits is restored, and `captain/` and the extensions are never touched.
  The skills are the one home of the authoring rules - `skillText.test.ts` pins that no persona prompt and not the workspace's own `AGENTS.md` repeats a sentence of them, the same structural pin the card contract has.
  `pluginLint` (`src/core/plugins/pluginLint.ts`) refuses emoji (in code and in a manifest title), an external URL in panel code and a direct `window.infinitary`; warns naming the NEAREST token on a raw color, type size, radius or shadow and on a second accent family (the scale is `src/shared/designTokens.ts`, kept in sync with the token CSS by its own test); notes a list with no empty state; and rewrites nothing.
  Evidence: `tests/fixtures/personal-skills/` is one real extension per data skill, compiled and mounted by the real host in `tests/e2e/ui-kit-panel.spec.ts` and lint-clean in `personalFixtures.test.ts`.
  The gallery seam (`design/fixtures/`) is off unless the window's own localStorage carries `infinitary.designFixtures`.
- Hardening the personal panels (talk-to-personalize Step 5, the last; `docs/personal-panels.md` "Hardening"): the host-owned switch is one preference row, `panels` on `ShellPreferences` (`{ enabled, offReason }`), written ONLY by `ShellPreferencesService.setPersonalPanels` - the Settings control over `inf:settings:panels:set`, and the safe-mode boot.
  The first mate never writes it (`personalize` has no action for it) and its context says where it is instead, because the switch exists for when a panel is what went wrong.
  Off is the CORE's, never the rails': `PersonalExtensions.setEnabled(false)` disposes every `server.ts` process, forgets every compiled panel, stops the watcher, and pushes ONE empty snapshot - so a background task stops ticking and a server action is unreachable, not merely hidden - and started off the service seeds, scans and compiles nothing; `ShellPreferencesService.subscribe` is the wire, so the preference and the unmount land in the same tick.
  Safe mode is a marker, because a crash writes no report (`src/core/personal/safeMode.ts`): every launch writes `pending` into the `launch` settings row before anything a panel could reach and clears it after `EARLY_LAUNCH_MS` (10s) or on a clean quit (`LaunchWatch.dispose`, from `startCore`'s dispose); two launches that never settled and the third writes the switch off with reason `safe-mode`, which is a feed line, the Settings row's words, and a context line - then starts the count over.
  `INFINITARY_EARLY_LAUNCH_MS` widens the window in dev/e2e only.
  The reason always travels (`panelsOffLine`): an off switch with no reason reads as a setting the captain forgot.
  Observe gained the fourth kind for it.
  `tests/e2e/personal-panels-hardening.spec.ts` is the acceptance, and its crash fixture is a real SIGKILL before the settle, not a stubbed counter.
