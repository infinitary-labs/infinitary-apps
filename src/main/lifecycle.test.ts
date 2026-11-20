import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { LaunchWatch } from "../core/personal/safeMode";
import { openInMemoryDatabase } from "../core/storage/db";
import { SettingsStore } from "../core/storage/settingsStore";
import { type BeforeQuitEvent, deferCoreDisposal } from "./lifecycle";

it("defers launch-marker disposal until an emitting SQLite query has returned", async () => {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const watch = new LaunchWatch({
    read: () => settings.getLaunchRecord(),
    write: (record) => settings.setLaunchRecord(record),
    schedule: () => () => {},
  });
  watch.begin();

  const lifecycle = new EventEmitter();
  const scheduled: Array<() => void> = [];
  const quit = vi.fn();
  deferCoreDisposal(
    {
      on: (event, listener) => lifecycle.on(event, listener),
      quit,
    },
    () => watch.dispose(),
    { schedule: (run) => scheduled.push(run) },
  );
  db.function("emit_before_quit", () => {
    lifecycle.emit("before-quit", { preventDefault: vi.fn() } satisfies BeforeQuitEvent);
    return 1;
  });

  expect(() => db.prepare("SELECT emit_before_quit()").get()).not.toThrow();
  expect(settings.getLaunchRecord()).toEqual({ pending: true, earlyCrashes: 0 });
  expect(scheduled).toHaveLength(1);

  scheduled[0]?.();
  expect(settings.getLaunchRecord()).toEqual({ pending: false, earlyCrashes: 0 });
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
});

it("holds the second quit until the core's disposal has settled", async () => {
  const lifecycle = new EventEmitter();
  const scheduled: Array<() => void> = [];
  const quit = vi.fn();
  let settle!: () => void;
  const settling = new Promise<void>((resolve) => {
    settle = resolve;
  });
  deferCoreDisposal(
    { on: (event, listener) => lifecycle.on(event, listener), quit },
    () => settling,
    { schedule: (run) => scheduled.push(run) },
  );
  lifecycle.emit("before-quit", { preventDefault: vi.fn() } satisfies BeforeQuitEvent);
  scheduled[0]?.();
  // A second quit while the crew settles is held, not run again.
  const again = { preventDefault: vi.fn() } satisfies BeforeQuitEvent;
  lifecycle.emit("before-quit", again);
  expect(again.preventDefault).toHaveBeenCalledOnce();
  expect(scheduled).toHaveLength(1);
  await Promise.resolve();
  expect(quit).not.toHaveBeenCalled();
  settle();
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
});
