import type { RepoView } from "@shared/repos";
import { type ForgeCheck, QUEUE_STATUS } from "../forge";
import type { QueueMark } from "../storage/taskStore";
import type { ChangeDeliveryOptions } from "./changeContext";
import { CHECK_WATCH_BOUND_MS } from "./checkWatch";

/**
 * What the app knows about a project's queue when a merge waits on it: the
 * workflow files that mention its status, whether anything ever answered,
 * and whether this version still holds only the app's mark after the check
 * watch's bound. These are reads, never a verdict that the project has no
 * queue, so the words say only what was read.
 */
export type QueueNoteFacts = {
  workflows?: RepoView["queueWorkflows"];
  answeredBefore: boolean;
  /** The version still holds only the app's mark, this long after the click. */
  quietMs?: number;
};

/**
 * A project's queue facts, read where it lives and kept on its row by the
 * project registry: the workflow files that mention the queue status, read
 * when the batched delivery is chosen and at each merge click that marks a
 * version, and when anything but the app last wrote that status.
 */
export class ProjectQueue {
  constructor(private readonly options: ChangeDeliveryOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Read the workflow files that mention the queue status on the project's
   * default branch and keep them on its row. A refused or failed read keeps
   * what was read before: nothing read is never "none mention it".
   */
  async readWorkflows(repoId: string): Promise<RepoView | undefined> {
    const repo = this.options.repos.get(repoId);
    if (!repo?.host || repo.host.kind !== "github") return repo;
    const forge = this.options.forgeFor(repo);
    if (!forge.queueWorkflows) return repo;
    try {
      const workflows = await forge.queueWorkflows();
      return this.options.repos.recordQueue(repoId, { workflows });
    } catch {
      return this.options.repos.get(repoId);
    }
  }

  /** The app marked `head` waiting: keep the mark's id, so a later write by anything else reads as one. */
  marked(taskId: string, head: string, id: number | undefined): void {
    const mark: QueueMark = { head, at: this.now(), ...(id !== undefined ? { id } : {}) };
    this.options.tasks.delivery.recordChangeEvidence(taskId, { queueMark: mark });
  }

  /**
   * One reading of a task's checks at `head`: the queue status there was
   * answered when it is anything but waiting (the app writes only waiting),
   * or when its id is no longer the app's own mark on that version. An
   * answer is kept on the task's mark and as the project's latest answer.
   */
  observe(taskId: string, head: string, items: readonly ForgeCheck[]): void {
    const queue = items.find((item) => item.name === QUEUE_STATUS);
    if (!queue) return;
    const record = this.options.tasks.get(taskId);
    if (!record?.repoId) return;
    const mark = record.delivery?.queueMark;
    const ownMark = mark?.head === head ? mark : undefined;
    const answered =
      queue.state !== "pending" ||
      (ownMark?.id !== undefined && queue.statusId !== undefined && queue.statusId !== ownMark.id);
    if (!answered) return;
    if (ownMark && !ownMark.answered)
      this.options.tasks.delivery.recordChangeEvidence(taskId, {
        queueMark: { ...ownMark, answered: true },
      });
    this.options.repos.recordQueue(record.repoId, {
      answeredAt: queue.finishedAt ?? this.now(),
    });
  }

  /** The facts the waiting note and the check watch's wake say, for a task waiting on its project's queue. */
  noteFacts(taskId: string): QueueNoteFacts | undefined {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (!record || !repo) return undefined;
    return queueNoteFacts(repo, record.delivery?.queueMark, this.now());
  }
}

/** The note facts from a project's row and a task's mark, at `now`. */
export function queueNoteFacts(
  repo: Pick<RepoView, "queueWorkflows" | "queueAnsweredAt">,
  mark: QueueMark | undefined,
  now: number,
): QueueNoteFacts {
  const quietMs =
    mark && !mark.answered && now - mark.at >= CHECK_WATCH_BOUND_MS ? now - mark.at : undefined;
  return {
    ...(repo.queueWorkflows ? { workflows: repo.queueWorkflows } : {}),
    answeredBefore: repo.queueAnsweredAt !== undefined,
    ...(quietMs !== undefined ? { quietMs } : {}),
  };
}

function hoursOf(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** Workflow paths in a sentence: "a.yml", "a.yml and b.yml", "a.yml, b.yml and c.yml". */
function pathsWords(paths: readonly string[]): string {
  if (paths.length <= 1) return paths[0] ?? "";
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

/**
 * The waiting note's warning, or undefined when the plain waiting words
 * hold: a project whose batch check never answered, said with what the
 * workflow read found; or a version nothing has written since the click for
 * the check watch's whole bound, on a project whose check answered before.
 */
export function queueWarningWords(facts: QueueNoteFacts | undefined): string | undefined {
  if (!facts) return undefined;
  if (!facts.answeredBefore) {
    const lead = "Nothing in this project has answered the batch check yet";
    const workflows = facts.workflows;
    if (!workflows) return `${lead}. This merge waits until something does.`;
    const on = workflows.filter((workflow) => workflow.active).map((workflow) => workflow.path);
    if (on.length > 0)
      return `${lead}; ${pathsWords(on)} ${on.length === 1 ? "mentions" : "mention"} it. This merge waits until it answers.`;
    if (workflows.length > 0)
      return `${lead}, and the workflow that mentions it is turned off. This merge waits until one answers.`;
    return `${lead}, and no workflow mentions it. This merge waits until one does.`;
  }
  if (facts.quietMs !== undefined)
    return `Nothing has answered the batch check since you approved this ${hoursOf(facts.quietMs)} ago. Your approval is kept and runs once that check passes.`;
  return undefined;
}

/**
 * The fact the check watch's two-hour wake adds for a version waiting on
 * its project's queue, in the crewmate's words; undefined when the queue
 * answered this version or the task waits on no queue.
 */
export function queueWakeWords(facts: QueueNoteFacts | undefined): string | undefined {
  if (!facts) return undefined;
  if (!facts.answeredBefore) {
    const workflows = facts.workflows;
    const read = !workflows
      ? "the app could not read its workflows"
      : workflows.length === 0
        ? "no workflow on its default branch mentions it"
        : `${pathsWords(workflows.map((workflow) => workflow.path))} ${workflows.length === 1 ? "mentions" : "mention"} it${workflows.some((workflow) => workflow.active) ? "" : " but is turned off"}`;
    return `Nothing in this project has ever answered ${QUEUE_STATUS}, and ${read}.`;
  }
  if (facts.quietMs !== undefined)
    return `Nothing has written ${QUEUE_STATUS} on this version since the app marked it waiting, though the project's batch check has answered before.`;
  return undefined;
}
