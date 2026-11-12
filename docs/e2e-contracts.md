# Electron fixture contracts

The isolated desktop host binds `HostCapabilities.keychain` to `absentKeychain` before any reader is constructed (`createDesktopKeychain`, `src/main/host/electronKeychain.ts`).
No journey can discover the real Claude item through service-only fallback, whatever its `USER`; `electronKeychain.test.ts` exercises both lookup forms and refuses any attempted child launch.
Native Keychain proof instead names a disposable store explicitly in `claudeKeychainAccess.integration.test.ts`.

## Truthful fixtures

How this project's stand-ins stay truthful (scout `fm3000-e2e-rigidity-s2`, section 7).
A stand-in for something outside the app (GitHub, a provider, the first mate's model, the Claude client) is a coherent version of that thing, not a shortcut the product happens to accept today.
A real guard that grows stronger then meets the same valid input it meets in use.

- **A happy path satisfies the real input contract.**
  Heads exist in the task branch's own git history, a pull request carries the title and body it was opened with, a provider object is complete, and a save point follows the naming runbook.
  The GitHub stand-in and the save-point helpers below keep that for forge and personal work.
- **A stand-in is tested through its real producer and consumer.**
  `tests/githubStub.test.ts` drives the stand-in through the app's own forge.
  `tests/mockProvider.test.ts` drives the HTTP mock with requests the product rendered (`captainCardChoice`) and asserts the tool call it answers with, the task it names, or the refusal.
  Neither asserts a source token or a snapshot of the fixture's code.
- **A scripted tool call is typed against the live tools.**
  Every call a stand-in model makes (`ScriptedCall`, `tests/helpers/scriptedCalls.ts`: the mock provider, `scriptFirstmateTurn`, the Ollama fixture through `nativeCall`, the Claude seat harness) takes its name and arguments from the tools the app actually serves - the first mate's as `FirstmateAgent` builds them, `CREWMATE_TOOLS`, the coding builtins - and an `app_change` value from its action-catalog line.
  A retired tool, argument or action fails `pnpm typecheck` in the PR checks, not only the Mac e2e run.
  Write a call where the type reaches it (a typed array, `satisfies ScriptedCall`), never as a widened `{ name: string }`.
- **A deliberately invalid input is its own named refusal test.**
  A wrong or missing title, a head this Mac lacks, a moved head and failing checks each have a case in `settle-effects.spec.ts` and `tests/githubStub.test.ts`, never an accidentally malformed happy path.
- **A request the script does not recognize fails in a way that names it.**
  A scripted first mate turn that never matches prints the inputs the first mate was served instead, rather than vanishing behind a downstream timeout.
- A change to a contract a fixture produces or consumes changes the fixture in the same PR, and the fixture's own test and the journeys that use it are among the tests that change runs.

## A signed-in Claude home

INF-2394 measure 1 gives the Claude stand-in one owner for a signed-in home: `signedInClaudeHome` in `tests/e2e/mockClaudeClient.ts` writes both the client's marker and the credential file the product reads.
A connected-account journey calls `launchSignedInClaude(accountId, options)` in `tests/e2e/claudeAccount.ts`, which prepares the home, runs the journey's remaining preparation, launches and asserts the account through `expectClaudeConnected`.
The wrapper closes the app if that prerequisite fails.
A Claude seat relaunch preserves the credential a journey changed instead of replacing it with a fresh sign-in.
A journey about a missing or outdated client, a login not yet registered in the app, or background work without the window uses `signedInClaudeHome` directly and checks its own readiness or registration outcome.
A quota journey passes its token and expiry readings to that same owner, never composes a second credential file.
The fifth rule in `scripts/lint-e2e-frames.ts`, `e2e-claude-store-owner`, refuses component seed calls and filesystem writes under the Claude store in journey files, following destination aliases and imported filesystem aliases.
An intentional store mutation, such as a partial credential rewrite, a changed login stamp or a removed client transcript, keeps `// e2e-claude-store: mutation -- <reason>` on the write's line or the preceding line.
The exception names a mutation the journey proves, never an ordinary sign-in seed.

## Filesystem fixture owners

INF-2394 measure 4 keeps filesystem-shaped stand-ins in imported owners, not in a journey's launch callback or another copy of a saved-file envelope.
An owner declares the product reader it stands in for with `@journey-area src/path/` in a documentation comment; a trailing slash names a directory and otherwise the path names one file.
The declaration is the same one the journey selector reads, so moving a product reader also reaches the stand-in's callers.
`prepareHome` takes an imported declared owner or a call to its factory, including when a journey composes its token, identity or expiry inputs.
The journey still owns its scenario values, enabled accounts, timestamps, authored messages and expected user result.

| Saved input | Fixture owner |
| --- | --- |
| Vault registry, account directories, Pi auth envelopes and the mock model catalog | `tests/e2e/accountFixtures.ts` |
| Claude tokens, account identity, model-list replies, renewal/login client scripts and client settings | `tests/e2e/mockClaudeClient.ts` |
| Shell startup, clone redirection and personal home resources | `tests/e2e/homeFixtures.ts` |
| Finished quota snapshot and model-catalog files | `tests/e2e/quotaFixtures.ts` |
| Crew session placement and transcript serialization | `tests/e2e/transcriptFixtures.ts` |
| Personal workspace placement and panel fixtures | `tests/e2e/personalFixtures.ts` |
| Predecessor/future profile formats, retired stores and installer markers | `tests/e2e/savedDataFixtures.ts` |
| A paired computer reached from elsewhere | `tests/e2e/deviceFixtures.ts` |
| Staged card media directories | `tests/e2e/cardFixtures.ts` |
| Isolated service-manager behavior and retained sign-in sentinels | `tests/e2e/workFixtures.ts` |

The existing fixture helpers for Claude seats, GitHub, GitLab, knowledge, older profiles, project origins, card revisions, usage and crew rosters also declare their product readers.
`e2e-fixture-owner` in `scripts/lint-e2e-frames.ts` checks journey files and their helpers, not unit files.
It refuses a home/user-data byte writer, copier, link, rename, deletion or metadata mutation outside a declared owner, and an exported seed/mock helper without an owner declaration.
It also refuses a quota `snapshot.json` written outside a declared owner, wherever its folder lives: a journey passes its reading, and its catalog when it needs one, to `seedQuotaFixture`, which checks both against the reader's schemas.
It follows imported filesystem aliases, namespace calls and scoped path aliases rooted in the launcher's home/user-data naming contract; it checks a copy's destination and both sides of a rename, never the write's payload.
The account vault's own `accounts` folder counts under any data folder, whatever the variable naming that folder, so a helper's `dir` parameter is held to the account owner as `userDataDir` is.
Empty directories have no saved-file envelope, and files under explicit `worktrees` or `workspace` path segments are authored project input rather than app-owned saved formats.
A journey authoring another project input or evidence artifact names that input beside its write with `// e2e-fixture: input -- <reason>`.
A journey proving an external mutation, such as corrupted data, missing media, changed trust or deleted window caches, keeps `// e2e-fixture: mutation -- <reason>` beside that mutation.
The narrower Claude mutation annotation also applies; an empty reason or file-wide comment never exempts another write.
These annotations do not waive assertions or permit an ordinary saved-state seed outside its owner.
This is a lexical fence, not interprocedural dataflow or a judgment that a test meets the six words.
The reading pass still checks intent, realistic inputs, a describable failure, layer, ownership and gate.
`tests/e2e-fixture-owners-lint.test.ts` exercises refusals and ownership, and `tests/e2e-fixture-data.test.ts` drives the account, quota and session readers against the owned output.

## Reading task state

Construct `TaskService` only while the fixture app is stopped: its constructor performs boot recovery writes, including interrupting active turns.
A poll against a running app uses typed IPC or an existing reader, never a new `TaskService`.
`dependency-wait.spec.ts` constructs its service before launch and keeps its observation connection under `PRAGMA query_only` while the app runs; only the offline recovery setup may write.
This guard catches accidental observer writes directly, rather than waiting for a database-lock race under parallel load.

## Context and feed assertions

- Decode the HTTP JSON, then the served context segment, then TOON (`tests/e2e/providerRequest.ts`).
  Never match escaped context bytes in a request body.
  `latestContext` folds every context the request carries, in order, the way the model reads a complete context and then its changes; the result is authoritative, including an empty board.
- Assert the decoded crew entries and backlog counts; unstarted work is read with a `tasks` call, as the first mate reads it.
  Keep the database, UI, workspace-removal and request-delivery assertions.
- A feed report is the first sentence, capped at 120 characters.
  The full report opens from its line in the task record's Activity.
  Use `reportSummary` for that view.
- Exact copy stays in `taskFeed.test.ts` and `feed.test.ts`.
  A workflow test asserts the lifecycle, not a copied phrase.
- Await the actual no-inner-overflow invariant across the resize chain.
  Do not wait on an arbitrary height threshold.

## Named save points in forge and personal fixtures

The GitHub stand-in (`tests/e2e/githubStub.ts`) is a coherent external system, checked through the app's own forge by `tests/githubStub.test.ts`.
A change carries the title and body it was opened with (`open_change`) or served with (`servePull` names both); the stand-in never makes one up.
Its head is the task branch's own commit, read live through `headOf`, so a later push moves it.
A merge is GitHub's squash at the head the app asks for, recorded with its title and message (`merges()`), and refused with 409 when the head moved on since (`onMergeRequest` lands such a push), or with 405 for a head `conflicts` names as in conflict with newer work.
The mergeability read by number initially says clean, as GitHub's can lag; after a 405, reads of that head report the known conflict until it is resolved, so an idle boundary during a background repair does not request the same refused merge again.
`headSha` and `setHead` name heads only for a change whose checks are read and that is never put in.
A wrong or missing title, a head this Mac lacks, a head that moved, or failing checks is a named refusal case (`settle-effects.spec.ts`), never an accidentally malformed happy path.
Personal workspace reports remain unmodified in the task record, while a report the naming runbook would refuse gets the runbook's `compose` form in git history (`chore:` under the built-in).
A journey asserts what the save point promises (`tests/e2e/savePoints.ts`): exactly one new save point, named so the host's own guard (`requireNamed`, under the bundled naming runbook a journey's app runs with) accepts it, touching the intended files and carrying the report, with nothing left unsaved.
The exact subject belongs to the unit tests that compose it (`panelInstructions.test.ts`, `liveWorkspace.test.ts`, `personalExtensions.test.ts`), never to a journey.

