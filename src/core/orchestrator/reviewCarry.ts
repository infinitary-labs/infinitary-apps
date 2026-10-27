import type { TaskDelivery, TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import { readChangeReading } from "../workspace/workspaceService";

/**
 * The change reading stored with `head` (INF-416 G): on the approval, on
 * the repair that produced it, or from a version seen before either.
 * A missing reading is not a mismatch.
 */
export function storedChangeReading(
  delivery: TaskDelivery | null | undefined,
  head: string | undefined,
): string | undefined {
  if (!delivery || !head) return undefined;
  const seen = delivery.versionReadings?.[head];
  if (seen) return seen;
  const authorization = delivery.mergeAuthorization;
  if (!authorization) return undefined;
  if (authorization.approvedHead === head && authorization.changeReading)
    return authorization.changeReading;
  const step =
    authorization.lineage.find((repair) => repair.toHead === head) ??
    (authorization.undecided?.toHead === head ? authorization.undecided : undefined);
  return step?.changeReading;
}

/**
 * Whether a passed review covers this head (INF-148). Exact head, a carry
 * recorded before the reading was stored with the version, or a stored
 * change reading that matches the review's. A missing head, a verdict that
 * is not a pass, or no stored match does not cover it.
 */
export function reviewCoversHead(
  delivery: TaskDelivery | null | undefined,
  head: string | undefined,
): boolean {
  if (!delivery) return false;
  if (delivery.reviewVerdict !== "pass" || !head) return false;
  if (delivery.reviewSha === head || delivery.reviewCarrySha === head) return true;
  const stored = storedChangeReading(delivery, head);
  return Boolean(delivery.reviewChange && stored && stored === delivery.reviewChange);
}

/**
 * Record that a passed review covers `head` when its change reading matches.
 * Compares stored readings. A version with none yet is read once and the
 * reading is stored - never a second carried-to head. Unreadable versions
 * record nothing. A placed task whose computer gave no reading does not
 * carry: an older computer reads none.
 */
export async function carryPassedReview(options: {
  tasks: TaskService;
  taskId: string;
  record: TaskRecord;
  repoDir: string | null | undefined;
  head: string;
  read?: (repoDir: string, sha: string) => Promise<string | null>;
}): Promise<boolean> {
  const delivery = options.record.delivery;
  if (!delivery) return false;
  if (delivery.reviewVerdict !== "pass" || !delivery.reviewSha) return false;
  if (reviewCoversHead(delivery, options.head)) return true;
  if (!options.repoDir) return false;
  const read = options.read ?? readChangeReading;
  let reviewed = delivery.reviewChange ?? null;
  if (!reviewed) {
    if (options.record.deviceId) return false;
    reviewed = await read(options.repoDir, delivery.reviewSha).catch(() => null);
    if (!reviewed) return false;
    options.tasks.recordChangeEvidence(options.taskId, { reviewChange: reviewed });
  }
  const stored = storedChangeReading(options.tasks.get(options.taskId)?.delivery, options.head);
  if (stored) return stored === reviewed;
  const headReading = await read(options.repoDir, options.head).catch(() => null);
  if (!headReading || headReading !== reviewed) return false;
  const latest = options.tasks.get(options.taskId)?.delivery;
  options.tasks.recordChangeEvidence(options.taskId, {
    versionReadings: { ...latest?.versionReadings, [options.head]: headReading },
  });
  options.tasks.note(
    options.taskId,
    `review at ${delivery.reviewSha.slice(0, 7)} covers ${options.head.slice(0, 7)}: the same change`,
    { news: false, feed: false },
  );
  return true;
}
