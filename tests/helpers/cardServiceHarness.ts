/**
 * The card service wired as the app wires it, for CardService's tests
 * (INF-2625's plan): a task service and card store over one database, with
 * every host hook recording what it heard. `make` builds a service over the
 * same record, so a second call is a restart.
 */
import type { Card, CardThread } from "@shared/cards";
import { CardService, type CardServiceHost } from "../../src/core/orchestrator/cardService";
import { CardStore } from "../../src/core/storage/cardStore";
import type { AppDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { freshDatabase } from "./database";

export function setup(
  db: AppDatabase = freshDatabase(),
  now = () => 1000,
): {
  db: AppDatabase;
  tasks: TaskService;
  cardStore: CardStore;
  gates: string[];
  pushes: Card[][];
  threads: CardThread[];
  make: (
    settleFacts?: (taskId: string) => string | undefined,
    captainResponded?: CardServiceHost["captainResponded"],
    extra?: Partial<CardServiceHost>,
  ) => CardService;
} {
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const gates: string[] = [];
  const pushes: Card[][] = [];
  const threads: CardThread[] = [];
  const make = (
    settleFacts: (taskId: string) => string | undefined = () => undefined,
    captainResponded?: CardServiceHost["captainResponded"],
    extra: Partial<CardServiceHost> = {},
  ) =>
    new CardService({
      now,
      tasks,
      cardStore,
      syncCaptainGate: (taskId) => gates.push(taskId),
      noteCapAnswered: () => {},
      closeAnsweredTask: () => false,
      captainResponded,
      settleFacts,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: (cards) => pushes.push(cards),
      broadcastThread: (thread) => threads.push(thread),
      ...extra,
    });
  return { db, tasks, cardStore, gates, pushes, threads, make };
}