## Scripted first mate turns

The served frame carries each segment's kind, origin and body, never a card choice's typed facts, so the mock never recovers a choice from its words.
A spec that needs the first mate to answer a known input scripts it ahead: it reads the card and its action off `window.infinitary.cards.list()`, renders the expected segment with `captainCardChoice` (the product's own `renderWake` and `frameServedInput`, `tests/e2e/providerRequest.ts`), and registers it with the calls to answer with (`scriptFirstmateTurn`).
The mock decodes each request's newest served input in every dialect it serves (`latestServedTurn`: chat completions, Anthropic messages, Responses input) and answers only a segment equal in kind, origin and body.
History, a same-titled card on another task, and a wake that carries the captain's words never match.
The outcome is the spec's checkpoint (`armed`, `answered`, `closed`), and a miss prints the inputs the first mate was served instead.
A rewording of the wake needs no test edit.
The Careful journey's cap-card retry (`rigor-reviewed.spec.ts`) is the first user; the mock's other branches still match `latestUserTail`.
A behavior a few journeys share across many turns is a scenario the journey names at launch instead (`docs/testing.md`, "A journey's own scenarios").


## Frame and rail helpers

After a card script finishes sending synthetic gestures while focus is elsewhere, `frameGesturesDecided(page)` (`tests/e2e/frames.ts`) waits out the app's focus-grace frames before a journey checks that nothing opened or gives the frame focus with a real press.

Chromium drops native clicks into a hidden window's sandboxed frames, so an e2e spec dispatches clicks in-frame with `clickInBody` (`tests/e2e/stack.ts`), which focuses the target before dispatching its click.
The `e2e-frame-actions` lint follows frame locator chains and helpers and refuses native pointer actions; a journey whose subject is native input itself keeps a reason next to that action (`docs/testing.md`, "The lint").
Such a native press, or a wheel turn, into the shown card right after the stage changed waits for `stageAtRest` (`tests/e2e/stack.ts`): as a stage move ends, Chromium can still aim a press by the window's earlier drawing and send it to the window's own page, on the frame's element, so the page inside never hears it.
A native press into a side panel's frame right after the panel expanded waits the same way until the window has drawn the panel open (`panelDrawnOpen`, `tests/e2e/panel-tasks.spec.ts`): the collapsed body was out of the window's drawing, and a press aimed by that drawing reaches the window's own page instead.
A card a row, a task key or a record's Show the card brings forward appears only once its body has drawn, and takes the window's focus then (`focusCard`), unless a press began since (`docs/keyboard.md`, "Cards and frames"); while it replaces another card or a record, Playwright already reads it as visible at opacity 0.
Until then the stage keeps the drawing it replaces in front of it, behind a shield that takes the pointer (`docs/renderer.md`), so a wheel turn aimed at the new card scrolls nothing.
Its body can already scroll by then: the frame's height applies at once, while its drawing counts only once the frame is at the width it drew at, which on Linux its first scrollbar can delay (`cards/drawnAtWidth.ts`, `tests/e2e/card-reading-place.spec.ts`).
A task record opened on an empty stage is unseen and takes no pointer until its body frame draws, so a journey opens its words or presses its controls only once the shown entry's opacity reads 1.
A record that replaces a card is unseen the same way but already takes the keyboard's focus, and if the card it replaced leaves the stack first, as a dismissed question does, it turns inert under that focus, so a journey waits for its opacity of 1 there too (`tests/e2e/card-leave.spec.ts`).
A words fold opened before then pushes that frame out of view, where the Mac does not draw it, and the record appears only when its hold ends (`tests/e2e/card-reading-place.spec.ts`).
`pressRow` focuses the Tasks panel and clicks a row with no `pointerdown`, so the window hears no press begin: a journey that presses another Tasks row with it right after waits for `shownEntry` to reach full opacity, or the card can take the focus `pressRow` gave the Tasks panel before its click counts, and no record opens (`tests/e2e/now-panel.spec.ts`).
A press that begins with its `pointerdown` keeps that focus, as the captain's does (`tests/e2e/row-press-card-appears.spec.ts`).
In a serial file the next test's press is right after too, so a test that brings a card forward ends once it has appeared (`tests/e2e/record-controls.spec.ts`).
`clickInBody` is a focus and a click, not a full pointer press: where the target acts on `pointerdown` as well, such as a Tasks row that closes its summary on `pointerdown` and opens its record on the click, the journey dispatches `pointerdown` before it (`tests/e2e/crew-hover.spec.ts`).
A dispatched pointer event never moves Chromium's native pointer, so a journey keeps a target's entry and exit in one stream.
After a native hover onto a key, a dispatched `pointerover` elsewhere leaves the native pointer on that key, and its next native hover sends only `pointermove`, never the `pointerover` that opens a summary; `tests/e2e/card-task-keys.spec.ts` dispatches both, and keeps one sliding journey for native entry across the frame boundary.
Playwright emulates a focused window for the hidden window's main frame alone, and a card's or a panel's frame in a process of its own can then miss that focus: its `document.hasFocus()` stays false, so neither the shell nor the frame's script can put the keyboard in it.
`launchApp` turns the same emulation on for each such frame as it commits a page, so the frames hold focus the way a shown, focused window gives it.
A card body's page reports no navigation, so it gets none, and Playwright's keyboard focuses the window with every key, as the window coming forward does.
A card's page the stage prepares while the keyboard is in another page therefore gives the window's focus to the window's own page at the next key, and the app gives it back (`docs/keyboard.md`, "Cards and frames"), but that key can be lost.
Playwright's mouse takes the window's focus too: a move while the keyboard is in a frame puts focus on the window's own page, and the app gives it back to that frame.
That hand-off lets a summary the pointer opened go, and a Tasks row the keyboard rests on opens its own, so a journey rests on a task key with Chromium's routed pointer, which moves no focus, as a real mouse moves none (`restOnTaskKey`, `slidePointer`).
A journey that drives a page's keys after the stage changed waits for `stagePrepared` (`tests/e2e/stack.ts`) and then puts the keyboard in the page with a command, which tells every page where focus is; `windowComesForward` (`tests/e2e/windowKeys.ts`) brings the window forward on purpose and waits for the focus to come back.
A focus move inside a frame tells no other page, so a journey whose next Playwright key goes into a frame right after the stage changed goes through `focusFrameAfterStage` (`tests/e2e/stack.ts`), which waits for `stagePrepared` and brings focus into that frame from the window's own page.
Playwright runs every read inside a frame as a user gesture, which gives that frame user activation for about five seconds: a spec that claims a frame cannot take focus, or that the shell gives it focus, reads only from the window until the claim is checked (`tests/e2e/frame-focus.spec.ts`).
An iframe fires `load` even for a 404, so a served mount's presence is asserted with Electron's `session.fetch`.
Every spec that reads a feed line or a now-panel row goes through `tests/e2e/rails.ts`.
The Checks value on a task record or hover summary uses `taskCheckWords`; `taskFact(scope, "checks")` owns the whole cell, including its state dot, finished age and recorded watch schedules.
`expectRecordTaskStatus` reads the record-specific status projection, not the list's status reason, and checks each relocated wait in the record's attention box.
The native-pointer record fixture reuses the composed template program from the served body's script under its unchanged CSP, not the raw source file that lacks injected shared functions.
Both docks start collapsed, and a collapsed dock's frame runs out of sight, where it never paints: a wait for its next animation frame never returns.
So `expandDock` is the one awaited expand: the chevron is a toggle, and two overlapping clicks close it again.
Presses on two docks of one page take turns with each other and with the input helpers (`takeTurn`), because two clicks at once can swallow one while it reports success.
A frame-side measurement can only see writes that land after the expand.

## Frames are read through the door

A card's or a panel's page draws in a frame of its own, and the frame's title shows while its page still holds the empty first document.
A one-shot read of that document (a count, a text, a size) answers "nothing there" once in a few runs: a journey reading a card's pictures failed 15 of 20 runs on an unchanged main before it waited for the drawing.
The app marks a frame `data-frame-drawn` when its page has drawn, so `tests/e2e/frames.ts` is the one door to a frame: `cardBody(page, title)`, `panelBody(page, id)`, `observeBody`, `bodyIn(scope)` and the helpers built on them (`shownCardFrame`, `recordFrame`, `nowFrame`, `activityFrame`, `dockBody`, `shownPanelCardFrame`, `browserPage`, `boardPage`) select a frame through that mark.
Whatever a journey then asks of the frame waits for the drawing, or fails loudly because it never came.
A journey that presses the record's controls waits for `expectRecordBody` in `tests/e2e/rails.ts` inside the open, not at the press: the host reveals the record before its body frame draws, and that frame then grows the card.
The card holds still only once a press is down (`docs/renderer.md`), so a press aimed at a control before that growth can go down beside it.
If the record's facts place its undrawn body below the viewport, `expectRecordBody` first scrolls the frame into view so Chromium can paint it; an already drawn record keeps its reading position.
A rail panel's frame (`panelBody`, `nowFrame`, `activityFrame`, `dockBody`) goes through `railFrame`, which also takes it as it stands while the rails are folded.
A folded rail keeps its panels outside the window, where Chromium runs no animation frame, so a panel whose page mounted after the fold (a reload with a card's thread open) is marked drawn only once the rails unfold.
A locator in that page still waits for its element, while a one-shot read of a folded panel can meet the empty first document.
A journey about a frame's own states reads the element with the `…Element` helpers (`cardBodyElement`, `panelElement`, `frameIn`, `warmElement`), which carry no mark; one about a frame that stops drawing, such as a body that navigates itself away, reads it with `cardBodyAsHeld`.
A script that resolves a frame inside the window takes its selector from `cardBodySelector` or `frameSelectorIn`.
The `e2e-frame-door` Biome rule (`tests/lint/e2e-frame-door.grit`, in `pnpm check`) refuses `frameLocator`, `contentFrame` and any string naming an `iframe` in a `*.spec.ts`; the helper files under `tests/e2e/` are the door's own.
A spec whose subject is a frame it builds itself, or the iframes an attack plants, says so in `// biome-ignore lint/plugin/e2e-frame-door: <why>`.
New surfaces that draw a frame get a helper in `frames.ts` or beside their subject, never a selector in a spec.

## Input waits for focus

A key goes wherever the window's focus is.
`focus()` returns before focus has moved: into a frame of its own it lands a moment later, and a key pressed in between goes to whatever still held it.
Two clicks, or a click and a key, that overlap on one page can swallow one while both report success, because Playwright keeps one hit-target check per page.
So `focusOn(target)` and `pressKey(target, key)` (`tests/e2e/windowKeys.ts`) focus the target, wait until it holds the window's focus (`untilFocused`), and press; `typeInto` already did the same for words.
For a pointer activation dispatched inside a hidden frame, `focusOn(target, { focusVisible: false, preventScroll: true })` preserves pointer modality without revealing the target; the journey then dispatches its in-frame click.
Hover alone does not change Chromium's focus-visible modality, so scripted default focus is not evidence of pointer focus.
A `fill` moves focus the same way, so a window key a journey presses after filling a field inside a frame (`pressWindowKey`) waits on `focusOn(field)` first: a key that reaches the window before it hears focus moved finds the window's focus where it was before, and command search opened then gives focus back there (INF-1132).
`focus()` on an inert element does nothing, and the stage keeps a card inert until it appears, as a task record does until its body draws (`docs/renderer.md`), so both first wait until neither the target nor a frame around it is inert.
They take their turn on the page's one input queue (`takeTurn`, `tests/e2e/inputQueue.ts`), the queue `expandDock` and `clickInBody` use, so a dock expanded in the background never overlaps them.
A target that is a frame's body is not focusable by itself: press on the frame's element (`frameIn(scope)`), which is where the window's focus goes.
The `e2e-bare-focus` Biome rule (`tests/lint/e2e-bare-focus.grit`) refuses an awaited `target.focus()` in a `*.spec.ts`.
A `focus()` in a script run in the page is the page's own and stays.
A spec's own raw `click()` is not on the queue; it overlaps a background expand only when a helper started one just before it, and `expandDock` is awaited by the helpers that need a dock open.

## One writer once the app runs

The core is the one writer of the saved data once the app has launched.
A spec seeds before the first launch, or between two launches while the app is stopped, with the stores it shares with the core (`seedTask`, `TaskService`, `CardStore`).
A second `TaskService` built against the live database runs boot recovery (it marks running turns interrupted) and locks the file: the dependency-wait journey lost a release run to "database is locked" that way, and the same journey passed once its observer only read.
After a launch a spec reads saved data through `readSavedData(userDataDir, read)` (`tests/e2e/savedData.ts`: read-only, `query_only`), and the knowledge collection through `readKnowledgeData(userDataDir, read)` beside it, or through a store it built before the launch and only reads from.
A search of every file the app keeps, such as a check that nothing saved holds what was typed, goes through `savedText(dir)` (`tests/e2e/savedText.ts`).
The app moves files while it writes them (Chromium renames its atomic-write file into place), so `savedText` leaves out an entry gone since its folder was listed and throws on any other failure, including a missing `dir`.
The `e2e-no-writer-after-launch` rule (`tests/lint/e2eWriters.ts`, run by `scripts/lint-e2e-frames.ts` in `pnpm check`) refuses `openDatabase`, `new TaskService`, `new CardService` and `new CardStore` in a spec after a launch call and before the app is closed, in a closure kept for later (`const read = () => new TaskService(...)`) or handed to a poll, and in a same-file helper called after a launch.
It is lexical; a store built in another file, or a write through a store built before the launch, is not seen.
The same rule refuses a spec's own `new Database(path, { readonly: true })` wherever it sits: a read-only open is only ever a read, and a read goes through `savedData.ts`; a writable `new Database` that seeds the stopped app stays.
A journey whose subject is someone else's write says so with `// e2e-writer-ok: <why>` on the line or the one above.
Such a write takes the write lock before it reads, as `seedDelivery` (`tests/helpers/taskDelivery.ts`) does with `BEGIN IMMEDIATE`.
A transaction that reads first and then writes is refused at once, with no busy wait, whenever the running app holds the write lock at that moment.
The check-refresh journey lost an alpha run to "database is locked" that way.
`closeOpenCards` (`tests/e2e/stack.ts`) puts the stack away through the core's shared leave call, `window.infinitary.cards.close`, and waits for the stage to agree, instead of pressing the minus on a drawing that may be leaving: the window's drawing always lags the core's state by a push, and a cleanup that reads the drawing fails whenever the card leaves between its read and its press.

## Words come from their owner

Words a person reads are the product's to change, and a spec that re-types them breaks the day they move: the lowercase start sentence, the on-hold wording, a stand-in contract version and a close warning the app no longer showed each failed an alpha's Mac check after a change whose own pull request ran green.
So a spec reads every multi-word text it expects from the module that owns it, and never types it where it asserts.

- **Words the product types** are imported from the product module that types them: its exported words (`DRIVER_WORDS`, `RIGOR_WORDS`), or its composer called with the spec's own data (`claudeClientOutdatedText(version, floor)`), so "Running as Builder" is the composer's words around the spec's device name.
  Words typed inline in a component move into an exported constant or composer in a plain module beside it, with no React, DOM or path-alias import so a spec can load it, and the component renders from it; the rendered text stays the same character for character.
- **Words the spec puts there itself** (a seeded task title, a card the mock authors, a field the spec fills, an error its stand-in returns) are named once, in the spec or in the mock that authors them, and that one constant is used where the words go in and where the spec expects them.
- **A version the contract owns** derives from the contract's own constants in `src/shared/ipc.ts`: `PROTOCOL_VERSION`, `PROTOCOL_MAJORS_BEHIND` and `VIEW_FLOOR` for the version window, or the first version a feature needs (`WORK_UPDATE_SINCE`, `src/shared/contractFeatures.ts`) for a computer too old for it, never a typed number that the contract's next version leaves behind.

The `e2e-typed-words` rule (`tests/lint/e2eTypedWords.ts`, run by `scripts/lint-e2e-frames.ts` in `pnpm check`) refuses, anywhere under `tests/e2e/`, a `toContainText` or `toHaveText` whose expected value carries a typed literal of three or more words (a string, the typed text of a template around its holes, a regular expression, or an item of an array of them); a fixture constant, a variable bound to a literal, whose words the product also types (its own three words or more found in a string, template or JSX text under `src/`, or a run of four or more of the product's words found inside it); and a contract or protocol version typed as a number.
It is lexical: words passed through a helper's argument, an object's property or a lookup by text inside a region (`row.getByText`, a role's name) are not seen, and a clean lint is not proof that a spec reads its words from their owner; a page-wide lookup by words is the next section's rule.
Words that are not a copy say why with `// e2e-typed-words: <why>` in their statement or on the line above it: a check whose subject is the build itself, such as the policy a card's frame runs under, which states it independently ("Independent oracles" in `docs/testing.md`), or a fixture's own words that only share a phrase with the product's, such as the captain's words that start a scripted spawn.
`tests/browser/observe-frame.test.ts` runs the real `observe.frame.js`, a frame program served as text that exports nothing, so its text assertions are where that program's words are pinned, as `record.frame.test.ts` pins the record's; the rule reads only `tests/e2e/`, so it leaves them alone.
A frame program's words a journey reads elsewhere either carry that reason or move to a `data-*` hook the program paints, as the record's card lines did (`data-record-card-state`).

## Find by place, not by words

A card's title shows in more than one place: on the card, in the last turn's reply above the message box (`docs/composer.md`, "The last turn"), in a task record's card line, and in the drawing the stage holds while the next card gets ready.
A page-wide lookup by those words matches whichever of them is there, so a journey that waited for a card by its title passed on the reply while the card had not come up, or failed on two matches once the card had: the reply bubbles alone broke several journeys in a day (FI3-1113).
So a spec finds a thing by its place, and reads words only inside it.

- **A card** is `shownCard(page, title)` (`tests/e2e/stack.ts`), the shown entry's region named by its title; `showCard` pages to it, and `expectNoCard(page, title)` returns once no open card has that title, read from the core's stack (`cards.list`) and the stage.
- **The pager** is `pager(page, count)` and `pagerAt(page, position, count)`, over `data-card-pager`, never its words.
- **A feed line** is a task's line by its event and key (`reportLine`, `startedLine`, `putInLine`, `statusLine`, `taskLine` in `tests/e2e/rails.ts`), or a task-less line by its writer's own words, imported: `feedLineOf(page, event)`, an action's `done` words, or the composer the product calls, with the spec's own data.
- **Other words** come from their owner (above) and are looked up inside the region that shows them: a row, a card's body, a dialog, a section through its helper (`modelsSection`, `dockRegion`).

The `e2e-text-lookup` Biome rule (`tests/lint/e2e-text-lookup.grit`, in `pnpm check`) refuses, anywhere under `tests/e2e/`, `page.getByText` with typed words (a string, a template or a regular expression) or a title (a name that says title), and, in a `*.spec.ts`, a region found by its name across the page or the stage; a region inside something already found, such as a card body's section, is found by place.
The `e2e-feed-line-prose` rule refuses typed words handed to `feedLine`: a string, a template, a regular expression, or a `new RegExp` built from one.
A check whose subject is the words themselves, such as a word that must never reach the screen, says so in a `biome-ignore` naming the rule and why.

## Waits run on the load clock

A journey's waits measure the time the journey got to run, not the time that passed (INF-1083, the captain's choice "a deadline counts only the time the test gets to run, capped at 20 times its budget").
On a busy Mac the runner, the app and its helpers can all stop for a minute at a time, and a wall-clock wait then fails work that was never slow.
`tests/helpers/budgets.ts` starts the load clock in each Playwright test worker on an ordinary run; `playwright.config.ts` imports it, and each worker reloads that config.
The clock ticks every 25 ms and counts each gap between ticks up to two ticks, so a stopped process's clock stops with it, and it counts only the share of processors left when the one-minute load per processor is above 1.
Every wait deadline reads it through `patches/playwright@1.62.1.patch` and `patches/playwright-core@1.62.1.patch`: the test, hook and fixture slots, `test.step`'s timeout, `expect` and `expect.poll` and `toPass`, every action's and locator's timeout, explicit per-call ones included, and `waitForEvent`.
Each wait also ends by its wall cap, 20 times its budget and at most 10 minutes (`waitCap`), so a wait whose work never comes still fails, by its own message, long before the whole check's limit.
A journey's own failure timer in the test process goes through `budgetTimer`, as the app's quit grace in `launch.ts` and the microphone probe do; a poll interval, a deliberate pause or a product deadline stays a plain timer.
A graded run (`INFINITARY_PERF_BUDGETS=1`) starts no clock, and every wait keeps its budget on the wall clock; so do the runner's own process and its whole-run limit.
Test durations, traces and reports keep the wall clock either way.
The runner's timeout slots accumulate wall elapsed time separately from their load elapsed time, so durations exposed to hooks and reports, and consumed by `scripts/journey-budget.ts` for journey placement, include time spent frozen without spending the timeout budget.
`tests/load-clock.test.ts` runs the real runner over a fixture and freezes its whole process group: a writer frozen 7 s past its 5 s budget still passes, a frozen after-hook writer also passes, both durations include the freeze, a missing file fails at its budget on a quiet run and by the cap under a frozen runner, and a graded run fails the frozen writer at its budget.

Unit tests run their limits and waits on the same clock and cap, through a clock of their own in each vitest worker (`docs/test-cohorts.md`, "Budgets").
The native phone gate mirrors the clock and cap in `PhoneLoadClock/PhoneWaitDeadline.swift`, read by `InfinitaryUITests/PhoneWaits.swift` and the app-hosted display samples, and explicitly starts the Node clock for its own failure timers (`docs/ios.md`, "Disposable verification").
Native predicate reads happen directly, so a short polling interval cannot time out before evaluating the predicate.

## A crashed page

`patches/playwright-core@1.62.1.patch` (`patchedDependencies` in `pnpm-workspace.yaml`) also carries one line of Playwright's own fix, which its 1.64 beta already has: a reply that arrives after a page crashed is ignored.
Without it, a page that crashes while it holds frames served at their own host fails the test with "Target crashed" or "Assertion error".
Playwright sends the page one more call as each of those frames detaches, drops those calls when the crash arrives, and then treats Chromium's late answers as a broken connection.
The main window holds the Tasks and Activity panel frames from launch, so a test that crashes it, like `tests/e2e/release-menu.spec.ts`, usually meets this.
A working copy installed before the patch can keep Playwright's unpatched copy while `pnpm install` answers "Already up to date"; remove `node_modules/.pnpm-workspace-state-v1.json` and install again.
The upgrade to a Playwright release that has the line removes that hunk; the load clock's hunks are ours and are made again on each upgrade.

## Guardrails

`tests/mockProvider.test.ts` exercises the real HTTP mock and its streamed tool arguments with repeated snapshots, multipart text, and title reuse.
The Electron workspace-inference test requires both distinct project actions exactly once.
Do not restore prose-regex fallbacks or union history into a current board.
Malformed current TOON fails loudly instead of resurrecting stale state.

When changing served context or feed presentation, run the contract tests and the Electron specs that consume it, the four above among them: each changed named case alone, then its whole file.
The full Electron suite is the release verify's job, never a local obligation (`docs/testing.md`).
Keep evidence of failed assertions: a missing element may mean outdated expected copy, not slow rendering.
Do not add retries or sleeps without demonstrating a timing cause.

## Claude turns

A spec that launches with `claudeTurns: true` (and a mock provider) runs real Claude turns.
The default stub (`tests/e2e/mockClaudeClient.ts`) then hands every SDK session that runs turns to the SDK's own co-released client from `node_modules`, never the client the machine has installed.
A session runs turns when it names a session (`--session-id=`, `--resume=`) or a model; the catalog read names neither, so it stays stubbed with `--version` and `auth *`.
`tests/e2e/claude-crew-turn.spec.ts` is the first spec on it: a Claude crewmate's `emit_card` becomes a card, and a steer lands mid-turn.

- **The box.**
  The client runs with `CLAUDE_CONFIG_DIR` and `TMPDIR` inside the run's throwaway HOME, the dummy `MOCK_CLAUDE_API_KEY`, `ANTHROPIC_BASE_URL` at the mock provider, nonessential traffic and the updater off, and a Keychain shim first on its `PATH`.
  Neither the client nor the app inherits the session that ran the tests: the e2e global setup drops its `CLAUDECODE`, `AI_AGENT`, `CLAUDE_*` and `ANTHROPIC_*`, and `tests/e2e/launch.ts` builds the app's environment without them (`tests/helpers/runnerSession.ts`).
  A run from a Claude crewmate therefore hands the client no messaging socket, token, session id or effort, and the client's entrypoint and SDK version are the SDK's own, as in CI; every `CLAUDE_*` it sees is the app's or the box's.
  The shim records each lookup and answers "not found" (exit 44).
  With `credential: "settings"` the box hands the client neither the dummy key nor `ANTHROPIC_BASE_URL`, so only the session's own settings can name a token command and an address (`claudeAccess.integration.test.ts`).
  A set `CLAUDE_CONFIG_DIR` already suffixes the Keychain service name (`docs/claude-client.md`).
  The spec asserts both: every lookup names a suffixed service (measured on client 2.1.234: `Claude Code-<hash>` and `Claude Code-credentials-<hash>`), and every request carries the dummy key and no `authorization` header.
  The bundled binary runs windowless on macOS, so the plan's hand-written protocol fallback was not needed.
  A boxed crewmate is offered only the client's own agents, `claude` ("FleetView's default when no agent name is typed") among them.
  The app's `settingSources: []` keeps out every agent definition in the box's HOME, the working copy and the folders above it.
  `src/core/claude/claudeCrewAgents.integration.test.ts` plants one in each place; none reaches the model, and with the client's own agents off the crewmate is offered none.
  The client always reads one folder the box cannot move, the machine's managed Claude folder (`/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux); on a machine with agents there, that test fails and names them.
  `credential: "subscription"` swaps the key for a dummy subscription token (`MOCK_CLAUDE_OAUTH_TOKEN`), with which the client pushes plan readings a key never gets, and `maxRetries` sets its retries; the Claude seat's integration test uses both.
- **Reuse only executable preparation.**
  Turn-mode `writeMockClaudeClient(home, options)` prepares its launcher, auth/catalog script and Keychain shim once per worker process.
  Each test's options, API address, credentials, transcripts, temp files and lookup log remain under its own scratch HOME; `mockClaudeKeychainLookups(home)` reads only that test's log.
  The shim's log destination is passed in the child's environment.
  Tests with distinct providers/credentials can run concurrently through the same immutable launcher; no live client or session is cached.
  Vitest's isolated integration worker cleans the executables after its file, and Playwright at worker exit, through the existing scratch-directory cleanup and unchanged leak gate.

- **The process boundary.**
  On macOS and Linux, turn mode uses a small launcher that sets the same boxed environment and replaces itself with the real client.
  Version reads stay stubbed without booting Node; auth and catalog commands still use the JavaScript stand-in.
  The SDK observes the real client's exit directly, without an extra Node supervisor per cold start.
  Windows keeps the existing forwarding wrapper.
  `tests/mockClaudeClient.test.ts` checks arguments, stdin, exit status, literal quoted paths, boxed credentials and the unchanged process identity through the executable interface.
- **One script, two dialects.**
  The mock provider serves a scripted call under `mcp__infinitary__<name>` when the request declares the tool that way, so one marker drives a Pi turn and a Claude turn.
  A scripted `bash` goes out as the client's own `Bash` where the request declares that tool.
  The client returns tool results as `tool_result` blocks in a user message, often beside a `<system-reminder>` note of its own; the mock reads such a message as a step of the running turn, so a script that counts its steps (`sinceLastUser`) drives both backends.
  `settle-effects.spec.ts` runs the kept-merge journey this way on a Pi crewmate and on a Claude one.
  Every Anthropic answer carries its own message id and tool-use ids.
  The client drops a response that repeats an earlier `toolu_` id and then re-sends the same request in a loop.
- **Mid-turn is a fact, not a race.**
  The Claude crewmate's next step is held open (`heldRequests()`).
  The spec steers only while it is held, and releases it (`releaseHeldCrew`, a progress note) only once the client's own transcript shows the steer queued (`claudeQueued`) - an order, never a clock.
  The steer rides `next`, so it arrives in the same request as the held step's tool result, as the seat's does.
- **The crew specs keep the first mate on Pi.**
  With a Claude account connected, the starter map slots only Claude's models, and a `models.json` provider cannot take a slot.
  So `claudeCrew.ts` connects an OpenRouter key pointed at the mock, slots one of its models and pins the first mate to it, as the captain would.
  A crewmate runs on Claude when its commission pins the Claude crew model, as a title carrying `CLAUDE_CREW_PROMPT_MARKER` (`tests/e2e/crewScripts.ts`) or `CLAUDE_CREWMATE_MARKER` makes the mock first mate do (`tests/e2e/mockProvider.ts`); the latter leaves the rest of the title to pick the crewmate's script, so one journey runs on Pi and on Claude alike.
  The window re-reads the first-run gate only on a quota push, so the helper asks for one after the slot change.
  A userData without accounts is a first launch, so a spec may seed a project row there before calling the helper.
  The crew's app also runs as `NO_CLAUDE_LOGIN_USER`, and its store is signed in with the plain-file credential on every platform.
  A crewmate's client holds the store between prompts, so the app's minute status read cannot ask the client then and reads the store's own files instead.
  Without that file the read falls through to the Keychain, and where it finds no login the crew's account reads as signed out: the next Claude crewmate opens on Pi's default model and fails with "No API key found", which reads as "sign in again".
- **The first mate on Claude** (W1 S12, `tests/e2e/claudeSeat.ts`): the captain pins a Claude model, and every first mate turn runs on the boxed client with a dummy subscription token (so the client reads the plan-window headers a person's login would) and no retries.
  The app itself runs as `NO_CLAUDE_LOGIN_USER`: the macOS Keychain names the machine's Claude login by service and `$USER`, so under a user no login was saved for, every sign-in and allowance lookup of the app's own finds nothing - no value is read, no permission asked - and a spec may press Connect or Sign in for Claude.
  The store is signed in with the plain-file credential.
  The mock provider cuts the seat off per class (`cutClaudeSeat`: the vendor's 401, a 429 with `rejected` plan-window headers and a reset, the 403 organisation refusal), and holds a first mate step open for a steer (`FM_SEAT_HOLD_MARKER`, `releaseHeldFirstmate`): the spec releases it only once the client's own transcript shows the steer queued - an order, never a clock.
  A Codex account beside it signs in with a dummy token shaped like Codex's (its claims name a ChatGPT account) and the app's `models.json` points Codex at the mock, which answers Codex's own dialect (`POST .../codex/responses`, server-sent Responses events, the zstd-compressed body read plain; the client's WebSocket attempt meets no upgrade and falls back) - so a move to Codex, and one back to Claude, run end to end.

## A helper in the test process

A journey that runs another Mac's helper inside the Playwright worker imports `startHelper` from `tests/e2e/helperRun.ts`, never from `src/core/helper/run.ts`.
The helper loads its sign-ins and conversations code with the first order that needs it, and Playwright compiles code first loaded during a test on the worker's own thread without keeping the compile for the next run.
Loaded then, the compile froze the test's clock for seconds inside a timed wait on a busy runner (INF-615); `helperRun.ts` loads both as the spec file loads, before any test's clock starts.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- E2E runs are hermetic and windowless: `tests/e2e/launch.ts` gives each app a throwaway userData and HOME (`INFINITARY_USER_DATA_DIR` keeps the window hidden - captain directive; `INFINITARY_HIDE_WINDOW=1` does the same for an unpackaged launch without one) and passes that same directory as `--user-data-dir`.
  Playwright's electron loader calls `app.whenReady()` before the main script's `setPath`, so without the switch every parallel electron shares `~/Library/Application Support/Electron` and a peer can SIGTERM a process that has not opened its singleton socket yet (verify run 35928921757, `first-launch.spec.ts`).
  Those temp dirs are removed when the Playwright worker exits (`close()` keeps them: a relaunch reads the same userData after quit).
  `close()` asks the app to quit and waits for its process to end; the quit itself takes milliseconds, and the rest is Chromium's own shutdown, which a loaded Mac can stretch to seconds (`docs/architecture.md`, the sharp edges).
  After 20 seconds the helper kills the process and says so on the log, so a quit that never ends costs a warning rather than a file's `afterAll`.
  An app closes once: a second `close()` - a `finally` after a step that already closed it - waits for the first, and an app that quit by itself has nothing left to close, so the step's own failure is the one reported (`app-close.spec.ts`).
  Playwright answers `app.process()` only while the app is open, so the helper reads the process as the app launches and never asks again.
  An app never outlives the worker that launched it: Playwright stops a worker's apps from the worker's own exit handlers, which a killed worker never runs, and a cancelled CI job's runner kills a job's processes one by one from a list it took first, so an app launched meanwhile would run on with no parent.
  So `launchApp` names each app's user-data folder to a watcher process beside the worker (`tests/e2e/workerApps.ts`) before the app starts, and once the worker has exited, however it ended, the watcher stops every process still running with one of those folders.
  Fake media devices (no macOS mic prompt) with `INFINITARY_MIC_ACCESS=granted` standing in for macOS's microphone answer (a spec names another in `env`), a mock OpenAI-compatible provider (`tests/e2e/mockProvider.ts`) wired through app-scoped `models.json` (`tests/e2e/mockModels.ts`), and faked voice-model readiness (opt out with `voiceModelReady: false`).
  The fake flag does not put the Whisper weights on disk, and every launch forks a stand-in voice helper in place of the app's own (`tests/e2e/voiceHelperStandIn.ts`, through `INFINITARY_VOICE_HELPER_ENTRY`).
  It answers no words for a recording that arrives as PCM, as the app's helper does without its weights; a spec that needs words passes `voiceTranscript`.
  `INFINITARY_GRAPHICS_CARD=present` stands in a graphics card for speech, which the hosted Linux runner lacks, and the stand-in helper lists WebGPU when asked what its speech library can do, as the library's builds for Apple silicon and Linux x64 do (`docs/architecture.md` section 8, "Where speech runs").
  Together they put speech in the helper on every computer the suite runs on, so dictation is offered under a virtual screen on Linux arm64 too, whose library lists no graphics provider and would leave the answer to the window's own adapter.
  A spec names `absent` in `env` to see dictation hide, and a check with the real model on disk passes `useAppVoiceHelper` to run the app's own helper on this computer's library (`voice-freeze.check`).
  A voice journey presses the dictation key and reads its words through `tests/e2e/dictation.ts`: right ⌥ on a Mac and right Ctrl on Linux, from `desktopConventions`.
  `INFINITARY_MEMORY_PRESSURE=normal` stands in macOS's memory pressure level, so a loaded Mac running the suite never wakes a journey's first mate about its own memory, which with no signed-in model puts up a sign-in card the journey never asked for (INF-2108); a spec names another level in `env`.
  Quota fixtures ride `INFINITARY_QUOTA_FIXTURE_DIR`.
  A seeded Grok API key's allowance read goes to a local port nothing listens on (`INFINITARY_GROK_KEY_URL`), never to xAI; a spec that serves that read names its own stub in `env` (`quota-live-sensor.spec.ts`, `docs/quota.md`).
  Each home's connection stays on loopback at a port kept per userData (`INFINITARY_CONNECTION_LOOPBACK_PORT`, `docs/devices.md`), so a relaunched home is where its devices left it, and no test listens on the Mac's own network or on the port a real app holds.
  The port comes from `claimedPort` (`tests/helpers/claimedPort.ts`): it lies below every ephemeral range, so the system never hands it to a listener that asks for port 0, and the worker holds a claim on it until it exits, so no other worker or run on the computer hands it out.
  A launched home never takes a port that a port-0 listener found and closed again: that port can go to any other port-0 listener in the run, and a probe would then read that listener as the home.
  `connectionPort` on the launched app names that port, so a probe of whether a home listens dials that home and no other process.
  Claude credentials seed into that HOME's `.claude` (`prepareHome`), never a per-account vault store.
  Context/fixture maintenance and the shared request decoder: `docs/e2e-contracts.md`; current snapshots must never be unioned with conversation history.
