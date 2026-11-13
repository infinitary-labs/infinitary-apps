# Runbooks

A runbook is a folder of guidance, not a program runtime and not a skill.
Its `runbook.json` may name a first-mate section, one crew section or several each with its own selector, a skills folder and HTML parts or pictures.
A section is plain text, either a Markdown file or a JSON string.
Delivery, Testing and Naming sections are Markdown; `node scripts/generate-runbook-fallback.ts` produces their code fallback for app and plain-Node consumers, and `pnpm check` refuses drift.
Rigor levels retains its JSON-string fallbacks, and runbooks other people made may still use JSON strings.
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
They are joined in list order - the shared `BUILTIN_RUNBOOK_ORDER` (Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs, Casual projects, Lessons, Batched pull requests, Computer cleanup, Advanced architecture), then added and personal ones - so a section names the runbook that holds a rule it relies on, never a place above or below it.
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
The card names the source, author, guidance reach and any built-in it turns off.
Adding leaves one feed line, including that replacement; the built-in stays available to turn back on.
An update cannot take a name from a different source or change a panel into a runbook.
Ask the first mate to remove an added runbook by name; the installer's remove action uses its id and removes its files and record.
Removal does not turn the replaced built-in back on or remove a separately installed panel.

An installed manifest uses the bundle's schema and additionally names `author` and `version`.
The admission reader, `checkRunbookFiles`, accepts Markdown, text, JSON, HTML, CSS and pictures as plain files, not symlinks or executable source.
Section paths stay inside the folder and name plain text; skills and parts name folders.
The same check runs when the global runbook root reads an installed folder, so an added script or escaping path on disk withdraws that runbook from reach.
The shared source fetcher's tree and byte bounds apply before admission; npm lifecycle scripts, git hooks and submodules never run.

A manifest may list relative panel folders in `panels`.
The existing panel compiler checks each folder at admission, but adding the runbook mounts no panel.
Guidance and skill roots cannot overlap these panel folders.
The installer tells the first mate where those inert sources will live after consent; adding one later uses that folder through the same installer and its separate panel consent card.
A panel's installed copy has its own record, grant and lifecycle.

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
No panel is installed just because a runbook holds panel source or parts; panels keep their own installation and consent door.

## Built-ins

