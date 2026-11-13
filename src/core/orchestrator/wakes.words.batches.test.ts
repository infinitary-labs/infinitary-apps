/**
 * The words of the wakes batches of your own queue, byte for byte
 * (`tests/helpers/wakeWords.ts` says why): the hold the first mate hears and
 * the send-back a change's own crewmate hears (docs/forge.md, "Batches of your own").
 */
import {
  type OwnBatchWakeKind,
  pinWakeWords,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<OwnBatchWakeKind> = {
  "batch-held": [
    {
      // INF-3759 piece 1: a failed batch of several is told once, and one repair task answers it.
      name: "a batch of two failed one check",
      wake: {
        facts: {
          kind: "batch-held",
          project: { id: "p-7a21", name: "meter" },
          change: "#31",
          url: "https://github.com/acme/meter/pull/31",
          head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
          checks: ["unit-tests"],
          members: [
            { task: "MTR-12", title: "fix(meter): read the reset date" },
            { task: "MTR-14", title: "feat(meter): show the weekly window" },
          ],
        },
      },
      words:
        '[fm-op] a batch of the captain\'s approved changes is held in project "meter" (repo_id p-7a21): #31 (https://github.com/acme/meter/pull/31) at 5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0 failed unit-tests. It carries, in order: MTR-12 "fix(meter): read the reset date", MTR-14 "feat(meter): show the weekly window". Changes approved meanwhile wait in line behind it. Start one task in that project now, with no card first, whose brief names the batch-repair skill, that pull request and that version: it accounts for every failed test against every change in the batch, then sends back the change or changes at fault, each with its reason, or fixes forward with a change it declares the batch\'s fix, or runs the failed checks again when it judges a flake, which still gets an owner. If a task is already repairing this batch, start nothing. Put up no card about the hold: Settings shows it with Try again and Send back with a reason.',
    },
  ],
  "batch-sent-back": [
    {
      // INF-3759 piece 1: a change sent back from its batch loses its approval.
      name: "a change sent back from its batch with a reason",
      wake: {
        facts: {
          kind: "batch-sent-back",
          head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
          reason: "Its new parser fails the date tests the batch ran.",
        },
      },
      words:
        "Your change at 5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0 was sent back from its batch of approved changes and is no longer approved: Its new parser fails the date tests the batch ran. The other changes of that batch go on without it. Repair it on your branch, validate, push and confirm its story, then put up a new merge card for the new version: once approved it joins the project's next batch.",
    },
  ],
};

pinWakeWords("the wakes of batches of your own, byte for byte", CASES);
