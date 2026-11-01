# Testing and CI rules

The green gate, the CI shape, and the mechanics every test keeps.
Cohorts and probes are `docs/test-cohorts.md`; the e2e harness is `docs/e2e-contracts.md`; how a change picks the tests it writes and runs is `docs/delivery-rigor.md`.

## This project's rulings on tests

Which tests a crewmate writes, and how it repairs a failing one, is the crew's default rule on tests (`docs/delivery-rigor.md`, "The default rule on tests").
A new end-to-end journey follows that rule like any other test, with no ask.
Its review names the promised result, the data, the completion signal, the platform prerequisites and the shared resources (FI3-1732).
This project adds four rulings of the captain, which win over that default:

- Weakening, skipping or deleting an existing test waits for the captain's approval.
- A phone part sends a tap once more only when backboardd's own log proves the simulator ignored the first one, and only through `tapOnPhone` (INF-1477, "Allow a proven second tap"; `docs/ios.md`).
  The photo pick alone also taps once more when the photo picker's own log proves it read the first tap as a press-and-hold and chose no photo ("Allow one more photo tap"), after one tap below the open preview closes it ("Allow the closing tap").
- A phone journey never waits for XCTest's animation reply: it skips that wait and keeps the app's run loop wait, and each tap waits until its own target, and the screen inside it, holds still (INF-1541, "The test code skips Apple's animation wait and checks each target itself"; `docs/ios.md`).
- A phone part's display change sets the text size once more only when the app's own log proves it read the old size after the simulator saved the new one, and never sets an appearance twice (INF-1785, "Confirm each change from the simulator's log, and set it once more only when the log proves the phone missed it"; `docs/ios.md`).

The crew's default rule has the change's own tests repeated before the completion card (INF-840): ten runs for a journey file or unit test file the change adds or edits, and three on each device for a phone part whose UI test code it edits (the chooser's distance 0, "The phone parts a pull request runs").
The captain's ruling puts those repeats on the Mac and only for those tests: "locally on mac only. only run affected tests".
A later ruling moves a unit test file's repeats to Linux CI (INF-2074's ci-gate fix: "Run a change's typecheck, lint and ten unit-file repeats on Linux CI instead of the Mac mini's line, since unit tests need no Mac").
Journey and phone part repeats run even on a computer in CI mode, so the repeat command alone carries `INFINITARY_CHECKS=local` ("Where the heavy checks run"):

- a journey: `INFINITARY_CHECKS=local pnpm exec playwright test <file> --repeat-each 10 --retries 0`, with `--no-deps` for a `renderer` or `application` spec;
- a unit test file: `ci.yml`'s two `unit-repeats` shards run every Vitest file the pull request adds or edits ten times in a row with no retries, each stopping at its first failed round (`pnpm test:repeats --shard <index/count>`, `scripts/unit-repeats.ts`); Vitest owns the file split, each summary names its shard and candidate files, and a pull request whose two checks passed needs no local repeat;
- a unit test file on `scripts/mac-unit-tests.ts`, which needs a Mac: ten `pnpm exec vitest run <file>` runs in a row on the Mac, since Vitest has no repeat flag and the Linux job leaves it out;
- a phone part: three `INFINITARY_CHECKS=local pnpm test:phone --both --part <part>` runs in a row, stopping the loop on the first nonzero exit (`|| exit $?`); local phone gates stop at their first failed part by default and return their place after cleanup (`docs/ios.md`).

`journeys.yml` and `phone.yml` add no repeat stage.
A push to main repeats nothing, since its pull request already did; a `ci.yml` run started on a branch repeats what the branch edits since `origin/main`.

## Actions artifact retention

Large, short-lived uploads use explicit three-day retention: `phone-results`, `phone-pictures`, `phone-logs`, `phone-simulator-logs`, `linux-packages` and the `source-desktop-*` family, including overflow-parallel journeys.
Two of them are shorter: a pull request's `linux-packages` are kept 1 day, and `phone-results` from a failed phone check 1 day, while a recording run's stay 3 days for its export.
This keeps recent diagnostic evidence and same-run package handoffs without accumulating weeks of bundles and binaries.
Phone result bundles upload only on failure or a recording request.
A `source-desktop-*` upload from a run whose journeys passed holds only `source-results.json` and any recorded demo; a run that did not pass keeps the window and everything under `test-results/`.
A failed run's `journeys-failures` and `e2e-failures` are kept 7 days.
The repository's default for an upload that names no retention is 14 days.
Download diagnostic evidence or export a recording within those three days if a task needs to keep it longer.
Phone logs also carry the full gate's `part-times.json`; if no unexpired passing full gate supplies times, the existing chooser runs every affected part instead of dropping coverage.
Published release assets are independent of Actions artifact retention, but a release resuming after its Linux packages expire must rebuild them.
Retention applies to new uploads only; existing artifacts keep their expiry dates, and repository storage still depends on upload volume and other artifact families.

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

## The required typecheck

`pnpm typecheck` runs the pinned tsrs checker in build mode through `scripts/typecheck.ts`, visiting the node, web and checked-JavaScript frame projects in `tsconfig.json`.
Local, pull-request, main and release verification use this one command; there is no second project check or tsc fallback.
The selector reads the pinned package's published platform list: native on Apple silicon and Linux x64/ARM64 (the native launcher selects GNU or musl), portable `@tsrs/wasm` elsewhere, including Intel macOS.
Selection never depends on whether a binary is installed or a check passed: a missing native binary, diagnostic or crash fails the gate without retrying another engine.
Both engines are exact development-dependency pins; the portable checker runs single-threaded with its own 4 GiB linear-memory limit, not the old Node heap flag.
TypeScript remains a runtime library for panel compilation, generated types and lint/test consumers, not a backup project-check command.

The three configurations keep their source lists and checking options; aliases use explicit relative targets without `baseUrl`.
The compiler owns its incremental `.tsbuildinfo` results and invalidates results from the previous compiler version on the first run; subsequent checks reuse the new results.
For an explicit fresh check, run `pnpm typecheck --force`; to remove saved results, run `node scripts/typecheck.ts --clean`.
A rollback restores the old command and removes the three root `tsconfig.*.tsbuildinfo` files before checking; it changes no app data or panel output.
This command is a batch check, not an editor, language-server or watch-mode migration.

## The statement check

Five main thread freezes (INF-703, INF-940, INF-1348, INF-1956, INF-2059) were synchronous SQLite whose cost grew with the saved record while the tests used a few rows.
A plan is what grows with the record, so the statement check reads plans (INF-2061).
`tests/helpers/statementCheck.ts` is a setup file of the `unit`, `unit-isolated`, `integration` and `probe` projects.
It records every statement the app's own code prepares while a test file runs: the first caller under `src/` that is not a test, so a test's own statements and a helper's are left out.
When the file ends, it plans each one with `EXPLAIN QUERY PLAN` against a freshly migrated database (the app's record, or the knowledge collection when only that schema compiles it), with every parameter bound as NULL.
The file fails on a walk the ledger does not explain: a `SCAN` of a growing table, read through a view's alias too, and a temporary b-tree in a statement that makes one.
A search through an index, a temporary b-tree over the rows an index sought, and a virtual table's own index are not walks.

`tests/helpers/statementWalks.ts` is the ledger, in three parts:

- `BOUNDED_TABLES` names each table that does not grow with the record and the code that trims it; every other table grows, a new one included.
- `ONE_TIME_CALLERS` names code whose statements run once per record, such as the migrations, the folder move and the D-13 purge; a statement prepared under one of them is not planned.
- `WALKS` holds each allowed walk by its statement's text, the walks its plan makes and why the walk is acceptable.

The ledger only shrinks.
A statement whose plan no longer makes its ledgered walks fails the check, and `tests/statement-check.test.ts` plans every entry, so a fixed walk leaves the ledger in the same pull request.
A new entry is a move its pull request explains, as a moved replay number is; the usual answer to a new walk is an index or a query that seeks.
An optional query index goes in `migrate`'s index block in `src/core/storage/db.ts`, with no migration version.
The check sees only the statements the tests prepare, and it reads no time: a walk of a small table and a slow file read are outside it.
`INFINITARY_STATEMENT_CENSUS=<folder>` writes each test file's planned statements there as JSON, for a review of every walk at once.

## The scale check

The statement check reads plans; a read that seeks through an index can still read more rows every time the record grows, as the task board did before INF-703, the minute pass before INF-1348 and a read every two seconds before INF-1956.
`tests/scale-check.test.ts` counts that work for the reads the app repeats on its main thread: a first mate turn's context build, the answer-delivery sweep, one minute pass (the crew's watchdog checks and the work presentation refresh, registered as `services.ts` registers them) and a task board update (INF-2061, built as INF-2069).
It seeds a record sized from the captain's readings: 3,400 closed tasks with about 47 events each (160,094 events in INF-2059's reading), their cards, threads and answered messages, beside running work with 33 open messages in 13 chains.
It runs each read once, then counts each statement the read runs and the rows it returns, reads again to show the counts repeat, adds three times the closed history and counts again.
It fails when any statement's runs or rows moved, naming the statement, both counts and the app code that ran it.
The answer is a read that seeks only the rows it needs, never a bigger number in the test.
It counts work, never time (captain's B1), and a walk that returns no rows is the statement check's to catch.
It sees only the reads it drives; a new read the app repeats on its main thread joins it.
The fixture seeds through `outsideCensus` (`tests/helpers/statementCheck.ts`), so the statement check does not read a stack for each of the seeding's prepares; the reads it measures are still recorded and planned.

## E2E scheduling and launch diagnostics

The renderer and application lanes (`tests/e2e/lanes.ts`, `playwright.config.ts`) share at most `min(10, availableParallelism())` workers.
The full Mac check (`verify.yml`) gives them half the processor (`--workers=50%`), because both Mac runner slots share one processor: with all of it, app launches starved past `firstWindow`'s 30 s while the other slot ran journeys too.
Desktop is the one-worker lane and runs last, even after a failure.
The lanes load only `*.spec.ts` files (`testMatch` in `playwright.config.ts`); a vitest `*.test.ts` beside them, such as a scenario's own test, runs in vitest's cohorts and never in Playwright.
New spec files start in desktop.
A file joins application once a review finds it needs no voice, paint budget, demo recording or other one-at-a-time resource, keeps its own HOME, userData, ports and service stand-ins, and passes under the parallel lanes' load in a full Mac and Linux run (`verify.yml`).
Background work (`run-work.spec.ts`) and the browser booking journeys (`task-browser-booking.spec.ts`) are such files: scratch homes, loopback SSH fixtures, a `launchctl` stand-in and a local test airline.
Desktop keeps the voice journeys (the dictation key and the microphone), the paint budgets tagged `@perf` (`tests/e2e/perf.ts`), and the demo recordings, which play at real speed.
Devices (`devices.spec.ts`) stays in desktop: under the parallel lanes' load, adding a Mac by its address, which packs the app at background priority (`src/core/devices/appArchive.ts`), outlasts the journey's wait for the Mac to join.
Automatic placement (`automatic-placement.spec.ts`) stays in desktop pending the full Mac and Linux parallel-lane qualification; its memory and compatibility readings remain live.
Its first two journeys replay captured busy and available CPU counters inside the isolated Electron process, releasing room only after observing the task's CPU wait (`tests/e2e/placementCpu.ts`, `docs/routing.md`).
No product hook or shared runner setting changes, and the remaining refusal journeys keep live CPU readings.
The task board (`task-board.spec.ts`) stays in desktop: a tile's summary lets go when its window loses focus, and on Linux's shared screen another journey's window can take that focus.
Google integrations (`integrations-google.spec.ts`) stays in desktop: its released-build case uses the packaged bootstrap, which ignores the launcher's private connection-port override, so that file has not qualified for sharing.
The application lane's recent journeys keep their existing assertions and fixtures: Copilot records its own clipboard writes and browser opens; the inbox links only inside scratch space; the privacy journey replays recorded log lines with its own process IDs; the browser journeys keep local sites and private sessions; and the task, card, panel and project journeys keep their own saved data and windows.
Their keyboard and pointer checks use the launcher's per-page focus, not the operating system's foreground window; none records a real-speed demo or grades paint budgets.
`tests/e2e-lanes.test.ts` pins these reviewed assignments and the files named here that stay in desktop.
A full run never stops at its first failure: it reports every failure, later tests still run, and desktop still runs after a failure in the parallel lanes; `tests/e2e-lanes.test.ts` runs the real lanes over fixture specs to hold this.

`INFINITARY_TEST_PROFILE=1` prints per-phase e2e launch timings (`tests/e2e/launch.ts`).

## Journey waits and check limits

A journey's waits run on the load clock and end by their wall cap, 20 times their budget and at most 10 minutes; a graded run keeps the wall clock (`docs/e2e-contracts.md`, "Waits run on the load clock").
A unit test's limits and waits run on the same clock and cap, and each `ci.yml` test step ends at 30 minutes (`docs/test-cohorts.md`, "Budgets").
Above every wait sit the whole check's limits (INF-1083, the captain's check limits).
A pull request's journeys and journeys on request end their run at 75 minutes (Playwright's `globalTimeout`, which `playwright.config.ts` reads from the workflow's `INFINITARY_E2E_RUN_MINUTES`) and their command at 90 (the step's `timeout-minutes`), on the Mac mini and on the Linux overflow alike.
The full Mac suite in `verify.yml` ends its run at 150 minutes and its command at 180.
The Mac command's 90 minutes include the build and run; it does not wait for a command lease.

