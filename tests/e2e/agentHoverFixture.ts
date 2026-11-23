import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { seedProject } from "../../src/core/workspace/seedProject";
import type { DeviceView } from "../../src/shared/devices";
import { scratchDir } from "../helpers/scratchDirs";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";

export const HOVER_PROJECT_NAME = "Navigation and search";

/**
 * A multi-computer fleet for the real pointer/sidebar placement regression.
 * Only the device list and tasks' execution placement are stood in; the real
 * core owns the tasks, details and panels. No remote service is contacted.
 * @journey-area src/renderer/src/character/crew/
 * @journey-area src/renderer/src/app/HomeMate.tsx
 */
export function agentHoverFixture(title: string) {
  const userDataDir = scratchDir("agent-hover-data-");
  const db = openDatabase(userDataDir);
  try {
    new SettingsStore(db).setRunbookStates({ batches: true });
    const path = join(userDataDir, "fixture-project");
    mkdirSync(path);
    seedProject(db, {
      id: "fixture-hover",
      name: HOVER_PROJECT_NAME,
      path,
      delivery: "queue-pr",
      origin: "https://example.invalid/fixture/hover.git",
      runsOn: null,
    });
    const service = new TaskService({ db });
    for (let i = 0; i < 26; i++) {
      const id = `agent-${i}`;
      const worktreeDir = join(userDataDir, id);
      mkdirSync(worktreeDir);
      seedTask(service, {
        id,
        title: `${i + 1}. ${title}`,
        repoId: "fixture-hover",
        worktreeDir,
        status: "idle",
        outcome: "The result selection stays in the task record during a refresh.",
        model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
        createdAt: Date.now() + i,
      });
    }
    new RepoRegistry(db, userDataDir).recordBatch("fixture-hover", {
      line: [],
      receipts: [],
      leftOut: [],
      finished: [
        {
          number: 1,
          formed: Date.now() - 20_000,
          ended: Date.now() - 10_000,
          outcome: "merged",
          holds: 0,
          members: [{ taskId: "agent-0", title }],
        },
      ],
    });
  } finally {
    db.close();
  }
  const devices: DeviceView[] = [
    { id: "worker-one", name: "Worker one", kind: "work", pairedAt: 1, inReach: true },
    { id: "worker-two", name: "Worker two", kind: "work", pairedAt: 2, inReach: true },
  ];
  const entry = join(scratchDir("agent-hover-entry-"), "entry.mjs");
  // e2e-fixture: input -- isolated shell entry standing in for fleet execution placement.
  writeFileSync(
    entry,
    `import { app, ipcMain } from 'electron';
    app.getAppPath = () => ${JSON.stringify(process.cwd())};
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
      const value = await listener(...args);
      if (channel === 'inf:devices:list') return ${JSON.stringify(devices)};
      if (channel === 'inf:tasks:board' && value?.tasks) return {
        ...value, tasks: value.tasks.map(task => {
          const index = Number(task.id.split('-')[1]);
          return index >= 10 ? { ...task, executionDeviceId: index < 18 ? 'worker-one' : 'worker-two' } : task;
        }),
      };
      return value;
    });
    await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "out/main/index.js")).href)});
  `,
  );
  return { userDataDir, entry };
}
