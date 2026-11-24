import { join } from "node:path";
import { cutText } from "@shared/textCut";
import type { WorkOrderChannel, WorkOrderRequest, WorkOrderResponse } from "@shared/work";
import type { ModelSession } from "../session/session";
import { HANDOVER_IN_DIR_NAME } from "../tasks/handoverFiles";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import type { MovedFolders } from "../workspace/workMove";
import type { PlacedTaskState, PlacedTasks } from "./placedTasks";
import type { WorkingCopies } from "./workingCopies";

/** What a working copy's order reads and writes of a conversation `SessionHost` holds here. */
export type CopyingConversation = {
  readonly task: string;
  state: PlacedTaskState;
  session: ModelSession | null;
  opening: Promise<void> | null;
  /** Each order applied, by id, with its answer. */
  readonly orders: Map<string, unknown>;
  /** The working copy's orders being done now, by id: one asked again waits for the same. */
  copying: Map<string, Promise<unknown>>;
};

/** What a working copy's order asks of `SessionHost`, which holds the conversations. */
export type WorkingCopyHost<H extends CopyingConversation> = {
  copies: WorkingCopies | undefined;
  tasks: PlacedTasks;
  /** The task's conversation, read from its folder when it is not held yet. */
  hold(task: string): H;
  /** Keeps an applied order and its answer (`SessionHost.remember`). */
  remember(held: H, orderId: string, answer: unknown): void;
  /** Whether the conversation is working (`SessionHost.busy`). */
  busy(held: H): boolean;
  /** Lets go of the open conversation without closing it, so it can open again. */
  releaseConversation(held: H): Promise<void>;
};

/**
 * An order about a task's working copy (docs/helper.md, "Its working
 * copies"). Those that act carry an id and are answered as they were when
 * asked again, but for a keep, which reads the working copy again; they
 * run beside the conversation's own orders, so a long clone or install
 * never holds a steer or an abort.
 */
