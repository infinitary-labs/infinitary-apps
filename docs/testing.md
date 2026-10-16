# Testing and CI rules

The green gate, the CI shape, and the mechanics every test keeps.
Cohorts and probes are `docs/test-cohorts.md`; the e2e harness is `docs/e2e-contracts.md`; how a change picks the tests it writes and runs is `docs/delivery-rigor.md`.

## This project's rulings on tests

Which tests a crewmate writes, and how it repairs a failing one, is the crew's default rule on tests (`docs/delivery-rigor.md`, "The default rule on tests").
A new end-to-end journey follows that rule like any other test, with no ask.
Its review names the promised result, the data, the completion signal, the platform prerequisites and the shared resources (FI3-1732).
This project adds one ruling of the captain, which wins over that default:

- Weakening, skipping or deleting an existing test waits for the captain's approval.

## Windows feasibility observations

The opt-in hosted Windows investigation is `docs/windows-feasibility.md`.
It collects results with disposable data and synthetic sign-ins; it is not a Windows support promise, a recurring suite or a release gate.

## Comparing binary payloads

Use `expectBytesEqual` (`tests/helpers/expectBytes.ts`) to assert complete byte equality on large recordings or transport pieces.
It checks the length and compares each view's bytes with `Buffer.equals`, rather than making the assertion library walk a million indexed properties.
Keep the transport's piece offsets, sizes and ordering assertions alongside it.
Its regression tests cover corruption at the beginning, piece boundary and end, truncated payloads, and views with different backing buffers.

## Frame styles in unit tests

Vitest blanks every `.css?raw` import unless the config sets `css: true`.

## The typecheck's heap

`pnpm typecheck` runs `tsc -b` with a 4 GB heap ceiling (`--max-old-space-size=4096` in the `package.json` script), so the PR checks, `verify.yml`, `release.yml` and a local run all get the same ceiling.
A clean check of `tsconfig.node.json` alone needs about 2 GB, and Node's default ceiling on the hosted Linux runner is about 2 GB, so without the flag an ordinary pull request can run out of memory there.
The web and frames projects need far less, so running the three projects as separate processes does not lower that need.
If the typecheck runs out of memory again, measure a clean `tsconfig.node.json` check with `--extendedDiagnostics` and raise the ceiling within the runner's memory.

## E2E scheduling and launch diagnostics

The renderer and application lanes (`tests/e2e/lanes.ts`, `playwright.config.ts`) share at most `min(10, availableParallelism())` workers.
Desktop is the one-worker lane and runs last, even after a failure.
New spec files start in desktop.
A file joins application once a review finds it needs no native focus, voice, paint budget or other one-at-a-time resource, and keeps its own HOME, userData, ports and service stand-ins.
Background work (`run-work.spec.ts`) and the browser booking journeys (`task-browser-booking.spec.ts`) are such files: scratch homes, loopback SSH fixtures, a `launchctl` stand-in and a local test airline.
Devices (`devices.spec.ts`) stays in desktop: under the parallel lanes' load, adding a Mac by its address, which packs the app at background priority (`src/core/devices/appArchive.ts`), outlasts the journey's wait for the Mac to join.
A full run never stops at its first failure: it reports every failure, later tests still run, and desktop still runs after a failure in the parallel lanes; `tests/e2e-lanes.test.ts` runs the real lanes over fixture specs to hold this.

`INFINITARY_TEST_PROFILE=1` prints per-phase e2e launch timings (`tests/e2e/launch.ts`).

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Local gate before every push: `pnpm typecheck && pnpm check && pnpm lint:adherence`, plus the relevant existing e2e specs that cover what you changed (the `renderer` and `application` lanes in `tests/e2e/lanes.ts` name the serial `desktop` lane as their teardown, so run one of their specs alone with `--no-deps` or it runs the whole desktop lane).
  Run the existing unit and integration tests a change can break by path, `pnpm test <path>...` (a bare file path finds its cohort, `docs/test-cohorts.md`), and the probes it reaches with `pnpm test:probes`.
  `pnpm exec vitest related --run <files>` is not that selection: it follows the whole transitive import graph, so a widely shared module reaches a large part of the suite (`src/shared/rigor.ts` reached 140 of 344 test files, 2026-09-30).
  The full unit suite (`pnpm test`) runs across `ci.yml`'s jobs on every PR and every push to main, its probes only where the change reaches them, and the full e2e suite (`pnpm build && pnpm exec playwright test`) is the release verify's job (next bullet); the full unit suite is not a per-push obligation.
  The full e2e suite runs only in CI, never locally during development or release preparation.
  The adherence lint runs the design skill's `_adherence.oxlintrc.json` through ESLint FlatCompat (current oxlint cannot execute its selector rules); its raw-px/hex rules are warn-level by the skill's own design.
- Standing CI rule (PR 8; CI shape revised by captain decision B, 2026-09-15, scout `fm3000-ci-release-only-s1`; split across machines by the captain's direction on FI3-1204, 2026-10-07; probes moved off every push by FI3-1756's plan, 2026-10-14): the PR checks are `ci.yml`'s five Linux jobs on all pull requests, including the release's own notes pull request, and pushes to main.
  `typecheck-lint-build` runs typecheck, biome, eslint adherence and build; `unit-tests` runs the in-memory cohorts (`pure`, `unit`, `unit-isolated`); `integration-tests (1/2)` and `(2/2)` run the integration cohort in vitest's own `--shard` halves, which split the files by a hash of their paths; `probe-tests` runs only the probes whose paths the change edits (`docs/test-cohorts.md`, "Probes") and passes with none.
  The hosted runner has two processors and a personal account is offered no larger one, so the jobs run side by side; together they run `verify.yml`'s `linux-checks` lane, which runs every probe, and `tests/release-contract.test.ts` holds every vitest project to one job or to shards that cover it, the probe project to its chooser.
  A new test file joins its cohort's job on its own; a new kind of check joins one of the jobs, never a step with a condition.
  The Linux jobs have no release-branch exemption: they must actually run to provide the required project verification, even though the generic forge verdict accepts conditional skipped checks.
  CI green means every check on the exact head commit SHA reports status=completed and conclusion=success or skipped (`gh pr checks`); a project that runs no checks reads green with the empty list, but on GitHub an empty list where workflow runs exist or have run for earlier pull requests reads pending ("checks have not started yet").
  The macOS work - the Playwright e2e suite and its run-alone pass, the universal package smoke, the replay gate - is `verify.yml`'s mac lane, in a reusable workflow that `release.yml` calls before its signing job (every alpha runs linux-checks, the whole Playwright suite on hosted Linux as `linux-e2e` ("The Linux source desktop" below) and mac; a stable promotion inherits its alpha's successful checks or is refused: `docs/alpha.md` "The signed channel workflow") and that crewmates request on demand through `github_write` (`docs/forge.md`, "Verification workflow requests"); it is deliberately not per PR and not nightly (the per-PR mac job was 98% of a ~$200/month bill).
  Crewmate validation is agent-driven and evidence-first (captain rulings 2026-09-19, the no-mistakes alignment; `docs/delivery-rigor.md`): demonstrate the user intent end-to-end with product-level evidence for each concrete thing an end user would do and relevant existing end-to-end tests covering the surfaces changed, re-run after an overlapping rebase, named under Verified, and a relevant test that cannot run is named, never dropped quietly - the full unit suite is the PR checks' job and the full Playwright suite and `pnpm package:mac` are `verify.yml`'s mac lane, with the full suite on Linux beside it (every alpha, and on demand), with full e2e runs only in CI, never locally, and no configured command is mandated anywhere in the rigor pipeline.
  Never treat old SHAs as authoritative for the current head.
