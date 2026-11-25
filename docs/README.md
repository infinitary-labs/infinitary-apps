# The docs index

This folder is how Infinitary is built, checked and decided, for crewmates and contributors, and it is never published; the public help for people who use the app is in `docs-site/`.

One line per page under `docs/`, saying what the page owns.
Each page holds how the project works now, in the present tense; `primitives/README.md` lists the reusable contracts these pages compose.
Markdown in `docs/`, `primitives/` and the design skill is one sentence per line, so two edits to different sentences of a paragraph merge (`node scripts/reflow-docs.ts --write`).
`pnpm check` runs `node scripts/agent-memory.ts`, which refuses a page this index does not list and a listed page that does not exist.

## The project and its rules

- `principles.md`: the captain's standing product and build principles, in full.
- `architecture.md`: the decided architecture, its decision record (§14), the fences between layers and the sharp edges already paid for.
- `delivery-rigor.md`: rigor levels, the holds, how a change is delivered and repaired, the default rule on tests and the final report's five headings.
- `agents-reach.md`: keeping the agent's reach, the limits ledger, the override counts per hold kind and the weekly audit.
- `required-actions.md`: what only the captain can do after a merge, and after-merge steps on a change's story.
- `vocabulary.md`: the code side of the plain-language words; the rule and table are the design skill's `copy/Vocabulary.prompt.md`.
- `i18n.md`: the language fact, the message catalog, the shipped languages and translating every new word in the same change.
- `contract.md`: the published contract `contract.json`, its version rule and the scripted client.
- `infinitary-rename.md`: the names the rename from Firstmate 3000 writes and still reads, and the old-name ledger.
- `saved-data-compatibility.md`: where state lives for each build, and how saved data stays readable across versions.

## The first mate, the crew and their guidance

- `orchestrator-contract.md`: the first mate's served prompt and tools, contract revisions and what served text may name.
- `firstmate-runaway-hardening.md`: the first mate flagship model and the guards on its turns.
- `task-capture.md`: every captain ask lands in a task, and answer delivery.
- `report-sort.md`: the whose-turn rule, sorting a crewmate's report from typed state and the idle ladder.
- `inbox.md`: the durable inbox every steer and wake rides.
- `routing.md`: how a crewmate's model is chosen.
- `kind-classifier.md`: the kind classifier behind model levels.
- `decision-models.md`: the models that make the first mate's decisions.
- `sequences.md`: how the first mate works an ask through opinionated steps without a workflow engine.
- `programs.md`: programs, tasks whose steps a script decides.
- `runbooks.md`: runbooks, the bundled guidance root, typed crew reach, skill precedence and switches.
- `lessons.md`: the teach kind, the lessons guide, learner and progress files and the lesson card.
- `knowledge.md`: what the captain keeps for later work: personal context and saved references.
- `personal-resources.md`: the personal instructions and skills switch.
- `automation.md`: Automation rules the first mate runs: schedules and events.
- `integrations.md`: integrations, how every surface reaches a service outside the person's projects, and GitHub's events.
- `secrets.md`: secrets, their custody and exact-operation authority.
- `tool-repetition.md`: how repeated completed operations are noticed.
- `axi-commands.md`: task commands in a crewmate's shell, their launcher, the task channel and a shell's limit.
- `task-browser.md`: a task's own browser, which its crewmate drives.
- `files.md`: files on another computer, the files command and how a copy travels.
- `leftover-programs.md`: programs a task leaves running, registered stops and ending them at a task's close.
- `heavy-runs.md`: declared heavy runs and the load line on the computer that runs them.
- `macos-privacy.md`: macOS's question about other apps' data and the privacy watch.

## Tasks and cards

- `task-record.md`: the task as a record and the wire protocol over it.
- `task-tags.md`: a project's tags, the tags a task carries and who set each.
- `task-graph.md`: parents, links and the ready query.
- `task-retention.md`: compaction, export and the session footprint.
- `reset.md`: Reset Infinitary, which takes this computer's Infinitary back to how it was just installed.
- `card-authoring.md`: the card body contract between agents and the card surface.
- `card-threads.md`: cards as threads between the captain and the card's author.
- `card-evidence.md`: the record of what each card offered and what the captain chose.
- `live-prototype-security.md`: the sandbox review of agent-written HTML.
- `task-board.md`: the task board, its lanes, tiles and keys.
- `task-card-tabs.md`: the task card's tabs, the Crewmate tab's transcript and prompt, and Browser tabs.
- `project-focus.md`: the project focus, the top bar's project pill and what it narrows.