export async function workingCopyOrder<H extends CopyingConversation>(
  host: WorkingCopyHost<H>,
  channel: WorkOrderChannel,
  request: unknown,
): Promise<unknown> {
  const copies = host.copies;
  if (!copies) throw new Error("This computer keeps no working copies.");
  switch (channel) {
    case "inf:working-copy:source-ref": {
      const [source] = request as WorkOrderRequest<"inf:working-copy:source-ref">;
      const file = `${host.tasks.folders(source.task).sourceCards}/${source.name}`;
      return copies.sourceRef(source, file);
    }
    case "inf:working-copy:revision": {
      const [{ task, headSha, builtOn }] = request as WorkOrderRequest<"inf:working-copy:revision">;
      return copies.revision(task, headSha, builtOn);
    }
    case "inf:working-copy:status": {
      const [{ task }] = request as WorkOrderRequest<"inf:working-copy:status">;
      return copies.status(task);
    }
    case "inf:working-copy:read": {
      const [{ task, ref, offset }] = request as WorkOrderRequest<"inf:working-copy:read">;
      return copies.read(task, ref, offset);
    }
    case "inf:working-copy:bundle": {
      const [{ task, ref, have, branch }] = request as WorkOrderRequest<"inf:working-copy:bundle">;
      return copies.bundle(task, ref, have, branch);
    }
    case "inf:working-copy:seed": {
      const [seed] = request as WorkOrderRequest<"inf:working-copy:seed">;
      return copies.seed(seed);
    }
    case "inf:working-copy:artifact": {
      const [piece] = request as WorkOrderRequest<"inf:working-copy:artifact">;
      return copies.artifact(piece);
    }
    default:
      break;
  }
  const [fields] = request as [{ task: string; orderId: string }];
  const held = host.hold(fields.task);
  const saved = held.orders.get(fields.orderId);
  const retryingPreparation = channel === "inf:working-copy:prepare" && preparationUnknown(saved);
  // A keep answers what the working copy holds now, which an earlier
  // version may have read short of its branch; keeping again what is
  // already kept answers the same commit.
  const keeping = channel === "inf:working-copy:keep";
  if (held.orders.has(fields.orderId) && !retryingPreparation && !keeping) return saved;
  const running = held.copying.get(fields.orderId);
  if (running) return running;
  const run = (async () => {
    let answer: unknown;
    switch (channel) {
      case "inf:working-copy:prepare": {
        const [prepare] = request as WorkOrderRequest<"inf:working-copy:prepare">;
        if (held.state.closed)
          throw new Error("This task's conversation was closed here, so it takes no working copy.");
        if (prepare.base && held.state.running)
          throw new Error("The conversation is running; its working copy cannot move yet.");
        // Persist uncertainty before any asynchronous preparation. After a
        // restart a failed reconciliation cannot prove the earlier work ended.
        host.remember(held, fields.orderId, { refused: "preparation-unknown" });
        try {
          answer = await copies.prepare(
            prepare.task,
            prepare.project,
            prepare.seed,
            prepare.base,
            prepare.branch,
          );
        } catch (caught) {
          // The host wants this computer's own sign-in: a typed answer, so
          // the home holds the task for it rather than reading the words
          // of a failure (docs/forge.md, "A computer's own sign-in").
          if (retryingPreparation) {
            answer = { refused: "preparation-unknown" };
            break;
          }
          if (!(caught instanceof ForgeAuthRequiredError)) {
            answer = {
              refused: "preparation-failed",
              message: cutText(caught instanceof Error ? caught.message : String(caught), 2000),
            };
            break;
          }
          const refused: WorkOrderResponse<"inf:working-copy:prepare"> = {
            refused: "forge-sign-in",
            host: caught.host,
            // A long server address fits the order's word; the home names the host itself.
            name: caught.place.slice(0, 64),
          };
          answer = refused;
        }
        break;
      }
      case "inf:working-copy:install":
        answer = await copies.install(held.task);
        break;
      case "inf:working-copy:keep":
        // Its conversation is closed for good first, so nothing changes the copy after.
        if (held.session || held.opening || held.state.running)
          throw new Error("This task's conversation is still open here.");
        answer = await copies.keep(held.task);
        break;
      case "inf:working-copy:retire": {
        const [retire] = request as WorkOrderRequest<"inf:working-copy:retire">;
        await copies.retire(held.task, retire.kept);
        answer = { ok: true };
        break;
      }
      case "inf:working-copy:move-out": {
        // Moving to another computer (docs/helper.md, "Moving a started
        // task"): only between turns, with nothing it started still
        // running, and the conversation let go, never closed, so the task
        // can run here again if the move does not finish.
        if (host.busy(held)) throw new Error("This task's conversation is in a turn here.");
        if (host.tasks.jobs(held.task).some((job) => !job.exit && !job.stoppedAt))
          throw new Error("A command this task started is still running here.");
        await host.releaseConversation(held);
        const [out] = request as WorkOrderRequest<"inf:working-copy:move-out">;
        answer = await copies.moveOut(held.task, movedFolders(host.tasks, held.task), out?.keep);
        break;
      }
      case "inf:working-copy:move-in": {
        const [move] = request as WorkOrderRequest<"inf:working-copy:move-in">;
        if (held.state.closed)
          throw new Error(
            "This task's earlier conversation here was closed and is not removed yet, so it takes no moved work.",
          );
        const sources = host.tasks.folders(held.task).sourceCards;
        answer = await copies.moveIn(
          move,
          {
            ...(move.bundle ? { bundle: join(sources, move.bundle.name) } : {}),
            ...(move.pack ? { pack: join(sources, move.pack.name) } : {}),
          },
          movedFolders(host.tasks, held.task),
        );
        break;
      }
      default:
        throw new Error(`${channel} is not a request this computer answers.`);
    }
    if ((channel === "inf:working-copy:prepare" && !preparationUnknown(answer)) || keeping)
      held.orders.delete(fields.orderId);
    host.remember(held, fields.orderId, answer);
    return answer;
  })();
  held.copying.set(fields.orderId, run);
  try {
    return await run;
  } finally {
    held.copying.delete(fields.orderId);
  }
}

/** The task's own folders a move carries, here (`workMove.ts`). */
function movedFolders(tasks: PlacedTasks, task: string): MovedFolders {
  const folders = tasks.ensure(task);
  return {
    evidence: folders.evidence,
    "card-bodies": folders.cardBodies,
    "source-cards": folders.sourceCards,
    sessions: folders.sessions,
    handover: join(folders.temp, HANDOVER_IN_DIR_NAME),
  };
}

function preparationUnknown(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "refused" in value &&
    value.refused === "preparation-unknown"
  );
}
