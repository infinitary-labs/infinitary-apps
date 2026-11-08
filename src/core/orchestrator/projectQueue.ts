import type { RepoView } from "@shared/repos";
import { type ForgeCheck, QUEUE_STATUS } from "../forge";
import { HELD } from "../queue/shipped/gitlab.mjs";
import { type QueueKind, queueKind } from "../queue/shipped/rules.mjs";
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
/**
 * One reading of a task's queue status: its project, the task, what the
 * status says, its link (a run, or a paused batch's issue) and the task's
 * pull request number when it has one.
 */
export type QueueReading = {
  repoId: string;
  taskId: string;
  state: QueueKind;
  link?: string;
  number?: number;
};

export class ProjectQueue {
  private readonly stateListeners = new Set<(reading: QueueReading) => void>();

  constructor(private readonly options: ChangeDeliveryOptions) {}

  /**
   * Hears each reading of a task's queue status in the shipped queue's
   * grammar, with the task and its project: a paused batch, or one that
   * moved on (docs/forge.md, "A paused batch"). Answers its own unsubscribe.
   */
  onState(listener: (reading: QueueReading) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Read the workflow files that mention the queue status on the project's
   * default branch and keep them on its row. A refused or failed read keeps
   * what was read before: nothing read is never "none mention it". Every
   * file is read only where a queue of the project's own matters - a
   * batched project, a waiting choice, or `all` - and otherwise only the
   * shipped queue's file, whose stamp every teammate follows.
   */
  async readWorkflows(repoId: string, all?: boolean): Promise<RepoView | undefined> {
    const repo = this.options.repos.get(repoId);
    if (!repo?.host) return repo;
    const forge = this.options.forgeFor(repo);
    if (!forge.queueWorkflows) return repo;
    try {
      const workflows = await forge.queueWorkflows({
        all: all ?? (repo.delivery === "queue-pr" || repo.queuePendingAt !== undefined),
      });
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
    const state = queueKind(queue.state, queue.detail);
    const reading: QueueReading = {
      repoId: record.repoId,
      taskId,
      state,
      ...(queue.link ? { link: queue.link } : {}),
      ...(record.delivery?.prNumber !== undefined ? { number: record.delivery.prNumber } : {}),
    };
    for (const listener of [...this.stateListeners]) listener(reading);
    // The queue held this version for a Maintainer (the GitLab part's held
    // words): only a Maintainer's approval after its last push and then the
    // captain's click start it again, so the task's crewmate hears it once
    // per version.
    if (queue.state === "pending" && queue.detail === HELD) {
      const change = reading.number !== undefined ? `!${reading.number}` : "the change";
      this.options.steer?.(taskId, {
        facts: { kind: "queue-held", change, head, words: HELD },
        once: `queue-held:${head}`,
      });
    }
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

  /** The facts the Firstmate's words at a queue wait and the check watch's wake say, for a task waiting on its project's queue. */
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

/** Workflow paths in a sentence: "a.yml", "a.yml and b.yml", "a.yml, b.yml and c.yml". */
function pathsWords(paths: readonly string[]): string {
  if (paths.length <= 1) return paths[0] ?? "";
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

/**
 * The fact the check watch's two-hour wake adds for a version waiting on
 * its project's queue, and what the Firstmate is told beside a merge click's
 * queue wait (`keptNote`, INF-2913), in the agents' words; undefined when
 * the queue answered this version or the task waits on no queue.
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
