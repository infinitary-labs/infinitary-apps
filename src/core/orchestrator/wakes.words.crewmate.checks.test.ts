/**
 * The words of the wakes a crewmate hears about checks: a repair assessed, a
 * main check observed, checks settled, a run watched and a job that exited
 * (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says why),
 * byte for byte.
 */

import {
  type CrewmateChecksWakeKind,
  pinWakeWords,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<CrewmateChecksWakeKind> = {
  "repair-assessed": [
    {
      name: "changed work with its report",
      wake: {
        facts: {
          kind: "repair-assessed",
          head: "4be7c1d90a2f",
          verdict: "changed-work",
          excerpt: "The repair also renamed a served word.",
        },
      },
      words:
        "An independent assessment of your repair at 4be7c1d90a2f found that your repair changed the work the captain approved, so the captain's kept merge approval ended and they decide again. Drive the checks green on the change as it is now and put up a new merge card that says what changed from the version they approved; do not declare the repair again.\n\nThe assessment's report:\nThe repair also renamed a served word.",
    },
    {
      name: "unknown",
      wake: { facts: { kind: "repair-assessed", head: "4be7c1d90a2f", verdict: "unknown" } },
      words:
        "An independent assessment of your repair at 4be7c1d90a2f could not tell whether your repair kept the work the captain approved, so the captain's kept merge approval ended and they decide again. Drive the checks green on the change as it is now and put up a new merge card; do not declare the repair again.",
    },
    {
      name: "unstated",
      wake: { facts: { kind: "repair-assessed", head: "4be7c1d90a2f", verdict: "unstated" } },
      words:
        "An independent assessment of your repair at 4be7c1d90a2f gave no clear verdict on what your repair did, so the captain's kept merge approval ended and they decide again. Drive the checks green on the change as it is now and put up a new merge card; do not declare the repair again.",
    },
    {
      name: "failed",
      wake: { facts: { kind: "repair-assessed", head: "4be7c1d90a2f", verdict: "failed" } },
      words:
        "An independent assessment of your repair at 4be7c1d90a2f did not finish, so the captain's kept merge approval ended and they decide again. Drive the checks green on the change as it is now and put up a new merge card; do not declare the repair again.",
    },
  ],
  "main-check-observed": [
    {
      name: "its checks",
      wake: {
        facts: {
          kind: "main-check-observed",
          checks: [
            { name: "typecheck-lint-build", state: "success" },
            { name: "critical-path", state: "failure" },
          ],
          sha: "7820fd065a1b",
        },
      },
      words:
        'The default branch reports finished checks at 7820fd065a1b: [{"name":"typecheck-lint-build","state":"success"},{"name":"critical-path","state":"failure"}]. Judge whether this clears your declared wait; these facts do not declare your change ready.',
    },
    {
      name: "an older row naming one check",
      wake: {
        facts: {
          kind: "main-check-observed",
          checks: [{ name: "typecheck-lint-build", state: "success" }],
          check: "typecheck-lint-build",
          sha: "7820fd065a1b",
        },
      },
      words:
        'The default branch reports typecheck-lint-build at 7820fd065a1b: [{"name":"typecheck-lint-build","state":"success"}]. Judge whether this clears your declared wait; these facts do not declare your change ready.',
    },
  ],
  "checks-settled": [
    {
      name: "observed",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "observed",
          change: "PR #1061 https://github.com/infinitary-labs/infinitary/pull/1061",
          head: "4be7c1d90a2f",
          checks: [{ name: "typecheck-lint-build", state: "success" }],
        },
      },
      words:
        "New check observations for PR #1061 https://github.com/infinitary-labs/infinitary/pull/1061 at 4be7c1d: typecheck-lint-build (success). Read current facts with check_change and follow your delivery guidance before offering a merge. This notice is not a merge offer.",
    },
    {
      name: "finished",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "finished",
          change: "PR #1061",
          head: "4be7c1d90a2f",
          checks: [
            { name: "typecheck-lint-build", state: "success" },
            { name: "critical-path", state: "success" },
          ],
        },
      },
      words:
        "The checks on PR #1061 finished at 4be7c1d: typecheck-lint-build (success), critical-path (success). Judge the work from these facts and your delivery guidance; offer its merge when ready.",
    },
    {
      name: "finished with none reported",
      wake: { facts: { kind: "checks-settled", outcome: "finished" } },
      words:
        "The checks on your pull request finished: no checks reported. Judge the work from these facts and your delivery guidance; offer its merge when ready.",
    },
    {
      name: "the first failure",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "first-failure",
          change: "PR #1061",
          checks: [{ name: "critical-path", state: "failure" }],
        },
      },
      words:
        "The first failed check on PR #1061 was seen while others are still running: critical-path (failure). Read its log and diagnose it. The app wakes you again when the checks finish; end your turn instead of calling check_change again.",
    },
    {
      name: "the first failure, unnamed",
      wake: { facts: { kind: "checks-settled", outcome: "first-failure", head: "4be7c1d90a2f" } },
      words:
        "The first failed check on your pull request was seen while others are still running at 4be7c1d: a check failed. Read its log and diagnose it. The app wakes you again when the checks finish; end your turn instead of calling check_change again.",
    },
    {
      name: "an earlier passed record",
      wake: { facts: { kind: "checks-settled", outcome: "passed", change: "PR #1061", count: 4 } },
      words:
        'An earlier check-watch record reports {"kind":"checks-settled","outcome":"passed","change":"PR #1061","count":4}. It is history, not a current readiness verdict. Repair counts are retired and place no hold. Read current check facts and follow your delivery guidance before offering a merge.',
    },
    {
      name: "an earlier failed record at the cap",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "failed",
          change: "PR #1061",
          checks: [{ name: "critical-path", state: "failure" }],
          cap: { rounds: 3, cap: 3 },
        },
      },
      words:
        'An earlier check-watch record reports {"kind":"checks-settled","outcome":"failed","change":"PR #1061","checks":[{"name":"critical-path","state":"failure"}],"cap":{"rounds":3,"cap":3}}. It is history, not a current readiness verdict. Repair counts are retired and place no hold. Read current check facts and follow your delivery guidance before offering a merge.',
    },
    {
      name: "an earlier not-green record",
      wake: { facts: { kind: "checks-settled", outcome: "not-green", change: "PR #1061" } },
      words:
        'An earlier check-watch record reports {"kind":"checks-settled","outcome":"not-green","change":"PR #1061"}. It is history, not a current readiness verdict. Repair counts are retired and place no hold. Read current check facts and follow your delivery guidance before offering a merge.',
    },
    {
      name: "timed out with checks running",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "timed-out",
          change: "PR #1061",
          head: "4be7c1d90a2f",
          checks: [{ name: "critical-path", state: "in_progress" }],
          waitedMs: 10_800_000,
        },
      },
      words:
        "The checks on PR #1061 at 4be7c1d are still running after 3h: critical-path (in_progress). The app stopped watching them: read them with check_change, and report a blocker if they never finish.",
    },
    {
      // The two-hour wake on a change waiting in this person's batch says
      // whose wait it is (docs/forge.md, "Batches of your own").
      name: "timed out waiting in a batch",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "timed-out",
          change: "PR #1061",
          head: "4be7c1d90a2f",
          checks: [{ name: "infinitary/queue", state: "pending" }],
          waitedMs: 7_200_000,
          batch:
            "The change waits in this project's batch of approved changes (In a batch; its checks are running). The app merges the batch once its checks pass, so nothing is needed from you.",
        },
      },
      words:
        "The checks on PR #1061 at 4be7c1d are still running after 2h: infinitary/queue (pending). The change waits in this project's batch of approved changes (In a batch; its checks are running). The app merges the batch once its checks pass, so nothing is needed from you. The app stopped watching them: read them with check_change, and report a blocker if they never finish.",
    },
    {
      name: "timed out bare",
      wake: { facts: { kind: "checks-settled", outcome: "timed-out" } },
      words:
        "The checks on your pull request are still running after 0m. The app stopped watching them: read them with check_change, and report a blocker if they never finish.",
    },
    {
      name: "gone",
      wake: {
        facts: { kind: "checks-settled", outcome: "gone", change: "the pushed branch fm/task" },
      },
      words:
        "The pushed branch fm/task is no longer open where the project lives, so the app stopped watching its checks. Read it with check_change and carry on.",
    },
    {
      name: "unreadable for a sign-in",
      wake: {
        facts: {
          kind: "checks-settled",
          outcome: "unreadable",
          change: "PR #1061",
          problem: "The app is not signed in to GitHub; the captain signs in under Settings.",
          signIn: true,
        },
      },
      words:
        "The app could not read the checks on PR #1061, so it stopped watching them: The app is not signed in to GitHub; the captain signs in under Settings.",
    },
    {
      name: "unreadable with no problem named",
      wake: { facts: { kind: "checks-settled", outcome: "unreadable" } },
      words:
        "The app could not read the checks on your pull request, so it stopped watching them: the host did not answer. Read them with check_change; if that fails too, report it as a blocker.",
    },
  ],
  "run-watch": [
    {
      name: "the first failure in an incomplete list",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "first-failure",
          runId: 19_022_431_877,
          name: "journeys",
          attempt: 2,
          jobs: [
            { id: 54_100_201, name: "linux-e2e (3)", failedAt: "Run journeys" },
            { id: 54_100_202, name: "linux-e2e (4)", failedAt: null },
          ],
          complete: false,
        },
      },
      words:
        'The first failed job in journeys (run 19022431877, attempt 2) was seen while the run is still going: 54100201 linux-e2e (3) — failed at "Run journeys"; 54100202 linux-e2e (4). The job list is incomplete; read the run for the remaining jobs. Read its log with read_workflow and diagnose it. The app wakes you again when the run ends; end your turn instead of sleeping or looping on reads.',
    },
    {
      name: "passed",
      wake: {
        facts: { kind: "run-watch", outcome: "passed", runId: 19_022_431_877, name: "journeys" },
      },
      words:
        "journeys (run 19022431877) passed. Carry on from where you stopped. This is a run outcome, not a pull request check reading or merge approval.",
    },
    {
      name: "failed with jobs and a state",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "failed",
          runId: 19_022_431_877,
          name: "journeys",
          state: "failure",
          jobs: [{ id: 54_100_201, name: "linux-e2e (3)", failedAt: "Run journeys" }],
        },
      },
      words:
        "journeys (run 19022431877) ended (failure): 54100201 linux-e2e (3) — failed at \"Run journeys\". Read failed logs with read_workflow before diagnosing with check_change at the run's version and the failed job's name.",
    },
    {
      name: "failed with no job named",
      wake: {
        facts: { kind: "run-watch", outcome: "failed", runId: 19_022_431_877, name: "journeys" },
      },
      words:
        "journeys (run 19022431877) ended (failed). No failed job was named. Read failed logs with read_workflow before diagnosing with check_change at the run's version and the failed job's name.",
    },
    {
      name: "cancelled",
      wake: {
        facts: { kind: "run-watch", outcome: "cancelled", runId: 19_022_431_877, name: "journeys" },
      },
      words:
        "journeys (run 19022431877) was cancelled. The app stopped watching it; read the run and report what stopped your work.",
    },
    // INF-4574 change 3, from INF-4558: a task watching a batch's run was
    // told to diagnose a failure the app holds and the batch's repair owns.
    {
      name: "the first failure in a batch of several",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "first-failure",
          runId: 19_461_022_517,
          name: "Batch pull request",
          jobs: [{ id: 55_301_744, name: "integration (2)", failedAt: "Run integration tests" }],
          batch: {
            change: "PR #1766",
            url: "https://github.com/example/app/pull/1766",
            head: "8c41d2e",
            members: [
              { task: "INF-4491", title: "Run the batch check's test groups on the Windows PC" },
              { task: "INF-4518", title: "Keep the feed's last line when a task closes" },
            ],
            current: true,
          },
        },
      },
      words:
        'The first failed job in Batch pull request (run 19461022517) was seen while the run is still going: 55301744 integration (2) — failed at "Run integration tests". This run checks PR #1766 (https://github.com/example/app/pull/1766), a batch of the captain\'s approved changes: INF-4491 "Run the batch check\'s test groups on the Windows PC", INF-4518 "Keep the feed\'s last line when a task closes". When its checks fail, the app holds the batch and the first mate starts one task to repair it, which owns this failure. Unless your own task is that repair, do not diagnose it yourself and put up no card about it: find the repair in the task record by the batch\'s pull request, then name its key and state in your report, or wait on it with report\'s waits_on if your work needs it, and carry on with your own work. The app wakes you again when the run ends; end your turn instead of sleeping or looping on reads.',
    },
    {
      name: "failed in a batch of one",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "failed",
          runId: 19_461_022_517,
          name: "Batch pull request",
          state: "failure",
          jobs: [{ id: 55_301_744, name: "integration (2)", failedAt: "Run integration tests" }],
          batch: {
            change: "PR #1766",
            head: "8c41d2e",
            members: [{ task: "INF-4518", title: "Keep the feed's last line when a task closes" }],
            current: true,
          },
        },
      },
      words:
        'Batch pull request (run 19461022517) ended (failure): 55301744 integration (2) — failed at "Run integration tests". This run checks PR #1766, a batch of one approved change, INF-4518 "Keep the feed\'s last line when a task closes", whose own task owns a failure of its checks. Do not diagnose it yourself and put up no card about it: name its key and state in your report, or wait on it with report\'s waits_on if your work needs it, and carry on with your own work.',
    },
    {
      name: "cancelled because the app combined the batch again",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "cancelled",
          runId: 19_461_022_517,
          name: "Batch pull request",
          batch: {
            change: "PR #1766",
            url: "https://github.com/example/app/pull/1766",
            head: "a93f07b",
            members: [
              { task: "INF-4491", title: "Run the batch check's test groups on the Windows PC" },
              { task: "INF-4563", title: "Repair held batch #1766" },
            ],
            current: false,
          },
        },
      },
      words:
        "Batch pull request (run 19461022517) was cancelled because the app replaced its version with a newer version of the same batch of the captain's approved changes, PR #1766 at a93f07b (https://github.com/example/app/pull/1766), whose checks run now. Nothing stopped your work: find the run for that version where the project lives, then read or watch it instead.",
    },
    {
      name: "timed out",
      wake: {
        facts: { kind: "run-watch", outcome: "timed-out", runId: 19_022_431_877, name: "journeys" },
      },
      words:
        "journeys (run 19022431877) is still going after 3 hours. The app stopped watching it; take a short read with read_workflow and report a blocker if it never ends.",
    },
    {
      name: "gone",
      wake: {
        facts: { kind: "run-watch", outcome: "gone", runId: 19_022_431_877, name: "journeys" },
      },
      words:
        "journeys (run 19022431877) is no longer available, so the app stopped watching it. Read the run and report what stopped your work.",
    },
    {
      name: "unreadable with a problem",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "unreadable",
          runId: 19_022_431_877,
          name: "journeys",
          problem: "GitHub answered 404",
        },
      },
      words:
        "The app could not read journeys (run 19022431877), so it stopped watching it: GitHub answered 404. Report a sign-in or access blocker; the captain signs in, never you.",
    },
    {
      name: "unreadable with none",
      wake: {
        facts: {
          kind: "run-watch",
          outcome: "unreadable",
          runId: 19_022_431_877,
          name: "journeys",
        },
      },
      words:
        "The app could not read journeys (run 19022431877), so it stopped watching it: the host did not answer. Report a sign-in or access blocker; the captain signs in, never you.",
    },
  ],
  "job-exit": [
    {
      name: "exited with a tail, to the first mate",
      wake: {
        facts: {
          kind: "job-exit",
          to: "firstmate",
          jobId: "j-9",
          command: "pnpm vitest run",
          exitCode: 0,
          durationMs: 252_000,
          tail: "Tests  86 passed (86)",
        },
      },
      words:
        '[fm-op] background job j-9 finished: "pnpm vitest run" exited 0 after 4m 12s. Output tail:\nTests  86 passed (86)',
    },
    {
      name: "ended by a signal with no output, in seconds",
      wake: {
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "j-10",
          command: "sleep 600",
          exitCode: null,
          durationMs: 400,
        },
      },
      words:
        '[job] background job j-10 finished: "sleep 600" exited by signal after 1s with no output',
    },
    {
      name: "exited after hours",
      wake: {
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "j-11",
          command: "pnpm package:mac",
          exitCode: 1,
          durationMs: 7_980_000,
          tail: "",
        },
      },
      words:
        '[job] background job j-11 finished: "pnpm package:mac" exited 1 after 2h 13m. Output tail:\n',
    },
    {
      name: "stopped at a quit",
      wake: {
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "j-12",
          command: "pnpm vitest run",
          exitCode: null,
          durationMs: 61_000,
          interrupted: "quit",
        },
      },
      words:
        '[job] background job j-12 did not finish: "pnpm vitest run" was stopped after 1m 1s, when Infinitary stopped on the computer running it. No exit will come; run it again if you still need its result.',
    },
    {
      name: "cut by a crash",
      wake: {
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "j-13",
          command: "pnpm vitest run",
          exitCode: null,
          durationMs: 61_000,
          interrupted: "crash",
        },
      },
      words:
        '[job] background job j-13 did not finish there: "pnpm vitest run" was still running when Infinitary ended unexpectedly on the computer running it, and it may have kept running, even to the end. No exit will come; check what it left before you run it again.',
    },
    {
      name: "stopped with its client",
      wake: {
        facts: {
          kind: "job-exit",
          to: "crewmate",
          jobId: "j-14",
          command: "pnpm vitest run",
          exitCode: null,
          durationMs: 3_725_000,
          interrupted: "client",
        },
      },
      words:
        '[job] background job j-14 did not finish: "pnpm vitest run" was stopped after 1h 2m, when the Claude Code process it ran in ended. No exit will come; run it again if you still need its result.',
    },
  ],
};

pinWakeWords("every wake a crewmate hears, byte for byte", CASES);
