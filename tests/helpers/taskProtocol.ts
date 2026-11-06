import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import type { CorePushChannel, PushPayload } from "@shared/ipc";
import type { TaskBoard, TaskBoardDelta } from "@shared/tasks";
import { type Mock, vi } from "vitest";
import { modelReasonOf } from "../../src/core/routing/modelReason";
import { servedSlots } from "../../src/core/routing/router";
import { ActivityStore } from "../../src/core/storage/activityStore";
import type { AppDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { TaskProtocol } from "../../src/core/tasks/taskProtocol";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskChange } from "../../src/core/tasks/taskWriter";
import { seedProject } from "../../src/core/workspace/seedProject";
import { freshDatabase as openInMemoryDatabase } from "./database";

/**
 * One task protocol over a fresh record, for the task protocol's tests
 * (task-system P3, design section 9). The acceptance the build plan names:
 * a snapshot pushed after N mutations equals a fresh board read (`fresh`),
 * because both are rebuilt from SQLite after the commit. The fixture also
 * keeps what the protocol pushed, broadcast and heard from the change seam.
 */

export const DAY = 24 * 60 * 60 * 1000;

/** What one fixture holds: the record, the protocol over it, and what it pushed and heard. */
export type TaskProtocolFixture = {
  db: AppDatabase;
  tasks: TaskService;
  activity: ActivityStore;
  protocol: TaskProtocol;
  cards: Card[];
  snapshot: Mock<() => Card[]>;
  events: FmEvent[];
  changes: TaskChange[];
  boards: () => TaskBoard[];
  deltas: () => TaskBoardDelta[];
  carried: () => { channel: CorePushChannel; payload: unknown }[];
  fresh: () => TaskBoard;
  settle: () => Promise<unknown>;
  tick: (ms?: number) => number;
  clock: () => number;
};

export function taskProtocolFixture(
  options: {
    deltaTrigger?: { rows: number; bytes: number };
    workPosture?: ConstructorParameters<typeof TaskProtocol>[0]["workPosture"];
    place?: (
      record: import("../../src/core/storage/taskStore").TaskRecord,
    ) => import("@shared/tasks").TaskPlace;
    modelLabel?: (model: string) => string | undefined;
    actions?: (
      record: import("../../src/core/storage/taskStore").TaskRecord,
    ) => readonly import("@shared/tasks").TaskActionLine[];
  } = {},
): TaskProtocolFixture {
  const db = openInMemoryDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    autonomy: true,
    addedAt: 1,
  });
  let now = 10 * DAY;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  const activity = new ActivityStore(db, () => now);
  const cards: Card[] = [];
  const snapshot = vi.fn(() => cards);
  const events: FmEvent[] = [];
  const pushes: { channel: CorePushChannel; payload: unknown }[] = [];
  const changes: TaskChange[] = [];
  tasks.onChange((change) => changes.push(change));
  const protocolOptions = {
    tasks,
    workPosture: options.workPosture,
    ...(options.place ? { place: options.place } : {}),
    repos: {
      get: (id: string) =>
        id === "r1"
          ? { name: "nimbus-api", delivery: "direct-pr" as const, autonomy: true }
          : undefined,
    },
    cards: { listOpen: () => cards, snapshot },
    tiers: (taskIds: readonly string[]) => servedSlots(new DecisionStore(db), taskIds),
    modelReason: (record: import("../../src/core/storage/taskStore").TaskRecord) =>
      modelReasonOf(record, {
        decisions: new DecisionStore(db),
        pins: () => [],
        keyOf: (ref) => tasks.resolve(ref)?.key || undefined,
      }),
    now: () => now,
    coalesceMs: 0,
    ...(options.deltaTrigger ? { deltaTrigger: options.deltaTrigger } : {}),
    ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
    ...(options.actions ? { actions: options.actions } : {}),
  };
  const protocol = new TaskProtocol({
    ...protocolOptions,
    broadcastEvent: (event) => events.push(event),
    emit: <C extends CorePushChannel>(channel: C, payload: PushPayload<C>) => {
      pushes.push({ channel, payload });
    },
  });
  /** The board a protocol that kept nothing builds from the same record and cards (INF-2078). */
  const fresh = () => {
    const other = new TaskProtocol({
      ...protocolOptions,
      broadcastEvent: () => {},
      emit: () => {},
    });
    try {
      return other.board();
    } finally {
      other.dispose();
    }
  };
  const boards = () =>
    pushes.filter((push) => push.channel === "inf:tasks").map((push) => push.payload as TaskBoard);
  const deltas = () =>
    pushes
      .filter((push) => push.channel === "inf:tasks:delta")
      .map((push) => push.payload as TaskBoardDelta);
  /** Every board push in order, each tagged with its carrier. */
  const carried = () =>
    pushes
      .filter((push) => push.channel === "inf:tasks" || push.channel === "inf:tasks:delta")
      .map((push) => ({ channel: push.channel, payload: push.payload }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    db,
    tasks,
    activity,
    protocol,
    cards,
    snapshot,
    events,
    changes,
    boards,
    deltas,
    carried,
    fresh,
    settle,
    tick: (ms = 1) => (now += ms),
    clock: () => now,
  };
}
