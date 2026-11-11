# The orchestrator contract

The first mate's served prompt and its tools.
Each revision is one file in `src/core/prompts/contract-revisions/`, and the version counts them (`src/core/prompts/contractVersion.ts`).
Card authoring is `docs/card-authoring.md`; threads are `docs/card-threads.md`.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Contract revisions live in `src/core/prompts/contract-revisions/`, one file each; `FIRSTMATE_CONTRACT_VERSION` counts them, and that folder's README keeps the ledger through 4.72.
  The first mate persona's pin lists 23 typed tools (`FIRSTMATE_TOOLS` in `src/core/session/tools.ts`, which `scripts/generate-self-source.mjs` reads and its test holds to the live tools), and the seat also serves `emote`, so a seat serves 24 - no bash, no read/ls/grep/find.
  The tools come from the one tool spec (`src/core/session/tools.ts`, runtime-neutral): each factory returns a bound tool (name, label, description, parameters, `run`), `buildFirstmateTools` (`src/core/orchestrator/firstmateTools.ts`) binds them to the host, and each runtime generates its own tool from that one list - `piToolOf` (`src/core/pi/toolSpec.ts`) at the Pi session factory's boundary, `claudeToolsOf` (`src/core/claude/claudeTaskTools.ts`) for a Claude seat - so a new first mate tool is one entry both seats and the pin pick up.
  The offline readers keep their own lists of those tools, which the same change updates (`docs/dispatch-extractor.md` "Tests", `docs/replay-harness.md` "What it replays").
  The self-source test reads the live agent's list (`tests/helpers/firstmateTools.ts`) and holds both runtimes' generated names to the pin plus `emote`, and the stamp's `toolsSha` fingerprints every tool's name, description and schema (`firstmateAgent.provenance.test.ts` holds that each moves it), so a change to the tool words always shows in the record.
  A first mate tool rule lives in a tool description or a top-level parameter's, never only a nested one, because no app tool describes a nested parameter (`docs/claude-client.md`).
  The seat itself is backend-neutral (`src/core/orchestrator/seat.ts`, `docs/architecture.md` §2 "The seat seam"): the spec carries the binding, the spec tools and a per-backend resume, and a seat speaks `FmEvent`s plus `turn_closed`, so nothing in `src/core/orchestrator/` reads a Pi event.
  The answer move is answer-with-default: an answer that implies a next step is ONE `decision` whose proposed step is its `default` action; a pure fact is a `note`; an active crewmate shows what the captain must see or decide on its own card, and the first mate acts on its report rather than relaying it; there is no seventh move, no propose tool, no recommendation kind.
  Reading is a crewmate's job: anything needing code, files, logs, git history, builds or reproduction is an investigation spawn (the standing rule in the prompt).
  On a task whose crewmate has a card open, the first mate's new `emit_card` is refused with "write on that card instead of a second one beside it", and every emitter writes on an overlapping open card in place, its own or someone else's (`docs/card-threads.md`, "Shared cards"; no one-card-per-topic cap).
  Thinking is medium for a captain turn, low for an `[fm-op]` drain (`FIRSTMATE_CAPTAIN_THINKING_LEVEL`).
  `emote` is visual only and motion only: it takes no words (INF-772).
  A turn ends with one plain sentence of about 40 characters saying what took effect, never the answer; on a captain turn it is the reply line beside the captain's message, and the typed line fills in when it is empty (`docs/composer.md` "The last turn").
  The first mate has no CI tool: `ChangeChecks` (`orchestrator/changeChecks.ts`) computes the PR-8 green rule in code and records per-task readings (the crewmate's `check_change`, the check watch and the merge card's gate take them), the host's settle-facts line renders them, and the first mate reads the latest in `crew_status`'s `ci` and at the end of a crewmate's report wake (`orchestrator/ciFact.ts`); a merge rechecks fresh whoever asks, and the first mate authors no merge card; `locate_project` (`workspace/projectLocator.ts`) replaces bash lookups.
  `spawn_crewmate` carries a structured intent (goal, verbatim user_words, typed constraints, delivery_note), with its work-shape facts in `shape` and its waits in `start_after`; the HOST renders the fixed brief template (`orchestrator/intentBrief.ts`) and the crewmate self-briefs on turn 1.
  Builder and reviewer briefs put the captain's verbatim words before the goal so their precedence over every elaboration below includes the goal.
  The served prompt is `FIRSTMATE_PROMPT_CORE` plus `FIRSTMATE_CARD_AUTHORING` plus `CARD_REPLY` plus `FIRSTMATE_HANDOFF`, with the captain's sequences as Pi's appended section after it (`docs/sequences.md`) (the core stays byte-stable, six-way classify-first, no interpolation; the authoring constant is appended by `buildFirstmateSystemPrompt` exactly as `crewmateBackendNote` is on the crewmate side; the style appendix was folded away at v2.0, its one kept rule - a settle effect is run by the host, which reports the outcome - now lives in the first mate's emit_card addendum); a redline is a contract revision: add a file to `src/core/prompts/contract-revisions/`, and the session records the served prompt's sha itself (`recordContract`).
  The card lint (`src/core/pi/cardLint.ts`, `docs/card-authoring.md` "The shape lint") asks for SHAPE through htmlparser2, never for the absence of words - never bring back a progress-phrase ban list: `lintCardShape` (each rule a typed fact, consent for an effect, a physical limit or a product fact: a card with actions is a decision with 2 or 3 actions and exactly one default, figure text at 11px or more, an entity-escaped body - `&lt;p&gt;` with no real element - is refused as such, an action whose id or label reads like merge/land carries a `settle` effect, no `host` effect from an agent, and a required question arrives unpicked with a Something else row; the wording, length, lead, headings, voice and button labels are the author's since INF-484 move 5) runs at BOTH boundaries (crewmate cards in `CrewmateCards.addCrewmateCard`, any backend); the settle-needs-task rule, attach-first, the closed-task choice refusal, and the carded-task refusal are first-mate-only, and G-1 and the PR-link rule are gone.
  Supervision persona, brief close, output cap, watchdog, and inbox mechanics are unchanged.

## Diagnosed check failures

FI3-237 pairs persona clarification with the crew's repair judgment; the host counts no repairs or reruns.
An initial failed reading requests the failed-step/log diagnosis, not a captain card.
The first mate coordinates an own repair, one evidenced failed-job rerun, or a confirmed separately owned baseline wait/resumption.
Unknown needs one bounded investigation.
A crewmate's blocker report, or a real captain-only decision or access gap, earns a question on its task; waits and raw failed versions hold nothing.
The typed declarations, persistent ledger and strict all-current-checks-success completion gate are specified in `docs/delivery-rigor.md` and `docs/forge.md`.
Existing recorded captain holds are not silently lifted.
Model changes still require the captain.

## App action catalog (4.54, pieces 1–4)

`app_state` reads the shared catalog in `src/shared/actions.ts`: area, strict value schema, current value, tier, and consistent static `captainAllowed` / `firstmateAllowed` flags, plus `allowedNow` for the current code-stamped wake.
`app_change` takes a top-level action enum, value, and evidence.
The dispatcher enforces actor permissions independently.
`asked` and `own-words` are the first mate's at any wake, with the captain's ask as evidence; the dispatcher refuses a change that gives none (INF-751).
`asked` takes the captain's ask in any form: the captain's message, the captain's choice on any card, or a schedule the captain set.
`own-words` takes only the captain's typed words.
The captain's ask reaches the first mate wherever it arrives: in the captain's own turn, in a message the captain sends while a turn runs, or in a crewmate's report that relays the captain's choice or the captain's reply.
Whether an ask is the captain's, and whether it is the captain's typed words, is the first mate's judgment; the host does not read the turn's wake for it, because a report or a scheduled turn can carry the captain's ask and the host cannot tell when one does not.
This follows the captain's ask to fix the rigidness, the same way INF-638 lets the first mate keep the captain's directions on its own judgment.
A message typed on a paired view is a captain message (the captain's pick on FI3-709, `docs/devices.md`).
`hands` delegates to the captain, and `yours` is captain-only.
`judgment` is the first mate's at any wake too, on its own judgment: its evidence is its reason, which the change keeps, never the captain's ask.
`direction` (INF-638, `judgment`) adds, revises and retires one of the captain's standing directions through `inf:knowledge:direction:set`, and lists them as its current value from `inf:knowledge:directions`.
The captain's ruling made it the first mate's judgment rather than a tier of the captain's words: "why not just give first mate a tool to freely read and write standing directions, and then rely on the agent's judgment on when/how to do it?"
A direction is a setting like the rest, not a second store of its own: each change leaves the same feed line and operation, and `record_knowledge` refuses one (`docs/knowledge.md`, "Directions are the first mate's to keep").
Sharing switches and purge stay the captain's.
Panels and plugins gain no change ability.
`show-card` (`asked`) brings a card forward when the captain asks: `inf:cards:show` restores an open minimized card or shows a closed card read-only.
The first mate reads its id from `tasks` by key; it has no action to minimize cards itself.
The existing `inf:cards:show-past` read-only closed-card door remains compatible.
It is no tool of its own, raises no card and runs no effect; see `docs/card-evidence.md` "The past card".
`show-whats-new` (FI3-932, `asked`) takes the What's new door, `inf:release-notes:show`: with no value the newest release note that listed changes, or the one for a `version` its current value lists, an open note to the front of the stack and a closed one read-only; it needs no card id (`docs/release-notes.md` "Reading a note again").
`device-invite` and `device-remove` (FI3-679 at 4.72, `hands` since FI3-683) make a pairing link and remove a paired device, and `device-address` still answers and no longer chooses an address.
They stay the captain's own on the home Mac's window: words typed on a paired view reach the first mate as the captain's, and a link never enters a conversation (`docs/devices.md`).
Asked for one, `app_change` files a card the host writes from typed facts - "Connect your MacBook Air" with Make a link, or "Remove Mac mini?" with a danger Remove Mac mini - whose click opens Settings -> Devices and acts there.
`project-setup` (FI3-1532, `hands`) proposes: any wake may call it, it changes nothing, and the host puts up its own setup card, whose Add project alone adds the project with the settings chosen there; the first mate hears the answer once as a `project-setup` wake (`docs/fleet.md` "Asking the first mate to add a project").
Settings → Automation's changes are four lines over `inf:automation:list` (INF-752, `docs/automation.md` "One owner"): `automation-edit` (`asked`) edits a rule by id and turns a draft or a paused rule on with `enable`, and `automation-state`, `automation-pause-all` and `automation-delete` (`judgment`) pause, resume, pause all and delete, as making a schedule is the first mate's judgment (captain decision Q4).
`cancel_schedule` is `automation-delete`; `schedule_prompt` stays the one way the first mate makes a rule.

Piece 1 covers projects folder (own-words), notifications, window wash, crew model names and panel collapse (asked).
Folder paths expand `~`; existing projects never move and missing folders are refused, not created.
Each applied catalog change leaves a feed line and an operation attributed to whoever acted, never a card: one per change the first mate makes, and one per run of the captain's own steps on one setting ("Settled runs" below); unchanged values and refusals leave no success trail (usage refresh records each successful refresh even when unchanged).
A captain choice can request asked settings, but is not own words for the projects folder.
Scheduled authority is persisted when a captain turn creates the schedule and travels as a typed wake fact.
A turn a captain-set schedule began is stamped `scheduled`, and one an autonomous or legacy schedule began is stamped `other`; neither refuses an asked change, and the first mate never quotes a schedule it set itself as the captain's ask.
A recurring schedule made outside a captain's own turn is saved as a draft that runs only once the captain turns it on, and `schedule_prompt`'s `draft` keeps an underspecified ask for the captain to finish (`docs/automation.md`, "Drafts").
Catalog writes are ordered so overlapping Settings calls cannot duplicate a change or attribute the next value to the previous call.
Before piece 3, other changing channels remained named in the shrinking parity inventory.
Piece 2 removes ten channels, bringing the ceiling to 18; its initial ceiling was 28 after the new dictation setter joined main before piece 1 shipped; dictation migration remains in piece 3.
Theme/panel changes in `personalize` began refusing report wakes in piece 1; piece 4 replaces those write paths with the catalog.

Piece 2 adds Intelligence: first mate model and account, crew slot membership/reset, model pins, dynamic routing, decision answerer, account rename/prefer/pause/disconnect and usage refresh.
Disconnect requires typed captain words and refuses the currently attached first mate account, even if a different account is saved for the next turn.
Own model changes reuse the existing idle-boundary rebind.
Pins and routing preserve each other; decision answerer changes preserve outbound consent and never handle keys.
Accounts are read back through their metadata view after writes; account write replies are acknowledgements, not the saved value.
The first mate's own account (`firstmate-account`) is a line apart from crew work's preferred account (`account-prefer`), and Settings → Intelligence writes it through the same line.
It takes an eligible account of the provider of the first mate's model and refuses another provider's account in words that point at the model; its feed line names the account by label.

Each shared request's setting fields are claimed by action lines (`fields`), or named in `ACTION_FIELD_EXCEPTIONS`.
Parity reads the request schema itself: adding a field to appearance, layout, presence, routing or decisions without a claim or named exception fails the check.
Sharing's selector enum is checked per choice too.
Usage's unit (a view choice inside Settings → Usage), default card size (a view choice in Settings → Appearance), decision format version and captain-only outbound consent are explicit exceptions.
The first mate's shared-object boundary uses these same field claims to preserve every unrelated value; the one-panel limit remains separate.
The tool's own-words action list is derived from the catalog tiers, including guidance actions.

Piece 3 makes parity strict: every changing core channel is a catalog line, an existing-ability reference, or a named non-setting exception.
There is no pending inventory.
Project configuration was an explicit exception until piece 4.
Login/dock now use core dispatch with field-scoped permissions.
Release-page opening records every successful request; signing out of a project host needs typed captain words, and reaches any host the app is signed in to, as Settings does.
Sharing, its ask, purge, panels consent, recovery and ask-first merge remain captain-owned.
Hand-over actions offer a card opening the relevant Settings section, never submit credentials.
Voice download runs through core dispatch over a host capability; model-file serving remains desktop-owned, and a host without that capability refuses the request.
The subsequently added dictation choices are inventoried as captain-owned, not a new first mate capability.
Existing task/card/panel-removal abilities remain their only execution paths.
Captain sign-in/key/consent actions also leave a trail, with no credentials in that trail.

Piece 4 adds `theme`, `panel` (rail, position and visibility), and `project-settings` to the same catalog and dispatcher.
`configure_repo` is retired; `personalize` keeps only removal, and a panel instruction is a `direction` scoped to the personal workspace.
Both actors get an attributed feed line and operation for each applied change, the captain's settling as a run ("Settled runs" below); project operations stay with their project and use the existing `repo_configured` refresh event, not a second personalization event.
No-ops and refusals add no success trail.
Shared appearance/layout channels enforce the named action's field boundary; panel arrangement resolves defaults, preserves collapse, refuses unknown surfaces and a full target rail, and stores only placement deviations.
Sign-in refusals' "Keep it on this computer" way now points at `app_change project-settings` too.

`window-size` (FI3-524, `asked`) claims the appearance row's size: 100, 110, 125 or 150 percent.
The Size picker, the size keys, the View menu and command search make the same change as the captain, so a run of them leaves one attributed feed line and operation, and the first mate makes it when asked.

### Settled runs

A run of the captain's own steps on one setting is one feed line and one operation, written where the trail writes them (`settle` in `src/core/dispatcher/actionTrail.ts`; the captain's answers on FI3-1330).
One drag of the window wash slider, a held size key or a panel folded and opened again would otherwise write a line and file a task number for every step.
A setting is one catalog action and its target: a panel by surface, an account by id, a provider's preferred account, a crew slot by offering and slot, or the action alone.
The run's first step writes its line and files its operation, and each later step rewrites both in place: the same row and the same task key, with the step's words and time.
A scale setting's line says where the run started and where it settled (`settled` on the catalog line: `window wash 48% → 76%`, `window size 100% → 125%`); every other line says the setting's settled state in its usual words, and a panel's says what changed since the run's first step.
A run ends when `SETTLE_MS` (10 seconds) pass with no further step, when any other line enters Activity, or when the captain changes another setting; the next step starts a new run with a new line.
A first mate change on the same setting writes its own line, so it ends the captain's run too.
A run that comes back where it started is withdrawn at once: its line leaves Activity and its operation leaves the record, because nothing changed (`TaskService.archive.withdrawOperation`; its task key is not reused).
Only the captain's changes settle.
Each change the first mate makes stays one line and one operation, so the answer check still finds one action per captain message (`docs/task-capture.md`).
Acts rather than values never settle or withdraw: every `alwaysTrail` line, the usage refresh, an account renamed or disconnected, a device removed and crew slots reset.
A project's setup, settings, where it runs and its removal write their own events (`repo_setup`, `repo_configured`, `repo_runs_on`, `repo_unregistered`), one line per change.

The event seam holds the one fact the run needs from Activity: which run Activity's newest line belongs to (`activityRun` in `src/core/eventSeam.ts`).
A step's `personalized` event carries its run's id, and a withdrawal carries `withdrawn`; the seam rewrites or deletes that row in `activity_events` only while it is still the newest line, and any other line ends the run.
The run is the generic `feedRunSchema` (`src/shared/events.ts`), read through `feedRunOf`: a copy's count of what it sent so far to a Mac being set up rides the same seam as a `device_setup` run (`docs/devices.md`, "How far the copy has gone"), and so ends a captain's run as any other line does.
`changesFeed` (`src/shared/feed.ts`) makes `feed.recent` read again on a rewrite and on a withdrawal, so Activity draws a run as one line with no change to the panel or to `PanelFeedLine`.
A run lives in memory: a restart ends it, and the record and Activity keep what it settled.
`src/core/core.settings.test.ts` ("settles a run of the captain's steps on one setting into one line and one operation", "starts a new run once the captain's setting has rested for the wait") and `tests/e2e/activity-runs.spec.ts` hold it.

### The fixed-context budget

A rule that the core, a tool description and a parameter each stated is said once.

- **One home per rule.**
  The core keeps which move and when.
  How a call works is the tool's own text: what a spawn's intent carries and what queues it, each `shape` fact's rule, the notes policy (`remember`), revise-in-place and what an effect is (`emit_card`), and that only a card's author withdraws it (`close_card`).
  A tool's text drops what the core already says: that crew_status outranks memory, that a red check is diagnosed first, where theme and panel changes go.
  A rule the host enforces is said once, as its refusal's text, and neither the core nor a tool's text repeats it: a note with no task, a second card beside a crewmate's, a merge card the crewmate owes, a merge with autonomy off.
  A rule a wake carries leaves the core: what the captain's Start asks, and what a capped task holds until the steer.
  A sentence kept to compensate for today's model stays and is marked as a ceiling in a comment beside it (`docs/principles.md`, "Build the agent's reach, never its verdicts").
- **A fixed choice is one string with an enum** (`stringEnum`, `src/core/session/tools.ts`), not a union of literals.
  The values and the validation are the same on both runtimes; `claudeTaskTools.ts` reads the form.
- **A shape a zod schema owns is one `zodParameter`** (`src/core/session/tools.ts`), never a spread of `z.toJSONSchema`.
  It leaves out the JSON Schema dialect line and the safe-integer range zod writes beside each integer, which no model acts on.
  It also leaves out a string's length, an array's item count and an object's closed flag: the tool parses the argument with the same zod schema, which refuses a value past one and names it.
  A pattern, a number's bound, an enum, a constant and the required fields stay, since a model writes a value from them; a count a model must plan around is said in the parameter's description.
- **emit_card describes only its top-level parameters.**
  A Claude seat was served no nested description until INF-744, so each nested rule rides `actions` or `CARD_MECHANICS`; `claudeToolSurface.test.ts` holds that no app tool describes a nested parameter.

The first mate's budget is derived: the 65,536-token floor, minus the 12,288 reserve, minus the promised 33,476-token conversation, which is 19,772.
A crewmate's budget, for each runtime and kind of work, is derived from the same floor and reserve: the conversation is promised at least as much room as the fixed part takes, so the budget is half of what the floor leaves after the reserve, 26,624.
`tests/helpers/promptBudget.ts` is the one measurement both read.
Each budget has two lines (`docs/testing.md`, "The prompt budget's two lines").
`tests/firstmate-fixed-context.test.ts` and `tests/crewmate-fixed-context.test.ts` fail a change only past the hard line, one and a half times the budget: 29,658 for the first mate and 39,936 for a crewmate.
The prompt-budget check on main fails past the budget itself, and a red run files one trim task that brings every reading back at or under its budget.
A change that would cross the budget trims first where it can.
The budget is not a second number a revision raises.
A room-restoring trim measures the same served prompt and tool schemas at both ends of the preceding fourteen days, including the sequences seed for the first mate and the largest backend/procedure case for a crewmate.
When that window crosses the fresh-history rename, read the earlier tree in the archive named by the root commit rather than shortening the window.
Report net growth, the chosen growth horizon, the restored room and the forecast's limits with the change's verification; these are measurements, not a second failing ceiling that makes the restored room unusable.
Do not raise the budgets; an overrun below the hard line spends promised conversation room only until its trim merges.
Each revision file says what its words cost, and names the one home of each rule it adds.
The test's ledger names, for every rule taken out of one text, the text that still says it: the core, a tool, a wake, or the refusal that answers the call breaking it.
The crewmate prompt follows the same homes: its tools say how `check_change`, `read_workflow`, `github_write` and `report` work, their refusals hold the repair, rerun and baseline limits, and the prompt keeps which move comes when.
`file_followup` owns filing eligibility, duplicate searches, dependencies and continuations; `note_progress` owns the plan format, `report` owns waiting and finished declarations, and `emit_card` owns completion-card shapes.
The general validation resource rule owns secret handling on every tier; the core keeps the specific Keychain consent and isolation instructions.

## What a context carries

Each input the first mate is served opens with one context, and a context carries the saved facts once per conversation, then only what changed (INF-1712, the captain on INF-1699's finding 1).
`ContextDelivery` (`src/core/orchestrator/contextDelivery.ts`) keeps what one model conversation has read, by section and by row.

- **Complete, then changes.**
  The first context of a conversation is complete: every saved section whole, with `delivery` saying so.
  Each later context carries only the sections and rows that changed since the model read them: a row section lists `changed` rows, which replace the row with the same id, and `removed` ids; a whole section is sent whole when any of it changed; `removed_sections` names a section now empty.
  An ordinary wake with nothing saved changed carries none of them.
- **The read witness moves the view.**
  What the model holds moves only when the backend reports the input read (`input_read`), never when an input is built or queued.
  An unread steer, a failed turn or a refused delivery sends its changes again in the next input.
  Two inputs built before either was read are applied in the order they were read.
- **A new conversation starts complete.**
  A fold of the conversation, a restart and a new session each reset the view, so the next context is complete again.
  An input sent before the reset and read after that complete context still counts, in read order, so a stale fact it puts back goes again in the next input.
- **The saved sections.**
  `project_scopes`, `repos` (by repo id), `crew` (by task id), `computers`, `computer_versions`, `backlog`, `open_cards` (by card id), `open_asks`, `introduction`, `schedules` (by id), `recent_fleet_outcomes`, `directions`, `surfaces`, `integrations`, `models_by_intelligence_bucket`, `quota`, `captain_time_zone`, `captain_language` and `self_source`.
  A row carries the time a fact runs from, never an elapsed time, so it changes when its fact does and never with the clock; `as_of` says when the input was read.
  `directions` is one section: when any direction changes, every current direction goes again whole under its authority line, so the model never holds part of the set.
- **The facts of one input.**
  `as_of`, `knowledge`, `captain_resolutions`, `thread_activity`, `visible_card_hint`, `about`, `focused_project` and `recovery` belong to the input they ride and are sent whenever they apply.
- **The crew lists started work.**
  `crew` lists every active task: running, idle, paused, held, and work on a computer that cannot be reached.
  Unstarted work is the `backlog` section's count per project; the `tasks` query reads it, a page at a time: a list that stops short names the `next` that alone reads its later pages from the one cut its first page took, under that page's filters, and a `next` whose cut is no longer kept, or was taken by an earlier session's tool, is refused.
  A list that stops short keeps the one cut its owner took in the same read as the first page - every matching task id, in order - and its later pages read those ids, so work started or updated between pages neither drops nor repeats a row; a page with no kept first page reads the live list.
- **A fold reads open work back.**
  After a fold, the next context carries `recovery` (`FOLD_RECOVERY`): before going on, the first mate reads `open_work`, which lists every message of the captain's not yet ended and every open card as the app holds them now, and reads one whole by `ask` or `card`.
  The messages include those still in a turn or waiting to be read, which the answer check judges only once their turn closes; `open_asks` lists them too.
  A message read whole carries its pictures as the pictures themselves, each checked against its saved copy, and a thread carries the settings the captain sent with each reply.
  A read longer than one part comes in parts of one version: each part names the next, bound to a digest of the whole, and a part of a version that changed since is refused rather than stitched to an older one.
  A fold during a turn that goes on - a retried request, a fold before the turn's next response, an input not yet read, or a backend that cannot say - steers that complete context, with its recovery, into the running turn, so it reaches the model before that response.
  That recovery goes ahead of the captain's words still queued, which keep their order, so the turn's next request reads it (`ModelSession.steerFirst`).
  A fold after the turn's last request steers nothing, since a steer would start a model request of its own; the next input carries the recovery.
  The recovery stays on each input until one carrying it is read, and its steer is never redelivered as the captain's words.
  `src/core/orchestrator/openWork.ts` reads the owners' saved records and changes nothing.

`src/core/orchestrator/contextDelivery.test.ts` and the "INF-1712" tests in `src/core/orchestrator/firstmateAgent.context.test.ts` hold it; `latestContext` in `tests/e2e/providerRequest.ts` folds a request's contexts in order the way the model reads them.

## What the served text may name

The app serves one text to every user's first mate and crewmates: the two personas' prompts, each tool's name, description and parameters, the briefs, the wakes, the kind classifier's instruction and the personal workspace's seed.
That text speaks for every project the app works on, never for this repository's own setup: its CI lanes and the Mac mini and virtual Macs that run them, its signing scripts and folders, its releases, and its tests, scripts and documents.
Those stay in `AGENTS.md`, `docs/` and `scripts/`, which a crewmate working on this repository reads before anything else, as a crewmate on any project reads that project's own instructions.
A rule every project needs is said in words every project has: the signing material a project keeps on this computer, not this repository's signing folder; the project's checks where it lives, not a workflow of ours; a project's own tests, not a file of ours.
The same boundary holds for what the host does on its own: a behavior keyed to this repository's workflow names, runners, labels or folders would be a leak, while one keyed to what any project declares - its lockfile, the workflows its host lists, its instructions - is not.
`tests/served-boundary.test.ts` holds the part that is a fact of the tree: a served text names no file this repository tracks, no workflow of its own and no `INFINITARY_` setting the app itself never reads.
Whether a sentence would read true in a project that is not this one is judged in review and measured by replay, never matched against a word list (INF-1549 removed the first such sentence, on signing inside a disposable virtual Mac; INF-1553's audit removed the rest).

## An answer's closing receipt

Every `answer-closed` receipt carries a `read` naming the exact `tasks` key; only the `next` instruction to use it is conditional.
That instruction covers any choice that files, starts or saves work by meaning, not by label: Approve and build, Start the next step and Save and defer are examples, not an allowlist.
The first mate judges what the choice authorizes under HANDOFF.
Before filing or starting authorized work it reads the saved plan with tasks by key, the standing rule in the core.
That read names the work already built on the plan (`built_on_by`), merged and dropped work included, and HANDOFF has the first mate reconcile it before filing or starting more (INF-976).
The answer-closed wake names that read when a choice just closed.
Routine acknowledgements and Abandon need no read.
The host does not parse action ids or labels into authorization.
The report may never have reached the first mate while its planner's decision card was open, so the receipt cannot assume an earlier report wake.
The context's recent choice line is a summary, not the full offer; the keyed task read remains the durable source.
Reading these typed records and filing their already-accepted work belongs to the first mate, not a retrieval crewmate.
HANDOFF still decides what the choice authorizes, and the pieces guide still decides how to reuse successors and link real prerequisites.