## Load never gates a run

The Mac mini is always busy with the fleet's other work, so no crewmate waits for its load to drop and no crewmate skips or defers a run because of load (INF-1541, the captain: "the mac will always be busy given how many other things our fleet needs to run").
A check runs now, at whatever the load is, and a number the crewmate picked from one loaded reading, such as "start below a one-minute load of 28", is not a project rule.
A run that fails or stalls under load is diagnosed from its own logs and fixed in the code that does not count the end of the work it waits for; it is not repeated until the load happens to be low.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Local gate before every push: `pnpm typecheck && pnpm check && pnpm lint:adherence`, plus the relevant existing e2e specs that cover what you changed (the `renderer` and `application` lanes in `tests/e2e/lanes.ts` name the serial `desktop` lane as their teardown, so run one of their specs alone with `--no-deps` or it runs the whole desktop lane).
  On a computer in CI mode the typecheck and the lint run in the pull request's `typecheck-lint-build` check instead ("Where the heavy checks run").
  Run the existing unit and integration tests a change can break by path, `pnpm test <path>...` (a bare file path finds its cohort, `docs/test-cohorts.md`), and the probes it reaches with `pnpm test:probes`.
  `pnpm exec vitest related --run <files>` is not that selection: it follows the whole transitive import graph, so a widely shared module reaches a large part of the suite (`src/shared/rigor.ts` reached 140 of 344 test files, 2026-09-30).
  The full unit suite (`pnpm test`) runs across `ci.yml`'s jobs on every PR and every push to main, its probes only where the change reaches them, and the full e2e suite (`pnpm build && pnpm exec playwright test`) is the release verify's job (next bullet); the full unit suite is not a per-push obligation.
  The full e2e suite runs only in CI, never locally during development or release preparation.
  The adherence lint runs the design skill's `_adherence.oxlintrc.json` through ESLint FlatCompat (current oxlint cannot execute its selector rules); its raw-px/hex rules are warn-level by the skill's own design.