## The window

- `renderer.md`: renderer hot paths and the character.
- `crew-orbits.md`: the crew's orbital formation around the first mate.
- `composer.md`: the composer's keys, growth, paste and recall.
- `keyboard.md`: keyboard commands, the catalog, scopes, the resolver, command search, key hints and a new feature's keys.
- `first-launch.md`: the first launch.
- `translucent-window.md`: the translucent window and what stays opaque.
- `fonts.md`: the font choice and how it reaches every view and frame.
- `ambient-music.md`: the ambient music, its composer and player.
- `ui-plugins.md`: the UI plugin system and the app's own panels.
- `personal-panels.md`: writing panels: the library, skills, lint, build loop and switch.
- `subscriptions-tab.md`: the Subscriptions tab and the honesty rules its rows keep.
- `usage.md`: Settings → Usage and the usage ledger's models and estimates.
- `freeze-recorder.md`: the freeze recorder, its watchdog thread and the freeze journey.

## Accounts, models and quota

- `quota.md`: how quota is read, renewed, reported and derived.
- `model-lists.md`: lean model lists and what each provider's catalog becomes in the app.
- `custom-api.md`: custom API connections.
- `claude-client.md`: the Claude client the person installed, and how it is found, checked and run.
- `claude-model-probe.md`: the live Claude model-catalog probe.
- `claude-renew-probe.md`: Claude's idle refresh request.
- `codex-client.md`: using a saved Codex reset through the Codex CLI the person installed.
- `account-evaluation.md`: signed-in account evaluations, a developer tool.

## Devices and other computers

- `devices.md`: pairing, device keys and the threat review.
- `connection.md`: the connection paired devices use.
- `view.md`: the app as a view of another Mac.
- `helper.md`: running work for another computer with no window, and the one writer of each store under `userData/work/`.
- `run.md`: Infinitary started by a command with no window.
- `phone-push.md`: card pushes to a phone, and what Infinitary's relay receives.
- `ios.md`: the native iPhone and iPad reader, its checks and TestFlight.

## Projects, where they live and delivery

- `fleet.md`: how projects are set up, configured and removed, and how delivery and autonomy are enforced.
- `forge.md`: where a project lives, pull requests, saved change stories, batches and verification requests.
- `public-ci.md`: public CI admission and release credential boundaries.
- `outside-intake.md`: the weekday intake rounds that answer outside issues and pull requests, and the method each round's reader follows.

## Tests, checks and releases

- `testing.md`: the green gate, what a change runs and where, the swept batch, the size check, the prompt budget, the size check on `AGENTS.md`, and pictures of a change.
- `test-cohorts.md`: the vitest cohorts and probes.
- `e2e-contracts.md`: how a journey reads frames, keys, saved data and words through their owners.
- `replay-harness.md`: the replay harness and the interaction eval gate.
- `release-notes.md`: the release notes ledger, version tracking and the startup note.
- `alpha.md`: alpha, stable and public downloads, cutting an alpha and promoting one.
- `local-code-signing.md`: local code signing on macOS.
- `mac-installation.md`: installing and updating Infinitary on a Mac.
- `windows.md`: the Windows installer and its checks.
- `windows-private-files.md`: private files on Windows.
- `windows-feasibility.md`: observations from the Windows feasibility work.
- `linux-packages.md`: Linux packages, their recipes and clean-system checks.
- `docs-site.md`: the public docs site, how it is built, checked and published.
- `google-verification.md`: the submission copy and evidence for the Google integration's verification.

## Sharing and data

- `sharing.md`: Diagnostics and contribution, and what leaves the computer.
- `feedback.md`: `/feedback`, the issue a person reviews and publishes on Infinitary's own project.
- `dev-observe.md`: Observe, development observability in development and alpha builds.
- `provenance-capture.md`: prospective provenance capture on the task record.
- `corpus-export.md`: the corpus export.
- `miss-deriver.md`: the retrospective miss deriver.
- `dispatch-extractor.md`: the dispatch extractor.
- `supervision-extractor.md`: the supervision-turn extractor for pre-S7c archives.
- `duplicate-deriver.md`: the duplicate-candidate deriver.
- `local-orchestrator.md`: the development-only local-model orchestrator.
