import { formatUsd } from "@shared/costLimit";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { cutText } from "@shared/textCut";
import type { TaskToolsDelegate } from "../pi/taskTools";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { queryTasksAsync } from "../tasks/taskQuery";
import type { DeliveryNote } from "./answerDelivery";
import type { AskCapture } from "./askCapture";
import { captainWordsIn } from "./captainOverrides";
import { cardMutationText } from "./cardMutationText";
import type { FirstmateAgentOptions, FirstmateTurn } from "./firstmateAgent";
import { startedReply } from "./replyLine";
import { handOffShape } from "./workShape";

/** What the graph tools reach of the first mate agent: its options, the running turn and its asks. */
export type FirstmateTaskToolsHost = {
  readonly options: FirstmateAgentOptions;
  readonly turn: FirstmateTurn;
  readonly asks: AskCapture;
  /** Save one action that took effect for the messages the turn has read. */
  noteDelivery(entry: DeliveryNote): void;
};

/**
 * The graph tools' host side (P2). Each write attaches the turn's ask to
 * the task it acts on (attach first, D1); a graph refusal - a cycle, a
 * parent with open children, a move a workspace forbids - returns as the
 * tool's text so the agent reads it in conversation.
 */
export function firstmateTaskTools(host: FirstmateTaskToolsHost): TaskToolsDelegate {
  const supervisor = host.options.supervisor;
  const tasks = host.options.tasks;
  const resolve = (ref: string): TaskRecord => {
    const record = tasks.resolve(ref);
    if (!record) {
      throw new Error(
        `Unknown task "${ref}". Use a task id or key from the context's crew, crew_status, or the tasks tool.`,
      );
    }
    return record;
  };
  /** A graph write on started work that took effect: the reply's words, when it has some, then the delivery. */
  const tookEffect = (ref: string, app?: string): void => {
    if (app !== undefined) host.turn.replyFacts.app = app;
    host.noteDelivery({ outcome: "action", kind: "work", tool: "update_task", ref });
  };
  const asText = (run: () => string): string => {
    try {
      return run();
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return caught.message;
      throw caught;
    }
  };
  return {
    plan: ({ captainStop, ...input }) => {
      let record: TaskRecord;
      try {
        record = supervisor.intake.plan(input);
      } catch (caught) {
        // A refused hand-off (INF-799) files nothing and reads as words.
        if (caught instanceof TaskGraphRefusal)
          return { taskId: "", key: "", text: caught.message };
        throw caught;
      }
      host.asks.attach(record.id, "create_task", true);
      // The captain asked for it to wait, as when they chose to file it for
      // later (INF-4165 finding 3): recorded at filing, so the next-move
      // check never reads the wait as work standing still.
      const stop = captainStop
        ? tasks.starts.declareCaptainStop(record.id, "firstmate")
        : undefined;
      // The reply says where the work landed (INF-2715): filed means the
      // backlog, and queued work says when it starts.
      host.turn.replyFacts.app =
        record.startPolicy === "on-request"
          ? `Filed ${record.key} in the backlog: ${record.title}`
          : `${record.key} ${supervisor.intake.plannedWaiting(record)}: ${record.title}`;
      host.noteDelivery({
        outcome: "action",
        kind: "record",
        tool: "create_task",
        ref: record.id,
      });
      // A when-ready row nothing waits on is dispatched by this very sweep:
      // the answer says a crewmate starts, the fact the feed line states.
      const waiting =
        supervisor.facts.crewStatus(record.id)[0]?.gate ??
        (record.startPolicy === "when-ready" ? "a crewmate starts on it now" : undefined);
      return {
        taskId: record.id,
        key: record.key,
        text: `Planned ${record.key} "${record.title}" (task_id ${record.id})${waiting ? ` - ${waiting}` : ""}.${stop ? ` ${stop.ok ? `Recorded that the captain asked ${record.key} to wait.` : stop.text}` : ""}`,
      };
    },
    update: async (input) => {
      try {
        const text = await (async () => {
          const record = resolve(input.task);
          // Resolve before any write. An unknown prerequisite is a tool error,
          // and two references to one task count once. INF-416 piece I: add
          // what is not linked yet; never compare the list or remove a link.
          const declared =
            input.declaredBlockers === undefined
              ? undefined
              : [...new Set(input.declaredBlockers.map((ref) => resolve(ref).id))];
          host.asks.attach(record.id, "update_task");
          // The answer to a task stuck at its provider (docs/inbox.md): the
          // app's own pick, never a model named here.
          if (input.unstick) {
            const answer = await supervisor.turns.unstick(record.id, input.unstick);
            if (!answer.ok) throw new TaskGraphRefusal(answer.text);
            tookEffect(record.id);
            return answer.text;
          }
          const beforePolicies = input.policies
            ? effectiveTaskPolicies(
                record,
                record.repoId ? host.options.repos.get(record.repoId) : undefined,
              )
            : null;
          const runsOn =
            typeof input.runsOn === "string"
              ? supervisor.placement.resolveRunsOn(input.runsOn)
              : input.runsOn;
          // A model named for started work moves it there between turns,
          // keeping its key, branch and working copy (INF-849).
          const moveTo =
            record.kind === "work" && record.status === "active" ? input.model?.trim() : undefined;
          // on-request on started work moves it back to the backlog (INF-2062):
          // its turn stops and its work stays, after the other edits land.
          const toBacklog =
            record.kind === "work" &&
            record.status === "active" &&
            input.startPolicy === "on-request";
          // A typed hand-off is checked as a new task's is (INF-799); empty clears it.
          const handOff = (() => {
            if (input.resultSchema === undefined && input.branchFrom === undefined) return {};
            const checked = handOffShape(
              tasks,
              {
                ...(input.resultSchema ? { result_schema: input.resultSchema } : {}),
                ...(input.branchFrom?.trim() ? { branch_from: input.branchFrom } : {}),
              },
              record.repoId,
              record.id,
            );
            if ("refused" in checked) throw new TaskGraphRefusal(checked.refused);
            return {
              ...(input.resultSchema !== undefined
                ? { resultSchema: checked.result_schema ?? null }
                : {}),
              ...(input.branchFrom !== undefined ? { branchFrom: checked.branch_from ?? "" } : {}),
            };
          })();
          // What updateFields applies first - a reopening, a move to another
          // project or under another parent - lands before where it runs is
          // judged, in one transaction: it is judged, and its words written,
          // where the task lands, and a refusal changes nothing.
          const moves = {
            ...(input.correctRequiredAction ? { correctRequiredAction: true } : {}),
            ...(input.project !== undefined ? { project: input.project } : {}),
            ...(input.parent !== undefined ? { parent: input.parent } : {}),
          };
          // A program's bound is the captain's consent (INF-799): raised only on the captain's turn.
          if (input.programBound !== undefined && host.turn.origin !== "captain-turn")
            throw new TaskGraphRefusal(
              "program_bound is raised only on the captain's words: ask the captain on a card first.",
            );
          const rest = {
            // A title past its room is refused by updateFields, never cut here.
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.programBound !== undefined ? { programBound: input.programBound } : {}),
            ...(input.basis !== undefined ? { basis: input.basis } : {}),
            ...handOff,
            ...(input.internalStep !== undefined ? { internalStep: input.internalStep } : {}),
            ...(input.speed !== undefined ? { speed: input.speed } : {}),
            ...(input.model !== undefined && !moveTo ? { model: input.model } : {}),
            ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
            ...(input.placementRequirements !== undefined
              ? { placementRequirements: input.placementRequirements }
              : {}),
            ...(input.policies ? { policies: input.policies } : {}),
            ...(input.direction ? { direction: input.direction } : {}),
            ...(input.goal !== undefined ? { goal: input.goal.trim() || null } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.startPolicy && record.status !== "active"
              ? { startPolicy: input.startPolicy }
              : {}),
            ...(input.verdict !== undefined
              ? { verdict: cutText(input.verdict?.trim() ?? "", 280) || null }
              : {}),
          };
          const changes = tasks.atomic(
            () => {
              const moved =
                Object.keys(moves).length > 0
                  ? tasks.updateFields(record.id, moves, "firstmate")
                  : [];
              const refused =
                runsOn !== undefined
                  ? supervisor.placement.runsOnRefusal(record.id, runsOn)
                  : undefined;
              if (refused) throw new TaskGraphRefusal(refused);
              const added: string[] = [];
              if (declared) {
                const linked = new Set(tasks.graph.blockers(record.id).map((row) => row.id));
                for (const blockerId of declared) {
                  if (linked.has(blockerId)) continue;
                  // A cycle throws inside this transaction, so the field edits
                  // above and below roll back with the link.
                  if (!tasks.graph.link(blockerId, record.id, "blocks", "firstmate")) continue;
                  const blocker = tasks.get(blockerId);
                  added.push(`waits for ${blocker?.key || blockerId}`);
                }
              }
              const where =
                runsOn !== undefined
                  ? {
                      runsOn: {
                        ask: runsOn,
                        words: supervisor.placement.runsOnWords(record.id, runsOn),
                      },
                    }
                  : {};
              return [
                ...moved,
                ...tasks.updateFields(record.id, { ...rest, ...where }, "firstmate"),
                ...added,
              ];
            },
            () => {},
          );
          const move = moveTo
            ? await supervisor.moves.requestMove(record.id, { by: "firstmate", model: moveTo })
            : undefined;
          const backlog = toBacklog
            ? supervisor.hostOps.moveToBacklog(
                record.id,
                { actor: "firstmate", via: "tool", decision: null },
                input.reason,
              )
            : undefined;
          if (backlog?.ok) tookEffect(record.id);
          if (move?.ok) tookEffect(record.id);
          // The captain asked for it to wait (INF-3846 piece 2): recorded after
          // the start policy and any move to the backlog, which it needs.
          const stop = input.captainStop
            ? tasks.starts.declareCaptainStop(record.id, "firstmate")
            : undefined;
          if (stop?.ok && stop.changed) tookEffect(record.id);
          const stopText = !stop
            ? undefined
            : !stop.ok
              ? stop.text
              : stop.changed
                ? `Recorded that the captain asked ${record.key || record.id} to wait.`
                : `${record.key || record.id} is already recorded as stopped by the captain.`;
          if (changes.length === 0) {
            if (move && !move.ok) throw new TaskGraphRefusal(move.text);
            if (backlog && !backlog.ok) throw new TaskGraphRefusal(backlog.text);
            if (stop && !stop.ok && !move && !backlog) throw new TaskGraphRefusal(stop.text);
            if (move || backlog || stop)
              return [move?.text, backlog?.text, stopText].filter(Boolean).join(" ");
            return `${record.key || record.id} is unchanged.`;
          }
          const updated = tasks.get(record.id) ?? record;
          if (input.speed) supervisor.noteUnsupportedSpeed(updated.id, input.speed);
          host.turn.replyFacts.app = `Updated ${updated.key}: ${updated.title}`;
          host.noteDelivery({
            outcome: "action",
            kind: "record",
            tool: "update_task",
            ref: record.id,
          });
          const policyNote = input.policies
            ? supervisor.policiesChanged(record.id, input.policies, beforePolicies)
            : "";
          // A task under another parent or in another project, or told
          // where it runs, goes there.
          if (runsOn !== undefined || input.parent !== undefined || input.project !== undefined)
            supervisor.placement.runsOnChanged(record.id);
          // Policy edits alone never dispatch a queued row.
          if (
            Object.keys(input).some(
              (key) => key !== "task" && key !== "policies" && key !== "direction",
            )
          ) {
            // An edit its crewmate never hears still sparks to it: its task
            // changed (INF-759). A policy notice sparks as it lands.
            supervisor.steer.announceReach(record.id);
            supervisor.intake.graphChanged();
          }
          const now = tasks.get(record.id);
          return `Updated ${now?.key || record.id}: ${changes.join(", ")}.${policyNote ? ` ${policyNote}` : ""}${move ? ` ${move.text}` : ""}${backlog ? ` ${backlog.text}` : ""}${stopText ? ` ${stopText}` : ""}`;
        })();
        return { text, ok: true };
      } catch (caught) {
        if (caught instanceof TaskGraphRefusal) return { text: caught.message, ok: false };
        throw caught;
      }
    },
    drop: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const text = supervisor.intake.dropTask(record.id, {
          reason: input.reason,
          ...(input.confirm ? { confirm: true } : {}),
          ...(input.replacedBy ? { replacedBy: input.replacedBy } : {}),
        });
        // A refusal comes back as text; only a task that is now dropped took effect.
        if (record.status !== "dropped" && tasks.get(record.id)?.status === "dropped") {
          tookEffect(record.id, `Dropped ${record.key}: ${record.title}`);
        }
        return text;
      }),
    reviseRequiredAction: (input) =>
      asText(() => {
        const mutation = supervisor.cards.reviseRequiredAction({ actor: "firstmate" }, input);
        if (mutation.effect === "revised") {
          host.noteDelivery({
            outcome: "action",
            kind: "card",
            tool: "update_task",
            ref: mutation.cardId,
          });
        }
        return cardMutationText(mutation);
      }),
    withdrawMerge: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const withdrawn = supervisor.withdrawMergeApproval(record.id);
        if (withdrawn.ok) {
          tookEffect(record.id, `Withdrew merge approval for ${record.key}: ${record.title}`);
        }
        return withdrawn.text;
      }),
    raisePutOff: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const raised = supervisor.cards.putOffs.raiseForTask(record.id);
        if (raised === 0)
          return `${record.key} has no card put off; nothing changed. Its decisions name what the captain chose.`;
        const words = `Raised again the card${raised === 1 ? "" : "s"} the captain put off on ${record.key}: ${record.title}`;
        tookEffect(record.id, words);
        return `${words}.`;
      }),
    pin: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const pinned = tasks.setPinned(record.id, input.pinned, { actor: "firstmate" });
        if (!pinned.ok) return pinned.text;
        const words = input.pinned
          ? `Pinned ${record.key} to the top of Tasks: ${record.title}`
          : `Unpinned ${record.key}: ${record.title}`;
        if (!pinned.changed)
          return `${record.key} is already ${input.pinned ? "pinned" : "not pinned"}; nothing changed.`;
        tookEffect(record.id, words);
        return `${words}.`;
      }),
    override: (input) =>
      asText(() => {
        const record = resolve(input.task);
        // Consent is the one fact the host checks: the words are the
        // captain's own - this turn's, or the words on this task the
        // first mate cites (INF-1216) - which the row keeps and nothing
        // reads. This turn's are every message of his it carries, however
        // it began: typed while it ran, or batched beside a crewmate's
        // report (INF-1582 finding 2). A scheduled check carries none.
        // A click on a merge is his approval of it, never words that pass
        // the checks (INF-1966): the host says which, from the card's action.
        const cited = captainWordsIn(host.turn, input.from, (from) =>
          supervisor.overrides.citedCaptainWords(record.id, from),
        );
        if (!cited.ok) return cited.text;
        const said = {
          words: cited.words,
          ...(cited.mergeClick ? { mergeClick: true as const } : {}),
        };
        host.asks.attach(record.id, "update_task");
        const declared = supervisor.overrides.declareOverride(record.id, {
          ...said,
          holds: input.holds,
          until: input.until,
        });
        if (declared.ok) {
          tookEffect(record.id, `Recorded your override on ${record.key}: ${record.title}`);
          // Words that pass the cost limit lift the hold standing on it.
          supervisor.costLimits.overrideChanged(record.id);
        }
        return declared.text;
      }),
    costLimit: (input) =>
      asText(() => {
        const record = resolve(input.task);
        // A cost limit is the captain's consent to spend (docs/usage.md,
        // "The cost limit"): set only on their words.
        if (host.turn.origin !== "captain-turn")
          return "cost_limit is set only on the captain's words: ask them on a card first.";
        host.asks.attach(record.id, "update_task");
        supervisor.costLimits.setTaskLimit(record.id, input.limit);
        const limit = input.limit;
        const words =
          limit === null
            ? "follows its project's or the app's cost limit again"
            : "none" in limit
              ? "has no cost limit"
              : `has a cost limit of ${formatUsd(limit.usd)}`;
        tookEffect(record.id, `${record.key} ${words}`);
        return `${record.key} "${record.title}" now ${words}. A cost-limit hold it no longer passes is lifted and its work carries on.`;
      }),
    withdrawOverride: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const withdrawn = supervisor.overrides.withdrawOverride(record.id);
        if (withdrawn.ok) {
          tookEffect(record.id, `Took back your override on ${record.key}: ${record.title}`);
        }
        return withdrawn.text;
      }),
    withdrawAllowance: (input) =>
      asText(() => {
        const record = resolve(input.task);
        host.asks.attach(record.id, "update_task");
        const withdrawn = supervisor.overrides.withdrawAllowance(record.id, input.card);
        if (withdrawn.ok)
          tookEffect(record.id, `Took back your yes on ${record.key}: ${record.title}`);
        return withdrawn.text;
      }),
    startAgain: async (input) => {
      const record = resolve(input.task);
      const result = supervisor.starts.startAgain(record.id);
      if (!result.ok) return result.text;
      host.asks.attach(record.id, "update_task");
      host.asks.attach(result.task.id, "update_task");
      tookEffect(
        result.task.id,
        `Started ${record.key} again as ${result.task.key}: ${result.task.title}`,
      );
      return `${result.task.key} replaces ${record.key}. ${await result.started}`;
    },
    startNow: async (input) => {
      const record = resolve(input.task);
      host.asks.attach(record.id, "update_task", true);
      const text = await supervisor.starts.startQueuedNow(record.id);
      // A refusal comes back as text; a start now running behind the
      // answer (INF-3060), or a task a crewmate now holds, took effect.
      if (
        record.status !== "active" &&
        (tasks.get(record.id)?.status === "active" || tasks.starts.startAttemptOf(record.id))
      ) {
        tookEffect(record.id, startedReply(record.title));
      }
      return text;
    },
    link: (input) => {
      const from = resolve(input.from);
      const to = resolve(input.to);
      host.asks.attach(to.id, "link_tasks");
      host.asks.attach(from.id, "link_tasks");
      const linked = () =>
        tasks.graph
          .linksTo(to.id)
          .some((link) => link.fromId === from.id && link.type === input.type);
      const before = linked();
      const text = input.remove
        ? supervisor.intake.unlinkTasks(from.id, to.id, input.type)
        : supervisor.intake.linkTasks(from.id, to.id, input.type);
      // A refusal comes back as text; only an edge that now differs took effect.
      if (linked() !== before) {
        host.turn.replyFacts.app = `${input.remove ? "Unlinked" : "Linked"} ${from.key} and ${to.key}`;
        host.noteDelivery({
          outcome: "action",
          kind: "record",
          tool: "link_tasks",
          ref: to.id,
        });
      }
      return text;
    },
    readCard: (cardId) => supervisor.crewmateCards.readCard(cardId),
    query: (input) =>
      queryTasksAsync(
        tasks,
        input,
        (repoId) => host.options.repos.get(repoId)?.name,
        (taskId) => host.options.supervisor.cards.newestBody(taskId),
        (taskId) => host.options.supervisor.cards.newestResolutionForTask(taskId),
        host.options.supervisor.toolHooks.taskQueryReach(),
      ),
  };
}
