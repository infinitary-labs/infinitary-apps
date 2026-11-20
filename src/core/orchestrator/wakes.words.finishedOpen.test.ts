/**
 * The words of the wake finished work still open an hour on gives the first
 * mate, byte for byte (`tests/helpers/wakeWords.ts` says why;
 * docs/report-sort.md, "Finished work still open an hour on").
 */
import {
  type FinishedOpenWakeKind,
  pinWakeWords,
  WAKE_TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FinishedOpenWakeKind> = {
  "finished-open": [
    {
      // INF-4072, finding 4: finished work still open an hour on, nothing waiting.
      name: "nothing waits for its crewmate",
      wake: {
        facts: {
          kind: "finished-open",
          task: WAKE_TASK,
          key: "INF-3807",
          finishedMs: 3_900_000,
          waiting: [],
        },
      },
      words:
        '[fm-op] task INF-3807 "Restructure the wakes file" declared its work finished 1h 5m ago and is still open, with nothing up for the captain to decide and no reminder about it left to come. Close it with settle_task done if the record bears that out, or steer its crewmate with what is still missing. You are told this once.',
    },
    {
      // A steer handed to a turn that never finished with it holds the close.
      name: "a message waits for its crewmate",
      wake: {
        facts: {
          kind: "finished-open",
          task: WAKE_TASK,
          key: "INF-3807",
          finishedMs: 82_800_000,
          waiting: [
            {
              id: 4127,
              ageMs: 80_000_000,
              state: "handed",
              attempts: 1,
              excerpt: "Re-run the meter bench with the new clock.",
            },
          ],
        },
      },
      words:
        '[fm-op] task INF-3807 "Restructure the wakes file" declared its work finished 23h ago and is still open, with nothing up for the captain to decide and no reminder about it left to come. Close it with settle_task done if the record bears that out, or steer its crewmate with what is still missing. You are told this once. A message still waits for its crewmate, which holds your close. If its crewmate no longer needs it, close with settle_task done and drop_waiting [4127], which drops it as the close goes through. Waiting: message 4127, queued 22h 13m ago and handed to a turn that never finished with it: "Re-run the meter bench with the new clock."',
    },
  ],
};

pinWakeWords("the finished-open wake, byte for byte", CASES);
