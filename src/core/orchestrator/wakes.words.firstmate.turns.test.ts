/**
 * The words of the first mate's wakes that `turnWakes.ts` words, byte for byte
 * (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says why): how
 * a crewmate's turns go: a failed, quiet or long turn, a failed commit or
 * hand-over, guidance set aside, a steer it has not read, a repeated tool
 * result and a failed task.
 */
import {
  WAKE_AT as AT,
  type FirstmateTurnWakeKind,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FirstmateTurnWakeKind> = {
  "possible-repetition": [
    {
      name: "calls that worked, with a usage reading",
      wake: {
        facts: {
          kind: "possible-repetition",
          task: TASK,
          notice: {
            identity: "github_read:/repos/infinitary-labs/infinitary/pulls/1061",
            toolName: "github_read",
            count: 3,
            outcome: "worked",
            first: { source: "crewmate", callId: "call-1", at: AT },
            latest: { source: "crewmate", callId: "call-3", at: AT + 95_000 },
          },
          usage: {
            at: AT + 95_000,
            input: 18_204,
            output: 911,
            cache_read: 402_118,
            cache_write: null,
            cost: null,
          },
        },
      },
      words:
        '[fm-op] Possible repetition on task 479823ee "Restructure the wakes file": github_read returned the same result 3 times for the same arguments, and every one of those calls worked; none failed. First/latest call references: {"first":{"source":"crewmate","callId":"call-1","at":1793903528000},"latest":{"source":"crewmate","callId":"call-3","at":1793903623000}}. Elapsed: 95000 ms. Latest available usage reading (not a total): {"at":1793903623000,"input":18204,"output":911,"cache_read":402118,"cache_write":null,"cost":null}. Missing fields and cost are unknown, not zero. Inspect the task. Repeated tests, rereads and polling may be useful. Judge against the original task before steering or interrupting within its scope. This observation is not a loop verdict or an automatic stop.',
    },
    {
      name: "calls that failed",
      wake: {
        facts: {
          kind: "possible-repetition",
          task: TASK,
          notice: {
            identity: "read:gone.md",
            toolName: "read",
            count: 3,
            outcome: "failed",
            first: { source: "crewmate", callId: "call-1", at: AT },
            latest: { source: "crewmate", callId: "call-3", at: AT + 4_000 },
          },
          usage: null,
        },
      },
      words:
        '[fm-op] Possible repetition on task 479823ee "Restructure the wakes file": read returned the same result 3 times for the same arguments, and every one of those calls failed with the same error. First/latest call references: {"first":{"source":"crewmate","callId":"call-1","at":1793903528000},"latest":{"source":"crewmate","callId":"call-3","at":1793903532000}}. Elapsed: 4000 ms. Latest available usage reading (not a total): null. Missing fields and cost are unknown, not zero. Inspect the task. Repeated tests, rereads and polling may be useful. Judge against the original task before steering or interrupting within its scope. This observation is not a loop verdict or an automatic stop.',
    },
    {
      name: "from a work computer that does not say whether they failed",
      wake: {
        facts: {
          kind: "possible-repetition",
          task: TASK,
          notice: {
            identity: "read:CONTRIBUTING.md",
            toolName: "read",
            count: 3,
            outcome: "unknown",
            first: { source: "crewmate", callId: "call-1", at: AT },
            latest: { source: "crewmate", callId: "call-3", at: AT + 4_000 },
          },
          usage: null,
        },
      },
      words:
        '[fm-op] Possible repetition on task 479823ee "Restructure the wakes file": read returned the same result 3 times for the same arguments, and whether those calls worked or failed is not known. First/latest call references: {"first":{"source":"crewmate","callId":"call-1","at":1793903528000},"latest":{"source":"crewmate","callId":"call-3","at":1793903532000}}. Elapsed: 4000 ms. Latest available usage reading (not a total): null. Missing fields and cost are unknown, not zero. Inspect the task. Repeated tests, rereads and polling may be useful. Judge against the original task before steering or interrupting within its scope. This observation is not a loop verdict or an automatic stop.',
    },
  ],
  "turn-failed": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "turn-failed",
          task: TASK,
          crewmate: "crewmate 61",
          error: "the Claude client exited with code 1",
        },
      },
      words:
        '[fm-op] crewmate 61\'s turn on task 479823ee "Restructure the wakes file" failed: the Claude client exited with code 1. The crewmate is still steerable; you can retry, steer, or interrupt it.',
    },
  ],
  "commit-failed": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "commit-failed",
          task: TASK,
          crewmate: "crewmate 61",
          error: "fatal: Unable to create '.git/index.lock': File exists.",
        },
      },
      words:
        "[fm-op] the host could not commit the personal workspace at the end of crewmate 61's turn on task 479823ee \"Restructure the wakes file\", so the task stays open and cannot close as finished. What it changed is saved in the workspace but not committed. Its crewmate's next report tries the commit again: steer it to look into the error and report again, or tell the captain. The error: fatal: Unable to create '.git/index.lock': File exists.",
    },
  ],
  "task-failed": [
    {
      name: "its one wording",
      wake: {
        facts: { kind: "task-failed", task: TASK, error: "the working copy could not be made" },
      },
      words:
        '[fm-op] task 479823ee "Restructure the wakes file" failed: the working copy could not be made',
    },
  ],
  "guidance-set-aside": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "guidance-set-aside",
          task: TASK,
          attempts: 5,
          excerpt: "Rebase onto main and push.",
        },
      },
      words:
        '[fm-op] guidance for task 479823ee "Restructure the wakes file" could not be delivered after 5 attempts and was set aside: Rebase onto main and push.. You can interrupt the task or spawn a follow-up.',
    },
  ],
  quiet: [
    {
      name: "inside calls with steers waiting",
      wake: {
        facts: {
          kind: "quiet",
          task: TASK,
          crewmate: "crewmate 61",
          minutes: 20,
          calls: [
            { tool: "Bash", since: AT },
            { tool: "github_read", since: AT + 30_000 },
          ],
          steers: { count: 2, since: AT + 60_000 },
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has produced no events for 20 minutes; it may be stuck. It is inside Bash since 2026-11-05T18:32:08.000Z, github_read since 2026-11-05T18:32:38.000Z. 2 steers handed over since 2026-11-05T18:33:08.000Z not read yet: the turn reads a steer only once its open call returns. You can steer or interrupt it.',
    },
    {
      name: "one steer waiting and no call",
      wake: {
        facts: {
          kind: "quiet",
          task: TASK,
          crewmate: "crewmate 61",
          minutes: 40,
          steers: { count: 1, since: AT },
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has produced no events for 40 minutes; it may be stuck. 1 steer handed over since 2026-11-05T18:32:08.000Z not read yet: the turn reads a steer only once its open call returns. You can steer or interrupt it.',
    },
    {
      name: "nothing open",
      wake: { facts: { kind: "quiet", task: TASK, crewmate: "crewmate 61", minutes: 20 } },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has produced no events for 20 minutes; it may be stuck. You can steer or interrupt it.',
    },
  ],
  "long-turn": [
    {
      name: "with a job and a call",
      wake: {
        facts: {
          kind: "long-turn",
          task: TASK,
          crewmate: "crewmate 61",
          hours: 2.5,
          job: { command: "pnpm vitest run", since: AT },
          calls: [{ tool: "Bash", since: AT + 60_000 }],
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been on one turn for 2.5 hours. Its background job runs since 2026-11-05T18:32:08.000Z: pnpm vitest run. A running job shows the job works, not the turn. It is inside Bash since 2026-11-05T18:33:08.000Z.',
    },
    {
      name: "bare",
      wake: { facts: { kind: "long-turn", task: TASK, crewmate: "crewmate 61", hours: 3 } },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" has been on one turn for 3 hours.',
    },
  ],
  "steer-unread": [
    {
      name: "behind a call",
      wake: {
        facts: {
          kind: "steer-unread",
          task: TASK,
          crewmate: "crewmate 61",
          since: AT,
          calls: [{ tool: "Bash", since: AT - 600_000 }],
        },
      },
      words:
        '[fm-op] a steer handed to crewmate 61 on task 479823ee "Restructure the wakes file" at 2026-11-05T18:32:08.000Z is still unread after two quiet checks. It waits behind Bash since 2026-11-05T18:22:08.000Z, and the turn reads it only once that call returns. You can wait, or interrupt the turn so the steer goes into its next turn.',
    },
    {
      name: "behind no call",
      wake: {
        facts: { kind: "steer-unread", task: TASK, crewmate: "crewmate 61", since: AT, calls: [] },
      },
      words:
        '[fm-op] a steer handed to crewmate 61 on task 479823ee "Restructure the wakes file" at 2026-11-05T18:32:08.000Z is still unread after two quiet checks. The turn has no open call the app can see. You can wait, or interrupt the turn so the steer goes into its next turn.',
    },
  ],
  // A steer with files_from answered before the files crossed (INF-3060).
  "handover-failed": [
    {
      name: "the copy failed before any file arrived",
      wake: {
        facts: {
          kind: "handover-failed",
          task: TASK,
          from: "INF-1109",
          error: "Kun’s Mac mini is out of reach.",
          arrived: 0,
          files: 2,
        },
      },
      words:
        '[fm-op] the files from INF-1109 for your message to task 479823ee "Restructure the wakes file" were not handed over: Kun’s Mac mini is out of reach. No file reached its hand-over folder. Your message is kept, and its crewmate reads it with a line saying the files did not arrive; hand them again with steer_crewmate files_from if they are still needed.',
    },
    {
      name: "the copy failed part way",
      wake: {
        facts: {
          kind: "handover-failed",
          task: TASK,
          from: "INF-1109",
          error: "Kun’s Mac mini is out of reach.",
          arrived: 1,
          files: 2,
        },
      },
      words:
        '[fm-op] the files from INF-1109 for your message to task 479823ee "Restructure the wakes file" were not handed over: Kun’s Mac mini is out of reach. 1 of 2 files reached its hand-over folder before the failure, with no receipt; its crewmate was not told about them. Your message is kept, and its crewmate reads it with a line saying the files did not arrive; hand them again with steer_crewmate files_from if they are still needed.',
    },
    {
      name: "every file arrived and the hand-over did not finish",
      wake: {
        facts: {
          kind: "handover-failed",
          task: TASK,
          from: "INF-1109",
          error: "Its receipt could not be recorded.",
          arrived: 2,
          files: 2,
        },
      },
      words:
        '[fm-op] the files from INF-1109 for your message to task 479823ee "Restructure the wakes file" were not handed over: Its receipt could not be recorded. All 2 files reached its hand-over folder, verified, but its crewmate was not told about them. Your message is kept, and its crewmate reads it with a line saying the files did not arrive; hand them again with steer_crewmate files_from if they are still needed.',
    },
  ],
};

pinWakeWords("the first mate's turn wakes, byte for byte", CASES);
