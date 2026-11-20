import type { TaskDelivery } from "../storage/taskRecords";

/**
 * A row's delivery as the board and a task's record send it (INF-3908): the
 * saved delivery without what no view draws from it. The change stories,
 * the live validation record and the check repair record are the largest
 * parts of a long record's delivery - 18.7 MB of a 21.5 MB board on a record
 * of 7,376 tasks - and every view that shows them reads them another way:
 * a task's record draws its validation from `liveValidation` on its own
 * read (`liveValidationSummary`), and a change's story rides its merge card.
 * The private closure snapshot is served through Details' policies.
 */
export function deliveryViewOf(
  delivery: TaskDelivery | null | undefined,
): (TaskDelivery & { reviewCovers?: boolean }) | null {
  if (!delivery) return null;
  const {
    presentation: _presentation,
    presentations: _presentations,
    liveValidation: _liveValidation,
    ciRepair: _ciRepair,
    closedPolicies: _closedPolicies,
    ...view
  } = delivery;
  return view;
}
