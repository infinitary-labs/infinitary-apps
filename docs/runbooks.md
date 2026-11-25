# Runbooks

A runbook is a folder of guidance, not a program runtime and not a skill.
Its `runbook.json` may name a first-mate section, one crew section or several each with its own selector, a skills folder and HTML parts or pictures.
A section is plain text, either a Markdown file or a JSON string.
Delivery, Testing and Naming sections are Markdown; `node scripts/generate-runbook-fallback.ts` produces their code fallback for app and plain-Node consumers, and `pnpm check` refuses drift.
Rigor levels retains its JSON-string fallbacks for its care sections, and runbooks other people made may still use JSON strings.
Skills inside it use the Agent Skills format and are read on demand.
The host does not decide which subject an ask belongs to.

## Serving and switches

`Runbooks` in `src/core/runbooks/runbooks.ts` reads the app bundle's `resources/runbooks` root through the existing self-source location, the installer's committed runbook folders and the personal workspace's `runbooks/` folders.
`SettingsStore` owns the saved on/off map; an absent entry is on, so an update's new built-ins start on, unless the manifest declares `startsOff`.
A runbook that ships as an experiment declares it, and stays off on a fresh install and after the update that brings it until its switch turns it on; turning it on saves the entry like any other switch.
Settings → Runbooks sits immediately after Intelligence and shares its visibility rules.
Built in lists the bundled runbooks; Yours lists installed and personal ones, including an unreadable folder with its reason and no switch.
Each valid row has its manifest's name and description, a keyboard-operable switch and save feedback.
Runbook rows carry optional source and error fields (`runbookViewSchema`, `src/shared/runbooks.ts`).
A built-in's View button opens a fresh read-only copy in a private temporary folder, never the signed app's own files.
Its label on pointer rest or keyboard focus tells the person to ask the first mate to customize it.
Open folder creates the personal runbooks folder if needed and opens it through a local host request using `shell.openPath`; that request accepts only a built-in identity or the personal folder, never an arbitrary path.
Only the computer holding the first mate's folders opens them; a controlling computer's folder row instead names that computer.
Open Runbooks and Open your runbooks folder are commands without default keys.
Make your own gives short examples of what to ask the first mate, not a hand-written format or an in-app editor.
The first mate reads the same list and changes it through `app_state` and `app_change runbook`, an asked catalog action.
The dispatcher owns the attributed feed line, named from the manifest rather than an internal identifier, and does not report unchanged writes as changes.
The manifest may declare a replacement; enabling it turns the named runbook off in the same saved update.
Adding a runbook from elsewhere uses the existing installer; personal copies use the same guidance reader and switches.

Enabled first-mate sections go through the appended-instructions door at each idle boundary, with `instructions_sha` over the exact joined text.
They are joined in list order - the shared `BUILTIN_RUNBOOK_ORDER` (Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs, Casual projects, Lessons, Batched pull requests, Pull request comments, Heartbeat, Computer cleanup, Moving secrets in, Feedback, Advanced architecture), then added and personal ones - so a section names the runbook that holds a rule it relies on, never a place above or below it.
Runbooks are outside the first mate's hard fixed-context budget; the model's physical context window still applies.
A switch affects the first mate's next idle boundary and newly opened crew conversations, not a prompt already running.
No procedure is refused for exceeding the core budget.

## Adding and removing

Ask the first mate to add a runbook from a full folder path, a git address (optionally pinned with `#ref`) or an npm package.
`PluginInstaller` uses the existing source fetcher, plain-file copy and source pin, staging records and host consent effects.
A top-level `runbook.json` chooses guidance admission rather than panel compilation; `PluginRecords` owns both kinds in the same table and installed folder root.
Existing saved records remain panels.
Nothing is served until the captain chooses Add it on the host's card; Don't add declines and removes the staged files.
Putting the card aside keeps the staged offer pending without serving or declining it.
Every runbook update asks again, because new guidance or a different replacement changes what the agents follow even when no panel grant changes.
The card leads with the runbook's description, then labeled rows: From (its author and the whole source), Reaches, Turns off for a built-in it replaces, and Shows a panel or Shows panels ("Panels" below).
One quiet line under the rows says it runs nothing, or, with panels, that adding it agrees to them and that they run no code of their own and send nothing off this computer.
The rows are `runbookConsentBody` in `src/core/plugins/consentWords.ts`, each label and line a catalog message.
Adding leaves one feed line, including that replacement; the built-in stays available to turn back on.
An update cannot take a name from a different source or change a panel into a runbook.
Ask the first mate to remove an added runbook by name; the installer's remove action uses its id and removes its files and record.
Removal does not turn the replaced built-in back on or remove a separately installed panel.

