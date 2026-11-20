/**
 * The words of the wake a card button the app could not carry out sends the
 * first mate, byte for byte (`tests/helpers/wakeWords.ts` says why;
 * docs/delivery-rigor.md, "Raising care from a merge card").
 */
import {
  type CardActionWakeKind,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<CardActionWakeKind> = {
  "card-action-undone": [
    {
      name: "the review it asks for could not start",
      wake: {
        facts: {
          kind: "card-action-undone",
          card: { id: "card-ready-7", title: "Ready to merge" },
          task: { id: TASK.id, key: "INF-3865", title: TASK.title },
          label: "Review carefully",
          undone: "start-review",
          reason: "there are no commits on its branch to review yet.",
        },
      },
      words:
        '[fm-op] The captain pressed "Review carefully" on card "Ready to merge" (card-ready-7) for task INF-3865 "Restructure the wakes file", and the app could not start the review the button asks for; the task\'s new rigor is recorded, and no review of it is open. The reason: there are no commits on its branch to review yet. Carry out what the captain\'s click asked for with your own tools, or tell the captain on a card what stops it.',
    },
    {
      name: "the rigor it sets was refused",
      wake: {
        facts: {
          kind: "card-action-undone",
          card: { id: "card-ready-7", title: "Ready to merge" },
          task: { id: TASK.id, key: "INF-3865", title: TASK.title },
          label: "Review carefully",
          undone: "set-rigor",
          reason: "INF-3865 is already done.",
        },
      },
      words:
        '[fm-op] The captain pressed "Review carefully" on card "Ready to merge" (card-ready-7) for task INF-3865 "Restructure the wakes file", and the app could not record the rigor the button sets, so the task\'s rigor and review are unchanged. The reason: INF-3865 is already done. Carry out what the captain\'s click asked for with your own tools, or tell the captain on a card what stops it.',
    },
  ],
};

pinWakeWords("the words of a card button the app could not carry out", CASES);