Common workflows is the single switch for planning, features, bugfixes, refactors and explanations.
Its retrieval line follows INF-1441: a fact or how/why answer from what the app can read now is retrieval; comparing past runs, a reproduction, a measurement or the web is research.
Programs has its own switch, so turning Common workflows off does not remove the programs guidance.
Its first-mate guide sends a programs ask to one crewmate nudged to use `start_program`, and its `programs` skill holds the dialect, the shapes and the bound for that crewmate; turning it off serves neither, and no crewmate is served `start_program` (`docs/programs.md`, "Starting a program").
Casual projects holds the small-project setup guidance.
Lessons holds its first-mate section and the lesson skill with its tested card parts and warm voice.
Its guide points to the workspace-owned `personal-panel/parts/lesson/` template; executable panel source is not inside the runbook's guidance skill.
It declares ongoing work and a requested intelligence rather than a special task kind.
Testing rules supplies only its selected crew sections.
Rigor levels holds what each of the three care names asks (`resources/runbooks/care`): the host records Quick, Default and Careful as typed facts and selects by them, and holds nothing else on a name.
Its Default section, served at Default and Careful, carries the procedure before a pull request, the evidence-first validation and the five report headings; its Quick section says nothing beyond the project's gate and green checks is required; its Careful section points at the `careful-change` skill, which holds the independent review's order - commit, report, no push or card until the review passed - the care notice for work already built and the live validation contract; and its first-mate guide says when to commission the review, how to relay findings and when to steer the push and the card.
With no runbook reader present, the crewmate prompt serves the same bundled sections itself (`careGuideFor`, `src/core/pi/piResources.ts`), so a crewmate on a work computer or in a test is told the same.
Turning it off leaves the names on the record and serves no procedure for them.
Batched pull requests holds `batch-repair`, which repairs a held batch of the captain's own approved changes: it accounts for every failed test against every change in the batch, then sends back the changes at fault, fixes forward, or runs the failed checks again for a flake that still gets an owner (`docs/forge.md`, "Batches of your own").
It also holds the shipped queue's two skills, for a project that still carries the team queue's files: `queue-setup`, which plans the queue on a card where the captain chooses the batch's checks and then copies the stamped files the generator writes beside it (`node scripts/generate-shipped-queue.ts`, `docs/forge.md` "The shipped queue"), and `queue-repair`, which claims a paused batch's issue and fixes forward, including flakiness, or sends one change back.
Its stamped files are `.txt` because a runbook carries no executable file; they are generated, never edited by hand.
Computer cleanup supplies the first mate’s ask-first procedure and the `computer-cleanup` skill for a look on a computer short on memory or whose heavy-run line a finished task's run blocks, after the captain agrees to use their plan’s allowance.
The skill owns measurement, the leftovers card and stopping only the captain’s picks; the runbook’s `guide.md` owns the first mate’s response to pressure and line-blocked notices, including when to offer again (`docs/heavy-runs.md`).
Disabling it removes both guides through the existing instruction-refresh and new-session doors; pressure facts and the unconditional no-kill instruction remain, and already running conversations keep what they received.
Advanced architecture is an experiment and starts off (`startsOff`).
It maps a project as flat diagrams of its parts, the links between them and the state machines inside them, and shows what a change moves on that map.
A project's map lives in its own `.architecture.json` files, one per mapped folder, holding names, groups, links and machines but never files, lines or counts, which come from git each time the map is drawn.
Its first-mate guide sends "map this project" to one crewmate that opens a pull request of map files only, and "what changed since" a date, a release or a commit to one read-only answer task that shows the change view on a card.
Its crew section, served to code tasks in a project, has a crewmate in a mapped project update every map file its change makes stale in the same pull request, and add the change view to its story when the change moves something on the map: the merge card draws it live and the pull request shows a picture of it (`docs/forge.md`, "A map view").
Its `advanced-architecture` skill holds the map file format with a worked example, how to map, state machines, how to work out a comparison from git, how to draw both on a card with the map part, `parts/map.html`, whose data block is the only thing a crewmate fills, naming a JSON file the map reads through the card's bridge (`docs/card-authoring.md`, "Data by reference") when the data does not fit beside it, and whose code the app supplies by reference (`docs/card-authoring.md`, "Parts by reference"), and how to put the change view in a change's story; `parts/map.schema.json` is the map file format.
`parts/map-page.html` is the same part in a page with the app's colors, which a crewmate fills the same way, opens in its task's browser and photographs; a bare part outside a card has no colors.
The map part, its page and the app's own copy of its code are generated: `node scripts/generate-runbook-parts.ts` minifies the part's readable sources in `src/core/runbooks/parts/` into the app's parts (`src/shared/appParts.generated.json`), writes the part as its markup with its code named by reference, and the page whole with the design tokens, and `pnpm check` refuses drift, so a change is made in the sources, never in the generated files.
Commit and PR naming supplies guidance and the one naming rule the app holds (`naming` in its manifest, read by `Runbooks.naming()` from the first runbook that is on and declares one).
The rule's `pattern` and `message` are what the commit-range, story-title and forge title checks test and say; its `compose` names each commit the app writes itself, `{summary}` standing for that commit's plain summary; its `footer` picks the lines of a pull request's own text that its squash commit message carries.
The app keeps no naming convention of its own (`src/core/workspace/naming.ts`): with the built-in off and a copy or another runbook on, every name follows that runbook's rule, and with no naming runbook on nothing is checked and the app's own commits carry their plain summary.
A project's own instructions and release tooling are unchanged either way.

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

`src/core/plugins/pluginInstaller.test.ts` also drives folder, local git and npm runbooks through real host consent, replacement, skill staging, separate panel consent and removal.
`tests/e2e/installed-runbooks.spec.ts` adds and declines a runbook by keyboard, checks its persisted switches after restart, observes the served guidance and removes it by talking.

`tests/e2e/personal-runbooks.spec.ts` copies real built-in guidance through the catalog, edits the personal source, switches by keyboard, checks one replacement line and the served prompt, restarts, and restores the built-in.
