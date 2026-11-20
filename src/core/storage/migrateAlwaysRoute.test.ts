import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { migrateAlwaysRoute } from "./migrateAlwaysRoute";
import { MIGRATIONS } from "./migrations";
import { SettingsStore } from "./settingsStore";

const pins = [
  { provider: "codex", id: "gpt-6.2-astra" },
  { provider: "grok", id: "grok-4.8" },
];

it.each([false, true])(
  "upgrades routing=%s without activating dormant pins or moving committed work",
  (enabled) => {
    const folder = scratchDir("infinitary-model-choice-");
    const before = openDatabase(folder, MIGRATIONS.indexOf(migrateAlwaysRoute));
    try {
      before
        .prepare("INSERT INTO settings (key, value) VALUES ('routing', ?)")
        .run(JSON.stringify({ dynamicRouting: enabled, pins }));
      const repo = before.prepare(
        "INSERT INTO repos (id, name, path, origin, added_at, runs_on) VALUES (?, ?, ?, ?, 0, ?)",
      );
      repo.run(
        "auto",
        "Automatic project",
        "/example/auto",
        "https://github.com/example/auto",
        AUTOMATIC_COMPUTER,
      );
      repo.run(
        "remote",
        "Remote project",
        "/example/remote",
        "https://github.com/example/remote",
        "mini",
      );
      const tasks = new TaskService({ db: before });
      seedTask(tasks, {
        id: "parent",
        title: "Started parent",
        status: "running",
        branch: "inf/parent",
        deviceId: "mini",
        shape: { kind: "unclear", runs_on_ask: AUTOMATIC_COMPUTER },
      });
      seedTask(tasks, { id: "child", title: "Queued child", status: "queued", parentId: "parent" });
      seedTask(tasks, {
        id: "direct",
        title: "Queued explicit automatic",
        status: "queued",
        shape: {
          kind: "unclear",
          runs_on_ask: AUTOMATIC_COMPUTER,
          override_model_id: "xai/grok-4.8",
        },
      });
      seedTask(tasks, {
        id: "remote",
        title: "Queued explicit device",
        status: "queued",
        parentId: "parent",
        shape: { kind: "unclear", runs_on_ask: "other-computer" },
      });
    } finally {
      before.close();
    }
    const after = openDatabase(folder);
    try {
      const store = new SettingsStore(after);
      const expected = enabled
        ? { dynamicRouting: true, pins }
        : { dynamicRouting: true, pins: [], dormantPins: pins };
      expect(store.getRoutingSettings()).toEqual(expected);
      store.setRoutingSettings({ dynamicRouting: false, pins: [] });
      expect(store.getRoutingSettings()).toEqual(expected);
      if (!enabled) {
        store.setRoutingSettings({ dynamicRouting: true, pins }); // Older view cannot restore stale pins.
        expect(store.getRoutingSettings()).toEqual(expected);
        store.setRoutingSettings({ ...store.getRoutingSettings(), pins, dormantPins: [] });
        expect(store.getRoutingSettings()).toEqual({ dynamicRouting: true, pins });
      }
      const tasks = new TaskService({ db: after });
      const place = enabled ? AUTOMATIC_COMPUTER : RUNS_ON_THIS_MAC;
      expect(tasks.get("parent")).toMatchObject({
        deviceId: "mini",
        shape: { runs_on_ask: AUTOMATIC_COMPUTER },
      });
      expect(tasks.get("child")?.shape?.runs_on_ask).toBe(enabled ? undefined : place);
      expect(tasks.get("direct")?.shape).toMatchObject({
        runs_on_ask: place,
        override_model_id: "xai/grok-4.8",
      });
      expect(tasks.get("remote")?.shape?.runs_on_ask).toBe("other-computer");
      expect(
        after
          .prepare("SELECT id, runs_on FROM repos WHERE id IN ('auto', 'remote') ORDER BY id")
          .all(),
      ).toEqual([
        { id: "auto", runs_on: enabled ? AUTOMATIC_COMPUTER : null },
        { id: "remote", runs_on: "mini" },
      ]);
    } finally {
      after.close();
    }
  },
);
