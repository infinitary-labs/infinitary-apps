import type { NamingRule } from "@shared/runbooks";
import { Batches, type BatchesOptions } from "../batches/batches";
import type { InboxStore } from "../storage/inboxStore";
import { TaskService } from "../tasks/taskService";
import type { ChangeChecks } from "./changeChecks";
import type { ChangePresentations } from "./changePresentations";
import type { FirstmateAgent } from "./firstmateAgent";
import type { KeptApproval } from "./keptApproval";
import { candidateHead, standInFront, standingAuthorization } from "./mergeAuthorization";
import { TICK_PERIOD_MS, type Ticker } from "./ticker";

/**
 * Batches of your own (docs/forge.md, "Batches of your own"), wired to the
 * owners its callbacks reach: only approved work is carried, each task's
 * kept merge reads its place, a change sent back loses its approval and
 * its crewmate is told, and a held batch of several reaches the first mate
 * once. The first pass after a start reconciles every open batch from the host.
 */
export function createOwnBatches(owners: {
  repos: BatchesOptions["repos"];
  forgeFor: BatchesOptions["forgeFor"];
  ticker: Pick<Ticker, "now" | "register">;
  tasks: TaskService;
  presentations: Pick<ChangePresentations, "batchRegion">;
  inbox: Pick<InboxStore, "enqueue">;
  /** Owners built after this one, read when a callback runs. */
  late: () => {
    checks: Pick<ChangeChecks, "declaredAbsent">;
    settling: {
      /** Runs a task's kept merge again, so it reads its change's place now. */
      kept: { runMergeAuthorization: (taskId: string) => Promise<unknown> };
      approvals: Pick<KeptApproval, "endAuthorization">;
    };
  };
  firstmate: () => Pick<FirstmateAgent, "notifyOp"> | undefined;
  note: (text: string) => void;
  /** The active naming runbook's rule, read at each use; absent or null, no naming runbook is on. */
  namingRule?: () => NamingRule | null;
  /** The combine, the push and the read of merged commits; git's own where left out. */
  git?: Pick<BatchesOptions, "combine" | "push" | "landed" | "branchName">;
}): Batches {
  const { tasks, forgeFor } = owners;
  // The standing approval, or one queued behind it, that covers this version of the task's own branch.
  const approval = (taskId: string, head: string) => {
    const record = tasks.get(taskId);
    const top = standingAuthorization(record?.delivery);
    if (!record || TaskService.isClosed(record) || !top) return undefined;
    return [top, ...(top.queued ?? [])].find(
      (entry) =>
        !entry.review && entry.target.branch === record.branch && candidateHead(entry) === head,
    );
  };
  const batches = new Batches({
    repos: owners.repos,
    forgeFor,
    now: owners.ticker.now,
    naming: () => owners.namingRule?.() ?? null,
    approved: (taskId, head) => approval(taskId, head) !== undefined,
    runsNoChecks: (taskId, head) => owners.late().checks.declaredAbsent(taskId, head),
    live: (taskId) => {
      const record = tasks.get(taskId);
      return record !== undefined && !TaskService.isClosed(record);
    },
    story: async (member, forge) => {
      const { story, region } = await owners.presentations.batchRegion(
        member.taskId,
        member.branch,
        member.head,
        forge,
      );
      return { region, projectText: story.projectText ?? "" };
    },
    settle: (taskIds) => {
      for (const taskId of taskIds)
        void owners
          .late()
          .settling.kept.runMergeAuthorization(taskId)
          .catch(() => {});
    },
    sentBack: (change, reason) => {
      const kept = approval(change.taskId, change.head);
      if (kept) {
        standInFront(tasks, change.taskId, (item) => item.id === kept.id);
        owners
          .late()
          .settling.approvals.endAuthorization(
            change.taskId,
            "invalidated",
            `its change was sent back from its batch: ${reason}`,
            { feed: true },
          );
      }
      owners.inbox.enqueue(change.taskId, {
        facts: { kind: "batch-sent-back", head: change.head, reason },
      });
    },
    held: ({ repo, batch }) =>
      owners.firstmate()?.notifyOp(
        {
          facts: {
            kind: "batch-held",
            project: { id: repo.id, name: repo.name },
            change:
              batch.number === undefined
                ? "its pull request"
                : forgeFor(repo).label({
                    number: batch.number,
                    branch: batch.branch,
                    headSha: batch.head,
                    url: null,
                  }),
            ...(batch.url ? { url: batch.url } : {}),
            head: batch.head,
            checks: batch.hold?.checks ?? [],
            members: batch.members.map((member) => ({
              task: tasks.get(member.taskId)?.key ?? member.taskId,
              title: member.title,
            })),
          },
        },
        "agent",
      ),
    note: owners.note,
    taskNote: (taskId, text) => tasks.note(taskId, text, { news: true }),
    ...owners.git,
  });
  owners.ticker.register("batches", TICK_PERIOD_MS, () => batches.sweep());
  return batches;
}