- Standing CI rule (PR 8; CI shape revised by captain decision B, 2026-09-15, scout `fm3000-ci-release-only-s1`; split across machines by the captain's direction on FI3-1204, 2026-10-07; probes moved off every push by FI3-1756's plan, 2026-10-14): the PR checks are `ci.yml`'s seven Linux jobs on all pull requests, including the release's own notes pull request, and pushes to main.
  `typecheck-lint-build` runs typecheck, biome, eslint adherence and build; `unit-tests` runs the in-memory cohorts (`pure`, `unit`, `unit-isolated`); `integration-tests (1/2)` and `(2/2)` run the integration cohort in vitest's own `--shard` halves, which split the files by a hash of their paths; `probe-tests` runs only the probes whose paths the change edits (`docs/test-cohorts.md`, "Probes") and passes with none; `unit-repeats (1/2)` and `(2/2)` use the same Vitest sharding to run each changed Vitest file ten times in a row, retaining each step's 30-minute deadline, and pass with none ("This project's rulings on tests").
  The hosted runner has two processors and a personal account is offered no larger one, so the jobs run side by side; together they run `verify.yml`'s `linux-checks` lane, which runs every probe, and `tests/release-contract.test.ts` holds every vitest project to one job or to shards that cover it, the probe project to its chooser.
  Every job runs on the label the repository variable `LINUX_RUNNER` names, the placement service's `shell-pc-linux` places (a fresh two-processor VM per job on the Windows PC, five at once), and on GitHub's hosted `ubuntu-latest` when the variable is unset; `tests/release-contract.test.ts` evaluates each job's runner both ways.
  The shell PC job image supplies Node 24 and a pre-filled pnpm store, so `ci.yml` disables setup-node's pnpm cache when `LINUX_RUNNER` is set; hosted jobs keep caching.
  Every other workflow's Linux jobs read the same variable the same way (INF-1720's plan): the journeys' chooser, starters and overflow, `verify.yml`'s Linux lanes, the phone check's replacement job, the replay gate, Linux startup, the Linux packages and the release's Linux helpers; the package check's Ubuntu 26.04 leg takes the variable's label with `-2604`, the PC's 26.04 job image.
  The gate jobs take the variable's label with `-gate` (DOP-157's plan): `phone.yml`'s `cancel-replaced`, `journeys.yml`'s `choose-journeys`, and the four Linux jobs that open a release (`release.yml`'s `resolve`, `notes` and `phone`, `ios-release.yml`'s `resolve`).
  The placement service's runners on that label take only these jobs and go first in the PC's line, so the Mac jobs waiting on them start within minutes; hosted, they run on `ubuntu-latest`.
  Linux dependency installs use `.github/actions/node-headers`, which finds the running Node archive's `include/node` headers and refuses an image missing them; only the install receives that root as `NPM_PACKAGE_CONFIG_NODE_GYP_NODEDIR`.
  Uppercase preserves the setting through pnpm's lifecycle environment filter.
  That setting belongs only to the install, so later Electron rebuilds keep their own headers.
  `ci.yml` also forces a better-sqlite3 source build with an empty header cache and an unreachable header server, then writes and reads a database.
  The same workflow contract test evaluates the cache input for both runners.
  A new test file joins its cohort's job on its own; a new kind of check joins one of the jobs, never a step with a condition.
  The Linux jobs have no release-branch exemption: they must actually run to provide the required project verification, even though the generic forge verdict accepts conditional skipped checks.
  CI green means every check on the exact head commit SHA reports status=completed and conclusion=success or skipped (`gh pr checks`); a project that runs no checks reads green with the empty list, but on GitHub an empty list where workflow runs exist or have run for earlier pull requests reads pending ("checks have not started yet"), and so does a pull request's list with none of its own workflow runs on the version yet where the project runs them (`docs/forge.md`, "The green rule").
  The macOS work - the Playwright e2e suite and the run-alone pass's Mac-only tests, the universal package smoke, the replay gate - is `verify.yml`'s mac lane, in a reusable workflow that `release.yml` calls beside its signing job and before anything publishes (every alpha runs linux-checks, the whole Playwright suite on Linux as `linux-e2e` ("The Linux source desktop" below) and mac; a stable promotion inherits its alpha's successful checks or is refused: `docs/alpha.md` "The signed channel workflow") and that crewmates request on demand through `github_write` (`docs/forge.md`, "Verification workflow requests"); it is deliberately not per PR and has no schedule of its own (the per-PR mac job was 98% of a ~$200/month bill).
  An alpha runs every journey on the Mac, and so does the nightly full check, which requests it with `all_journeys: true`; any other request runs there only the tests tagged `MAC_ONLY_TAG`, since `linux-e2e` runs every other one ("Tests that need a Mac").
  Crewmate validation is agent-driven and evidence-first (captain rulings 2026-09-19, the no-mistakes alignment; `docs/delivery-rigor.md`): demonstrate the user intent end-to-end with product-level evidence for each concrete thing an end user would do and relevant existing end-to-end tests covering the surfaces changed, re-run after an overlapping rebase, named under Verified, and a relevant test that cannot run is named, never dropped quietly - the full unit suite is the PR checks' job and the full Playwright suite and `pnpm package:mac` are `verify.yml`'s mac lane, with the full suite on Linux beside it (every alpha, and on demand), with full e2e runs only in CI, never locally, and no configured command is mandated anywhere in the rigor pipeline.
  Never treat old SHAs as authoritative for the current head.
- A timing claim in a test is asserted as an ORDER or as WORK, never as a wall-clock window (captain's B1, 2026-09-24: "one clock, budgets measured"): on a host running several suites at once a millisecond budget, a runner-clock interval, or two short real timers racing measure the load.
  Log the events the behavior promises in one ordered list on the page, count what a paint built (`rail-panels.spec.ts`), wait on the event that follows the one you need, or drive a unit test's timers on a fake clock (`jobManager.test.ts`, `piAccountBackend.test.ts`).
  A fake clock that also advances with real time (`shouldAdvanceTime`) can fire a timer before the test does, so a step that fires the next timer while real work runs holds the clock still with `vi.setTimerTickMode("manual")` (`sessionHost.test.ts`, INF-435).
  A journey that waits on one of the app's own passes - a redelivery after a restart, a check's reread, a placement sweep - spreads `SHORT_TICK` (`tests/e2e/launch.ts`) into its launch `env` rather than waiting out the app's one-minute tick: it names a two-second period in `INFINITARY_TICK_PERIOD_MS` (`docs/architecture.md`, "One clock"), which a packaged build ignores.
  The main thread's own processor time is work, not a wall-clock window: a busy host stretches a stall's wall time but not the work the main thread did in it, so the freeze journey (`tests/e2e/main-thread-freeze.spec.ts`) grades its 250 ms line wherever it runs (`docs/freeze-recorder.md`, "Before a change merges").
  A budgeted duration goes through `tests/e2e/perf.ts` (`measured`, or `graded` for a bar with a 95th percentile and a maximum, tests tagged `@perf`): printed and annotated every run, graded only by `verify.yml`'s on-demand `perf` input on a quiet host, the same run that holds vitest's tests to their budgets (`docs/test-cohorts.md`, "Budgets"); the Biome plugin `tests/lint/e2e-no-ms-budgets.grit` refuses `toBeLessThan(X_MS)` anywhere else in `tests/e2e`.
- Test temp directories: a test makes one only through `scratchDir(prefix)` (`tests/helpers/scratchDirs.ts`), removed after the vitest file or as the Playwright worker exits - never at module scope or in a Playwright `describe` body, which run in the runner (refused there).
  Both runners point TMPDIR at one private per-run root (`tests/helpers/runTempRoot.ts`, from each global setup) and FAIL the run naming whatever is still in it; `tests/run-temp-root.test.ts` drives that guard through a real vitest run.
  Each global setup also drops the variables of the session that started the run (`tests/helpers/runnerSession.ts`: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_*` and `ANTHROPIC_*`), so a run from a Claude crewmate starts its workers, apps and boxed Claude clients the way CI does; a test that wants one names it in the environment it builds.
  Work that writes after a test returns must be awaited first (`catalogRefreshesSettled` for Pi catalog refreshes).
  The leaked 300k-entry temp dir of 2026-09 made every mkdtemp cost seconds.
- Test ports: a test that gives a home, a stand-in server or any other listener a loopback port takes it from `claimedPort` (`tests/helpers/claimedPort.ts`), in vitest and Playwright alike.
  A port found by listening on port 0 and closing again is free only for that moment: another worker can be handed the same one, and the home that listens second fails while its join reaches the other worker's home, refused as not that Mac (INF-698).
  A claimed port lies below every ephemeral range and stays claimed by its worker until the worker exits, so no other worker, run or port-0 listener on the computer takes it, and a home that quits can open again where it was.

## Tests that need a Mac

The captain's principle of 2026-10-28 (`docs/principles.md`): a test runs on the Mac only when it needs a Mac, and Linux runs every test it can.
A journey needs a Mac when it skips on Linux, or when it has a step only a Mac runs; it then carries `MAC_ONLY_TAG` (`tests/e2e/tags.ts`) in its own details, `test("…", { tag: MAC_ONLY_TAG }, …)`, or a describe's around it, beside its own `test.skip` and reason.
A unit test that needs a Mac is a file of the reviewed list in `scripts/mac-unit-tests.ts` instead (`docs/test-cohorts.md`).

Where each journey runs:

| Run | Linux | Mac |
| --- | --- | --- |
| A request for journeys (`journeys.yml`) | every named journey | their tagged tests, or every test with `mac_all` |
| A requested full check (`verify.yml`) | every journey | every tagged test, or every journey with `all_journeys` |
| The nightly full check and every alpha (`verify.yml`) | every journey | every journey |

Three checks hold the tag to what a test needs:

1. Every Linux journey job, `source-journeys.yml`'s starters, overflow and full shards, fails on a test that skipped there without the tag (`scripts/untagged-skips.ts`), whether its journeys passed or failed.
   The run-alone pass refuses one itself ("Each test owns its prerequisites" above).
2. The `e2e-mac-tag` lint in `pnpm check` (`tests/lint/e2eMacTag.ts`) refuses an untagged test that reads a Mac fact, and a tagged test that reads none.
   A test reads a Mac fact when its own code, or a `test.skip` or hook of the describe or file around it, names `THIS_DESKTOP` or `HAS_APP_MENU` (`tests/e2e/desktop.ts`) or the platform name "darwin".
   A step only Linux runs, such as a comparison with "linux", needs no Mac, and a helper the test calls is not followed.
3. `tests/release-contract.test.ts` holds the Mac steps of `journeys.yml` and `verify.yml` to the tag (`--grep @mac-only`), and the untagged-skip step to every Linux journey job.

`tests/e2e-mac-tag.test.ts` drives the first two on this repository's own journeys and a Linux run's real result.

## Full e2e runs are CI-only

Run only the affected spec files locally.
`playwright.config.ts` refuses a local run without an explicit `.spec.ts` file filter, including runs filtered only by project, grep or last failure.
`--list` is allowed because it discovers tests without executing them.
For `renderer` or `application` specs, add `--no-deps` to avoid pulling in the whole `desktop` lane.

For a full run, start `verify.yml` in GitHub Actions for your branch.
Crewmates use `github_write` to POST `/repos/{owner}/{repo}/actions/workflows/verify.yml/dispatches` with `{"ref":"<branch-or-tag>"}` and any workflow inputs their task needs through the app's own GitHub sign-in (`docs/forge.md`, "Verification workflow requests").
For an isolated Mac proof, pass the optional `mac_runner` input with a temporary runner label; it changes only that invocation's Mac lane, never `MAC_RUNNER` or the Linux jobs.
The reusable workflow accepts the same input, and leaving it unset keeps the normal project runner and hosted fallback.
An accepted request is not a passing check: find the run with `github_read`, confirm its version, then read `check_change`.
CI sets `CI`; do not set it locally to bypass the guard.
Every alpha's own verification runs the full suite; no local full run precedes a release.
The full-suite workload measurement (`scripts/test-workload.ts`) must also run in CI.
Unit tests are unchanged.

## Where the heavy checks run

Anyone building Infinitary runs every check on their own computer by default.
A computer opts into CI mode with one git setting, `git config --global infinitary.checks ci` (INF-800, the captain's approval: "Only the heavy checks: journeys, the phone check and the replay gate").
INF-2074's ci-gate fix adds the typecheck and the lint ("Run a change's typecheck, lint and ten unit-file repeats on Linux CI instead of the Mac mini's line, since unit tests need no Mac").
In CI mode these checks refuse to start outside CI and name their route on request instead (`scripts/checks-mode.ts`):

| Check | Command that refuses | Its route in CI mode |
| --- | --- | --- |
| Journeys | `pnpm exec playwright test` naming a committed journey (`playwright.config.ts`) | `journeys.yml` on request with the `files` it names ("Journeys on request"); a pull request runs none |
| The phone check | `pnpm test:phone` and `scripts/test-phone.ts` | `phone.yml` on request ("The phone check on request") |
| The replay gate | `pnpm replay:gate` | `replay.yml` on request (`docs/replay-harness.md`, "The gate") |
| The typecheck | `pnpm typecheck` | the pull request's `typecheck-lint-build` check; before a pull request, `ci.yml` on request |
| The lint | `pnpm check`, `pnpm lint` and `pnpm lint:adherence` | the pull request's `typecheck-lint-build` check; before a pull request, `ci.yml` on request |

Crewmates start each route the way they start a full verification: `github_write` to `POST /repos/{owner}/{repo}/actions/workflows/<workflow>/dispatches` with `{"ref":"<branch>"}` and the route's inputs (`docs/forge.md`, "Verification workflow requests").
An accepted request is not a passing check: find the run, confirm its version, then read it.
The pull request's own `typecheck-lint-build` check stands in for a local typecheck and lint, so only `ci.yml` started on a branch with no pull request adds Linux work for them.
A single unit test run stays local in both modes; a change's ten unit-file repeats run in `ci.yml`'s `unit-repeats` shards ("This project's rulings on tests").
Pictures and demos for a card stay local too: they are evidence, not checks.
A throwaway picture or demo script is never committed, so the journey guard lets it run; an existing spec cannot take pictures in CI mode.
Inside CI (`CI` is set) the heavy checks always run, because the Mac mini's runners run as the same user and read the same git settings.
`INFINITARY_CHECKS=local` or `INFINITARY_CHECKS=ci` overrides the git setting for one run in a terminal; the app's crewmates do not see a shell profile's variables, which is why the setting is a git setting.
A value other than `ci` or `local` refuses rather than guess.
`tests/checks-mode.test.ts` runs each command with a scratch home's git settings.

## A local heavy run's place

A local `pnpm test:phone` gate and every local `playwright test` run, repeats included, take a place before their heavy work: the gate before it builds, a journey run in the e2e global setup before any test starts (`scripts/heavy-run-place.ts`).
Inside CI the job already holds its runner's place and asks for none.
With `BORROWED_PLACE` set, the run says it rides that borrowed place and asks neither the load line nor a crew place; the virtual Mac's measured load is not declared again.
A phone part the gate starts rides the gate's place.

Where the shell has this computer's load line, the run declares its needs there through `infinitary-load-axi run` and holds them until it ends (`docs/heavy-runs.md`).
The supervisor preserves the gate's input pipe on a separate descriptor before starting background children, including under dash; closing that pipe ends an admitted hold or terminates a still-waiting group.
A phone gate declares 4 processors and 8192 MiB and a journey run 4 processors and 4096 MiB, the shares the Mac mini's crew places reserve, which include the simulators launchd starts outside the run's process group (INF-1664).
The run prints the line's facts while it waits and says when it is admitted.
A run that ends or dies gives its hold back.
A run stopped while it still waits leaves the line: a small supervisor outside the run's process group ends the waiting command once the run's end closes its input.
Inside a run its caller already declared, the run rides that hold, and the line refuses it when the outer run declared less.

Where the shell has no line, the run asks the Mac mini's crew place service exactly as before, and says so first (the captain's "Add the fallback, no alpha needed").
The shell has no line when the command is not on its PATH, the shell has no task channel, or the app gives the task no line, as an app older than the line does.
The Mac mini is always busy with the fleet's checks, so there a local heavy run waits in the placement service's one line for a crew place rather than for a quieter Mac (INF-1541, the captain's "the mac will always be busy given how many other things our fleet needs to run").
The client (`scripts/crew-place.ts`) connects to the account's real `Library/Caches/infinitary-ci/crew-places.sock` (`INFINITARY_CREW_PLACE_SOCKET` overrides it), names only what runs (`phone` or `journeys`), prints each place in line it is told, and holds the place while its connection lives, so a run that ends or dies gives it back.
The service decides what each kind costs and where it ranks beside the checks; the paired contract is dotfiles-private's fm-placer crew socket (DOP-112).
With no service listening, as on any computer but the Mac mini, the run starts at once.
A refused request fails the run with the service's reason; a service restart is asked again, and a run it had granted is counted again at once.

`tests/heavy-run-place.test.ts` drives a journey run, the phone gate, a run killed while it holds its place, nested runs and each way a shell has no line through the real task channel and line.
`tests/crew-place.test.ts` drives the crew place client, a journey run and the phone gate against a stand-in service, from a shell with no line (`tests/helpers/noLoadLine.ts`).

## A main repair's priority label

Our own runners queue a main repair's checks ahead of other work when its pull request carries the `fixes-main` label.
The label is a project rule for infinitary-labs/infinitary only, not app behavior and not a setting (INF-1423, direction A).
A crewmate that repairs a failing main follows these steps:

1. It records the evidence that main fails, then confirms its own open pull request targets main from the same repository and its exact task branch.
   Diagnosis may come before or after the pull request exists, and resumed work repeats the confirmation.
2. It adds only `fixes-main` through the generic GitHub label tools, keeps every other label, and reads the labels back before requesting checks on that branch.
3. When it withdraws the repair, it removes only `fixes-main`.
   A write whose outcome is uncertain is checked by reading, never repeated blindly.
4. A closed pull request keeps the label as history: the service ignores it while the pull request is closed.
   Reopening restores eligibility, so the crewmate reassesses whether the pull request is still a main repair.

Priority never interrupts running work, and capacity, test gates and merge consent are unchanged.

## Native phone checks on the pull request

A pull request no longer starts `phone.yml` (INF-2139, captain: "let's pull journeys and phone checks off PRs now"): a crewmate whose change selects the gate requests it on its branch ("The phone check on request").
The pull request selection below stays in `phone.yml` for the continuous run on `main` that replaces it.
`phone.yml` selects the iPhone and iPad gate for `ios/`, the phone-card generator, the phone-contract generator with its shape guard, and the gate's own setup (`scripts/affected-phone.ts`).
A change to the generated phone contract that touches only its `public static let version` line, a first-number change included, does not select it; `pnpm check` still verifies the file is current on every pull request.
The setup inputs are `phone.yml`, `scripts/test-phone.ts`, `tests/helpers/phoneHome.ts`, `tests/helpers/phoneKeyboard.ts`, the activity writer `scripts/phone-activity.ts`, the leftover sweep `scripts/phone-leftovers.ts`, the check runner `scripts/phone-checks.ts`, the simulator selector `scripts/phone-simulator.ts` and its pin `scripts/phone-pin.json`, and the test plan helper `scripts/phone-test-plan.ts`.
The runner's diagnostic inputs also select it: `scripts/phone-guest-observer.ts` and `tests/helpers/phoneWebStacks.ts`, `phoneGuestLaunches.ts`, `phoneLauncherLog.ts`, `phoneLookupWait.ts` and `phoneProxyLaunches.ts`.
Setup the device gates never run does not select it: the chooser itself, the replacement helper `scripts/replaced-phone-runs.ts`, the local test home `scripts/phone-test-home.ts`, and the virtual Mac scripts `scripts/virtual-mac/phone.sh`, `phone-job.sh` and `vm.sh` while `PHONE_VIRTUAL_MAC` is unset.
Changes to general shared modules, connection/device code, packages or the lockfile alone do not select the native gate.
The chooser runs inside the `native-phone` job on the Mac, so no Linux job stands before it (INF-2125); it reads the comparison of the pull request's merge commit with its first parent, the base branch, and an unreadable comparison selects the gate rather than silently skipping it.
When the chooser selects no gate, as for a change only to the generated contract's version line, the job ends before it installs anything.
The `native-phone` job runs the disposable `scripts/test-phone.ts --both` gate on `MAC_RUNNER`, with `mini-mac` as its fallback label, never a paid hosted Mac.
When the job fails, or a run on request records, it keeps native result bundles, logs, published-client results and connection readings in the `phone-results` artifact.
The same command logs also live in the smaller `phone-logs` artifact, independently of the result bundles.
Each part's live simulator log lives in `phone-simulator-logs`, never in `phone-logs`, which keeps `phone-logs` within the app's 64 MiB artifact download.
The pictures the journeys took live in the small `phone-pictures` artifact, exported from the result bundles by device and part.
A failure on either device fails the job, and on a pull request the first failed part stops the other parts.
A newer push cancels its pull request's older phone runs whose native job has not started its device gate (`scripts/replaced-phone-runs.ts`), so it never waits behind them.
That gate checks and builds once, starts one simulator per device, and runs the phone journey's six parts on each, twelve in all, one after the other on their device's simulator with the two devices side by side, each part with its own test home and a clean app (`docs/ios.md`, "Disposable verification").

### The phone parts a pull request runs

On a pull request the gate runs only the closest of the journey's six parts within a six-minute budget, as the Mac journeys do ("Journeys on the pull request"), and the nightly check of `main` runs every part.
The chooser (`scripts/affected-phone.ts`) gives each part a distance: 0 when the change edits UI test code the part runs, 1 when it edits a file in the part's owner table (`PART_OWNERS`), and 2 for any other phone input.
It reads a UI test change by its functions: each changed line counts for the test functions around it, added lines in the new version and removed ones in the old, and each part reaches its test and every function it calls by name.
The rest part also starts from every test no other part names, and a change to the app-hosted tests puts it at 0.
A blank or comment-only line counts for nothing; a line outside any function, or a test file it cannot read or parse, counts for every part.
It keeps the closest part, every part at 0 even past the budget, and any other while the kept minutes stay within `PHONE_BUDGET_MS`; ties go to the shorter part, so a change only to setup the gates use runs rest.
A part's minutes are its longer device's time in the newest passing on-request check of `main` whose `phone-logs` artifact holds `part-times.json`, which only a full gate writes; a passing check of some parts is passed over for an older full one.
With none readable, or with `PHONE_VIRTUAL_MAC` set, every part the change reaches runs.
The job summary names each kept and left part with its distance, minutes and reason, and the `phone-placement` artifact keeps the same as JSON.
A part the pull request leaves is checked after it merges, by the nightly check of `main`; an author who wants every part first runs the phone check on request on their branch.
`tests/phone-chooser.test.ts` replays real changes merged to `main` through the chooser.
Unlike the desktop journey workflow, a device gate that already started finishes and deletes the simulator it started for each device.
A manual rerun of a replaced version stops before its gate.
So does a run whose pull request merged or closed while it waited in the phone line, so it never holds that line for a device gate; the nightly check of `main` checks what merged.
On the Mac mini's own runners, native jobs share `mac-mini-phone` across pull requests, with `queue: max` and `cancel-in-progress: false` at the job level; up to 100 phone jobs can wait without newer jobs replacing them.
A job on the virtual-Mac label (`VIRTUAL_MAC_RUNNER`) takes a group of its own, so phone checks run side by side in the virtual places (`docs/ios.md`, "A phone check the placement service puts in a virtual Mac").
Desktop journey jobs from different pull requests remain parallel.
Desktop journeys and native phone gates run directly, without a command lease, so real and virtual Macs can check concurrently.
The phone workflow keeps its configured concurrency groups; they do not exclude desktop checks or a local phone command.
The native job retains its 165-minute job limit for setup, the device gate, cleanup and evidence upload; there is no command-admission wait.
`pnpm test:phone` checks the configured execution mode, then runs `scripts/test-phone.ts` directly.
`tests/mac-check-lock.test.ts` executes the workflow and package command strings with held workloads to verify overlap, failure status and cancellation.
With the repository variable `PHONE_VIRTUAL_MAC` set, the device gate runs in a fresh virtual Mac on its own runner (`docs/ios.md`, "The phone check in a virtual Mac"); `tests/phone-ci.test.ts` evaluates the job's steps both ways, and `tests/virtual-mac-phone.test.ts` runs its scripts against a stand-in tart.
A job the placement service runs inside a virtual Mac runs both devices side by side, one simulator each; a real-Mac gate uses the device gate's default concurrency, which is the same two.
The fixture, simulator identity and unsigned Xcode configuration are described in `docs/ios.md`, "Disposable verification".

### The phone check on request

`phone.yml` also runs on request (`workflow_dispatch`), such as the nightly check of `main`: `POST /repos/{owner}/{repo}/actions/workflows/phone.yml/dispatches` with `{"ref":"main","return_run_details":true}`.
A default run on request skips the chooser and runs every part of the device gate whatever changed; the nightly request stays on this default.
For a crewmate checking its own branch, send `{"ref":"<branch>","inputs":{"affected":"true"},"return_run_details":true}` to select touched parts conservatively.
The optional `base` input defaults to `origin/main`.
This selection reuses `PART_OWNERS` and the Swift function reach reader, without a timing budget.
Shared phone inputs, unreadable comparisons or test changes, and the fixed `PHONE_VIRTUAL_MAC` route run every part instead.
An affected request with no reached parts skips the native job; the summary and `phone-placement` artifact record the selection.
Explicit `parts` still overrides automatic selection for diagnostic runs.
Neither route starts a release, TestFlight or App Store step.
It has no pull request, so `scripts/replaced-phone-runs.ts` cancels nothing and never stops its gate.
No part on either device stops another, and inside the gate a failed Swift package test no longer skips the simulator tests (`scripts/phone-checks.ts`); every failure is reported and fails the job.
For an isolated overlap proof, its optional `mac_runner` input selects a runner for that request only, as `verify.yml` does; shared runner variables stay unchanged.
An explicit runner uses the shared `mac-mini-phone` queue; the fixed `PHONE_VIRTUAL_MAC` switch, when set, still takes precedence.
Without that input, it takes the same line and runner as a pull request's phone check: its own fresh virtual Mac on the virtual-Mac label, otherwise the `mac-mini-phone` queue, without excluding desktop checks.

## Journeys on the pull request

A pull request no longer starts `journeys.yml` (INF-2139, captain: "let's pull journeys and phone checks off PRs now"): a crewmate runs the journeys its change reaches itself, which `node scripts/affected-journeys.ts --base origin/main` lists, locally or, in CI mode, by requesting them ("Journeys on request").
The pull request selection below stays in `journeys.yml`, `linux-source` included, for the continuous run on `main` that replaces it.
A pull request gets `journeys.yml`'s Linux `choose-journeys` check, which installs the locked tools, selects the journey files and writes the reasons and placement in its summary.
The chooser downloads `e2e-results` from the newest successful `verify.yml` run that has an unexpired artifact of that name and sums each journey file's measured Mac durations.
Only a run of every journey keeps that artifact, so a requested check of the tagged tests alone never becomes the journeys' times.
It finds that run in the workflow's plain run list, newest first, never through GitHub's search by result, which has answered no run while passing ones were listed.
It asks for that list without each run's pull requests, which it never reads: working them out has run past GitHub's time limit and answered 502, and leaving them out drops no run.
It reads each passing run's artifact list and keeps paging past runs without usable `e2e-results`, including installer-only verifications.
If no passing run has usable results, the chooser fails rather than silently dropping journeys; run full verification to supply fresh timings.
An artifact-list error or a failed download still fails the chooser.
`scripts/journey-budget.ts` places every chosen file on Linux, and on the Mac mini (the `MAC_RUNNER` label) only the chosen files that hold a test tagged `MAC_ONLY_TAG`, whose `affected-journeys` job runs only those tests (`--grep @mac-only`), as "Tests that need a Mac" says.
A file with a tagged test runs on both: its tagged tests on the Mac, and its other tests on Linux, where its tagged tests skip or run their shared steps.
A tagged test is never sent to Linux alone.
`linux-overflow` packs the chosen files into six-minute groups separately for parallel and desktop files, on Linux machines running beside the Mac.
It is at most five jobs, one per Linux place on the PC (`LINUX_PLACES`, INF-1720's plan).
For modest selections the existing grouping and job count stay unchanged.
For five-job candidate estimates, the chooser additionally reads compact observations from the newest successful default-branch run of each of `journeys.yml` and `verify.yml`.
Missing or expired reports retain the prior placement; artifact API or download failures still fail the chooser rather than hiding an access problem.
The timing reader checks schema, Linux X64, run/attempt/checkout identity, successful final job conclusion, complete selection, lane ownership and compatible configured/actual workers.
It rejects ambiguous reusable-job identities rather than guessing between overlapping jobs.
Each selected file needs a compatible reading; partial coverage retains the entire prior placement rather than mixing Mac test-work sums with Linux elapsed intervals.
An observed skip-only file has zero executed work but stays selected, unlike a missing file.
The estimator preserves file boundaries, schedules files over the observed parallel worker count, keeps desktop serial, and adds observed setup/cleanup outside the executed file span using final job timestamps.
It uses the largest compatible observed file interval and lane overhead, not a replacement platform multiplier.
The allocator evaluates advisory lane allocations within the same five jobs, retaining each nonempty lane and accepting only a lower predicted completion without higher predicted summed job occupancy.
Automatic execution retains the conservative placement until live evidence supports adopting the calibrated model; candidate placements and their timing source remain visible in the placement artifact and summary.
An explicit `--apply-linux` request on `scripts/journey-budget.ts` runs the candidate for verification; `journeys.yml` does not pass that flag.
It never hard-codes a three-plus-two split.
The conservative fallback still gives each lane places by its share of estimated work, at least one, and places a file into its lane's least loaded job, which may exceed six minutes.
A new or previously skipped file uses the slowest measured file in its lane, and the summary lists it as unmeasured.
Conservative Linux estimates use the plan's observed rates: one Mac minute of parallel work per Linux minute and 0.6 Mac minutes of desktop work.
A file stays intact, so an indivisible slow file may exceed six minutes; conservative estimates exclude setup, and neither model predicts runner waits or shared-machine slowdown.
Every selected file runs on Linux exactly once in this placement; the independent Linux starter coverage still runs too.
The chooser keeps its selection and placement as the `journey-placement` artifact.
The full Mac suite remains part of every alpha's `verify.yml` and of the nightly full check; a break that only a Mac shows in an untagged test first surfaces there.
When the chooser passes with no tagged files, the Mac job skips by its own condition without taking a runner; when the chooser fails, its failed check holds the merge.
Both success and a job-condition skip satisfy the app's green rule.
If GitHub branch rules ever require `affected-journeys`, they must require `choose-journeys` too: a job skipped because its prerequisite failed does not itself hold a merge.
It reverses captain decision B of 2026-09-15 for pull requests in part (FI3-1305, the captain's answer of 2026-10-08).
That decision kept every Mac journey for the alpha because a hosted Mac was ~$200 a month, and its price was a loop: a change merged on green Linux checks, the alpha's full Mac run found one to three broken journeys of about 610 hours later, and every other pull request waited on the fix.
Twenty-one failing sites in five days were certain breaks after an intentional product change, found at the alpha cut; the check puts them on the change that caused them.
`scripts/affected-journeys.ts` chooses the files from the diff (`--base`, `--head`, `--json` for the reasons):

1. a spec file the change edits;
2. a spec whose import closure reaches a changed helper and imports one of its changed exports, directly or through another helper: one under `tests/e2e/`, a shared one elsewhere under `tests/` such as `tests/helpers/`, or a script.
   The closure stops at a module of `src/`: a product change reaches a journey through rules 3 to 7 and 10 instead, which match words in the spec and its helpers under `tests/e2e/`;
3. a spec that imports a changed module of `src/shared/` and names a symbol that module's diff adds or removes (a declared property of four or more letters or an export, with at least one capital letter);
4. a spec, or a helper most journeys do not import, that names a `data-*` hook, as a whole token, that the change adds or removes in `src/`;
5. a spec, or a helper most journeys do not import, that holds a sentence of two or more words as its own quoted string, one the change adds or removes in a string of `src/`;
6. a spec, or a helper most journeys do not import, that names a `data-*` hook, as a whole token, that the edited part of a file under `src/renderer/` draws before or after the change, even when the change adds or removes no hook.
   The parser uses the smallest enclosing JSX subtree plus ancestor container hooks, or the enclosing top-level declaration for non-JSX edits, following local declaration consumers.
   Import edits, unowned setup, absent hunks and deleted owners retain conservative coverage;
7. a spec, or a helper most journeys do not import, that calls a `window.infinitary` method, or names a read, whose message between the window and the core the change edits (`scripts/window-messages.ts`);
8. a targeted fallback row matches a changed path, even without a changed hook, symbol or sentence;
9. a commit of the change names the journey in a `Journeys:` trailer;
10. a spec, or a helper most journeys do not import, that reads words a string of `src/` serves, when the change alters what it reads.
    It reads them with a regular expression of its own holding a word of four or more letters, or its stand-in scripts a tool by name, as `name: "check_change"`, that most journeys do not script.
    Only quoted strings of two or more words on the diff's lines count; a comment, and a one-word value of the code such as `"checked"`, serve nothing.
    The rule compares the pattern's matches, or the tool's mentions, on the removed and added strings of each file, so words that only moved choose nothing;
11. the freeze journey (`main-thread-freeze.spec.ts`), when the change edits code the main process runs, under `src/core/`, `src/main/` or `src/shared/`, other than a unit test (`FREEZE_JOURNEY`).
    Any such code can hold the main thread on a long record with no hook, symbol or words changing (`docs/freeze-recorder.md`, "Before a change merges").
    It is its own rule beside the fallback table, because it reaches nearly every change and the fallback table's replayed merges predate it.

A journey calls the window's interface directly, such as `window.infinitary.retention.scope()`, so a changed answer breaks it with no hook, sentence or symbol of its own changing.
`knowledge-gate.spec.ts` compares that answer whole, so a new field in it breaks the journey (INF-1136).
Rule 7 reads a message as a channel of the contract, `invokeContract` or `pushContract` in `src/shared/ipc.ts`.
The channel changes when the code of its entry changes, or the code of a declaration of `src/shared/ipc.ts` that the entry uses, directly or through another declaration there.
A method of the preload's `window.infinitary` object changes with its channel or with its own code in `src/preload/index.ts`, and a read of `readCatalog` in `src/shared/reads.ts` with its channel, its own entry or a declaration of that module it uses.
The journey names the method by its whole path, as `window.infinitary.retention.scope` or `window.firstmate.retention.scope`, or holds the read's name as its own quoted string.
A comment or a line break is not code, so an edited comment on a channel chooses nothing.
A schema the contract imports from another module is not followed: the task and card schemas there change with most changes, and most journeys call a method that carries them.
A change that reaches a journey through such a schema names it in a `Journeys:` trailer.

A core change reaches a journey through the words it serves the model, which the journey's stand-in reads with no hook, sentence or symbol of its own changing, so rule 10 reads them (INF-1255).
Project scopes (PR #470) added a context note holding "a project or scope", and `programRun.ts` read the project the captain named with `/project (\S+)/`, so the note named the project "or".
Merge anyway (PR #462) let a completion card up once every failed check carries its `check_change` diagnosis, and its refusal says so; `checkRepair.ts` scripts `check_change` and relied on that refusal.
A sentence of a template literal that spans lines carries no quote on its own line, so rule 10 does not read it; a change that reaches a journey that way names it in a `Journeys:` trailer.

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

The author of a change knows reach that no rule above reads, such as a journey that imports a module but never names what changed in it (PR #167 broke `now-panel.spec.ts` through `src/shared/taskFacts.ts` that way).
The author names each such journey in a trailer on any of the branch's commits, separated by commas or spaces, as a file name with or without `.spec.ts` or as its path:

```
Journeys: now-panel, task-crewmate.spec.ts
```

The chooser reads the trailers of every commit between the base and the head, adds each named journey with the reason "the change's commits declare it reaches this journey", and the summary shows that reason.
A declared journey is placed beside the screen readers, ahead of the importers of a distant shared helper.
A name that is no journey under `tests/e2e/` fails the chooser rather than silently running nothing for it.
A declaration only adds journeys; it never removes one a rule chose.

A changed helper selects only journeys whose import closure imports one of its changed exports.
The chooser compares top-level declarations and bodies, follows references to edited private declarations, and reads original names through import aliases.
A change to imports or setup before the declarations can affect every export.
Importing a shared module is not enough, and an ordinary word most specs already contain does not count.
A hook name inside a longer token, such as a document path, does not count.
A fragment inside a longer quote does not count, and a sentence held only by the stand-in does not select every journey that reaches it.
The hook and sentence rules ignore app unit tests and cancel a token present on both sides of a file's change; the drawn-hook rule reads the whole changed screen file, not only its diff, and ignores a unit test beside it.
They read only the journey and its own helpers, not helpers most journeys import.
They read the text, not the product's meaning.
They match the whole hook and the whole quoted sentence, so a fragment in the shared stand-in does not select every journey.
A change no journey or helper it imports reaches runs nothing and the chooser reports so in its summary.
A change to an export every journey imports still runs them all, because that is the break this check exists to catch.
A changed screen file that draws a hook most journeys read, such as `HomeScreen.tsx` with `data-stage-entry`, likewise runs most journeys.
A model behavior only a few journeys need lives in its own scenario file instead ("A journey's own scenarios"), so an edit to it runs only those journeys.
The Mac job refuses an empty file list, builds once, then runs the chosen files' tagged tests with `--no-deps`, as a local run does (`docs/testing.md`, "Full e2e runs are CI-only").
It does not repeat the release's other stages: the run-alone pass, the replay gate, the package smoke and the full suite stay `verify.yml`'s, inside every alpha and on demand.
A newer push to the same pull request cancels the older run, because the Mac mini is one machine.
`tests/affected-journeys.test.ts` pins the selection and `tests/release-contract.test.ts` the workflow's shape.

The native phone gate uses the same clock and cap through `PhoneWaits.swift`, with 1200-second ordinary XCTest allowances and a 60-minute gate limit on every route; graded native runs retain Xcode's own allowances and wall-clock waits (`docs/ios.md`, "Disposable verification").
Its on-demand `parts`, `starve` and `perf` inputs select native parts and reproduce twelve-second stalls without changing assertions or app deadlines.

### Journeys on request

`journeys.yml` also runs on request for any branch, with the journeys it names: `POST /repos/{owner}/{repo}/actions/workflows/journeys.yml/dispatches` with `{"ref":"<branch>","inputs":{"files":"now-panel task-crewmate.spec.ts"}}`.
The names are read as a `Journeys:` trailer's are, separated by spaces or commas, and a name that is no journey fails the chooser (`scripts/affected-journeys.ts --named`).
The chooser places the named files exactly as it places a pull request's, every one on Linux and their tagged tests on the Mac mini, and the run skips the pull request's Linux starter coverage.
Its `mac_all` input runs every named journey on the Mac mini as well, every test of it, for a check of the Mac itself such as a `starve` experiment.
It is a computer's route for journeys in CI mode ("Where the heavy checks run"), such as a journey a change is still being written against.
Its optional `mac_runner` input selects an isolated Mac runner for that request, as `verify.yml` does, without changing shared runner variables.
Each request is its own concurrency group, so another request on the same branch, `main` included, never cancels it, whatever journeys either names (INF-941); only a newer push to a pull request replaces that pull request's older run.
A request its requester no longer needs is cancelled by its run's id (`POST /repos/{owner}/{repo}/actions/runs/{id}/cancel`).

The `starve` input runs the Mac journeys through the load controller, `scripts/starve-check.py`, after the build.
The controller runs the command's own process tree for 0.1 s, stops it for 0.2 s, and adds a 65-second stop after each 20 seconds of that, longer than the one-minute journey default.
It walks the command's known processes and their children, detached sessions included, through `libproc` on macOS and `/proc` on Linux, never a system-wide listing, which on macOS can wait on an unrelated process part-way through exec.
It rescans a stopped parent for children it started meanwhile, rechecks each process's identity before letting it go, and never signals a process outside the tree.
On Linux it counts a process waiting in the kernel with a stop already pending as stopped, since it stops before it runs again: a parent in vfork waits that way until its child, stopped before exec, is let go.
It prints its schedule, the processes it found and the ones stopped at each long stop.
Cancelled, it lets the tree go and gives it five seconds to end before killing what is left.
Its own experiment limit is 15 minutes (`--timeout`, required, in seconds), and its run, pause and stall arguments reproduce another chosen load; compare unchanged and changed code with the same arguments.
`tests/starve-check.test.ts` holds it over real detached process trees.
The `perf` input sets `INFINITARY_PERF_BUDGETS=1` for the Mac command, for a quiet graded run.
Neither input changes where the files are placed or the Linux overflow jobs.

## A journey's own scenarios

The shared stand-in model (`tests/e2e/mockProvider.ts`) answers every journey, so nearly every journey imports it and an edit to it runs them all.
A scripted model behavior that only some journeys need is a scenario in its own file under `tests/e2e/scenarios/`, imported only by those journeys.
A scenario is the stand-in's `Scenario` type: a start function that returns an answerer.
The stand-in calls the start function once when it starts, so any state the scenario keeps lasts as long as that stand-in.
The answerer reads one request (`ScenarioRequest`, which also carries whether it came on Anthropic's messages wire and the stand-in's port, for a card that loads a page the stand-in serves) and returns tool calls, text, a refusal the way the service sends one, or `held`, a turn the stand-in keeps open the way a crewmate goes on working; `undefined` passes the request on.
An answer's `afterMs` holds it back that long, the way a model takes its time over a turn's last line.
A journey names its scenarios where its stand-in starts: `launchApp({ withMockProvider: true, scenarios: [reviewedTier] })`, `launchClaudeCrew({ scenarios })`, or `startMockProvider({ scenarios })` for a stand-in the spec keeps across launches.
The kept-merge and guided-merge scripts read git output through `scenarios/mergeShell.ts`: a background job receipt ends the turn, a supervision ask leaves the merge assignment intact, and the exit continues it with the completed output.
Their Pi commands request background execution even on a quiet host, so `settle-effects.spec.ts` exercises that boundary without a sleep or a load-dependent command.
`scenarios/mergeShell.test.ts` replays inline and background completion with disposable git commits and the bash tool's own receipt and exit words.
A relaunch with `reuseMockProvider` keeps the scenarios that stand-in started with, and `launchApp` refuses `scenarios` when it does not start the stand-in itself.
The stand-in asks the named scenarios in the order named, after the first mate's answer-missing retry and a spec's scripted turns (`scriptFirstmateTurn`) and before every shared answer; the first answer wins.
Words a journey and its scenario share, such as a marker or a card title, live in the scenario file, and the journey imports them from there.
A shared helper the scenarios read, such as `calledTool` or `sinceLastUser`, stays in the stand-in, which exports it.
A behavior that answers before the scenarios are asked, or that the spec releases through the stand-in's own controls (`releaseThreadAnswer`, `releaseHeldFirstmate`, `refuseClaude`), stays in the stand-in.
So do the answers to the app's own words, such as the first-run welcome, a report that declares its work finished and a crewmate's build-in-place brief, and the captain's words nearly every journey's first mate needs: commission a crewmate, settle, steer or cancel a task, an answer card and a catalog change.
Every other scripted behavior, whether one journey or several use it, is a scenario.
Only a journey or another scenario imports a scenario file.
`tests/lint/e2e-scenario-imports.grit` refuses the import anywhere else in `tests/e2e`, in `pnpm check`, because one import in a shared helper puts the scenario under every journey again.
An edit to a scenario file then picks only the journeys that import it, by rule 2 of "Journeys on the pull request".

## Per-run e2e evidence

Each Playwright run keeps its result directories (traces, error contexts, failure pictures, `testInfo.outputPath` files) and its JSON result in `test-results/runs/<UTC start>-<runner pid>/` (`tests/e2e/runEvidence.ts`), printed as `This run's evidence: …` before its tests start.
Every `launchApp` keeps a unique `launches/<pid>-<id>/` folder inside that run, including launches shared by a file's hooks and relaunches after a restart.
It streams `main.stdout.log`, `main.stderr.log` and `provider.requests.jsonl` while the app runs, then copies app-owned `crewmates/<task>/sessions/` before and after closing, before scratch cleanup removes userData.
The provider record keeps decoded request bodies with sequence numbers and timestamps, including tool-result follow-ups, never authentication headers; a reused provider replays its history to the new launch's record.
`launch.json` identifies the disposable userData and worker; no account store or whole HOME is copied.
The existing failure uploads in `journeys.yml`, `source-journeys.yml` and `verify.yml` already keep this run directory under `test-results/`.
Main-process streams attach as soon as Playwright returns the launched process; a failure inside `electron.launch` itself has only Playwright's launch error, not these streams.
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
  `verify.yml`'s `linux-e2e` runs it over every spec file across four isolated Linux jobs, `journeys (run alone N/4)` ("The Linux source desktop", below), keeps each share’s result as the `e2e-alone-N` artifact and lists its counts and failures in that job's summary.
  A test that runs only on a Mac carries `MAC_ONLY_TAG` (`tests/e2e/tags.ts`) beside its own `test.skip` and reason: on Linux it is recorded as skipped, and `verify.yml`'s mac lane runs those tests alone (`--tag @mac-only`) after its other stages, whether the suite passed or failed, keeps their result as the `e2e-alone-mac` artifact, and lists their failures apart from the suite's in the job summary ("A red verify's evidence", below).
  A test that skips without the tag, or skips on a Mac, fails the pass, since it never ran alone.
  `tests/release-contract.test.ts` holds both steps.
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

- **The helper layer** is `tests/e2e/rails.ts` (the rails' frames, the now rows, and a task's feed lines by event and key: `reportLine`, `startedLine`, `putInLine`, `statusLine`, `taskLine`, with `taskKey` to find the key and `feedLineOf` for a task-less line in `feedLineFrom`'s own words; `recordFact(page, fact)` selects a task-record detail value by the stable `RecordFact` identity in `src/shared/recordFacts.ts`, painted as `data-record-fact` independently of its displayed label; `recordDrawings(page, taskId)`, every drawing of a task's record on the stage, shown, or held while the next card gets ready or drops away, which a journey that hides a record waits to be gone, the sign its Hide has finished; `expectRecordBody(page)`, the record body once its frame has drawn, which a journey that presses the record's controls waits for inside the open, because the host reveals the record before that frame draws and the frame then grows the card), `tests/e2e/stack.ts` (the card stack; `shownCard(page, title)`, the shown card by the region its title names, never by the title's words, which the last turn's reply may repeat; `expectNoCard(page, title)`, no open card of that title in the core's stack or on the stage; `cardMeta(page, title)`, the shown card's meta line over `data-card-meta`; `pager(page, count)` and `pagerAt(page, position, count)` over `data-card-pager`, never the pager's words; `cardSurface(page)`, the shown card's own box, never the stage's fixed-height `[data-card-layer]` envelope around it; a settle card's `factsStrip` over `data-fact`; and `dragCardTo(page, width)`, the captain's edge drag, which holds the edge beside the card's chrome and travels over it, never over the sandboxed body frame), `tests/e2e/prompt.ts` (the task prompt), `tests/e2e/projects.ts` (`projectRow(page, id)` over `data-project` in Settings → Projects; policy outcomes come from `window.infinitary.repos.list()`), `tests/e2e/crew.ts` (`crewPlaneCounts` over `data-plane-counts` on the visible orbit, read once its first frame has painted; `pointAtCrewmate(page, wanted)`, which waits until the planes have settled in (`data-plane-blend`) and that crewmate is listed, then points at its name when it is a part seated at its constellation node (`data-constellation-crew`) or sweeps the pointer along the orbit `data-plane-crew` names it on, since a start the record already names can reach the orbit a moment later and a part takes its seat only once the planes have settled; `waitForFirstmateIdle(page)`, the character has drawn and the first mate's turn has ended even while a card hides its frame), `tests/e2e/lastTurn.ts` (`yourBubble(page)` and `mateBubble(page)` over `data-last-turn-bubble` in the pair that stays, the first mate's `data-state`, and `bubbleWords` for a bubble's whole words; `askFirstmate(page, text)`, which sends a message and waits for the first mate's answer to it as an order of typed events, `user_turn`, then `firstmate_reply`, then its busy signal down, never a glimpse of the character's working state, which a quick turn can pass through between two polls; docs/composer.md "The last turn"), `tests/e2e/starters.ts` (`starterFor(provider, slot)` over `STARTER_SLOTS`), `tests/e2e/taskTimeline.ts` (`SPAWNED_TASK_START`, the event kinds a spawned task's start leaves on its timeline, which a journey extends with its own turn's), `tests/e2e/taskBrowser.ts` (a task's browser: `browserView(page, taskId)` over `data-task-browser`, `canvasReading` for the pictures the view drew, `pageSays` and `clickOnPage` on the task's hidden page itself, `windowCount`, `filesHolding` for what no file may keep, `stopTaskBrowsers` to make room under the cap of four, and `closeSite` to close a test site with every connection a browser's session still holds open to it) and `tests/e2e/layout.ts` (layout as invariants: `within(inner, outer)` names the edges that escape, `intersects`, `expectClearOf(page, surface, ...controls)` for a surface inside the window and clear of the controls still needed, `overflows(el)`, `tokenPx(scope, name)` for a token as the window resolves it, `pseudoBox` for where a `::before`/`::after` really paints, `settled(page, read)` for boxes once a move has finished, two reads agreeing across a painted frame of the page, `atRest(target)` for a box read once no motion plays on it or on a box it sits in (a card grows into place as it arrives, its controls already working), and `minimumWindowSize`/`resizeWindow` for the window's own minimum).
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
  Biome's rule engine builds a rule's regular expression again at every node it tests, so a rule names a method or matcher as a plain string (`"toBe"`), and puts an `includes "text"` check ahead of each regular expression, with text every match must contain (INF-2138).
  `tests/e2e-contract-lint.test.ts` holds a fixture line on each side of those checks, so a check that skips a real finding fails it.
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
`detailsReveal.spec.ts` opens the record template's Activity under the real reveal stylesheet and focuses inside it in the same task, protecting a body that takes focus before its fade draws a frame.
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
await heroShot(app, page, { region: card, anchors: [panelTitle], name: "<entry id>" });
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
It shows each theme without saving it: the main process hands the window the captain's saved preferences with that theme, as the core pushes them after a change, and sets the window material to match, then puts the saved theme back.
Switching through Settings would be the captain's own change, which writes its line in Activity (`docs/orchestrator-contract.md`, "Settled runs"), so a pair of Activity, or of the newest line a collapsed Activity shows, would hold that line in one picture and not the other.
`tests/e2e/hero-shot.spec.ts` checks that Activity shows the same lines at both pictures and that the pair files nothing on the record.
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

## Signed Mac installation and updates

`verify.yml` with `installer_only=true` runs `mac-installer.yml` with its build and Apple-silicon checks on the placement service's `mini-mac-virtual` virtual-only label and Intel on `macos-15-intel`, using the selected ref and existing release credentials without publishing anything.
Its scratch signing home, real notarized binaries, native replacements, saved-work checks and failure cases are described in `docs/alpha.md`, "Isolated signed verification".
A release no longer runs it: each alpha runs the update check instead, and a pull request that changes the update path runs this check on request (`docs/alpha.md`, "The update check").
The local `mac-updates.spec.ts` journey owns channel selection, update consent, progress, restart recovery and keyboard access, with native effects replaced; it does not prove signed installation.
The affected-journey selector retains that journey for changes to the core Mac controller or shared renderer update store, including changes with no new words or hooks.

## A red verify's evidence

`verify.yml` keeps what the e2e run left on the run itself, so a red release is read from its page instead of re-run blind (scout `fm3000-e2e-rigidity-s2`, I5; held by `tests/release-contract.test.ts`):

- **`e2e-results`** is Playwright's JSON result (the `json` reporter in `playwright.config.ts` beside the unchanged console reporter; verify's e2e step names its path, `playwright-report/e2e-results.json`, through `PLAYWRIGHT_JSON_OUTPUT_FILE`), kept whenever the suite ran.
- **`e2e-failures`** is, on a failed run, everything under `test-results/` (the run's own directory under `test-results/runs/`, "Per-run e2e evidence" above): each failed journey's `error-context.md` (the error, its call log and the window's accessibility snapshot), `trace.zip` (the runner's steps, errors and sources) and `test-failed-*.png` (the app window), beside whatever the specs wrote.
  Playwright takes the picture and the snapshot as the app closes - inside the test, or in `afterAll` as it retires the worker after the failure - so a journey that shares one app across its file gets them too.
  The picture costs about 100 ms per app close and is dropped when the test passed.
- **`e2e-demos`** is every demo a journey recorded (`testInfo.outputPath("demo")`, "Recording a demo" above), kept whenever the suite ran, passed or failed, so a requested demo can be watched from the run's page.
- `e2e-failures` is kept 7 days, the others 14 days.
  None can fail the job, and none runs when a stage the suite needs kept it from starting.
- **`e2e-alone-mac`** is the run-alone pass's directory for the Mac-only tests ("Each test owns its prerequisites", above): `alone-results.json`, with every test it ran, how each ended and its first error, and each test's output, beside the trace and picture of each that failed; kept whenever the pass ran.
- **Every stage reports**: each stage waits only on the stages it needs, never on every stage before it (INF-663).
  The unit suite, the client check and the replay gate need the install; the e2e suite needs the build, the signed dev Electron and the recorder; the package smoke needs the build and the signed dev Electron; the four package checks need the package.
  So a red unit test still leaves the e2e suite's and the package's results on the run, and the linux-checks lane's checks and build each run whatever another of them did.
  The job still ends red on any failure, so `release.yml` still refuses to sign.
- **The job summary** names the requested ref and the exact commit checked out, the first failed stage, the e2e counts (skipped includes a serial file's tests that did not run), every failure in the order it started and the first one's assertion, and then the Mac-only run-alone tests' counts and each that failed alone.
  It reads the stages' outcomes and the JSON, never the log's prose, and decides nothing about which failure caused which: that stays with whoever reviews the evidence.
  It reports and never gates.
- **What they can hold:** every app ran on a throwaway userData and HOME, no verify step holds a secret (`release.yml` passes it none), and a trace records the launch environment's shape, never its values.
- Zero retries and the release-only trigger are unchanged.
  A local run writes the same files into its own `test-results/runs/<run>/`, the JSON beside them ("Per-run e2e evidence" above); a `--reporter` flag replaces both reporters.

## A virtual Mac as a runner

On the Mac mini, start a local virtual Mac only under `borrow-virtual-mac --label <text> --minutes <n> -- <command>`.
It borrows `mini-vm1` or `mini-vm2`, never a crew place; do not add a load-line declaration, crew place or hand-made hold for that virtual Mac.
The borrow owns the whole command's lifetime, ends at completion or the later of one hour and the declared minutes, and cleans up a leftover virtual Mac.
Outside CI, `image.sh`, `run.sh` and `phone.sh run` enter that command automatically where it exists, using `BORROW_MINUTES` (required there) and optional `BORROW_LABEL`.
An existing `BORROWED_PLACE` reuses the outer borrow without asking again; scripts use its `BORROWED_VM` name and granted processor and memory size.
Where the command is missing, the scripts start at once as before; CI keeps its existing placement.
For example, `BORROW_MINUTES=30 scripts/virtual-mac/run.sh tests/e2e/mic-access.spec.ts` borrows for the journey and cleanup.
For a phone check, use `BORROW_MINUTES=45 scripts/virtual-mac/phone.sh run <results folder> iphone ipad`; split `start`/`gate`/`delete` calls are only for CI, an explicit outer borrow, or a computer without the command.
A local split `start` refuses where borrowing is available, because returning from it would free the place before the gates ran.

A virtual Mac runs the journeys like the Mac mini does only when its image holds two things the app and macOS look for there.
`scripts/virtual-mac/image.sh [name]` builds that image with tart (`brew install cirruslabs/cli/tart`, or name it with `TART`), under tart's own `TART_HOME`, `~/.tart` by default.
It clones Cirrus Labs' `macos-tahoe-xcode` image of the Xcode `scripts/phone-pin.json` names with 6 CPUs and 16 GB by default (the granted size under a borrow) as `infinitary-lane`, and `provision.sh` adds Node 24, the `packageManager` pnpm, a warm pnpm store and the two things below inside it.
Each part checks itself as the image is built, and the image is renamed into place only once all of them pass, so a fix lands in the script and never in an image by hand.
`scripts/virtual-mac/run.sh <files>` runs journeys in a fresh clone of the image the way `journeys.yml` runs them on the Mac mini, on the working copy's committed version, keeps the run's log and `test-results/runs/` in `test-results/virtual-mac/`, and deletes the clone.
`scripts/virtual-mac/phone.sh` runs the phone check's device gates in a clone of the same image when `PHONE_VIRTUAL_MAC` is set (`docs/ios.md`, "The phone check in a virtual Mac").

### One image for every project

The Mac mini's placement service (`dotfiles-private`) runs every project's Mac jobs in fresh clones of this one image, two at a time, and deletes each clone after its job.
It brings its own GitHub runner into each clone, so the image holds none.
Provisioning installs its checksum-verified Node archive under `$HOME/tool-cache/node/<version>/arm64`, checks the executable's version, then writes `arm64.complete` for `actions/setup-node`.
`$HOME/node` links to that installation, preserving the guest services' and login shells' path.
The placement service points virtual runners' `RUNNER_TOOL_CACHE` at `$HOME/tool-cache`, outside the runner's wiped `_work`, so the first job in a fresh clone finds Node without downloading a manifest or archive.
After reboot, the image builder checks the completion marker, cached executable and shared installation before publishing the image.
`provision.sh` fails the build unless the tools those jobs' workflows name are there: `git`, `gh`, `python3`, `perl`, `swift`, `xcodebuild` and `xcrun`, and the iOS 26.1 runtime sshhip's full simulator suite explicitly requests.
The base is Cirrus Labs' image of the Xcode `scripts/phone-pin.json` names, and the build refuses it unless that Xcode is the one selected and the pin's iOS simulator build is available; provisioning downloads that build from Apple when the base lacks it (`docs/ios.md`, "Disposable verification").
Neither base provides sshhip's iOS 26.1 fixture.
Provisioning also updates the guest's Homebrew and installs its Python and Bash, refusing an image without `tomllib`, Homebrew's tap-trust command or Bash 4+ on the job's path.
The full Mac gate consumes Python and Homebrew, and sshhip's simulator admission wrapper uses Bash's `coproc`; macOS's Bash 3.2 is not sufficient.
Both Tart services prepend the image's Node and Homebrew to their child process path and use launchd's `ProcessType Interactive`, so their children do not inherit background scheduling.
`guest-services.sh` configures both plists without replacing or reloading the responsible agent, preserving its microphone grant.
The builder requests shutdown inside the guest and waits for a successful VM process exit before rebooting or publishing; a failed or incomplete shutdown refuses the image.
After a fresh boot, it checks both saved `ProcessType` values and both loaded services' `spawn type`, then Python's `tomllib`, Bash and Homebrew through a non-login `tart exec`, matching how the runner starts.
It records the verification shell's actual priority without asserting a fixed scheduler value.
The provisioning user's signing commands run only inside the disposable guest with an explicit scratch home and signing-material directory.
`image.sh` finds an Apple-verified, ready iOS 26.1 disk installed on the build Mac, or accepts its Apple-supplied disk through `IOS_RUNTIME_DMG`.
It shares that disk's folder read-only and imports the runtime inside the guest; it never copies simulator devices, host runtime state or signing material.
`IOS_RUNTIME_VERSION` names the required version and defaults to 26.1, and the image is refused unless that runtime becomes available after import.
The guest's imported runtime remains in the image, while the source disk stays untouched on the build Mac.
The build also fails when the image holds any code-signing identity, so nothing that signs as the captain is ever in a clone.

### The real Mac's place

A job that signs with the captain's Apple certificates asks for the real Mac through the repository variable `REAL_MAC_RUNNER`: `release.yml`'s signing job and `ios-release.yml`'s TestFlight job.
Each reads `${{ vars.REAL_MAC_RUNNER || vars.MAC_RUNNER || <its fallback> }}`, so until the switch sets `REAL_MAC_RUNNER` it runs where it ran before.
The signed installer's build and Apple-silicon checks, the release's Apple-silicon update check and `release.yml`'s publication job ask for a virtual Mac by the placement service's `mini-mac-virtual` label.
The publication job holds no Apple signing material: it publishes and checks the files the signing job handed over once the disk image passed its check (`docs/alpha.md`, "Signing on the real Mac, publication in a virtual Mac").
The signing job runs while the release's checks run (`docs/alpha.md`, "Signing while the checks run"), so it holds the real Mac during the release's Mac lane, which then takes a virtual place or waits.
These checks require throwaway guests for their signing, trust changes or writes to `/Applications`; the signed installer's Intel check, run only on request, stays on a disposable hosted Mac (`docs/alpha.md`, "Isolated signed verification").
The phone check reads that label from `VIRTUAL_MAC_RUNNER` when the variable is set, so it starts on the next free virtual place, beside any other phone check (`docs/ios.md`, "A phone check the placement service puts in a virtual Mac").
The other Mac jobs read `MAC_RUNNER` alone and may run in any place, a virtual one or the real Mac's.
`tests/release-contract.test.ts` holds which jobs ask for the real Mac.

### A release's own queues

A publishing release's Mac jobs can ask for release-only queues, which the placement service starts before every other waiting Mac job (DOP-178).
The queues share the existing places and add no capacity; they keep a release from waiting behind phone checks, main repairs and borrowed virtual Macs.
Three repository variables name them, one per place kind:

- `RELEASE_MAC_RUNNER`, any place: `verify.yml`'s Mac lane, passed as its `mac_runner` input.
- `RELEASE_REAL_MAC_RUNNER`, the real Mac: `release.yml`'s signing job and `ios-release.yml`'s TestFlight job.
- `RELEASE_VIRTUAL_MAC_RUNNER`, a virtual Mac: both `mac-update.yml` calls, passed as its `runner` input, and `release.yml`'s publication job.

`release.yml` reads them only when its resolved `dry_run` is `false`: a publishing run's own verification and update rehearsal take the release queues, and every job of a dry run stays on the ordinary labels.
The TestFlight job runs only for a release, so it reads its variable whenever it is set.
Each unset variable keeps that job on today's label, the ones "The real Mac's place" names.
The queues are runner-up pools; set all three only after runner-up serves them, so no queued release waits on a label nothing serves.
`tests/release-contract.test.ts` holds where each job starts with the variables set, unset and in a dry run.

### The runner's microphone access

The journeys open Chromium's fake microphone, but coreaudiod still asks macOS for microphone access on behalf of the responsible process, which in a virtual Mac is the lane's guest agent, not the app.
With no grant, macOS raises a prompt nobody answers and `getUserMedia` never settles, so `mic-access.spec.ts` and `voice-prompt-focus.spec.ts` fail after their waits.
The image grants `kTCCServiceMicrophone` to that agent: sign the agent ad hoc (`codesign -f -s -`), because a Homebrew build is only linker-signed and a row for it fails its code requirement, then add a row carrying its cdhash requirement.
The running agent keeps its old signature until it restarts, so the grant holds from the image's next start, which is every clone's first.
`micProbe.cjs` opens the microphone from a file page, because a `data:` page is not a secure context and has no `navigator.mediaDevices`.
`tests/e2e/globalSetup.ts` checks this before any test starts (`tests/e2e/micPreflight.ts`): in a virtual Mac, or with `INFINITARY_E2E_MIC_PREFLIGHT=1`, it opens the fake microphone once and fails the run with the fix when it does not open.
`INFINITARY_E2E_MIC_PREFLIGHT=0` turns the check off for a run whose specs open no microphone, as `tests/run-evidence-playwright.test.ts`'s fixture runs do, so a slow virtual Mac does not boot Electron for it before their first spec.

### Drawing in software

In a virtual Mac every app a journey starts draws in software (`--disable-gpu`, `virtualMacSwitches` in `tests/e2e/virtualMac.ts`).
Its paravirtualized Metal now and then never signals that a frame finished, and Chromium's GPU process waits for that signal with no limit (`CALayerTreeCoordinator::ApplyBackpressure`).
The app then draws nothing, `requestAnimationFrame` stops, and a screenshot waits until the GPU watchdog ends the process 25 to 50 s later, past Playwright's 30 s (INF-747).
Other apps in the same guest keep drawing, because each GPU process waits on its own signal.
Software drawing has no such wait.
The Mac mini draws on its real graphics card and keeps that path covered.
A perf run's paint budgets (`INFINITARY_PERF_BUDGETS=1`, `tests/e2e/perf.ts`) graded in a virtual Mac measure software drawing instead.

### The Claude Code the app finds first

`knownClaudeHomes` looks in `~/.local/bin` and `~/.claude/local`, which the base image leaves empty, then in `/opt/homebrew/bin`, all before the search path.
So the image installs Claude Code there with Homebrew's npm (`/opt/homebrew/bin/npm install -g --force --prefix /opt/homebrew @anthropic-ai/claude-code@<version>`); a copy Node's own npm puts in `~/node/bin` is never read.
The version is the one the Mac that builds the image finds first, or `CLAUDE_CODE_VERSION`, so the lane runs the client the Mac mini's own journeys run.
`claude-seat-instructions.spec.ts` fails with a first mate that never answers when that copy is old.

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

## The latency check

`tests/e2e/latency.check.spec.ts` is INF-2078's latency measure, the one INF-1359 and INF-1361 run on their cards: the actual app on a record the captain's size (`tests/e2e/captainSizedRecord.ts`) with the freeze recorder on, six stand-in crewmates each writing a progress line a second (`tests/e2e/scenarios/writingCrew.ts`), while the captain types a question one key at a time and then scrolls the Tasks list with its landed work open.
It is a perf check (`PERF_TAG`) that skips unless `INFINITARY_PERF_BUDGETS=1` on a Mac, so it runs on request: `journeys.yml` with `files` naming it and `perf` on, or `verify.yml` with `perf` on.
Locally, run `pnpm build`, then `INFINITARY_PERF_BUDGETS=1 pnpm exec playwright test tests/e2e/latency.check.spec.ts --no-deps` on a quiet Mac.
It grades the plan's bar, each a soft hold (`graded` in `tests/e2e/perf.ts`), so one run reports every miss:

- no main thread stall of 50 ms or more while typing or scrolling, read from the freeze recorder's record (`docs/freeze-recorder.md`);
- a key press round trip under 17 ms at its 95th percentile, timed from the test's press to the window's page done with it, which holds the driver's own dispatch of a few milliseconds and the app's main thread, where a stall holds every key;
- Tasks list frames under 20 ms at their 95th percentile and under 50 ms at most, with under one in twenty dropped (over 25 ms), read by the Tasks panel's own animation frames while the list scrolls a step a frame and the crew's changes arrive;
- each list redraw under 4 ms and the core's cost per change under 5 ms, read from a Chromium trace of a quiet stretch with only the crew writing, as the top-level tasks of the Tasks panel's main thread and of the app's main thread; a task that bundles several writes counts once.

Every run prints each measure as a `[perf]` line, and writes `latency.json`, each stall in words and the trace into the run's own directory.
The app ticks at its own period, so a minute pass may or may not fall in a stretch; judge a measure near its bar over several runs.

## The Linux source desktop

`source-journeys.yml` builds the checkout and runs journeys on the app built from source on Ubuntu 24.04 x64 (`LINUX_RUNNER`, hosted when unset), under Xvfb on a 2560 by 1600 virtual screen with Chromium's sandbox enabled.
`journeys.yml` calls it as `linux-source` on a pull request's run, which no pull request starts now ("Journeys on the pull request"), with the starter journeys, split onto two machines by the existing parallel and serial desktop lanes: `source-start`, `phase0-guardrails`, `answer-delivery` and `claude-crew-turn`, the keyboard journeys `keyboard-routing` and `keyboard-regions`, which press Ctrl where a Mac presses ⌘ (`docs/keyboard.md`, "Keys on each system"), the task browser's journeys (`task-browser`, `task-browser-actions`, `task-browser-diagnostics` and `task-browser-booking`), the device journeys (`devices`) unconditionally, without a second selector, and the voice journeys (`phase6-voice`, `voice-prompt-focus` and `repro-voice-press`), which hold right Ctrl, with a stand-in graphics card and a stand-in voice helper (`docs/e2e-contracts.md`); the real card check is the captain's on each Linux alpha (`docs/architecture.md` section 8, "Where speech runs").
`verify.yml` calls it as `linux-e2e` with `suite: full`: every journey in the suite, before every alpha and on demand, in eight jobs, and the run-alone pass in four more isolated jobs.
Four take a quarter each of the parallel lanes (`styles`, `renderer` and `application`) and four a quarter each of the serial `desktop` lane, each run with `--no-deps` so neither lane waits as the other's teardown and the desktop lane still runs alone on its machine; a job is named for its share, such as `journeys (desktop 2/4)`.
The four `journeys (run alone N/4)` jobs divide the run-alone pass’s ordered listing by round-robin position with `--shard N/4`; together they cover every later file:line/lane selection once, without splitting tests that share a line.
Each share keeps the existing fresh Playwright process and home for each selection, runs the parallel lanes at the existing local width and then its desktop selections serially, and keeps a distinct `e2e-alone-N` artifact and summary.
The Mac-only tests skip there and run alone on the Mac lane.
Request `source-journeys.yml` on a branch with `suite: alone` to check just those four jobs, without the ordinary suite, Mac checks or packaging.
A stable promotion inherits them with the other lanes ("Full alpha checks, inherited stable checks" in `docs/alpha.md`).
The replay gate and packaging stay on the Mac lane.
The Linux packages have their own checks, an installed-package journey on a clean copy of each system (`docs/linux-packages.md`, "The checks").

The launcher shows the app's window on Linux without giving it focus (`paintLikeAMac` in `tests/e2e/launch.ts`): a hidden window there paints about once a second, where a hidden Mac window paints at the display's rate, so a journey that waits on frames or plays Chromium's synthetic pointer would wait out its time.
On the virtual screen the shown window disrupts no desktop, so run Linux journeys under `xvfb-run` there too.
With no window manager the window under the pointer takes the keyboard, so the lane parks the pointer on the screen's last pixel (`xdotool`), where no window reaches, and stops before any journey unless the pointer is there.
It starts Xvfb with `-noreset`: Xvfb otherwise resets as its last client leaves, which is `xdotool` itself before any app opens, and puts the pointer back at the screen's centre.
Every app window opens centred, so a pointer at the centre sits in each one, and the windows of parallel journeys, opening and closing over one another, hand it to the window under test, whose page then hears it leave what its journey rests on.
Linux text is antialiased in grey, as macOS draws it (`--disable-lcd-text`): Chromium draws subpixel text only on an opaque layer of its own, so a component would otherwise draw different pixels in a panel and out of one.
A journey reads this computer's desktop through `tests/e2e/desktop.ts` (`THIS_DESKTOP`, `HAS_APP_MENU`, and a key's words and `aria-keyshortcuts` through their owners in `src/shared/keyboard.ts`), and its dictation key and hints through `tests/e2e/dictation.ts`, so the same journey reads ⌘ and right ⌥ on a Mac and Ctrl and right Ctrl on Linux.
A step whose subject only a Mac has - the window wash, Show in dock, the app menu - runs where the desktop has it, the rest of its journey runs on both, and the test carries `MAC_ONLY_TAG` so a pull request's Mac job runs that step.
A journey whose whole subject is the Mac's skips on Linux, says why and carries `MAC_ONLY_TAG` ("Tests that need a Mac"): the shell keys' default keys (`multiline-composer`, `card-threads`; `docs/composer.md`, "Shell keys"), the window wash (`window-wash`, `activity-runs`), macOS's microphone permission (`mic-access`), macOS's question about other apps' data (`macos-privacy`), the app's own git (`app-git`, `run-work`; `docs/forge.md`, "The app's own git"), the Mac app another Mac downloads with its zip tools (`devices`, `run-work`), `CFFIXED_USER_HOME` (`user-data-folder`) and the real voice model (`voice-freeze.check`).
The SSH journeys run on Linux too, against the runner's own OpenSSH (`tests/helpers/sshServer.ts`).
The demo encoder is the release's static FFmpeg 7 there ("Recording a demo" above).
A mock crewmate writes its fixture files one bash call each, since Linux refuses a command argument over 128 KiB (`writeFilesCalls` in `tests/e2e/mockProvider.ts`).

The disposable Linux runner, a hosted machine or the PC's fresh virtual machine, installs the downloaded Electron sandbox helper root-owned with mode 4755 at a space-free temporary path, named by `CHROME_DEVEL_SANDBOX`.
It removes the unpacked adjacent helper after installing it because Chromium prefers an adjacent helper to the development fallback.
Chromium splits the helper's command-prefix path at spaces, so the helper is separate while the checkout and app executable still stay under `Application Support`.
The Playwright launcher explicitly enables Chromium sandboxing.
Each job keeps the machine-readable result and any failed journey evidence; the job that runs `source-start` also keeps a 1280 by 800 Linux window picture.
Ordinary Linux source jobs additionally keep a separate `journey-timing-Linux-<suffix>-<lane>-<shard>` artifact for 14 days, without changing those evidence bundles.
The timing exporter comes from a separate sparse checkout pinned to `github.workflow_sha`, not the candidate's `inputs.ref`; these local reusable workflows share their caller's commit.
An older reviewed candidate need not contain the helper, and a branch moving after dispatch cannot replace the exporter.
The export command still runs in the candidate's directory and reads its report and git revision, without copying tooling into or modifying that checkout.
`tests/journey-timing-workflow.test.ts` exercises the workflow's checkout inputs and export command with separate candidate and workflow commits, including failed and missing reports.
`scripts/journey-timing.ts` projects the existing Playwright JSON into `journey-timing.json`: schema version, run and attempt, checked-out revision, platform and architecture, suite/lane/shard, requested and observed selected files, configured and actual workers, outcomes and per-file/project attempt intervals and work.
Paths retain their directory identity, including styles files under `tests/renderer`; repeated attempts keep their retry and worker identity, without logs, steps, pictures or attachment paths.
`elapsedMs` spans the first executed attempt's start through the last one's end in that file/project group, including intervening gaps; `workMs` sums non-skipped attempts and is not wall time.
Skipped attempts remain observed skips, with null elapsed intervals when nothing executed; missing reports, absent requested files and tests without results remain explicit and cannot be successful complete observations.
The exporter marks a report successful only when the test command succeeded, every selected test has a completed result, and Playwright records no global errors, unexpected outcomes or flakes.
This flag describes the test observation, not the final workflow conclusion; a timing consumer must also check that job's successful conclusion and compatible provenance before using it.
`setupMs` spans the first job step through test-command entry; `jobObservedMs` and `testStepObservedMs` end at export, after the skip gate but before uploads and runner cleanup.
These are bounded observations, not total job occupancy or runner waiting: join the run/attempt/job and matrix identity to GitHub's job timestamps for final job time, including checkout before the first step and work after export.
A missing report records null workers and Playwright timing, never zero work or a skip.
Run-alone keeps its existing per-selection reports unchanged and does not export the final child process as an ordinary complete timing observation.
The affected-journey allocator consumes compatible compact reports as described under "Journeys on the pull request"; selection, worker limits, lane definitions, full-verification shard counts, cancellation and release gates stay unchanged.
On Mac, a pull request editing `tests/e2e/layout.ts` still runs every resize and minimum-size caller selected by `scripts/journey-callers.ts`, including calls through the demo helper.
The Mac affected-journey selector covers the same callers through their imports.
Window sizes in `resizeWindow`, its returned restore value and `minimumWindowSize` describe content pixels before page zoom, not outer bounds that include a native menu or frame.
This is the source app, not a packaged Linux release check.
The launcher gives each app a throwaway HOME, userData, TMPDIR and XDG configuration, cache and data directories, and pins the Mac home with `CFFIXED_USER_HOME`.

## Linux automatic startup fixtures

`linux-startup.yml` runs the production runtime/session classifier on a disposable Ubuntu machine for pull requests and main: the PC's fresh virtual machine through `LINUX_RUNNER`, or GitHub-hosted Ubuntu when it is unset.
It checks a disposable logged-out user under running systemd, then starts that user's manager for the available case.
It also checks a plain Ubuntu container with installed systemctl but no running systemd, then an unavailable systemctl.
The job logs the runtime, commands, statuses and classification, never the user manager's environment values.
The fixture removes its disposable user and manager; it changes no person's startup configuration.

## Linux-only branch checks

`ci.yml` accepts `workflow_dispatch` for branch validation without triggering any Mac job.
It runs the same Linux gate and cohorts as a pull request; a successful unit job can be rerun individually to collect required consecutive passes without starting unrelated Mac workflows.
