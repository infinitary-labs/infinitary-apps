import {
  type AwayCopy,
  type CommittedPlacement,
  type ComputerMove,
  type HomeCopy,
  PLACEMENT_WAIT,
  type PlacementSnapshot,
  type PlacementWait,
  placementReason,
  placementSnapshotSchema,
} from "@shared/placement";
import { type HostStamp, stampOnto, type WorkShape } from "@shared/routingPolicy";
import type { TaskGate, TaskRecord } from "../storage/taskRecords";
import { TaskGraphRefusal } from "./taskGraph";
import { TaskService } from "./taskService";
import { type TaskWriter, withShapeKey } from "./taskWriter";

/**
 * Where a task's work runs and what its start waits on there: its computer
 * and a move to another one, its account, the placement a start waits for,
 * its gate and its working copy. Reached as `tasks.placement`.
 */
export class TaskPlacement {
  constructor(private readonly writer: TaskWriter) {}

  /**
   * A started task moved to another provider between turns (INF-849): the
   * record names the model and account that serve it from here on, and one
   * timeline row and feed line, written as whoever asked, says so. Its key,
   * branch, working copy and history stay.
   */
  recordMove(
    id: string,
    input: {
      model: { provider: string; id: string };
      accountId: string | null;
      actor: "captain" | "firstmate";
      text: string;
      data: Record<string, unknown>;
    },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.patch(id, {
        model: `${input.model.provider}/${input.model.id}`,
        accountId: input.accountId,
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: input.text,
        data: { ...input.data, news: true },
        feed: true,
      });
    });
    run();
  }

  /**
   * A started task's move to another computer as it stands
   * (docs/helper.md, "Moving a started task"), or null once none does. A
   * `line` is one timeline row, and a feed line with `feed`, written as
   * whoever acted. Its key, branch, working copy and history stay.
   */
  setComputerMove(
    id: string,
    move: ComputerMove | null,
    line?: { text: string; actor: "captain" | "firstmate" | "host"; feed?: boolean },
  ): void {
    const at = this.writer.now();
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      this.writer.patch(id, {
        shape: withShapeKey(record.shape, "computer_move", move ?? undefined),
        updatedAt: at,
      });
      if (line)
        this.writer.addEvent({
          taskId: id,
          at,
          actor: line.actor,
          kind: "note",
          text: line.text,
          data: { news: line.feed === true, ...(move ? { computerMove: move } : {}) },
          feed: line.feed === true,
        });
    })();
  }

  /**
   * The one commit of a move to another computer: the record names the
   * computer the task runs on now and its working copy there - a folder
   * here, or none here for a computer that runs work - and the move turns
   * to removing the copy it left. Its start's placement ends: it describes
   * where the task started. Refused for a closed task or one that already
   * runs on `deviceId`.
   */
  commitComputerMove(
    id: string,
    input: {
      deviceId: string | null;
      repoDir: string;
      worktreeDir: string;
      branch: string;
      move: ComputerMove;
      actor: "captain" | "firstmate";
      text: string;
      /** What it leaves on a computer out of reach, kept with the commit so a restart finds it. */
      awayCopy?: AwayCopy;
    },
  ): void {
    const at = this.writer.now();
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (TaskService.isClosed(record)) throw new Error("This task is closed.");
      if ((record.deviceId ?? null) === input.deviceId)
        throw new Error("This task already runs on that computer.");
      let shape = withShapeKey(record.shape, "computer_move", input.move);
      if (input.awayCopy)
        shape = withShapeKey(shape, "away_copies", [
          ...(record.shape?.away_copies ?? []).slice(-15),
          input.awayCopy,
        ]);
      // What this Mac brought home was the computer it left: the next one's starts afresh.
      shape = withShapeKey(shape, "home_copy", undefined);
      this.writer.patch(id, {
        deviceId: input.deviceId,
        placement: null,
        repoDir: input.repoDir,
        worktreeDir: input.worktreeDir,
        branch: input.branch,
        workspaceState: "present",
        shape,
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: input.text,
        data: { news: true, computerMove: input.move },
        feed: true,
      });
    })();
  }

  /**
   * The commit this Mac just brought home of the branch of a task on a
   * computer that runs work, and when (`WorkShape.home_copy`): what a move
   * continues from if that computer is out of reach. Quiet: no timeline row.
   */
  recordHomeCopy(id: string, copy: HomeCopy): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.shape?.home_copy?.sha === copy.sha) return;
      this.writer.patch(id, { shape: withShapeKey(record.shape, "home_copy", copy) });
    })();
  }

  /**
   * What the task left on computers it moved off while they were out of
   * reach, as it stands now (`WorkShape.away_copies`); an empty list clears
   * it. A `line` is one timeline row, and a feed line with `feed`.
   */
  setAwayCopies(
    id: string,
    entries: readonly AwayCopy[],
    line?: { text: string; feed?: boolean },
  ): void {
    const at = this.writer.now();
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      this.writer.patch(id, {
        shape: withShapeKey(record.shape, "away_copies", entries.length ? [...entries] : undefined),
      });
      if (line)
        this.writer.addEvent({
          taskId: id,
          at,
          actor: "host",
          kind: "note",
          text: line.text,
          data: { news: line.feed === true },
          feed: line.feed === true,
        });
    })();
  }

  /**
   * The host's stamp and the tier it computes to (S3), written onto the
   * record as it stands (INF-416 piece F). The stamp carries only the
   * fields the host owns (`HOST_STAMP_FIELDS`); a model, a basis or any
   * other field a person owns stays, including one cleared while the
   * stamp was in flight. Deliberately quiet - a shape explains a routing
   * decision rather than being a state change, and it rides
   * `routing_decisions` for the audit either way.
   */
  recordShape(id: string, stamp: HostStamp, difficulty: TaskRecord["difficulty"]): void {
    const run = this.writer.write(() => {
      const current = this.writer.mustGet(id).shape ?? { kind: "unclear" as const };
      this.writer.patch(id, {
        shape: stampOnto(current, stamp),
        difficulty,
        updatedAt: this.writer.now(),
      });
    });
    run();
  }

  /**
   * The latest Automatic wait, on the record rather than in process memory,
   * so a restart keeps the words and does not say the line again. Not the
   * could-not-start notice. Null clears it once the task is no longer waiting.
   */
  setPlacementWait(id: string, wait: PlacementWait | null): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record) return;
      const shape = record.shape ?? { kind: "unclear" as const };
      const current = shape.placement_wait;
      if (wait === null) {
        if (!current) return;
        this.writer.patch(id, {
          shape: withShapeKey(shape, "placement_wait", undefined),
          updatedAt: this.writer.now(),
        });
        return;
      }
      if (current?.kind === wait.kind && current.words === wait.words) return;
      this.writer.patch(id, {
        shape: {
          ...shape,
          placement_wait: {
            ...wait,
            since:
              current?.kind === wait.kind
                ? (current.since ?? this.writer.now())
                : this.writer.now(),
          },
        },
        updatedAt: this.writer.now(),
      });
    });
    run();
  }

  /**
   * The approved version of an earlier part this task's working copy starts
   * on (`shape.built_on`, docs/task-graph.md, "A part that starts at
   * approval"), written at its start and moved to a newer approved version
   * of that part once the task's version builds on it ("Following the part
   * under it", `followBase`). Quiet, like the placement wait.
   */
  setBuiltOn(id: string, builtOn: NonNullable<WorkShape["built_on"]>): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record) return;
      const shape = record.shape ?? { kind: "unclear" as const };
      this.writer.patch(id, {
        shape: { ...shape, built_on: builtOn },
        updatedAt: this.writer.now(),
      });
    });
    run();
  }

  /** Re-binding at a resume attachment point updates the account column. */
  setAccountId(id: string, accountId: string | null): void {
    const run = this.writer.write(() =>
      this.writer.patch(id, { accountId, updatedAt: this.writer.now() }),
    );
    run();
  }

  /** Evaluate against every durable pending reservation and commit in one writer transaction.
   * The callback is synchronous: no preparation or other asynchronous work can interleave.
   */
  commitPlacement(
    id: string,
    choose: (pending: readonly TaskRecord[]) => PlacementSnapshot | undefined,
  ): CommittedPlacement | undefined {
    return this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.placement && record.placement.reservation !== "ended") return record.placement;
      if (TaskService.isClosed(record) || record.branch || record.sessionFile) return undefined;
      const chosen = choose(this.writer.store.pendingPlacements());
      if (!chosen) return undefined;
      const snapshot = placementSnapshotSchema.parse(chosen);
      if (record.placement && snapshot.computerId !== record.placement.snapshot.computerId)
        throw new Error("A committed task cannot move to another computer.");
      const placement: CommittedPlacement = { snapshot, reservation: "pending" };
      this.writer.patch(id, {
        placement,
        deviceId: snapshot.computerId,
        ...(snapshot.acceptedFallback
          ? {
              shape: {
                ...(record.shape ?? { kind: "unclear" as const }),
                placement_fallback_accepted: true,
              },
            }
          : {}),
        updatedAt: this.writer.now(),
      });
      this.writer.addEvent({
        taskId: id,
        at: this.writer.now(),
        actor: "host",
        kind: "note",
        text: placementReason(snapshot),
        data: { news: true },
        feed: true,
      });
      return placement;
    })();
  }

  pendingPlacements(): TaskRecord[] {
    return this.writer.store.pendingPlacements();
  }

  waitForPlacement(id: string, acceptedFallback: boolean, words = PLACEMENT_WAIT): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.status !== "open") return;
      const shape = record.shape ?? { kind: "unclear" as const };
      if (
        record.startPolicy === "when-ready" &&
        (!acceptedFallback || shape.placement_fallback_accepted)
      )
        return;
      this.writer.patch(id, {
        startPolicy: "when-ready",
        shape: { ...shape, ...(acceptedFallback ? { placement_fallback_accepted: true } : {}) },
        updatedAt: this.writer.now(),
      });
      this.writer.addEvent({
        taskId: id,
        at: this.writer.now(),
        actor: "host",
        kind: "note",
        text: words,
        feed: false,
      });
    })();
  }

  beginPlacementPreparation(id: string): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (TaskService.isClosed(record)) throw new Error("This task is closed.");
      if (record.placement && !record.placement.preparationStarted)
        this.writer.patch(id, {
          placement: { ...record.placement, preparationStarted: true },
          updatedAt: this.writer.now(),
        });
    })();
  }

  /** Only the placement owner presents evidence of observation or completion. */
  releasePlacement(id: string, orderId: string, evidence: "observed" | "ended"): void {
    this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (
        !record?.placement ||
        record.placement.snapshot.orderId !== orderId ||
        record.placement.reservation !== "pending"
      )
        return;
      this.writer.patch(id, {
        placement: { ...record.placement, reservation: evidence },
        updatedAt: this.writer.now(),
      });
    })();
  }

  /** Bind a computer before its first turn; a committed Automatic choice stays fixed. */
  setDevice(id: string, deviceId: string | null): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.placement && record.placement.snapshot.computerId !== deviceId)
        throw new TaskGraphRefusal("A committed task stays on the computer it chose.");
      this.writer.patch(id, { deviceId, updatedAt: this.writer.now() });
    })();
  }

  /**
   * A computer that runs work is being removed: each live task's own Runs
   * on that names it is forgotten, as each project's moves home
   * (docs/helper.md, "A task's own Runs on"). Answers their ids.
   */
  forgetRunsOn(deviceId: string): string[] {
    const at = this.writer.now();
    const run = this.writer.write(() =>
      this.writer.store.listByStatus("open", "active").flatMap((record) => {
        if (!record.shape || record.shape.runs_on_ask !== deviceId) return [];
        this.writer.patch(record.id, {
          shape: withShapeKey(record.shape, "runs_on_ask", undefined),
          updatedAt: at,
        });
        this.writer.addEvent({
          taskId: record.id,
          at,
          actor: "host",
          kind: "note",
          text: "Runs on: the computer it named was removed, so it runs where its parent or project says",
          data: { news: true },
        });
        return [record.id];
      }),
    );
    return run();
  }

  /**
   * One computer's two entries became one (docs/devices.md, "One computer,
   * one entry"): each live task's own Runs on that names the entry that went
   * names the one kept instead. Answers their ids.
   */
  moveRunsOn(from: string, into: string, words: string): string[] {
    const at = this.writer.now();
    const run = this.writer.write(() =>
      this.writer.store.listByStatus("open", "active").flatMap((record) => {
        if (!record.shape || record.shape.runs_on_ask !== from) return [];
        this.writer.patch(record.id, {
          shape: withShapeKey(record.shape, "runs_on_ask", into),
          updatedAt: at,
        });
        this.writer.addEvent({
          taskId: record.id,
          at,
          actor: "host",
          kind: "note",
          text: `Runs on: ${words}, the one row its computer keeps now`,
        });
        return [record.id];
      }),
    );
    return run();
  }

  /** Re-hold an open row (a captain answer routed it to another wait). */
  setGate(id: string, gate: TaskGate | null, text?: string): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.patch(id, { gate, updatedAt: at });
      if (text) {
        this.writer.addEvent({
          taskId: id,
          at,
          actor: "host",
          kind: "status",
          text,
          data: { gate },
          feed: false,
        });
      }
    });
    run();
  }

  /** The worktree is gone; the record and its session stay (D2). */
  markWorkspaceRemoved(id: string): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const placement = this.writer.mustGet(id).placement;
      if (placement) this.releasePlacement(id, placement.snapshot.orderId, "ended");
      this.writer.patch(id, { workspaceState: "removed", updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "note",
        text: "working copy removed",
        data: { news: false },
        feed: false,
      });
    });
    run();
  }
}
