import { expect } from "@playwright/test";
import { CardService } from "../../../src/core/orchestrator/cardService";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { TaskService } from "../../../src/core/tasks/taskService";
import { askFirstmate } from "../lastTurn";
import type { LaunchedApp } from "../launch";
import { sinceLastUser } from "../providerRequest";
import { relationshipsAsk } from "./upgradedRelationshipsRead";

/** The task services a seeding or a read between launches writes through, on the stopped app's data. */
export function taskWriters(
  userDataDir: string,
  at = Date.now() - 60 * 60_000,
): {
  db: ReturnType<typeof openDatabase>;
  tasks: TaskService;
  cardStore: CardStore;
  cards: CardService;
} {
  const db = openDatabase(userDataDir);
  const now = () => (at += 60_000);
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    now,
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  return { db, tasks, cardStore, cards };
}

/** The first mate's `tasks` reads of one task's fields, by key, as the tool returned them. */
export async function firstmateFields(
  app: LaunchedApp,
  key: string,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const prompt = relationshipsAsk(key, fields);
  await askFirstmate(app.page, prompt);
  const read = (app.mockProvider?.requestBodies() ?? [])
    .map(sinceLastUser)
    .filter((turn) => turn.user.includes(prompt))
    .find((turn) => turn.results.length === fields.length);
  if (!read) throw new Error(`The first mate did not read every field of ${key}.`);
  return Object.fromEntries(
    fields.map((field, index) => {
      const page = read.results[index] ?? "";
      const header = page.match(
        /^field (\w+) as (text|json), offset 1, nextOffset none, length \d+\n/,
      );
      expect(header?.[1], `the ${field} page of ${key}`).toBe(field);
      const text = page.slice(header?.[0].length ?? 0);
      return [field, header?.[2] === "json" ? JSON.parse(text) : text];
    }),
  );
}