An installed manifest uses the bundle's schema and additionally names `author` and `version`.
The admission reader, `checkRunbookFiles`, accepts Markdown, text, JSON, HTML, CSS and pictures as plain files, not symlinks or executable source.
Section paths stay inside the folder and name plain text; skills and parts name folders.
The same check runs when the global runbook root reads an installed folder, so an added script or escaping path on disk withdraws that runbook from reach.
The shared source fetcher's tree and byte bounds apply before admission; npm lifecycle scripts, git hooks and submodules never run.

## Panels

A manifest may list relative panel folders in `panels`, and a runbook that is on shows them on the rails; turning it off takes them away.
Guidance and skill roots cannot overlap these panel folders.
A runbook's panel has the id `<runbook>-<folder name>`, where a runbook that replaces a built-in uses the built-in's id, so a copy keeps your place for the built-in's panel.
That id is for the rails, the layout and commands; a runbook's panel keeps its saved data and its integration asks under its own runbook's id and folder (`runbookPanelSlice`), so a panel that shares its shown id never reads or loses its data.
`Runbooks.panels()` lists the on runbooks' panels, and `PersonalExtensions` adds them as a third root beside your panels and added ones (`src/core/personal/framedPanels.ts`).
They are drawn in a frame like an added panel, with source `installed`, the runbook's name as `by` and its id as `runbook`, and run no code of their own in the app: a `server.ts` mounts nothing.
A panel of your own or an added one keeps its id; a runbook's panel with a taken id, or a folder name that cannot name a panel, is left off, named once in the panel log, and listed with its reason among the window's refused panels (the snapshot's `refused` list), on a row of its own beside the panel that keeps the id.
A runbook's panel the core will not serve, such as one with background code or one nobody agreed to, is answered refused with that reason too.
The first mate's surfaces name each runbook's panel by its runbook and list the ones left off, a view of another Mac lists them among its refused panels too, and a list past its bound (`PERSONAL_REFUSED_MAX`, `PANEL_MOUNTS_MAX`) leaves out refused runbook panels, never a drawn one.
A personal runbook's panel is served what its manifest asks, as your own panels are.
An added runbook's panels are agreed on its own add card: under Shows panels the card names each panel with one line for what it reads, each integration it uses, whether it moves tasks and each setting it may change, and Add it records those grants on the runbook's record (`plugins.panels_json`).
The exact names it reads, each integration's rule and reason, the moves and settings fine print and what each panel keeps sit under the card's Full details, as on a panel's own card.
A panel whose files on disk ask for more than was agreed, or one with no recorded agreement, mounts nothing and says to add its runbook again.
Settings → Runbooks names a runbook's panels under its switch.
An added runbook is read only under its record's id: files changed to name another runbook are listed as not available, never served under that one's agreement.
Removing an added runbook clears every slice of saved data its id owns, whatever its files list now; asking the first mate to remove a runbook's panel answers that its runbook's switch takes it away.
The same folder can still be added as a panel of its own through the installer's separate panel card, with its own record, grant and lifecycle.

### Built-in panels

A built-in runbook's panels are the app's own: each folder is listed in `RUNBOOK_FRAME_PANELS` (`src/shared/plugins/frameLib.ts`) and in `APP_PANEL_FOLDERS`, and the main build compiles it into the frame lib with the folders under `src/panels/`, under the id `<runbook>-<folder>` (`builtinPanelSource`).
The first is Batches, the Batched pull requests runbook's `panel` folder (`docs/forge.md`, "The Batches panel").
`Runbooks.panels()` leaves a built-in's panels out; each waits instead on its runbook's gate, `runbook-<id>`, open while that built-in is on (`runbookGate`, `runbookGatesOf`, `src/shared/surfaces.ts`), which the window asks at start, after each `runbooks_changed` and when a view's first mate comes back in reach ("A folder that waits on a gate" in `docs/ui-plugins.md`).
Whether the panel then takes room on its rail is the panel's own choice, as for any panel.
A built-in panel's words are catalog messages under `src/shared/i18n/messages/<language>/`, compiled into a `messages.generated.ts` beside it (`RUNBOOK_PANEL_DIRS`, `scripts/generate-messages.ts`), which is never committed.
Making the runbook yours copies that compiled file with the folder, from the source in development and from the self-source in a packaged build (`scripts/generate-self-source.mjs`), so the copy builds as a runbook of yours with the words of every language.
The copy keeps the built-in's panel id, and turning it on turns the built-in off, so its own panel shows in the built-in's place.

## Making a new runbook

Ask the first mate for lasting guidance or a skill for every crewmate.
The core operate paragraph routes this to a crewmate on the personal workspace, even when Common workflows is off.
A skill for only one project stays in that project.
The workspace's instructions point runbook work at its seeded `runbooks` skill, the one home of the manifest, Markdown sections, selectors, skills and plain-file format.
`AUTHORING_SKILL_IDS` includes this skill so boot seeds and refreshes it beside the other workspace skills.
A newly authored folder under the workspace's `runbooks/` is on at the next read, because absent switches are on, unless the captain asked for it to start off and its manifest declares `startsOff`; there is no extra installer consent for work the captain asked the crewmate to write there.
Customizing a built-in still starts through the copy action below, which leaves the copy off.

## Making a built-in yours

Ask the first mate to copy a built-in runbook, with a new name and unused id.
The asked `runbook-copy` catalog action copies its whole folder into `runbooks/<copyId>/` in the personal workspace and returns that editable path in the runbook list.
The copy's manifest keeps its sections, selectors, skills, parts and naming rule, gives it its own identity, and names the built-in in `replaces`.
The copy starts off, so copying alone changes no served guidance.
Existing ids and folders are never overwritten, and a linked personal runbooks root is refused.

Edit the copy's files in the personal workspace, directly or through a crewmate working there.
The global reader validates these plain folders on every read, through the same guidance-only boundary used for installed runbooks.
Unlike an installer snapshot, the personal folder is the served source: edits reach the next idle boundary or new crew conversation without reinstalling.
The app never rewrites personal copies on startup or update.

Turn the copy on in Settings → Runbooks or ask the first mate.
The existing replacement switch turns the built-in off in the same saved update and leaves one feed line naming both runbooks.
The built-in stays available and unchanged; to restore it, turn the copy off and the built-in on.
Turning the copy off does not automatically restore the built-in, and turning the built-in on does not turn other runbooks off.
An invalid personal folder supplies no guidance until repaired; the saved switches remain as they were.

## Typed crew reach

A crew section's manifest selectors match only the kind, project or personal place, delivery, care, backend and project id already known at dispatch.
Each supplied selector must match; an omitted selector is unrestricted, and an empty selector matches nothing.
The kinds selected by the testing runbook are data: plan, reproduce, implement, fix and chore on a project.
Research, retrieval, review and the personal workspace receive none of that section.
A runbook's optional projects list restricts its crew reach by project id.
Its skills remain available on demand throughout that reach, independently of the narrower crew-section selectors.
A manifest with several crew sections serves each one whose selector the facts match, in manifest order, so one runbook says one thing at Quick and another at Careful.

The first mate declares the kind on spawn or create, and the task records `firstmate:declared` as its source.
A declaration uses the existing answer/change kind branches from INF-1441; the read-only fact still decides what the task delivers.
Undeclared work keeps the classifier path and its existing deliverable restriction.
The host no longer compares a relayed plan line's text to decide its kind.

The crew section enters the prompt through the crew preset and the existing prompt builder.
Project skills win a name, then opted-in personal skills, then runbook skills.
Plain skill files travel in the work session specification, so a work computer stages its own files instead of receiving an unusable path on the home computer.
Every work computer on the Secrets major supports these skills, and the existing work-major boundary refuses an older computer before it receives the task.
Pi lists them through its existing resource loader, and Claude stages them through its existing explicit local-skill plugin door with settings sources off.
Each session writes them in a staging folder of its own beside its record, so no session removes the files another open session of the task still reads (`src/core/session/stagingFolders.ts`, INF-2054).
HTML parts stay beside their skill and can be read through the same file access.
Only the folders a manifest lists in `panels` show as panels; panel source or parts anywhere else in a runbook show nothing.

## Built-ins

Common workflows is the single switch for planning, features, bugfixes, refactors and explanations.
Its retrieval line follows INF-1441: a fact or how/why answer from what the app can read now is retrieval; comparing past runs, a reproduction, a measurement or the web is research.
Programs has its own switch, so turning Common workflows off does not remove the programs guidance.
Its first-mate guide sends a programs ask to one crewmate nudged to use `start_program`, and its `programs` skill holds the dialect, the shapes and the bound for that crewmate; turning it off serves neither, and no crewmate is served `start_program` (`docs/programs.md`, "Starting a program").
Casual projects holds the small-project setup guidance.
Lessons holds its first-mate section and the lesson skill with its tested card parts and warm voice.
Its guide points to the workspace-owned `personal-panel/parts/lesson/` template; executable panel source is not inside the runbook's guidance skill.
It declares ongoing work and a requested intelligence rather than a special task kind.
Testing rules supplies only its selected crew sections: the six words on tests to plan, reproduce, implement, fix and chore tasks on a project, and a review section (`review.md`, selected by `kind: review`) that makes a test the change adds or edits, or any test in a test file it edits, a finding when it cannot fail - its expected value computed by the code under test, its assertion on what a stand-in was set to return, or no assertion at all - and a new or edited test the builder did not show failing once a finding too; a project's own rule on tests wins over it.
Rigor levels holds what each of the three care names asks (`resources/runbooks/care`): the host records Quick, Default and Careful as typed facts and selects by them, and holds nothing else on a name.
Its Default section, served at Default and Careful, carries the procedure before a pull request, the evidence-first validation, the five report headings and which code comments to write (only a decision record, never a tautology, an excuse or a stale comment); its Quick section says nothing beyond the project's gate and green checks is required; its Careful section points at the `careful-change` skill, which holds the independent review's order - commit, report, no push or card until the review passed - the care notice for work already built and the live validation contract; and its first-mate guide says when to commission the review, how to relay findings and when to steer the push and the card.
Its review section (`review.md`, selected by `kind: review`) reaches every independent review, which carries no care of its own: it makes a useless comment the change adds, edits or makes untrue a finding, and an excuse comment's shortcut the finding; a project's own rule on comments wins over it.
With no runbook reader present, the crewmate prompt serves the same bundled care sections itself (`careGuideFor`, `src/core/pi/piResources.ts`), so a crewmate on a work computer or in a test is told the same; the review section has no such fallback.
Turning it off leaves the names on the record and serves no procedure for them.
Batched pull requests holds `batch-repair`, which repairs a held batch of the captain's own approved changes: it accounts for every failed test against every change in the batch, then sends back the changes at fault, fixes forward, merges a version that passed on a rerun, or runs the failed checks again for a flake that still gets an owner (`docs/forge.md`, "Batches of your own").
Its id is `batches`, and a person who turned it off under its earlier id, `queue`, keeps it off (`SettingsStore.getRunbookStates`).
It starts off (`startsOff`), and its manifest's `offers` names `batched-pull-requests`: a project may newly choose batched pull requests only while a runbook that is on offers them.
`offers` is a closed list the host can read (`RUNBOOK_OFFERS`, `src/shared/runbooks.ts`); the host asks whether any enabled runbook offers a choice (`Runbooks.offers`), never which one, so a personal copy keeps it.
Each project's view carries the answer as `batchesOffered`, and Settings → Projects lists batched pull requests and names them under Where changes go only while it holds or the project already uses them (`deliveryChoices`, `src/shared/repos.ts`).
While none offers them, choosing them in Settings, through the first mate's `project-settings` or in a setup proposal is refused with a reason that says where to turn the runbook on; a batched project's other settings still change.
Each start turns the built-in on, quietly, when a project is on batched pull requests and no enabled runbook offers them (`Runbooks.keepOffersInUse`), so a person already batching keeps the choice after the update that started it off.
Turning a runbook off is refused while that would leave a choice a project uses unoffered, naming each such project.
Pull request comments starts off (`startsOff`) and is one switch for every project.
While on, it serves its crew section to a crewmate whose change goes through a pull request (`direct-pr`, `queue-pr`) and its first-mate guide, and its manifest's `wakes` names `pull-request-comments`, which asks the host to read new comments on each followed pull request and wake its crewmate (`docs/forge.md`, "Comments on a pull request").
`wakes` is a closed list the host can read (`RUNBOOK_WAKES`, `src/shared/pullComments.ts`); the host asks whether any enabled runbook names a wake (`Runbooks.wakes`), never which one, so a personal copy keeps it.
A switch reaches only newly opened crew conversations, so the host sends the wake only to a crewmate whose conversation was served a section that asks for it (`Runbooks.crew`'s `wakes`, kept on the task as `servedWakes`).
The crew section holds every judgment: how to sort a comment as a clear fix, a choice for the captain or nothing to do, what each author's relation allows, how to reply and sign it, and what it never does on GitHub.
Heartbeat starts off (`startsOff`) and is one switch for the whole app.
Its manifest's `wakes` names `heartbeat` (`HEARTBEAT_WAKE`, `src/shared/heartbeat.ts`), and the host asks only whether an enabled runbook names it: while one does, the host keeps the heartbeat rule in Automation, and once none does it removes it (`docs/automation.md`, "The heartbeat").
Its first-mate guide holds every judgment about a beat: what to do with each row marked new, the one heartbeat card, and the Found line that ends each beat, with no tool call when no row is new.
Computer cleanup supplies the first mate’s ask-first procedure and the `computer-cleanup` skill for a look on a computer short on memory or whose heavy-run line a finished task's run blocks, after the captain agrees to use their plan’s allowance.
The skill owns measurement, the leftovers card and stopping only the captain’s picks; the runbook’s `guide.md` owns the first mate’s response to pressure and line-blocked notices, including one offer per memory warning ID and when to offer again (`docs/heavy-runs.md`).
Disabling it removes both guides through the existing instruction-refresh and new-session doors; pressure facts and the unconditional no-kill instruction remain, and already running conversations keep what they received.
Moving secrets in holds only the `bring-secrets` skill, with no first-mate or crew section, so no session is served its guidance: a crewmate opens it when its task moves secrets from another tool into Secrets, and reads only the recipe file for that tool (`docs/secrets.md`, "How a move starts").
Feedback supplies the first mate's guide for a `/feedback` request, which starts one feedback task at once with no card, and the `feedback-report` skill, the crewmate's drafting procedure (`docs/feedback.md`).
Advanced architecture is an experiment and starts off (`startsOff`).
It maps a project as flat diagrams of its parts, the links between them and the state machines inside them, and shows what a change moves on that map.
A project's map lives in its own `.architecture.json` files, one per mapped folder, holding names, groups, links and machines but never files, lines or counts, which come from git each time the map is drawn.
Its first-mate guide sends "map this project" to one crewmate that opens a pull request of map files only, and "what changed since" a date, a release or a commit to one read-only answer task that shows the change view on a card.
Its crew section, served to code tasks in a project, has a crewmate in a mapped project update every map file its change makes stale in the same pull request, and add the change view to its story when the change moves something on the map: the merge card draws it live and the pull request shows a picture of it (`docs/forge.md`, "A map view").
Its `advanced-architecture` skill holds the map file format with a worked example, how to map, state machines, how to work out a comparison from git, how to draw both on a card with the map part, `parts/map.html`, whose data block is the only thing a crewmate fills, naming a JSON file the map reads through the card's bridge (`docs/card-authoring.md`, "Data by reference") when the data does not fit beside it, and whose code the app supplies by reference (`docs/card-authoring.md`, "Parts by reference"), and how to put the change view in a change's story; `parts/map.schema.json` is the map file format.
`parts/map-page.html` is the same part in a page with the app's colors, which a crewmate fills the same way, opens in its task's browser and photographs; a bare part outside a card has no colors.
The map part, its page and the app's own copy of its code are generated: `node scripts/generate-runbook-parts.ts` minifies the part's readable sources in `src/core/runbooks/parts/` into the app's parts (`src/shared/appParts.generated.json`), writes the part as its markup with its code named by reference, and the page whole with the design tokens, and `pnpm check` refuses drift, so a change is made in the sources, never in the generated files.
The same generator bundles the app's own stage part, which no runbook offers, from `src/renderer/src/character/stage/` into that file (`docs/card-authoring.md`, "The app's own stage").
The map's script is one closure kept in four source files joined in order (`map.js`, `map.layout.js`, `map.draw.js`, `map.input.js`), listed as the part's `fragments` in that script; they are pieces of one function, so Biome skips them and the generator's minifier parses the joined script.
Commit and PR naming supplies guidance and the one naming rule the app holds (`naming` in its manifest, read by `Runbooks.naming()` from the first runbook that is on and declares one).
The rule's `pattern` and `message` are what the commit-range, story-title and forge title checks test and say; its `compose` names each commit the app writes itself, `{summary}` standing for that commit's plain summary; its `footer` picks the lines of a pull request's own text that its squash commit message carries.
The app keeps no naming convention of its own (`src/core/workspace/naming.ts`): with the built-in off and a copy or another runbook on, every name follows that runbook's rule, and with no naming runbook on nothing is checked and the app's own commits carry their plain summary.
A project's own instructions and release tooling are unchanged either way.
Its guide, served to the first mate and to code crewmates, also says in words how a task's branch is named: the built-in says `inf/` and a few lowercase words saying what the work does, and a turned-on copy says what its own guide says, with no pattern for the app to read.
The first mate writes the name as the task's `branch` when it files or starts the task; the app adds a short code from the task's id, names a task left unnamed `inf/` and its title's slug, and refuses only a name git would refuse or one under its batch branches (`docs/architecture.md`, "A task's branch").

Runbook guidance may decide author choices on the cards it describes, such as voice, length, layout, opening and button names.
The fixed card shape, merge authorization, consent, delivery and care facts remain core.
Delivery judgment supplies only crewmates on pull request delivery (direct-pr or queue-pr) with the checks, repair, readiness and stopping guidance.
Its switch removes those judgments from new crew prompts without changing check facts, merge authorization, consent or the care names on the record.
The host tools carry check facts and record declarations; the runbook holds the judgments, including when repairs stop: once an attempt shows nothing new, with no fixed count.
The panel-building runbook was not selected, so those skills and the design skill stay workspace-owned.

## Checks

`src/core/runbooks/runbooks.test.ts` drives real bundle manifests, persisted switches, typed reach, naming and staged skill parts.
`tests/e2e/runbooks.spec.ts` switches Common workflows by keyboard, relaunches, and asks the first mate to turn it back on through the shared catalog; it also finds every runbook that starts off listed and off.
`tests/browser/architecture-map.test.ts` draws the shipped map part, filled with this project's own map files and two comparisons from its history, in a card's frame with its code put in place of its reference as the window does, and refuses overlapping boxes and labels at every level and machine, in both themes; it also checks the map's keys, a two-row footer at most 80 pixels tall at a desktop card's width and 100 at a phone's, that a plain scroll over the map is the card's while a pinch or ⌘-scroll zooms it, that Full screen, F and a tap on a touch screen send the whole drawing to the picture viewer where the host offers no full screen, and otherwise ask for the live map at the card's place, comparison and choice, that the full-screen copy opens at that state, fills its window, moves on a plain scroll, a finger or a pinch, says where it goes and leaves Escape to the app, that the card's map goes where the copy was left, that the arrows under the drawing step through each change and wrap with the full list under More, that a click anywhere inside a dashed box chooses it, a packed data block, and the change view's tags and counts, including a removed state machine, outside boxes, a removed outside box's links, switching comparisons and a card that opens at a removed machine or part, that the map gives its card no answer to send, and that a double-click goes in without selecting a box's words, and that a data block naming its file draws the same map from the bridge's answer and lists a problem when the file cannot be read.
`src/core/runbooks/mapPart.test.ts` holds the filled map part, and the part naming its data file once the host keeps it, to the card body limit and a crewmate card's checks, and `tests/e2e/architecture-map.spec.ts` drives a map card whose data is a kept file in the window by keys: into a state machine, back out, and through a comparison.
The fixed-context test measures the core with the bundled care, testing and delivery sections the prompt serves itself when no runbook reader is present, the same text the built-ins hold.
The existing lesson and workflow journeys cover the guidance's consumers.
The replay gate and the signed-in evaluations serve the bundled runbooks through their shared isolated host (`scripts/replay/isolatedHost.ts`), as a fresh app does; `tests/eval-host-runbooks.test.ts` holds that for the evaluations.

`src/core/plugins/pluginInstaller.test.ts` also drives folder, local git and npm runbooks through real host consent, replacement, skill staging, its panels' agreement on the add card, separate panel consent and removal.
`src/core/personal/personalExtensions.test.ts` mounts a runbook's panels under its name, lets your own panel keep its id, and mounts nothing unagreed or with code.
`tests/e2e/runbook-panel.spec.ts` turns a personal runbook on and off by keys in Settings and finds its panel and its command come and go.
`tests/e2e/installed-runbooks.spec.ts` adds and declines a runbook by keyboard, checks its persisted switches after restart, observes the served guidance and removes it by talking.

`tests/e2e/personal-runbooks.spec.ts` copies real built-in guidance through the catalog, edits the personal source, switches by keyboard, checks one replacement line and the served prompt, restarts, and restores the built-in.
