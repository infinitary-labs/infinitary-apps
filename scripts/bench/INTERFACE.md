# Grading interface (the S0 runtime, as the S1 driver sees it)

The contract is simple: a task id and a diff go in, and the task's own `reward.json` comes out. The grading is exactly the way DeepSWE's harness grades: a fresh container from the task image at the base commit, the hidden tests mounted at `/tests`, and the diff at `/logs/artifacts/model.patch`. Setup, disk and concurrency limits are in [`README.md`](README.md).

## Input

The attempt driver's verifier seam (`commandVerifier` in `verifier.ts`) calls the runner as an executable:

```sh
run-attempt.ts ... --verifier <repo>/scripts/bench/verify-task.ts
# which the seam runs as
scripts/bench/verify-task.ts <task-id> <patch-path> <out-dir>
```

By hand, or for other sources of a diff, run the same grading through `bench.ts`:

```sh
node scripts/bench/bench.ts verify <task-id> --patch <file>      # or --patch - to read stdin
node scripts/bench/bench.ts verify <task-id> --worktree <dir>    # the worktree's whole state against the base
node scripts/bench/bench.ts verify <task-id> --repo <dir> --ref <ref>
node scripts/bench/bench.ts verify <task-id> --empty
```

Add `--out <dir>` to choose where the logs go. By default they go to a new directory under `.bench/runs/verify/`. An in-process caller can use `runVerifier` from `verifierRunner.ts` directly.

- **`<task-id>`** is one of the 113 ids from `pool list` (the folder names under `.bench/deep-swe/tasks/`).
- **The diff** is a `git diff --binary` against the task's base commit (`baseCommit` in `pool list --json`). It is applied in `/app`, the repository at that commit. An empty diff grades the pristine base.
- **`--worktree`** builds the diff from the worktree's whole working state: commits, staged and unstaged edits, deletions, and untracked files that are not ignored. It does this without touching the worktree's index. The bridge applies the same diff, so what a crewmate tests in the container is what gets graded. Make the worktree with `pool checkout <task> <dest>`, which puts it at the base commit.
- **`--repo --ref`** grades a committed ref, for example a task's kept ref after it closes (`refs/infinitary/kept/<task-id>`).
- **The task image.** A missing image is pulled when the container starts, outside the timed run. Cache it first with `pool pull <task>`: that pull checks the free-disk floor and waits out the registry's rate limit. The one on container start does neither.

## Output

`verify-task.ts` writes the task's `reward.json`, verbatim, to `<out-dir>/reward.json`. It also puts the logs under `<out-dir>` (see `logsDir` below). Both it and `bench.ts verify` print one JSON object on stdout:

```json
{
  "task": "tomlkit-toml-table-converters",
  "reward": 1,
  "scores": {
    "reward": 1,
    "f2p_total": 60, "f2p_passed": 60,
    "p2p_total": 964, "p2p_passed": 964,
    "f2p": 1, "p2p": 1, "partial": 1
  },
  "patchBytes": 21412,
  "exitCode": 0,
  "timedOut": false,
  "wallSeconds": 3.4,
  "logsDir": "/…/.bench/runs/verify/tomlkit-toml-table-converters-…"
}
```

- **`scores`** is the task's `reward.json`, verbatim. It is `null` when the verifier wrote none, or when it timed out. The grader (`tests/grader.py` in each task) defines these fields:
  - `reward`: 1 only if there is at least one fail-to-pass test, every fail-to-pass test passes, and no pass-to-pass test fails. Otherwise 0. This is the leaderboard's binary score.
  - `partial`: `(f2p_passed + p2p_passed) / (f2p_total + p2p_total)`.
  - `f2p` and `p2p`: the pass rate of each bucket. An empty fail-to-pass bucket counts as 0.0, and an empty pass-to-pass bucket as 1.0.
  - `apply_failed: 1` appears only when the diff did not apply. It then comes with `reward: 0` and every count at zero passes. A diff that does not apply is a grade of 0, not a failure of the tooling.
