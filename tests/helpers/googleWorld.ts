import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { hostEnv } from "../../src/core/hostEnv";
import {
  googleIntegration,
  googleSetup,
  IntegrationSettingsStore,
  IntegrationsService,
  mcpIntegration,
  OutsideReads,
} from "../../src/core/integrations";
import { handoverFileName } from "../../src/core/tasks/handoverFiles";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { atUtilityQos } from "../../src/core/utilityQos";
import { freshDatabase } from "./database";
import {
  type GoogleStandIn,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "./googleStandIn";
import { integrationKeys } from "./integrationKeys";
import { scratchDir } from "./scratchDirs";

export type GoogleWorld = {
  google: GoogleStandIn;
  dir: string;
  tasks: TaskService;
  /** The app's clock, which the test moves. */
  clock: { now: number };
  /** Every page the person's browser opened, and what it showed. */
  opened: string[];
  pages: string[];
  /** Every view the service pushed to Settings, as JSON. */
  pushed: string[];
  integrations: IntegrationsService;
  db: Database.Database;
  reads: OutsideReads;
  /** A task's refusal of a file the service saves for it, by task id. */
  refusals: Map<string, string>;
  keys: ReturnType<typeof integrationKeys>;
  binding: ReturnType<typeof googleIntegration>;
  setup: ReturnType<typeof googleSetup>;
};

/**
 * The Google binding and its integrations service for a unit test
 * (docs/integrations.md, "Google"): a stand-in Google
 * (`googleStandIn.ts`) as the run's Google and client, real Secrets over
 * disposable custody (`integrationKeys.ts`), a task database with one task,
 * a hand-over folder and a clock the test moves. Everything it starts goes
 * on `cleanup`, which the test's own afterEach runs.
 */
export async function googleWorld(
  cleanup: (() => void | Promise<void>)[],
  browser?: (url: string) => Promise<void>,
  withMcp = false,
  /** What an older version saved in the integrations folder before this one opens it. */
  older?: (
    dir: string,
    google: GoogleStandIn,
    keys: ReturnType<typeof integrationKeys>,
  ) => Promise<void>,
  keyOptions?: Parameters<typeof integrationKeys>[0],
  /** False is a released build: a new sign-in needs the person's own client, as `googleSetup`'s `signsIn` says. */
  runSignsIn = true,
): Promise<GoogleWorld> {
  const google: GoogleStandIn = await startGoogleStandIn();
  cleanup.push(() => google.close());
  const dir = join(scratchDir("fm-google-"), "integrations");
  const keys = integrationKeys(keyOptions);
  await older?.(dir, google, keys);
  // Each case owns a new database, but Google never needs to replay the task database's migrations.
  const db = freshDatabase();
  cleanup.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "task-1", title: "Answer Lena", status: "idle" });
  const clock = { now: Date.UTC(2026, 9, 22, 16) };
  const opened: string[] = [];
  const pages: string[] = [];
  const pushed: string[] = [];
  const setup = googleSetup({
    packaged: false,
    env: {
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  if (!setup) throw new Error("a run that names a client has a Google setup");
  const reads = new OutsideReads(dir);
  // The task's hand-over folder, named as the crew names it; a task here may refuse a file.
  const handover = scratchDir("fm-google-handover-");
  const refusals = new Map<string, string>();
  let integrations: IntegrationsService | undefined;
  const binding = googleIntegration({
    root: dir,
    keys: keys.keys,
    client: setup.client,
    endpoints: setup.endpoints,
    runSignsIn,
    // The person's browser: it opens the page and follows Google back to the app.
    open:
      browser ??
      (async (url) => {
        opened.push(url);
        pages.push(await (await fetch(url)).text());
      }),
    now: () => clock.now,
    changed: () => integrations?.changed(),
  });
  integrations = new IntegrationsService({
    bindings: [
      binding,
      ...(withMcp
        ? [
            mcpIntegration({
              root: dir,
              env: () => hostEnv(),
              belowUi: (file, args) => atUtilityQos(file, args),
              cwd: () => dir,
              version: "0.0.0-test",
              changed: () => integrations?.changed(),
            }),
          ]
        : []),
    ],
    store: new IntegrationSettingsStore(dir),
    asks: {
      keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) =>
        tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
    },
    reads,
    files: {
      refusal: (taskId) => refusals.get(taskId),
      save: async (taskId, name, bytes) => {
        const file = handoverFileName(name, createHash("sha256").update(bytes).digest("hex"));
        const folder = join(handover, taskId);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        writeFileSync(join(folder, file), bytes, { mode: 0o600 });
        return { file, path: join(folder, file) };
      },
    },
    now: () => clock.now,
    push: (view) => pushed.push(JSON.stringify(view)),
  });
  cleanup.push(() => integrations?.dispose());
  return {
    google,
    dir,
    tasks,
    clock,
    opened,
    pages,
    pushed,
    integrations,
    db,
    reads,
    refusals,
    keys,
    binding,
    setup,
  };
}

/** Every argument after `cleanup`. */
export type GoogleWorldOptions =
  Parameters<typeof googleWorld> extends [unknown, ...infer Rest] ? Rest : never;
