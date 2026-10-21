# Test cohorts

The vitest suite is split by what a test depends on (captain's A1, 2026-09-24).
A test that spawns real work carries a budget sized to that work; an in-memory test keeps vitest's 5 s default.

## The cohorts and projects

`pnpm test` runs every project, and so does `verify.yml`'s `linux-checks` lane.
The PR checks (`ci.yml`) run the same projects on separate machines: `unit-tests` runs `pure`, `unit` and `unit-isolated`, each `integration-tests` job runs one `--shard` of `integration`, and `probe-tests` runs only the files of `probe` the change reaches ("Probes" below, `docs/testing.md`).

| Project | Files | Rule |
| --- | --- | --- |
| `pure` | `src/shared/**/*.test.ts` | Shared contracts and math. One module cache (`isolate: false`) with per-test guards against mutated globals (`tests/helpers/pureProject.ts`). In memory, like `unit`. |
| `unit` | every other test file not listed as integration | Most files share loaded code (`isolate: false`) with the same process-state leak guard as `pure`; 47 module-mocking, environment/global-mutating or SDK-loading files run as `unit-isolated` with `isolate: true` (the explicit list in `vitest.config.ts`). Both use vitest's 5 s default. May not start a child process, drive real git or sleep on a real clock. |
| `integration` | the list below | Real git, pnpm, a shell, a stub executable or the installed Claude client. Eight workers on macOS, four elsewhere, in a group that starts after `pure` and `unit` finish, so the suite does not load the host it measures. Each file carries a budget sized to its measured work. |
| `probe` | the files of the list below that `PROBE_FILES` names | Integration files that can fail with no code change ("Probes" below). The same workers and budgets as `integration`, in a group that starts after it finishes. |

`pure`, `unit` and `unit-isolated` each use `Math.max(2, os.availableParallelism() - 1)` workers: the two-CPU hosted runner uses both CPUs, and a larger machine still reserves one CPU.
The guard checks environment names and clock/timer identities after each test and after file teardown; it fails rather than silently repairing a leak.
Module mocks, stubbed globals/environment, and the Claude SDK's import-time `NoDefaultCurrentDirectoryInExePath` write belong in `unit-isolated`, never on an environment allowlist.
New unit files default to guarded sharing; add state-mutating files to the isolated list.


`pnpm exec vitest run --project <name> <files>` runs one project's files; use `--project unit --project unit-isolated` for the complete unit cohort; a bare file path finds its project on its own.

## Probes

A probe is an integration file that can fail with no code change, because it leans on what the runner has: SSH and Remote Login stand-ins, dns-sd, release rehearsals, the connection listener, real Playwright runs, the Claude client against a stand-in API and whole-core command-line runs.
Such a file fails on the runner's state as well as on the code, and catches a real problem mostly when its own subject changes (FI3-1756).
So a change runs only the probes whose paths it edits, and `verify.yml`'s `linux-checks` lane, inside every alpha and on demand, runs them all.

`scripts/affected-probes.ts` owns the list: `PROBES` groups the probe files by what they reach outside the code, each group with the paths it watches, and `PROBE_FILES` is every file of it.
A probe runs when the change edits the probe itself, a path its group names (a directory ending in `/` matches what is under it), or a path of the lane itself (`LANE`: the chooser, `vitest.config.ts`, the packages and the shared test setup), which runs every probe.
A base the chooser cannot read runs every probe, and a group naming a path that no longer exists is refused, so a moved subject cannot silently stop its probes running before the release.
`ci.yml`'s `probe-tests` runs `pnpm test:probes` from the change's merge base with main on a pull request and from the previous main on a push, and writes which probes ran and why in its summary; with none it passes without running vitest.
Locally, `pnpm test:probes` runs the probes the working copy's commits reach from `origin/main`, and `node scripts/affected-probes.ts` only lists them.

A probe stays on the integration list below, so the unit fence still exempts it, and `vitest.config.ts` refuses a probe that is not on it.
To make a file a probe, add it to a group of `PROBES` (or a new group with the paths it watches); the `integration` project drops it and the `probe` project takes it.

## The fence

Never relabel a test as `unit` just to run it sooner.
Migration and backfill tests use `openInMemoryDatabase()` to run real migrations, never the cloned template.
The database guard (`tests/helpers/database.test.ts`, isolated in `vitest.config.ts`) stays isolated: a warmed template breaks its fixed-clock comparison.

A failed or interrupted run is never a timing sample (`compareWorkloads`).

`tests/lint/unit-cohort.grit` refuses, in every `pure` and `unit` test file, an import of `node:child_process`, `node:timers/promises` or a product module whose one job is to spawn (`workspace/git` and any relative `git` module, `sql/forkChildProcess`, `devices/ssh`, `devices/relay`, `devices/dnsSd`), whether static, dynamic, `require` or `vi.importActual`.
A new module of that kind joins the plugin's pattern.
A type-only import is not a dependency and passes, and so does `vi.mock` of any of them (faking a spawn is how a unit test avoids one).
It runs inside `pnpm check` through biome.json's unit-cohort override.
It is a Grit plugin rather than a `noRestrictedImports` override because Biome replaces a rule's options per override instead of merging them: a test-file override of that rule would silently drop the Electron, Pi and Claude fences for every test under `src/core/`.

The fence sees a test file's own imports.
A unit test that reached a spawn through product code (`WorkspaceService` on a real repository, say) would pass it, and so would a `setTimeout` written inside a test (a few unit tests still yield a macrotask or hold a lock open for a few milliseconds that way, and none of them asserts on elapsed time); the 5 s default is what bounds those, and the answer for a new one is the same: fake the dependency or inject a clock, or list the file as integration.

## The list

The integration cohort is ONE list: the `!` exclusions of biome.json's unit-cohort override (the override whose `plugins` names `tests/lint/unit-cohort.grit`).
The fence skips those files, and `vitest.config.ts` reads the test-file exclusions as the `integration` project's `include`, so a file cannot be fenced as a unit test and run as an integration test, or the other way round.

A shared process-fixture helper may also be exempted there; it is not itself a test suite.
Its process-driving test callers must still be listed as integration.
The custom CA fixture is shared by the integration trust tests and desktop/packaged probes.
The SSH server fixture (`tests/helpers/sshServer.ts`) is shared by the Remote Login integration test and its e2e journeys.

To add a test that needs a real process: write it, add its path to that override's exclusions, measure it (below), and give it a budget if the rule asks for one.
Never raise a unit test's timeout instead - a raised timeout on an in-memory test hides the dependency this split exists to name.

## Budgets

A budget is sized to measured work.
Measure each limit on the Linux machine that runs the checks.
The rule: take each test's fastest measured run; the budget is **five times the slowest of those, rounded up to a whole 5 s**, and never below vitest's 5 s default.
The investigation measured the ordinary loaded regime on the shared Mac at 1.5 to 3 times a quiet run on sequential spawn chains, so five times leaves headroom above the worst ordinary slowdown without hiding a tenfold regression.
Past about 25 times (the concurrent-suite regime the investigation also recorded) no budget survives, and none is sized for it.
On a Mac the product runs every git below the UI (`taskpolicy -c utility`, `src/core/utilityQos.ts`), where it yields to every busier process, so a long chain of them on a Mac loaded by other runs waits on that load rather than its own work, well past five times.
A file whose cases chain the product's git and are not about that clamp runs them at the run's own priority: its `vi.mock` of `atUtilityQos` goes through `tests/helpers/unclampedQos.ts`, which gives it a host with no `taskpolicy`, and its row below says "at the run's own priority".
`src/core/utilityQos.test.ts` holds the clamp itself, and `src/core/workspace/git.test.ts` keeps running the app's own git under it.

A budget lives in the file, as `vi.setConfig({ testTimeout })` for the whole file, or on the describe or test that carries the work when only part of the file spawns.
A budget an author already set above the rule stays as it was, and a test whose time is a fixed product timeout rather than load-scaled work (hostEnv's hanging-shell test waits out a 3 s timeout) keeps the budget sized to that timeout.
A file whose slowest test fits the 5 s default under the rule carries none.

| File | Depends on | Budget |
| --- | --- | --- |
| `src/core/workspace/worktreePool.test.ts` | real git, real pnpm, at the run's own priority | 15 s for the file; the real-pnpm measurement test is 600 s |
| `src/core/orchestrator/prCi.test.ts` | real git at the run's own priority, the put-in's 300 + 900 ms backoff | 10 s |
| `src/core/orchestrator/settleService.test.ts` | real git for a pure update and an edited line, at the run's own priority | 15 s |
| `src/core/workspace/conventional.test.ts` | real git for incoming commit range, at the run's own priority | 5 s default |
| `src/core/workspace/workspaceService.test.ts` | real git, at the run's own priority | 15 s |
| `src/core/folderMove/move.test.ts` | real git, the system's copier, SQLite, a vite build and the Electron binary: the one-time move of a scratch data folder | 10 s (Mac slowest per-case minimum 0.588 s) |
| `src/core/helper/workingCopies.test.ts` | real git: a computer's clones, working copies and bundles, at the run's own priority | 10 s |
| `src/core/placed/placedSessions.test.ts` | real git on both sides of a placed task's working copy, at the run's own priority | 10 s |
| `src/core/placed/placedAccounts.test.ts` | real git for each side's workspace of a placed task, at the run's own priority | 5 s default |
| `src/core/placed/placedCutOff.test.ts` | real git for each side's workspace of a placed task whose sign-in there is cut off, at the run's own priority | 10 s |
| `src/core/helper/cleanUp.test.ts` | real git: what a removal takes from a computer's clones and working copies, at the run's own priority; a worker thread holding the route's lock, and that lock's fixed 2 s wait | 30 s |
| `src/core/claude/claudeModelProbe.test.ts` | the installed Claude client | 10 s |
| `tests/replay-captain-session.test.ts` | the replay CLI, git | 60 to 240 s |
| `tests/release-contract.test.ts` | node, brew | 10 s default, 180 s on brew style |
| `tests/release-publication.test.ts` | the release workflow's tap and release-asset scripts: real git on a stand-in tap, the publication CLI, a stand-in `gh`, `brew` and `curl` | 50 s |
| `tests/release-notes.test.ts` | the release-notes gate: real git on scratch repositories with commits and tags, the `scripts/release-notes.ts` CLI | 10 s |
| `tests/cask-consumers.test.ts` | a scratch clone of the installed Homebrew (macOS only, skipped without it), git, ditto, the publication CLI | 340 s |
| `src/core/hostEnv.test.ts` | stub login shells | 10 s on the hang test |
| `tests/export-tasks.test.ts` | node, pnpm | 60 s |
| `tests/account-eval.test.ts` | twenty independently owned one-case production sessions (all ten cases on each backend), two 503/no-retry proofs, one ten-case Pi run proving every case opens with its sheet allowance, one Pi case refused on a scripted local endpoint, one Claude case cut mid-answer on one, the complete ten-case no-call sheet, plus the Claude crewmate's client read from the real process table and a mock Claude run stopped when that client ends; local mock provider and boxed Claude client | 30 s kept per case |
| `tests/eval-auth-turn-taking.test.ts` | two processes on a scratch auth file and local fake OAuth server, for two provider ids | 5 s default |
| `tests/module-runner.test.ts` | plain Node core imports and task-export CLI, occupied WebSocket port | 15 s |
| `tests/mac-check-lock.test.ts` | actual workflow commands and the `test:phone` package script, held Node processes, `ps` and Python kernel-lock probes, on macOS/Linux | 5 s default |
| `tests/virtual-mac-phone.test.ts` | the phone check's virtual Mac scripts against a stand-in tart, real git, bash and tar on a scratch working copy | 5 s default (Mac slowest per-case minimum 0.618 s) |
| `tests/phone-release-process.test.ts` | the dispatched release command, temporary key fixtures and stand-in Xcode/upload commands; no signing or network | 5 s default |
| `tests/run-evidence-playwright.test.ts` | two overlapping Playwright runs of a fixture config through the e2e global setup; the build guard (node, `ps`) under one held run | 15 s |
| `src/core/orchestrator/crewSupervisor.test.ts` | real git, at the run's own priority | 60 s on the real-git describe |
| `tests/e2e-lanes.test.ts` | playwright --list over every spec, and the real runner over fixture specs | 60 s; 180 s on the listing (Linux fastest 35.7 s; it grows with the suite) |
| `tests/e2e-contract-lint.test.ts` | Biome, with the repository's plugins, over a fixture spec | 5 s default |
| `tests/replay-gate-catches-lock-refusal.test.ts` | the replay CLI, git | 60 s |
| `src/core/claude/claudeRenewProbe.test.ts` | a recording client; the installed Claude client only with `INFINITARY_CLAUDE_RENEW_PROBE=1` on disposable Linux | 5 s default; 240 s on each opt-in leg |
| `tests/run-temp-root.test.ts` | a nested vitest run | 120 s |
| `tests/generate-self-source.test.ts` | node, git archive | 60 s |
| `src/core/sql/sqlService.test.ts` | a forked SQL process, bundled with vite | 5 s default (60 s on the bundling `beforeAll`, kept) |
| `src/core/claude/claudeToolSurface.test.ts` | the Claude client, through the SDK, and boxed on the seat's harness against a local stub API | 180 s on each client run |
| `src/core/claude/claudeFirstmateSession.integration.test.ts` | the SDK's own client, boxed, against a per-case local stub API | 15 s |
| `tests/replay-claude-session.test.ts` | the SDK's own client, boxed, against a local stub API, under the real first mate agent | 15 s |
| `src/core/claude/claudeClassifierSession.integration.test.ts` | the SDK's own client, boxed, against a local stub API; the kind scorer's CLI | 15 s |
| `src/core/claude/claudeCrewAgents.integration.test.ts` | the SDK's own client, boxed, with agent definitions planted around a crewmate, against a local stub API | 10 s (Linux slowest per-case minimum 1.966 s) |
| `src/core/claude/claudeCrewContract.integration.test.ts` | the installed Claude client, else the SDK's own, boxed, reopening a crewmate's conversation across a changed prompt or tool description, against a local stub API | 40 s (Mac fastest 1.285 s per case; four client starts at Linux's 2 s) |
| `src/core/claude/claudeAttribution.integration.test.ts` | the boxed Claude client against a local stub API, a crewmate with a staged skill in a git working copy, with and without the attribution setting | 15 s (Linux slowest per-case 2.919 s) |
| `src/core/claude/claudeAutoMemory.integration.test.ts` | the boxed Claude client against a local stub API, with planted personal notes across crewmate, seat and question sessions | 15 s (Linux slowest per-case minimum 2.060 s) |
| `src/core/claude/claudeToolWait.integration.test.ts` | the SDK's own client, boxed, whose one app tool waits 3 s, against a local stub API | 20 s |
| `src/core/claude/claudeCrewCard.integration.test.ts` | the SDK's own client, boxed, with a crewmate's own tools, against a local stub API | 5 s default (five times its fastest is 3.3 s) |
| `src/core/claude/claudeProjectResources.integration.test.ts` | the SDK's own client, boxed, with a working copy's instructions, skills and settings and the folders above it planted around a crewmate, against a local stub API | 20 s (Linux staging case's fastest is 3.523 s) |
| `src/core/claude/claudeSession.contract.integration.test.ts` | the SDK's own client, boxed, against a local stub API, under the session contract's suite | 15 s |
| `src/core/claude/claudeSession.integration.test.ts` | the SDK's own client, boxed, against a local stub API, running a background shell sleep; and under a real supervisor, a foreground sleep that a close or a quit cuts | 15 s |
| `src/core/claude/interruptWedge.integration.test.ts` | the SDK's own client, boxed, under the work computer's `SessionHost`, against a local stub API that never answers; the client frozen with SIGSTOP and stopped by the session | 30 s (each case waits out the SDK's 5 s SIGTERM-to-SIGKILL grace; Mac about 3.5 s per case) |
| `tests/bench-attempt.test.ts` | the benchmark attempt CLI: the whole core, real git, the e2e mock provider | 95 s |
| `src/core/claude/claudeFirstmateSeat.live.test.ts` | the installed Claude client on the machine's own login (opt-in, `INFINITARY_CLAUDE_SEAT_LIVE=1`) | 180 s opt-in |
| `src/core/core.test.ts` | the whole core: git at the run's own priority, the login shell | 60 to 120 s on its boots |
| `tests/replay-gate-catches-lint.test.ts` | the replay CLI, git | 60 s |
| `src/core/forge/providers/plainGit.test.ts` | real git, at the run's own priority | 5 s default (five times its slowest is 2.5 s) |
| `tests/bench-patch-pool.test.ts` | real git, python3's tomllib (benchmark tooling, `scripts/bench/`) | 5 s default |
| `src/core/personal/personalExtensions.test.ts` | real git, at the run's own priority | 5 s default |
| `tests/test-workload.test.ts` | node | 5 s default |
| `src/core/jobs/jobManager.test.ts` | bash jobs, the login shell | 5 s default |
| `src/core/personal/workspace.test.ts` | real git, at the run's own priority | 5 s default |
| `tests/local-codesign.test.ts` | node, a stub `security` | 5 s default |
| `tests/mockClaudeClient.test.ts` | the e2e Claude stub and a recording client, a shell | 5 s default |
| `src/core/personal/sequencesSkill.test.ts` | real git, at the run's own priority | 5 s default |
| `src/core/personal/liveWorkspace.test.ts` | real git, at the run's own priority | 5 s default |
| `src/core/workspace/git.test.ts` | the app's own git and a stand-in, a shell | 5 s default |
| `src/core/utilityQos.test.ts` | taskpolicy children | 5 s default |
| `src/core/orchestrator/firstmateAgent.test.ts` | real git, at the run's own priority | 5 s default |
| `tests/ensure-electron-installed.test.ts` | node | 5 s default |
| `tests/typecheck.test.ts` | the pinned checker through its real command, a scratch copy of the settings words and incremental imports, missing/failed native executables | 20 s for the eleven-check incremental journey; 5 s default elsewhere |
| `tests/install-clones.test.ts` | `cp -c`, tar, the installed ONNX runtime files, APFS's private size through koffi | 5 s default |
| `src/core/claude/claudeLoginProbe.test.ts` | the installed Claude client | 5 s default |
| `src/core/personal/captainSkill.test.ts` | real git, at the run's own priority | 5 s default |
| `src/core/pi/customApiCertificates.integration.test.ts` | a local HTTPS server and the custom-API certificate review | 5 s default |
| `src/core/claude/claudeCli.test.ts` | stub client executables | 5 s default |
| `src/core/hostEnv.gitSignIn.test.ts` | real git, openssl, a local HTTPS host | 5 s default |
| `src/core/workspace/repoRegistry.test.ts` | real git, at the run's own priority | 5 s default |
| `src/core/forge/signIns.test.ts` | the app's git sign-in helper script | 5 s default |
| `src/core/pi/personalizeTool.test.ts` | real git | 5 s default |
| `src/core/plugins/pluginInstaller.test.ts` | real git at the run's own priority, npm pack (a local registry that answers nothing), tar | 10 s on the npm test, 5 s default for the rest |
| `src/main/host/darwinKeychain.scratch.test.ts` | `security` (opt-in, `INFINITARY_SCRATCH_KEYCHAIN_PROBE=1`) | 120 s on the opt-in unlock test, 5 s default for the rest |
| `src/main/host/claudeKeychainAccess.integration.test.ts` | isolated `security` on a throwaway keychain, and an ad-hoc `codesign` of the large app it builds (darwin only) | 5 s default; 15 s on building the app (Mac fastest 2.4 s) |
| `src/core/devices/remoteLogin.test.ts` | the Mac's own `sshd` on loopback (`tests/helpers/sshServer.ts`, macOS only, skipped without it), ssh, ssh-keygen, tar, curl, openssl | 15 s (Mac slowest per-case fastest 2.1 s); 30 s on the check-line and password tests, and on the Mac's download describe (Mac slowest per-case fastest 5.7 s) |
| `src/core/devices/relay.test.ts` | a stand-in relay on Node, and on macOS `/usr/bin/nc`, carrying the real connection on loopback | 5 s default |
| `src/core/devices/dnsSd.test.ts` | a stand-in for macOS's dns-sd, a shell script per run (`tests/helpers/dnsSdStandIn.ts`); the held run (`runDnsSdHeld`) waits out a one-second `-t`, 1.4 s the slowest | 5 s default |
| `src/core/helper/fromHome.test.ts` | a folder held by a live process, waited for on the real clock | 5 s default |
| `src/core/devices/computerUpdate.test.ts` | real TLS on loopback and the Mac's own tar, a computer's run started again on the real clock; on a Mac, a download from a local HTTPS release with curl, shasum, ditto and a stand-in codesign | 10 s |
| `src/core/devices/farSystems.test.ts` | `/bin/sh` running the look, the removal and the controller a home sends, with the system's own tools the look asks | 30 s |

Measure with the project's own worker count and no ceiling, several times, and take each test's fastest run.
Noise only ever adds time:

```sh
pnpm exec vitest run --project integration --testTimeout=180000 --reporter=json --outputFile=run.json
```


## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Test cohorts (captain's A1, 2026-09-24; `docs/test-cohorts.md` is the one home): vitest runs three cohorts in five projects - `pure` (`src/shared`, one shared module cache), `unit`/`unit-isolated` (in memory, vitest's 5 s default) and `integration` (real git, pnpm and child processes: eight workers on Mac, four elsewhere, after the other two, each file stating a budget sized to its measured work), whose probes run as `probe` after it.
  The integration list is ONE list, the exclusions of biome.json's unit-cohort override: that override runs `tests/lint/unit-cohort.grit` (no `child_process` or `timers/promises` import in a unit test, and none of the product's spawn-only modules, `workspace/git`, `sql/forkChildProcess`, `devices/ssh`, `devices/relay` and `devices/dnsSd`; type-only imports pass) and `vitest.config.ts` reads the same list.
  A new test that spawns fails `pnpm check` until it is listed there with a measured budget; never raise a unit test's timeout instead.
  `pnpm exec vitest run --project <name> <files>` runs one cohort's files.
