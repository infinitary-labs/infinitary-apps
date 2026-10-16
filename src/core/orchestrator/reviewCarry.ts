import type { TaskDelivery, TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import { readChangeReading } from "../workspace/workspaceService";

/**
 * Whether a passed review covers this head (INF-148). Exact head, or a
 * carry the host already recorded because the change lines matched.
 * A missing head, a verdict that is not a pass, or no recorded carry does
 * not cover it: the sync gates refuse, as they did for a different version.
 */
export function reviewCoversHead(
  delivery: TaskDelivery | null | undefined,
  head: string | undefined,
): boolean {
  if (!delivery) return false;
  if (delivery.reviewVerdict !== "pass" || !head) return false;
  return delivery.reviewSha === head || delivery.reviewCarrySha === head;
}

/**
 * Record that a passed review covers `head` when the change lines match.
 * The async gates call this before the sync check, so that check reads a
 * typed fact. Unreadable versions record nothing. A placed task whose
 * computer gave no reading does not carry: an older computer reads none.
 * A pass from before this field existed carries when its reviewed commit
 * is still on this Mac and the task is not placed.
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
  const reviewed =
    delivery.reviewChange ??
    (options.record.deviceId
      ? null
      : await read(options.repoDir, delivery.reviewSha).catch(() => null));
  if (!reviewed) return false;
  const headReading = await read(options.repoDir, options.head).catch(() => null);
  if (!headReading || headReading !== reviewed) return false;
  options.tasks.recordDelivery(options.taskId, { reviewCarrySha: options.head });
  options.tasks.note(
    options.taskId,
    `review at ${delivery.reviewSha.slice(0, 7)} covers ${options.head.slice(0, 7)}: the same change`,
    { news: false, feed: false, data: { reviewCarrySha: options.head } },
  );
  return true;
}
