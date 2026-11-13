import type { FmEvent } from "@shared/events";
import { hostRunsQueue } from "@shared/repos";
import type { CrewSupervisor } from "./orchestrator/crewSupervisor";
import type { FirstmateAgent } from "./orchestrator/firstmateAgent";
import type { ProjectQueue } from "./orchestrator/projectQueue";
import { QueueChoice } from "./orchestrator/queueChoice";
import { QueuePauses } from "./orchestrator/queuePauses";
import { TICK_PERIOD_MS, type Ticker } from "./orchestrator/ticker";
import type { TaskService } from "./tasks/taskService";
import type { RepoRegistry } from "./workspace/repoRegistry";

/** Home wiring for the project queue's batched choice and its paused batches; each owner keeps its writes. */
export function startHomeQueue({
  repos,
  tasks,
  queue,
  ways,
  forgeFor,
  supervisor,
  broadcastEvent,
  notify,
  ticker,
}: {
  repos: RepoRegistry;
  tasks: Pick<TaskService, "get" | "note" | "onChange">;
  queue: Pick<ProjectQueue, "readWorkflows" | "onState">;
  ways: ConstructorParameters<typeof QueueChoice>[0]["ways"];
  forgeFor: ConstructorParameters<typeof QueuePauses>[0]["forgeFor"];
  supervisor: Pick<CrewSupervisor, "cards" | "hostOps">;
  broadcastEvent: (event: FmEvent) => void;
  notify: (notice: Parameters<FirstmateAgent["notifyOp"]>[0]) => void;
  ticker: Pick<Ticker, "now" | "register">;
}) {
  // A batched choice before the project's queue exists (INF-2885 direction
  // B, docs/forge.md "Choosing batched pull requests before a queue
  // exists"): it waits with its card up, the first mate hears the card's
  // Ask, and a merge in the project reads its workflows again.
  const queueChoice = new QueueChoice({
    repos,
    queue,
    raiseCard: (card) => supervisor.cards.hostCards.raiseHostCard(card),
    withdrawCard: (id, reason) => supervisor.cards.hostCards.withdrawHostCard(id, reason),
    tell: (facts) => notify({ facts }),
    note: (text) => broadcastEvent({ type: "firstmate_note", text }),
    ways,
    offers: {
      offered: (repoId) => repos.queueOffered(repoId),
      record: (repoId, version) => repos.recordQueueOffered(repoId, version),
    },
    now: ticker.now,
  });
  // Each new read of a project's queue is followed for every teammate: a
  // project that runs the shipped queue is batched here too, and an older
  // shipped queue is offered its update once (docs/forge.md, "The shipped queue").
  repos.onQueue((repo) => void queueChoice.follow(repo).catch(() => {}));
  // A paused batch of the shipped queue (docs/forge.md, "A paused batch"):
  // each task's queue reading may show it, Settings shows it with its
  // Resume, and the first mate hears it once to start the repair.
  const queuePauses = new QueuePauses({
    repos,
    forgeFor,
    tell: (facts) => notify({ facts }),
    note: (text) => broadcastEvent({ type: "firstmate_note", text }),
    taskNote: (taskId, text) => tasks.note(taskId, text, { news: true }),
    now: ticker.now,
  });
  queue.onState((reading) => queuePauses.observed(reading));
  ticker.register("queue-pauses", TICK_PERIOD_MS, () => queuePauses.sweep());
  supervisor.hostOps.setQueueChoice({
    plan: (repoId) => queueChoice.plan(repoId),
    keep: (repoId) => queueChoice.keep(repoId),
  });
  tasks.onChange((change) => {
    for (const event of change.events) {
      if (event.kind !== "merged" && event.kind !== "landed") continue;
      const repoId = tasks.get(event.taskId)?.repoId;
      const repo = repoId ? repos.get(repoId) : undefined;
      if (!repo) continue;
      if (repo.queuePendingAt !== undefined) void queueChoice.recheck(repo.id);
      // A merge may bring in the shipped queue, or a newer one: read again.
      else if (hostRunsQueue(repo.host)) void queue.readWorkflows(repo.id).catch(() => {});
    }
  });
  return { queueChoice, queuePauses };
}