- A timing claim in a test is asserted as an ORDER or as WORK, never as a wall-clock window (captain's B1, 2026-09-24: "one clock, budgets measured"): on a host running several suites at once a millisecond budget, a runner-clock interval, or two short real timers racing measure the load.
  Log the events the behavior promises in one ordered list on the page, count what a paint built (`rail-panels.spec.ts`), wait on the event that follows the one you need, or drive a unit test's timers on a fake clock (`jobManager.test.ts`, `piAccountBackend.test.ts`).
  A budgeted duration goes through `tests/e2e/perf.ts` (`measured`, tests tagged `@perf`): printed and annotated every run, graded only by `verify.yml`'s on-demand `perf` input on a quiet host; the Biome plugin `tests/lint/e2e-no-ms-budgets.grit` refuses `toBeLessThan(X_MS)` anywhere else in `tests/e2e`.
- Test temp directories: a test makes one only through `scratchDir(prefix)` (`tests/helpers/scratchDirs.ts`), removed after the vitest file or as the Playwright worker exits - never at module scope or in a Playwright `describe` body, which run in the runner (refused there).
  Both runners point TMPDIR at one private per-run root (`tests/helpers/runTempRoot.ts`, from each global setup) and FAIL the run naming whatever is still in it; `tests/run-temp-root.test.ts` drives that guard through a real vitest run.
  Each global setup also drops the variables of the session that started the run (`tests/helpers/runnerSession.ts`: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_*` and `ANTHROPIC_*`), so a run from a Claude crewmate starts its workers, apps and boxed Claude clients the way CI does; a test that wants one names it in the environment it builds.
  Work that writes after a test returns must be awaited first (`catalogRefreshesSettled` for Pi catalog refreshes).
  The leaked 300k-entry temp dir of 2026-09 made every mkdtemp cost seconds.

## Full e2e runs are CI-only

Run only the affected spec files locally.
`playwright.config.ts` refuses a local run without an explicit `.spec.ts` file filter, including runs filtered only by project, grep or last failure.
`--list` is allowed because it discovers tests without executing them.
For `renderer` or `application` specs, add `--no-deps` to avoid pulling in the whole `desktop` lane.

For a full run, start `verify.yml` in GitHub Actions for your branch.
Crewmates use `github_write` to POST `/repos/{owner}/{repo}/actions/workflows/verify.yml/dispatches` with `{"ref":"<branch-or-tag>"}` and any workflow inputs their task needs through the app's own GitHub sign-in (`docs/forge.md`, "Verification workflow requests").
An accepted request is not a passing check: find the run with `github_read`, confirm its version, then read `check_change`.
CI sets `CI`; do not set it locally to bypass the guard.
Every alpha's own verification runs the full suite; no local full run precedes a release.
The full-suite workload measurement (`scripts/test-workload.ts`) must also run in CI.
Unit tests are unchanged.

## Native phone checks on the pull request

`phone.yml` selects the iPhone and iPad gate for `ios/`, `docs/contract.json`, the phone-contract generator with its shape guard, and the gate's own setup (`scripts/affected-phone.ts`).
The setup inputs are `phone.yml`, `scripts/test-phone.ts`, `tests/helpers/phoneHome.ts`, `scripts/phone-test-home.ts`, `scripts/affected-phone.ts` and the command-lease helper `scripts/with-mac-check.py`.
Changes to general shared modules, connection/device code, packages or the lockfile alone do not select the native gate.
Its hosted Linux chooser reads the complete git comparison; an unreadable comparison selects the gate rather than silently skipping it.
The `native-phone` job runs the same disposable `scripts/test-phone.ts` gate for both devices on `MAC_RUNNER`, with `mini-mac` as its fallback label, never a paid hosted Mac.
It keeps native result bundles, logs, published-client results and connection readings in the `phone-results` artifact.
Unrelated pull requests have an explicitly skipped native job; a failure on either device fails the job.
Unlike the desktop journey workflow, a newer push waits for a running native check to finish its simulator cleanup, replacing only an older pending run for that pull request.
Only native jobs share `mac-mini-phone` across pull requests, with `queue: max` and `cancel-in-progress: false` at the job level; up to 100 phone jobs can wait without newer jobs replacing them.
Desktop journey jobs from different pull requests remain parallel.
The actual desktop build/test command takes a shared lease through `scripts/with-mac-check.py`; each native device gate takes an exclusive lease against the same runner-account cache file.
A waiting phone holds the entry lock while active desktops finish, so new desktops cannot continually pass it; after admission, command exit or cancellation releases the kernel lease.
The runner slots must share one account; the helper uses stock Python and `fcntl`, never signing material.
The native job's 120-minute limit allows 45 minutes for both device gates, 60 across admission waits and 15 for setup, cleanup and evidence upload, without changing any test deadline.
Desktop work may run between the two device gates.
Setup, evidence uploads, Linux jobs and the Linux choosers do not take the lease.
`tests/mac-check-lock.test.ts` runs the actual workflow command strings with held scratch Node processes and real kernel probes to verify overlap, exclusion, failure and cancellation.
The fixture, simulator identity and unsigned Xcode configuration are described in `docs/ios.md`, "Disposable verification".

## Journeys on the pull request

A pull request gets `journeys.yml`'s hosted Linux `choose-journeys` check, which selects the journey files without installing packages and writes the reasons in its summary.
Its count and file list pass to `affected-journeys`, on the Mac mini (the `MAC_RUNNER` label): only the journey files the change can break, never the whole suite.
When the chooser passes with no files, the Mac job skips by its own condition without taking a runner; when the chooser fails, its failed check holds the merge.
Both success and a job-condition skip satisfy the app's green rule.
If GitHub branch rules ever require `affected-journeys`, they must require `choose-journeys` too: a job skipped because its prerequisite failed does not itself hold a merge.
It reverses captain decision B of 2026-09-15 for pull requests in part (FI3-1305, the captain's answer of 2026-10-08).
That decision kept every Mac journey for the alpha because a hosted Mac was ~$200 a month, and its price was a loop: a change merged on green Linux checks, the alpha's full Mac run found one to three broken journeys of about 610 hours later, and every other pull request waited on the fix.
Twenty-one failing sites in five days were certain breaks after an intentional product change, found at the alpha cut; the check puts them on the change that caused them.
`scripts/affected-journeys.ts` chooses the files from the diff (`--base`, `--head`, `--json` for the reasons):

1. a spec file the change edits;
2. a spec whose import closure through `tests/e2e/` reaches a changed helper;
3. a spec that imports a changed module of `src/shared/` and names a symbol that module's diff adds or removes (a property of four or more letters, an export, or a camelCase name);
4. a spec whose helpers name a `data-*` hook, as a whole token, that the change adds or removes in `src/`;
5. a spec, or a helper most journeys do not import, that holds a sentence of two or more words as its own quoted string, one the change adds or removes in a string of `src/`;
6. a targeted fallback row matches a changed path, even without a changed hook, symbol or sentence.

The fallback table beside the existing selector unions these files into its result, deduplicating files and preserving existing reasons:

| Changed path | Additional files under `tests/e2e/` |
| --- | --- |
| `src/renderer/src/cards/` or `src/renderer/src/app/HomeScreen.tsx` | `keyboard-routing.spec.ts`, `stage-reveals.spec.ts` |
| `src/renderer/src/app/focusRecovery.ts` or `src/renderer/src/plugins/frames/frameFocus.ts` | `frame-focus.spec.ts`, `focus-recovery.spec.ts`, `card-task-keys.spec.ts` |
| `src/core/devices/` | `devices.spec.ts` |
| `src/core/routing/placementEngine.ts`, `src/main/host/resourceMemory.ts`, or `automaticPlacement.ts`, `placementFacts.ts`, `resourceSampler.ts`, `computerResources.ts` or `computerResourceFeed.ts` in `src/core/placed/` | `automatic-placement.spec.ts` |

Directory paths match descendants; file paths match exactly.
Each matched row reports its changed paths in the summary, including when existing rules already selected its files.
A matched row with a target missing from the available specs refuses selection rather than silently omitting promised coverage.
Documentation-only changes add no Mac files.

A helper most journeys import still runs them all.
Importing a shared module is not enough, and an ordinary word most specs already contain does not count.
A hook name inside a longer token, such as a document path, does not count.
A fragment inside a longer quote does not count, and a sentence held only by the stand-in does not select every journey that reaches it.
The hook and sentence rules read the diff, not the product's meaning.
They match the whole hook and the whole quoted sentence, so a fragment in the shared stand-in does not select every journey.
A change nothing in `tests/e2e` reaches runs nothing and the chooser reports so in its summary.
A change to a helper most journeys import (`launch.ts`, the stand-in) still runs them all, because that is the break this check exists to catch.
The Mac job refuses an empty file list, builds once, then runs exactly the chosen files with `--no-deps`, as a local run does (`docs/testing.md`, "Full e2e runs are CI-only").
It does not repeat the release's other stages: the run-alone pass, the replay gate, the package smoke and the full suite stay `verify.yml`'s, inside every alpha and on demand.
A newer push to the same pull request cancels the older run, because the Mac mini is one machine.
`tests/affected-journeys.test.ts` pins the selection and `tests/release-contract.test.ts` the workflow's shape.

## Per-run e2e evidence

Each Playwright run keeps its result directories (traces, error contexts, failure pictures, `testInfo.outputPath` files) and its JSON result in `test-results/runs/<UTC start>-<runner pid>/` (`tests/e2e/runEvidence.ts`), printed as `This run's evidence: …` before its tests start.
Playwright clears a run's output directory as the run starts, and that used to be all of `test-results/`, so a second run of the same working copy deleted the first one's traces and pictures while it was still going, and the two shared one JSON result.
The newest ten finished runs are kept, and every live one; `--last-failed` still reads the working copy's last run, from `test-results/.last-run.json`.
A spec saves its pictures and JSON with `test.info().outputPath(name)` (or the `testInfo` it was handed), so each lands in that test's own directory inside the run's, beside its trace: `test-results/runs/<run>/<spec>-<test title>-<lane>/<name>` (Playwright shortens a long title with a hash).
A fixed path in `test-results/` is shared by every run of the working copy, so a second run would overwrite the first's picture; `tests/lint/e2e-run-evidence-path.grit` refuses one in `tests/e2e` on `pnpm check`.
A run's start clears nothing outside `test-results/runs/`.
A run is going while a process with its runner's pid is running and started no later than the run did, so a pid the system has since handed to another process never counts.
While a run of a working copy is going, `pnpm build` there - and so `pnpm test:e2e` - refuses before writing anything, naming the run (`scripts/refuse-build-during-e2e.ts`, `prebuild`'s first step): the run launches the app from `out/` for every test, and a rebuild would replace the app under its later tests.
Build again once it has finished or been stopped; `pnpm exec playwright test <spec>` runs more specs against the current build meanwhile.
`tests/run-evidence-playwright.test.ts` drives two real overlapping runs, and a build refused under a real run.

## Each test owns its prerequisites

A named test passes when it is selected alone, from fresh state: `pnpm exec playwright test tests/e2e/<file>.spec.ts:<line>`, with `--project=<lane> --no-deps` for a `renderer` or `application` spec.
After a failure Playwright discards the worker, even with zero retries, and the next test starts over from `beforeAll`/`beforeEach`.
A test that leans on an earlier test's task, sign-in or panel then starts on an empty app, and its own red result hides the first one.
In the 2026-09 release cuts, side-rails' collapse and settings cases and forge-signin's sign-in-again and sign-out cases failed that way.

- The setup a test needs is its own.
  `side-rails.spec.ts` launches a fresh app per test, and a case that needs the docked home commissions its task through `commissionFirstTask`.
  `forge-signin.spec.ts` arranges each case's projects, GitHub stand-in and sign-in (`arrange({ signedIn })`).
  `claude-seat.spec.ts` gives each case a test-scoped app, HOME and mock provider, asserts an empty card/task state before the case, and attaches the starting and resulting state.
  `task-record.spec.ts` shares only its app launch; every case commissions its own reported task, including before its restart, and record/worktree reads stay keyed to that task.
- Sharing one app across a file (`beforeAll`) saves launches; it is never a prerequisite.
  Each test still makes the task, card or account it asserts on, and finds it by its own key.
- A journey whose later parts are the point of the earlier ones is ONE test with named `test.step` sections, never separate tests borrowing a predecessor's state.
  `personal-panels.spec.ts` is one: build, relaunch, both themes, a follow-up, removal.
  `claude-crew-turn.spec.ts` is another: card and mid-turn steer, hermetic-client checks, then Observe reading that turn's app-owned transcript after the client original is removed.
  A journey that joins tests keeps the minute each had (`test.setTimeout(n * 60_000)`), never a longer wait inside it.
  `test.describe.configure({ mode: "serial" })` orders tests; it does not make an undeclared prerequisite correct.
- **The run-alone pass** checks the rule, since no lint can see what a test borrows.
  `scripts/e2e-alone.ts` lists the tests with Playwright's own `--list`, and runs each test after the first of a spec file that shares one app (a `beforeAll`) by itself, by `file:line`, in a Playwright run of its own on the current build.
  `verify.yml`'s mac lane runs it over every spec file after its other stages, whether the suite passed or failed, keeps its result as the `e2e-alone` artifact, and lists its failures apart from the suite's in the job summary ("A red verify's evidence", below); `tests/release-contract.test.ts` holds that step.
  Locally it takes the affected spec files, like a Playwright run: `node scripts/e2e-alone.ts tests/e2e/<file>.spec.ts` after `pnpm build`.
  The renderer and application lanes' tests run four at a time, and the desktop lane's one at a time after them, as in the full run.
- Vitest cases keep the same rule, selected alone with `pnpm test <file> -t "<name>"`.
  `core.test.ts`'s capture cases share one booted core: a case that needs a project registers its own, the decision case waits out the first mate turn its choice wakes, and the crewmate's spawn, steer, hinted turn, settle and protocol reads are one test whose `section(name, part)` calls name the part a failure stopped in.
  A check over the whole session is an `afterEach` that holds whichever cases ran, never a last case counting what earlier ones made.

## The e2e assertion contract

Adopted by the captain on 2026-09-28 (scout `fm3000-e2e-rigidity-s1`, "adopt with notes") and narrowed on 2026-10-02 (FI3-547: "focus on tests that truly assert a functional user journey without being too specific about the exact pixels at each step").
Of the twelve failures behind three red release cuts, seven were end-to-end specs re-typing a product detail - exact copy, a pixel number, a model id, DOM order - that one intentional change moved, and every such detail was one fact copied into several spec files.
The 0.1.27 cuts then showed what separates the tests worth keeping: all eleven of their test-only failures asserted how the app looks, reads or is built (an internal number or shape, a pixel size, typed wording or an exact list, a halfway state), while every real bug was caught by a step where someone does something and must get the result they came for - press Close and the card goes, ask and the answer card appears - twice inside tests whose own animation and layout assertions noticed nothing.
So an e2e test is a journey: someone does something (opening a screen counts), the test checks the result they came for (the card closed, the task exists, the reply arrived, the setting took, their own data is there, the unsafe thing was refused), and it would still pass if the screen were redesigned and reworded tomorrow.
What a journey asserts, each fact from its one place:

| An e2e spec asserts | Through | Never | Because that lives in |
| --- | --- | --- | --- |
| the journey's result (a task exists, is blocked by its review, a card was filed or closed, the host moved, the setting took) | `window.infinitary.tasks.detail`/`board`, `cards.list`, the task record | the pager text, the feed's wording, a whole state compared for equality (exactly no tasks, the full event list), a halfway state nobody waits on | the typed IPC surface (pinned by `phase0-guardrails.spec.ts`) |
| the controls and content the journey uses or lands on | `data-*` hooks and roles through the helper layer: `reportLine(page, key)` on `[data-feed-event][data-feed-key]`, `nowRow(page, key)`, `recordFact(page, fact)`, `promptInput(page)`, `getByRole("button", …)` | re-typed copy, a page-wide `getByText`, CSS classes, a bare-tag `querySelector("input")`, nth positions, an inventory of what else is on the screen (every tab, chip or row) | `feed.test.ts`, `taskFeed.test.ts`, the vocabulary tests, the replay gate |
| words only when imported from their single source | `CARE_WORDS.quick`, `reportSummary(MOCK_REPORT)`, `STANDARD_PLACEHOLDER`, the mock's own titles | a string typed into the spec that the product also types | `src/shared/vocabulary.ts`, `src/shared/feed.ts`, `src/shared/firstRun.ts` |
| layout only as the loss it would cause: at the smallest window the control can still be used and the content reached, and a frame stops resizing | doing the thing at `minimumWindowSize` (`BrowserWindow.getMinimumSize()`); where no action shows the loss, measured boxes compared with each other through `tests/e2e/layout.ts` (`within`, `overflows`, `expectClearOf`) | pixel equality, a hard-coded rect, a two-decimal ratio, geometry re-computed in the test; spacing, alignment, colour, a drawing, an animation's timing | `cardGeometry.test.ts`, `threadGeometry.test.ts`, `record.frame.test.ts`; polish is judged by eye and by the pictures a crewmate attaches |
| ids only from the product's tables | `STARTER_SLOTS` (`src/shared/modelSlots.ts`), `CLAUDE_MODELS` | a model id such as "claude-sonnet-5-5" typed into a spec or a helper | the catalog specs (`model-lists`, `decision-models`, `phase5-model-catalog`), whose subject is the catalog |
| timing as order or work | as the timing rule above | wall-clock windows | captain's B1 |

- **The helper layer** is `tests/e2e/rails.ts` (the rails' frames, the now rows, and a task's feed lines by event and key: `reportLine`, `startedLine`, `putInLine`, `statusLine`, `taskLine`, with `taskKey` to find the key and `feedLineOf` for a task-less line in `feedLineFrom`'s own words; `recordFact(page, fact)` selects a task-record detail value by the stable `RecordFact` identity in `src/shared/recordFacts.ts`, painted as `data-record-fact` independently of its displayed label; `recordDrawings(page, taskId)`, every drawing of a task's record on the stage, shown or held while the next card gets ready, which a journey that hides a record to meet it afresh waits to be gone, since opening it again sooner shows the held drawing as it was), `tests/e2e/stack.ts` (the card stack; `shownCard(page, title)`, the shown card by the region its title names, never by the title's words, which the last turn's reply may repeat; `expectNoCard(page, title)`, no open card of that title in the core's stack or on the stage; `cardMeta(page, title)`, the shown card's meta line over `data-card-meta`; `pager(page, count)` and `pagerAt(page, position, count)` over `data-card-pager`, never the pager's words; `cardSurface(page)`, the shown card's own box, never the stage's fixed-height `[data-card-layer]` envelope around it; a settle card's `factsStrip` over `data-fact`; and `dragCardTo(page, width)`, the captain's edge drag, which holds the edge beside the card's chrome and travels over it, never over the sandboxed body frame), `tests/e2e/prompt.ts` (the task prompt), `tests/e2e/projects.ts` (`projectRow(page, id)` over `data-project` in Settings → Projects; policy outcomes come from `window.infinitary.repos.list()`), `tests/e2e/crew.ts` (`crewPlaneCounts` over `data-plane-counts` on the visible orbit, read once its first frame has painted; `waitForFirstmateIdle(page)`, the character has drawn and the first mate's turn has ended even while a card hides its frame), `tests/e2e/lastTurn.ts` (`yourBubble(page)` and `mateBubble(page)` over `data-last-turn-bubble` in the pair that stays, the first mate's `data-state`, and `bubbleWords` for a bubble's whole words; `askFirstmate(page, text)`, which sends a message and waits for the first mate's answer to it as an order of typed events, `user_turn`, then `firstmate_reply`, then its busy signal down, never a glimpse of the character's working state, which a quick turn can pass through between two polls; docs/composer.md "The last turn"), `tests/e2e/starters.ts` (`starterFor(provider, slot)` over `STARTER_SLOTS`), `tests/e2e/taskTimeline.ts` (`SPAWNED_TASK_START`, the event kinds a spawned task's start leaves on its timeline, which a journey extends with its own turn's), `tests/e2e/taskBrowser.ts` (a task's browser: `browserView(page, taskId)` over `data-task-browser`, `canvasReading` for the pictures the view drew, `pageSays` and `clickOnPage` on the task's hidden page itself, `windowCount`, `filesHolding` for what no file may keep, `stopTaskBrowsers` to make room under the cap of four, and `closeSite` to close a test site with every connection a browser's session still holds open to it) and `tests/e2e/layout.ts` (layout as invariants: `within(inner, outer)` names the edges that escape, `intersects`, `expectClearOf(page, surface, ...controls)` for a surface inside the window and clear of the controls still needed, `overflows(el)`, `tokenPx(scope, name)` for a token as the window resolves it, `pseudoBox` for where a `::before`/`::after` really paints, `settled(read)` for boxes once a move has finished, `atRest(target)` for a box read once no motion plays on it or on a box it sits in (a card grows into place as it arrives, its controls already working), and `minimumWindowSize`/`resizeWindow` for the window's own minimum).
  A fact that more than one spec reads gets one helper there, over a `data-*` hook the renderer paints where the fact lives; a fact without a hook gets one, never a copy of its words.
  A product change that moves such a fact is then one helper edit in the same PR, and the end-to-end tests that cover a surface are that helper's callers.
- **Independent oracles.**
  A journey that imports the product's words or numbers (`reportSummary(MOCK_REPORT)`, `PROTOCOL_VERSION`) proves that the fact reached the user, not that the fact is right: importing production output everywhere is not an independent oracle.
  The focused test that owns it states it outright (`src/shared/ipc.test.ts` pins the version's number, `taskFeed.test.ts` the feed's sentences), and an assertion names the user promise it protects.
  Decision consent is read from `decisionConsent` in its journey and stated independently in `src/shared/decisions.test.ts`; answer-task guidance is read from `renderAnswerShapeSection` and owned by `intentBrief.test.ts`.
  Settings recovery journeys keep saved values, refusal feedback and successful retries without copying the explanation that `settingSave.test.ts` and `readableRequest.test.ts` own.
- **Tiers.**
  `pure` and `unit` tests own every printed word, every sentence served to a model and every computed number (`feed.test.ts`, `taskFeed.test.ts`, `cardGeometry`, `threadGeometry`, `record.frame.test.ts`, `rigor.test.ts`); `integration` owns the boxes around the SDK, the CLI and git; e2e owns journeys and boundaries, without the literals.
  A boundary check keeps its build-level assertions, because there the build is the promise: what a card's frame may do, what leaves the Mac, the pinned API.
  A screenshot is evidence a crewmate attaches, never an assertion; no pixel snapshot is added.
  The goldens stay the two that exist: the replay baseline, and the pinned `window.infinitary` API and first mate tool set.
- **The gate is unchanged.**
  E2E stays release-only (`verify.yml`, above) with zero retries; the live Claude catalog alarm and the benchmark tooling tests keep blocking the release.
  The contract exists so that an intentional change breaks one helper its author sees, not a spec the release finds.
- **Keys wait until the app takes them.**
  `launchApp` returns only once the shell marks the window's keys as its own (`data-window-keys="commands"` on the document, `docs/keyboard.md` "Who runs a window command"), so a window key pressed right after a launch runs its command; a journey that reloads the page waits for the same mark with `untilWindowCommands(page)` before its next window key.
  A launch that expects the saved-data refusal window instead of the shell passes `shell: false` and returns once that page has loaded.
  Keyboard settings' recorder is started with `startRecording(page, command)`, which returns once the main process records, and ended with `endRecording(app, page, key)`, which returns once the window's keys run commands again (`tests/e2e/windowKeys.ts`).
  Words typed with Playwright's keyboard go wherever focus is, so a journey types where a step of its own put focus through `typeInto(field, text)`, which waits until that field holds the window's focus, and fills a field it only needs words in with `fill` or `pressSequentially`; a task's hidden page takes keys through `typeOnPage` (`tests/e2e/taskBrowser.ts`).
  A key pressed on an element goes through `pressKey(target, key)`, and an element that only needs focus through `focusOn(target)`: both wait for `untilFocused(target)`, because focus moves into a frame of its own a moment later, and take their turn on the page's input queue (`docs/e2e-contracts.md`, "Input waits for focus").
  A frame is read through the door in `tests/e2e/frames.ts`, which selects it only once the app marks its page drawn (`docs/e2e-contracts.md`, "Frames are read through the door").
  A journey waits for the first mate's answer to a message it sent with `askFirstmate`, and for its turn to end otherwise with `waitForFirstmateIdle`, never by the character's pose name, which reads idle before a turn has started as well as after it ended.
- **The lint.**
  Twelve Biome plugins in `tests/lint/`, scoped to `tests/e2e` and run by `pnpm check`, refuse what the table's "Never" column and the rules above name: `e2e-structural-selectors.grit` (a bare-tag `querySelector`/`querySelectorAll`, a class in any selector), `e2e-measured-box.grit` (a box `toEqual` a rect of number literals, measured lengths and tolerances of two or more digits, geometric `Math.abs` gaps, pixel `toHaveCSS` expectations and product constants used as expected sizes), `e2e-model-id-literal.grit` (a model id outside the catalog specs), `e2e-feed-line-prose.grit` (words typed into `feedLine`: a string, a template, a regular expression or a `new RegExp` built from one), `e2e-no-ms-budgets.grit` (a `toBeLessThan(X_MS)` outside `tests/e2e/perf.ts`), `e2e-run-evidence-path.grit` (a fixed path in `test-results/`), `e2e-typed-keys.grit` (a keyboard's `type` or `insertText` outside `typeInto` in `tests/e2e/windowKeys.ts`), `e2e-firstmate-pose.grit` (the first mate's pose name, such as "First mate - idle", outside `waitForFirstmateIdle` in `tests/e2e/crew.ts`, its own spec and `phase1-shell.spec.ts`, whose subject is the pose), `e2e-frame-door.grit` (a `frameLocator`, a `contentFrame` or an `iframe` selector in a `*.spec.ts`: a frame is read through `tests/e2e/frames.ts`), `e2e-bare-focus.grit` (an awaited `target.focus()` in a `*.spec.ts`: focus goes through `focusOn` or `pressKey` in `tests/e2e/windowKeys.ts`), `e2e-layout-state.grit` (the renderer's `data-rails-folded`, `data-card-width`, `data-stage-rate` and `data-side-panel-size` hooks), and `e2e-text-lookup.grit` (`page.getByText` with typed words or a card's title, and a spec's region found by its name across the page or the stage: a card is found through `shownCard`, another region through its helper; `docs/e2e-contracts.md`, "Find by place, not by words").
  `biome.json` gives them to `tests/e2e/**` alone through one override, so Biome runs none of them over the rest of the tree; a new e2e rule joins that override, never the top-level `plugins`.
  All twelve are errors.
  The four the table names were each raised once a semantic review had moved its callers onto the helper layer (`e2e-model-id-literal` and `e2e-feed-line-prose` in I6 of scout `fm3000-e2e-rigidity-s2`): a looked-up class became a `data-*` hook or the owning module's exported constant, a model id became `starterFor` or a row read from `window.infinitary.models`.
  The catalog specs keep their ids and the geometry contract tests their measured boxes.
  An imported product size or a token-derived number is still a copied layout expectation, not a journey's result.
  The layout rule leaves inline Set counts and decoded image dimensions alone; a non-layout arithmetic use that it flags keeps an adjacent reason (PNG decoding and the encoded demo attachment limits).
  The frame helper inspects folding only to avoid waiting for an offscreen rail to paint; it never asserts a layout.
  `expectClearOf` accepts any placement that stays inside the window without overlapping the journey's needed controls; the task-board, task-key and row summaries share it rather than reimplementing their placement algorithm.
  `layout-invariants.spec.ts` exercises clear placements on every side and refuses overlap, an escaped edge and a missing control.
  A spec whose subject is every element of a tag says so where it counts them, in `// biome-ignore lint/plugin/e2e-structural-selectors: <why>` (a card body's iframes and images in `card-containment.spec.ts`, a card document's scripts in `card-scripts.spec.ts`, a diagram's labels in `phase4-cards.spec.ts`).
  A thirteenth rule, `e2e-frame-actions` (`tests/lint/e2eFrameActions.ts`, run by `scripts/lint-e2e-frames.ts` in `pnpm check` and `pnpm lint`), refuses native `click`, `dblclick`, `check`, `uncheck`, `setChecked`, `tap`, `hover` and `dragTo` on frame contents.
  It follows `frameLocator` and `contentFrame` chains, scoped locator aliases and local or imported helpers' returns and arguments through TypeScript's symbols, rather than guessing from variable names; `owner()` returns the outer iframe element and stays native.
  It loads only `tests/e2e` sources, not the product or libraries, and follows initializers, not later assignments or arbitrary runtime data flow.
  A frame action uses `clickInBody` or an in-frame event, since Chromium can drop native pointer input in the hidden window.
  A journey proving native input itself keeps the action with an adjacent `// e2e-frame-actions: native -- <reason>`; an empty reason or a file-wide exception does not exempt it.
  `panel-tasks` keeps its native activation and pointer-routing checks, and `frame-focus` keeps the click whose job is to transfer focus without the helper doing it.
  A fourteenth, `e2e-no-writer-after-launch` (`tests/lint/e2eWriters.ts`, run by the same script), refuses a store opened for writing in a spec once the app runs (`openDatabase`, `new TaskService`, `new CardService`, `new CardStore` after a launch, in a kept closure or in a helper called after one); a spec reads saved data after a launch through `readSavedData` (`tests/e2e/savedData.ts`), and `// e2e-writer-ok: <why>` waives a journey whose subject is someone else's write (`docs/e2e-contracts.md`, "One writer once the app runs").
  A fifteenth, `e2e-typed-words` (`tests/lint/e2eTypedWords.ts`, run by the same script), refuses words a spec types where they belong to someone else: a `toContainText` or `toHaveText` whose expected value carries a typed literal of three or more words, a fixture constant whose words the product also types under `src/`, and a contract or protocol version typed as a number; the spec reads the words from their owner instead, the product's exported words or composer, the mock's constant or its own named constant (`docs/e2e-contracts.md`, "Words come from their owner").
  `tests/e2e-contract-lint.test.ts` drives the Biome rules on fixtures and the frame rule through its callable and command interfaces, including breaking chains, preserving shell actions and requiring reasons; `tests/e2e-writers-lint.test.ts` drives the writer rule and `tests/e2e-typed-words-lint.test.ts` the typed-words rule.
  These are lints on test code, never a banned-phrase list on product copy, and they recognize only the patterns they name: a clean lint is not proof that a spec asserts a contract.

### Completion controls

`completionAction(page, title)` in `tests/e2e/stack.ts` reads the card's typed settle-merge action and locates its button by the action's exact label, so the journey never duplicates host-authored wording.

## Focused stylesheet contracts

`tests/renderer/` owns browser checks of exact stylesheet composition, outside the end-to-end journeys above.
`pnpm test:styles` runs them against Chromium in the hermetic launcher's hidden window after `pnpm build`; the complete CI `pnpm test:e2e` gate includes them.
`railDocking.spec.ts` exercises the real rail stylesheet with collapsed, expanded and hidden bottom panels on both rails, protecting one bottom group with no extra margins between its shown panels.
Pictures and a surface reproduction still show whether a visible fix meets the captain's intent.

## Capturing pictures of a change

A change a person can see gets pictures of each changed view before the first edit and after the change (`docs/delivery-rigor.md`, `docs/card-authoring.md`).
This project's recipe uses `regionShot` in `tests/e2e/pictures.ts`:

1. Build once per state: `pnpm build` before the first edit (the unchanged app), and again after the change.
   A hermetic run shows what `out/` was built from, not what the source holds: the app's own panels (`src/panels/`, such as the task board) reach it only as the compiled `out/frame-lib/builtin/` (`docs/ui-plugins.md`, "The app's own panels are ordinary folders (piece 7)"), so restoring the source to photograph the earlier state needs another `pnpm build` too.
   Never build while an e2e run of the working copy is going (`## Per-run e2e evidence`).
2. Launch through the hermetic launcher, `launchApp` in `tests/e2e/launch.ts`, in a throwaway Playwright script or an existing spec you run alone with `--no-deps`; never the real app, home or sign-in.
   Reach the view through the same mock provider and seed helpers the specs use (`seedTask`, `tests/e2e/stack.ts`, `tests/e2e/crew.ts`).
3. Fix the window size with `resizeWindow` (`tests/e2e/layout.ts`), for example the minimum window size from `minimumWindowSize` plus one roomy size, and use the same size before and after.
   Choose a size where the entire intended region fits both the window and its scrolling ancestors; a locator taller than the visible scrolling region cannot capture hidden content faithfully.
   For content that cannot fit, photograph smaller intentional regions or use an explicit scrolling capture strategy, never a partial picture described as whole.
4. Photograph each region with `regionShot(region, path)` (the card, the panel, the row), not the whole window, so the picture is cropped to the smallest region that shows the change; take both themes (`setThemeViaSettings`, `tests/e2e/theme.ts`) when color changes.
   It waits for the region's and its ancestors' finite reveal motion with `atRest`, brings the region into view, and checks its measured bounds against the window and every clipping ancestor before capturing.
   It photographs the region at any Size, 100% to 150%, at the window's own resolution, the way `heroShot` does ("A hero picture" below), with the caret hidden.
   A refused crop requires resizing the window or choosing a smaller region; disabling screenshot animations alone does not establish reveal readiness or recover clipped content.
   `tests/e2e/region-shot.spec.ts` checks this boundary by decoding synthetic corner markers after a reveal and at every Size, not by comparing a visual golden.
   When the change is the window itself, `windowShot(page, path)` photographs the whole window the same way, at any Size.
   Playwright's own `page.screenshot` shows only the window's top-left at a larger Size ("A hero picture" below says why), so a whole-window picture never comes from it.
   `tests/e2e/window-shot.spec.ts` checks `windowShot` at every Size by decoding synthetic markers in the window's corners, with a recording running alongside that must keep every frame whole.
5. Save the files with `testInfo.outputPath(name)`, then copy them into your task's evidence folder with a name that carries the view and the state (`rail-panel-before.png`).
   They stay out of the working copy, the commit and the PR.

Shoot a view again after any later edit or update that touches it, the same way as before.

## Recording a demo

Where the change is behavior a still cannot show - a drag, a keyboard journey, motion, progress, recovery from an error - that view gets a demo recording in place of its pictures (`docs/card-authoring.md`, "Demo recordings").
Record the same action before the first edit and after the last, at the same window size, theme, data and crop, with `startDemo` (`tests/e2e/demo.ts`) in the same kind of throwaway script or spec run as the pictures:

```ts
const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
// reach the view through the mock provider and seed helpers, as for a picture
await demo.record("Drag the row to the top", rowList, async () => {
  // the one action, played once
});
const files = await demo.finish({ dir: testInfo.outputPath("demo"), name: "rows-after" });
```

1. `startDemo` launches the hermetic app (`launchApp`) with its home pinned by `CFFIXED_USER_HOME` as well as `HOME`, fixes the window at `size`, then starts Playwright's screencast (`page.screencast`) on the ready window, keeping every frame it draws as a JPEG at quality 100.
   It records browser rendering, never the screen: the window stays hidden and nothing else on the Mac is in it.
   The demo is never built from Playwright's own WebM of the window: that encoder is fixed at 1 Mbit/s VP8 with a starved keyframe every 5.12 seconds, which flashes the view grey-purple for one frame and blocks dark gradients before the MP4 step runs.
   A frame smaller than the window (a capture cut off by a clipped screenshot) is dropped and the frame before it holds.
   `demo-recorder.spec.ts` holds a still view past that interval and refuses a one-frame flash.
   The first recorded frame supplies the clock origin for action marks, so startup time cannot shift the poster or crop back into an earlier reveal.
   Readiness takes whole-window pictures with `windowShot` only: any clipped capture, Playwright's own `page.screenshot` included, briefly crops Chromium's drawing surface, and at a larger Size the recording catches a frame of only the window's top-left.
2. `record` waits for fonts and the starting view to draw at rest, and scrolls a named region wholly into view.
   It holds a drawn half-second lead-in, marks the start, and keeps the starting view for 0.2 seconds across encoder frame rounding.
   It plays the action once and marks its end, cropping to the region's starting box: the card, panel, row, or `"window"` when the action opens something over it.
3. `finish` closes the app, cuts that span (with half a second before and most of a second after) out of those frames at their real times, crops it, scales it to fit 1280 x 720 at 24 frames a second, and encodes a silent H.264 MP4 (High profile, CRF 14, full-range BT.601 JPEGs converted once to limited-range BT.709 and tagged so, yuv420p, `+faststart`), its poster (the recording frame at the action-start mark; `poster: "first"` or `poster: "last"` explicitly selects a recording frame) and a manifest of how it was made.
4. It checks the result as the host will on a card - `readDemoVideo`, every frame decoded, the poster the recording's own size.
5. When no MP4 can be made, `finish` falls back to a GIF of the same span that plays once: at most 10 seconds (a longer action is refused, not cut), fitted to 1280 x 720 at 10 frames a second through FFmpeg's palette pass, made at three quarters and then half that size when it passes 8 MB, written with `-loop -1` so it carries no loop instruction, and checked by `readDemoGif`, the host's own walk; its poster follows the same action-start default and explicit frame choices, and its manifest says why the MP4 could not be made (`fallback`).
   `format: "gif"` makes the GIF alone, as `card-demo-gif.spec.ts` does to check it; `format: "mp4"` makes the MP4 alone, with no fallback.
6. A demo that cannot be made either way throws `DemoEncoderUnavailable` naming both reasons rather than leave one the card would refuse; it is reported with still pictures, never relabelled or claimed.
7. Copy the three files into the task's evidence folder with names that carry the view and the state (`rows-before.mp4`, `rows-after.mp4`); like pictures, they stay out of the working copy, the commit and the PR.

The encoder is one pinned FFmpeg build (`tests/e2e/demoEncoder.ts`: ffmpeg-static `b6.1.1`, with libx264 for the MP4 and its own GIF encoder for the fallback; FFmpeg 6 on a Mac and the release's static FFmpeg 7 on Linux, each checked for the version its pin names), fetched on first use into `~/Library/Caches/fm3000-dev/` (`$XDG_CACHE_HOME` or `~/.cache` elsewhere) and checked against the release's published SHA-256 before it runs.
It is a development tool: the app ships no FFmpeg, and installing the project's dependencies downloads none.
Playwright's screencast still runs through Playwright's own FFmpeg build, which installing the dependencies does not fetch either, so `startDemo` installs it on first use with the project's Playwright (`playwright install ffmpeg`, into Playwright's cache; `needWindowRecorder` in `tests/e2e/demoEncoder.ts`).
A machine that cannot install it gets `DemoEncoderUnavailable` before launch, rather than opening an app that cannot record.

For a keyboard demo, wrap each press and its result assertion in `await demo.step(async () => { ... })`.
The helper holds that result for half a second before the next press, so focus and intermediate views remain visible at real speed.
These holds are presentation pacing, not readiness checks or performance budgets; the callback still waits for the result through the usual shared helpers.
`record` holds the tail before returning, so an immediate `finish` keeps it too.
Never take a Playwright screenshot inside the action, a locator's or the page's own; take a whole-window picture with `windowShot` and crop the saved file after recording if a reference is needed.
Look at the poster and watch the whole recording before attaching them; describe only the states the files actually show.

A journey that records a demo saves it under `testInfo.outputPath("demo")`, and `verify.yml` keeps every such folder as the `e2e-demos` artifact for 14 days whether the suite passed or failed ("A red verify's evidence" below).
Only a journey that calls `startDemo` records; the suite never records itself.

## A hero picture

A change a person can see also keeps one hero picture pair, committed beside its release note (`docs/release-notes.md` "Hero pictures"): the crop a startup note shows when the change is a highlight.
It is part of the change, not evidence, so it is the one picture the pull request carries.
Take it at build time, from one of the After views above, with `heroShot` (`tests/e2e/pictures.ts`) in the same throwaway script or spec run:

```ts
await heroShot(page, { region: card, anchors: [panelTitle], name: "<entry id>" });
```

It unions the region and its anchors, pads the clip out to landscape inside the window, photographs that one clip in both themes, encodes WebP in the app's own Chromium, and writes `release-notes/pictures/<entry id>-dark.webp` and `-light.webp`; `ready` brings a view back that a theme switch let go of, such as a pointer resting on a row.
It photographs the clip at any Size, 100% to 150%, at the window's own resolution.
Playwright's own screenshot hands Chromium the clip in page pixels, which Chromium reads as the window's unzoomed pixels, after trimming it at the page's width, so at a larger Size it lands up and to the left of the region and is cut short.
With no clip it hands Chromium the page's size the same way, so a whole-window picture keeps only the window's top-left.
A clip handed to Chromium also briefly crops its drawing surface, which a recording running alongside can catch.
`heroShot`, `regionShot` and `windowShot` therefore ask Chromium for the whole window as drawn, with no clip, and the first two crop it in the app's own canvas, by the device pixel ratio Chromium reports (the Size's zoom times the screen's scale).
All three hide the caret as Playwright's `caret: "hide"` does, and `heroShot` also holds motion still as `animations: "disabled"` does.
After each theme switch it waits for motion that ends, never for motion that does not, as `atRest` does, so a view with something that keeps moving, such as the working dots, still takes its pair, with that motion held at its start.
`tests/e2e/hero-shot.spec.ts` checks this at every Size by decoding synthetic corner markers in both pictures, and with a marker that pulses without end.
The recipe:

1. Crop to the component that holds the new thing, plus one anchor that says where it is: the card, the panel with its title, the row with its neighbors, the character with its line.
   Never the whole window, unless the change is the window.
2. Keep it landscape, between 16 by 9 and 2 by 1, about 1200 by 600: the lead slot is about 720 by 360 and the two beside it about 330 by 150, so a whole window shrinks past reading.
   The check refuses a picture taller than it is wide.
3. Show the state where the change is at its best, with sample data a person would recognize, never the empty state and never the captain's own data.
   Leave the pointer out unless the change is about resting on something.
4. Take both themes from one clip in one run, at one window size, so the pair matches to the pixel; prefer the smallest window that shows the change without scrolling it, so the picture is dense.
5. Draw nothing on the picture: no arrows, rings or labels.
   The alt text and the note's title name the new thing; when no crop can show the change, declare `noPicture` with the reason instead.
6. The release crewmate looks at the pictures of the entries it ranks and re-takes a pair by this recipe when one does not carry; there is no larger source to re-crop.

## A red verify's evidence

`verify.yml` keeps what the e2e run left on the run itself, so a red release is read from its page instead of re-run blind (scout `fm3000-e2e-rigidity-s2`, I5; held by `tests/release-contract.test.ts`):

- **`e2e-results`** is Playwright's JSON result (the `json` reporter in `playwright.config.ts` beside the unchanged console reporter; verify's e2e step names its path, `playwright-report/e2e-results.json`, through `PLAYWRIGHT_JSON_OUTPUT_FILE`), kept whenever the suite ran.
- **`e2e-failures`** is, on a failed run, everything under `test-results/` (the run's own directory under `test-results/runs/`, "Per-run e2e evidence" above): each failed journey's `error-context.md` (the error, its call log and the window's accessibility snapshot), `trace.zip` (the runner's steps, errors and sources) and `test-failed-*.png` (the app window), beside whatever the specs wrote.
  Playwright takes the picture and the snapshot as the app closes - inside the test, or in `afterAll` as it retires the worker after the failure - so a journey that shares one app across its file gets them too.
  The picture costs about 100 ms per app close and is dropped when the test passed.
- **`e2e-demos`** is every demo a journey recorded (`testInfo.outputPath("demo")`, "Recording a demo" above), kept whenever the suite ran, passed or failed, so a requested demo can be watched from the run's page.
- All four are kept 14 days.
  None can fail the job, and none runs when an earlier stage kept e2e from starting.
- **`e2e-alone`** is the run-alone pass's directory ("Each test owns its prerequisites", above): `alone-results.json`, with every test it ran, how each ended and its first error, and each test's output, beside the trace and picture of each that failed; kept whenever the pass ran.
- **The job summary** names the requested ref and the exact commit checked out, the first failed stage, the e2e counts (skipped includes a serial file's tests that did not run), every failure in the order it started and the first one's assertion, and then the run-alone pass's counts and each test that failed alone.
  It reads the stages' outcomes and the JSON, never the log's prose, and decides nothing about which failure caused which: that stays with whoever reviews the evidence.
  It reports and never gates.
- **What they can hold:** every app ran on a throwaway userData and HOME, no verify step holds a secret (`release.yml` passes it none), and a trace records the launch environment's shape, never its values.
- Zero retries and the release-only trigger are unchanged.
  A local run writes the same files into its own `test-results/runs/<run>/`, the JSON beside them ("Per-run e2e evidence" above); a `--reporter` flag replaces both reporters.

## Voice start and release budgets

`tests/e2e/voice-freeze.check.spec.ts` is a macOS real-model check, skipped unless `INFINITARY_VOICE_MODEL_DIR` names the installed Whisper model directory.
It clones that directory into hermetic userData and uses the fake microphone; no real microphone or sign-in is used.
Run `pnpm build`, then `INFINITARY_VOICE_MODEL_DIR="<model directory>" INFINITARY_PERF_BUDGETS=1 pnpm exec playwright test tests/e2e/voice-freeze.check.spec.ts` on a quiet host.
It grades seven budgets.
Two keep the window thread and the main process free: first-use main-process busy time under 300 ms, and release-key handling under 16 ms at sixfold renderer throttling.
Five keep the model out of the window and the process that draws it: no WebGPU work on the GPU process's main thread after release, no task there of 16 ms or more after release or during first use, and no more than 500 MB of renderer or GPU-process footprint growth.
Where the recognizer runs in the window (an Intel Mac, `docs/architecture.md` section 8) those five are printed but not graded.
Every run also prints the voice helper's own footprint while its model is loaded.
Budgets are soft (`tests/e2e/perf.ts`), so one run reports every miss.
Release-key handling is one sample of a React re-render at sixfold throttling and is noisy on a loaded host; judge it over several runs.
The Chromium traces include actual key dispatch markers and are kept with the run; missing markers fail instead of making a whole trace look like post-release work.
Set `INFINITARY_VOICE_HOLD_MS=60000` to check release after a minute of real capture, where the synchronous clip work used to grow with length.

## The Linux source desktop

`source-journeys.yml` builds the checkout and runs journeys on the app built from source on hosted Ubuntu 24.04 x64, under Xvfb on a 2560 by 1600 virtual screen with Chromium's sandbox enabled.
`journeys.yml` calls it as `linux-source` on every pull request with the starter journeys: `source-start`, `phase0-guardrails`, `answer-delivery` and `claude-crew-turn`, the keyboard journeys `keyboard-routing` and `keyboard-regions`, which press Ctrl where a Mac presses ⌘ (`docs/keyboard.md`, "Keys on each system"), the task browser's journeys (`task-browser`, `task-browser-actions`, `task-browser-diagnostics` and `task-browser-booking`), the device journeys (`devices`) unconditionally, without a second selector, and the voice journeys (`phase6-voice`, `voice-prompt-focus` and `repro-voice-press`), which hold right Ctrl, with the stand-in model and a stand-in graphics card; the real card check is the captain's on each Linux alpha (`docs/architecture.md` section 8, "Where speech runs").
`verify.yml` calls it as `linux-e2e` with `suite: full`: every journey in the suite, before every alpha and on demand, in eight jobs.
Four take a quarter each of the parallel lanes (`styles`, `renderer` and `application`) and four a quarter each of the serial `desktop` lane, each run with `--no-deps` so neither lane waits as the other's teardown and the desktop lane still runs alone on its machine; a job is named for its share, such as `journeys (desktop 2/4)`.
A stable promotion inherits them with the other lanes ("Full alpha checks, inherited stable checks" in `docs/alpha.md`).
The run-alone pass, the replay gate and packaging stay on the Mac lane.
The Linux packages have their own checks, an installed-package journey on a clean copy of each system (`docs/linux-packages.md`, "The checks").

The launcher shows the app's window on Linux without giving it focus (`paintLikeAMac` in `tests/e2e/launch.ts`): a hidden window there paints about once a second, where a hidden Mac window paints at the display's rate, so a journey that waits on frames or plays Chromium's synthetic pointer would wait out its time.
On the virtual screen the shown window disrupts no desktop, so run Linux journeys under `xvfb-run` there too.
With no window manager the window under the pointer takes the keyboard, so the lane parks the pointer on the screen's last pixel (`xdotool`), where no window reaches, and stops before any journey unless the pointer is there.
It starts Xvfb with `-noreset`: Xvfb otherwise resets as its last client leaves, which is `xdotool` itself before any app opens, and puts the pointer back at the screen's centre.
Every app window opens centred, so a pointer at the centre sits in each one, and the windows of parallel journeys, opening and closing over one another, hand it to the window under test, whose page then hears it leave what its journey rests on.
Linux text is antialiased in grey, as macOS draws it (`--disable-lcd-text`): Chromium draws subpixel text only on an opaque layer of its own, so a component would otherwise draw different pixels in a panel and out of one.
A journey reads this computer's desktop through `tests/e2e/desktop.ts` (`THIS_DESKTOP`, `HAS_APP_MENU`, and a key's words and `aria-keyshortcuts` through their owners in `src/shared/keyboard.ts`), and its dictation key and hints through `tests/e2e/dictation.ts`, so the same journey reads ⌘ and right ⌥ on a Mac and Ctrl and right Ctrl on Linux.
A step whose subject only a Mac has - the window wash, Show in dock, the app menu - runs where the desktop has it, and the rest of its journey runs on both.
A journey whose whole subject is the Mac's skips on Linux and says why: the shell keys' default keys (`multiline-composer`, `card-threads`; `docs/composer.md`, "Shell keys"), the window wash (`window-wash`, `activity-runs`), macOS's microphone permission (`mic-access`), the app's own git (`app-git`, `run-work`; `docs/forge.md`, "The app's own git"), work run in the background through launchd (`run-work`; `docs/helper.md`), and, as before, the Mac's own SSH server (`devices`, `run-work`), `CFFIXED_USER_HOME` (`user-data-folder`) and the real voice model (`voice-freeze.check`).
The demo encoder is the release's static FFmpeg 7 there ("Recording a demo" above).
A mock crewmate writes its fixture files one bash call each, since Linux refuses a command argument over 128 KiB (`writeFilesCalls` in `tests/e2e/mockProvider.ts`).

The disposable hosted Linux runner installs the downloaded Electron sandbox helper root-owned with mode 4755 at a space-free temporary path, named by `CHROME_DEVEL_SANDBOX`.
It removes the unpacked adjacent helper after installing it because Chromium prefers an adjacent helper to the development fallback.
Chromium splits the helper's command-prefix path at spaces, so the helper is separate while the checkout and app executable still stay under `Application Support`.
The Playwright launcher explicitly enables Chromium sandboxing.
Each job keeps the machine-readable result and any failed journey evidence; the job that runs `source-start` also keeps a 1280 by 800 Linux window picture.
On Mac, a pull request editing `tests/e2e/layout.ts` still runs every resize and minimum-size caller selected by `scripts/journey-callers.ts`, including calls through the demo helper.
The Mac affected-journey selector covers the same callers through their imports.
Window sizes in `resizeWindow`, its returned restore value and `minimumWindowSize` describe content pixels before page zoom, not outer bounds that include a native menu or frame.
This is the source app, not a packaged Linux release check.
The launcher gives each app a throwaway HOME, userData, TMPDIR and XDG configuration, cache and data directories, and pins the Mac home with `CFFIXED_USER_HOME`.