- **`reward`** at the top level is `scores.reward`, or -1 when the verifier itself failed. The verifier failed when it timed out, wrote no reward, or wrote its own `-1` (for example, the hidden test patch did not apply).
- **`logsDir`** holds `artifacts/model.patch` (the diff as graded) and `verifier/`. The `verifier/` directory contains `reward.json`, `ctrf.json` (the per-test results), `run.log`, `test-stdout.txt` (the verifier's full output) and `reports/` (the reports each framework writes itself).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Graded. `reward` is 0 or 1. It is 0 when the diff did not apply. `verify-task.ts` has written `<out-dir>/reward.json`. |
| 3 | The verifier failed, with `reward: -1`. `verify-task.ts` writes no `reward.json`, so the seam records a verifier error. This is an infrastructure failure: re-run once, then report it. Never count it as a 0. |
| 1 | Tooling error, such as an unknown task, no pool, the container services down, or a container that failed to start. Nothing was graded. |
| 2 | Usage. |

## Timing

- **`wallSeconds`** is the verifier's own run, from `bash /tests/test.sh` to its exit. Container start is excluded. Pulling the image takes up to about 140 s more when it is not cached.
- **Budget:** every task's verifier budget is 1800 s (`verifier.timeoutSec`). A verifier past its budget is stopped, and the result is `timedOut: true` with exit 3.
- **Measured:** `data/empty-patch-sweep.json` times every task's verifier on the empty patch. It ran on the Mac mini (M4 Pro, 14 cores, 64 GB) under Apple container 1.4.1 and Rosetta, up to three at once, on 2026-09-27. All 113 tasks graded with `reward: 0`, and none needed a retry. The median verifier took 29 s, the p90 175 s, and the slowest `kgateway-consistent-hash-policy` 547 s, 30% of its budget. By language, Go had the slowest median, 93 s, and Python the fastest, 12 s. A pull took up to 140 s per image.
- **Two tasks cannot be graded under Rosetta:** `narwhals-rolling-window-suite` and `skrub-duration-encoding`. Their test suites import polars 1.39.3, which segfaults under Rosetta on its first DataFrame (AVX2, FMA and BMI2 are all advertised). So not one test runs: 0 of 10,093 and 0 of 2,784 pass-to-pass tests pass on the base. The reference patch scores 0 too. The table lists them under `suiteDidNotRun`. Leave them out of a run's denominator, or grade them on a native x86-64 host. Every other task passes all of its pass-to-pass tests on the base.
- **Before a run counts a task,** check the table's outlier lists. They are `suiteDidNotRun`, `passingOnEmptyPatch`, `infrastructureFailures` and `slowUnderRosetta` (a verifier past half its budget). Only the first list is non-empty today.
- A patch that makes tests run longer (or hang) takes longer than the empty-patch time. Plan on the budget, not the median.

## Rules the driver keeps

- **At most three task containers at once, across processes.** The verifier, the bridge and exports all wait for a free slot on their own. A driver never starts task containers any other way.
- **Never show a crewmate the pool.** `.bench/deep-swe/tasks/<id>/` holds `solution/` (the reference patch) and `tests/` (the hidden tests). A crewmate gets only `instruction.md`'s text, its working copy and the bridge. Crewmate isolation is social, not a filesystem jail: the pool is readable by the same user, and the bridge prefix shows where the tooling lives. Treat a trajectory that reads under the pool as contaminated. A mirror's name and description do not name the task or the benchmark (`mirrorName` in `repos.ts`), so leave them that way.
- **The bridge** is the crewmate's way to build and test inside the task's own environment. Its `--bridge` prefix is `node <repo>/scripts/bench/bench.ts bridge <task-id> --`, and the crewmate runs it from its working copy (the default `--worktree`). It exits with the command's code, with 125 when the working copy's diff does not apply to the image, and with 124 on `--timeout`, which also removes the container. Ignored files, such as installed dependencies, survive between calls. The diff it applies includes the driver's committed `AGENTS.md`, which is harmless in `/app` and excluded from grading. When the attempt ends, call `bridge stop <task> --worktree <working copy>`.
- **The driver boots the core against its own state directory,** never the release app's `<appData>/infinitary` (or Firstmate 3000's `<appData>/firstmate-3000`). No model spend happens in this tooling. Spend belongs to the driver.
