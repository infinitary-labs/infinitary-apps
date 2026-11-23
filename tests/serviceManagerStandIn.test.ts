import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { processAlive } from "../src/core/helper/lock";
import {
  afterStandIn,
  type ServiceManagerStandIn,
  serviceManagerStandIn,
} from "./e2e/serviceManagerStandIn";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The journeys' stand-in for this account's service manager
 * (tests/e2e/serviceManagerStandIn.ts; the review of INF-5409): a stop says a
 * job is unloaded only once its supervisor exited having seen its run exit.
 * A supervisor that dies before its run exits, as one that crashed, leaves
 * the job as it was: its stop fails, the job still shows as loaded or active,
 * and the journeys' cleanup says the run may still be there, all without
 * signalling any saved process number.
 */

vi.setConfig({ testTimeout: 15_000 });

const LINUX = process.platform === "linux";
const LABEL = "app.infinitary.stand-in-check";

describe.skipIf(process.platform === "win32")("the stand-in service manager", () => {
  it("accepts a removed supervisor PID record but surfaces other PID read failures", () => {
    const standIn = serviceManagerStandIn(scratchDir("stand-in-home-"));
    const state = join(standIn.dir, "state");
    // Teardown reads the PID after the supervisor removes it and records the run's exit.
    writeFileSync(join(state, `${LABEL}.runs`), "123\n");
    writeFileSync(join(state, `${LABEL}.exits`), "0\n");
    expect(() => standIn.stopAll()).not.toThrow();

    const pid = join(state, `${LABEL}.pid`);
    symlinkSync(pid, pid);
    expect(() => standIn.stopAll()).toThrow(expect.objectContaining({ code: "ELOOP" }));
  });

  it("keeps a job whose supervisor died before its run exited, and says its cleanup failed", async () => {
    const home = scratchDir("stand-in-home-");
    const standIn = serviceManagerStandIn(home);
    const manager = Object.values(standIn.env)[0] ?? "";
    const ask = (...words: string[]) => spawnSync(manager, words, { encoding: "utf8" });
    // The job's run ends on its own once this test lets it go, by a file it waits for, and within a
    // minute whatever happens, so nothing here signals it.
    const release = join(home, "release");
    const program = [
      process.execPath,
      "-e",
      "const f = process.argv[1]; setInterval(() => require(`node:fs`).existsSync(f) && process.exit(0), 50); setTimeout(() => process.exit(0), 60000);",
      release,
    ];
    const plist = join(home, `${LABEL}.plist`);
    const start = () =>
      LINUX ? ask("--user", "start", LABEL) : ask("bootstrap", "gui/501", plist);
    if (LINUX) {
      const units = join(home, ".config", "systemd", "user");
      mkdirSync(units, { recursive: true });
      writeFileSync(
        join(units, `${LABEL}.service`),
        `[Service]\nExecStart=${program.map((word) => JSON.stringify(word)).join(" ")}\n`,
      );
    } else {
      writeFileSync(
        plist,
        `<plist><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${program
          .map((word) => `<string>${word.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`)
          .join("")}</array></dict></plist>`,
      );
    }
    expect(start().status).toBe(0);
    await expect.poll(() => standIn.runs(LABEL).length).toBe(1);
    const run = standIn.runs(LABEL)[0] ?? 0;
    try {
      expect(processAlive(run)).toBe(true);
      standIn.crashOnStop(LABEL);
      const stop = () =>
        LINUX ? ask("--user", "stop", LABEL) : ask("bootout", `gui/501/${LABEL}`);
      const loaded = () =>
        LINUX
          ? ask("--user", "show", "--property=ActiveState", "--value", LABEL).stdout.trim()
          : ask("print", `gui/501/${LABEL}`).status;
      // Its supervisor dies during the stop, before its run exits.
      expect(stop().status).toBe(1);
      expect(standIn.running(LABEL)).toBe(false);
      expect(processAlive(run)).toBe(true);
      expect(loaded()).toBe(LINUX ? "active" : 0);
      // Its supervisor already gone at a stop asked again.
      expect(stop().status).toBe(1);
      expect(loaded()).toBe(LINUX ? "active" : 0);
      // A start asked of the job that shows as loaded or active is refused, and starts no second run.
      expect(start().status).not.toBe(0);
      expect(standIn.runs(LABEL)).toEqual([run]);
      expect(processAlive(run)).toBe(true);
      expect(() => standIn.stopAll()).toThrow(/its supervisor gone before it exited/);
    } finally {
      // Let go only now, every reading done: the run ends on its own, and nothing here signalled it.
      writeFileSync(release, "");
      await expect.poll(() => processAlive(run), { timeout: 10_000 }).toBe(false);
    }
  });

  // A journey's cleanup reports the first teardown failure first, a failure to keep the records
  // after it, and fails on that alone too.
  it("reports a teardown failure before a failure to keep the records, and either alone", () => {
    const missing = join(scratchDir("stand-in-records-"), "never-made");
    const standIn = (stops: () => void) =>
      ({ dir: missing, stopAll: stops }) as unknown as ServiceManagerStandIn;
    const keepTo = () => join(scratchDir("stand-in-kept-"), "service-manager");
    const ran: string[] = [];
    const thrown = (run: () => void): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return null;
    };
    const both = thrown(() =>
      afterStandIn(
        standIn(() => {
          throw new Error("the stand-in did not stop");
        }),
        false,
        keepTo,
        [() => ran.push("commands ended")],
      ),
    );
    expect(ran).toEqual(["commands ended"]);
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).message).toMatch(/^the stand-in did not stop \(and then: /);
    expect((both as AggregateError).errors[0]).toMatchObject({
      message: "the stand-in did not stop",
    });
    const copyOnly = thrown(() =>
      afterStandIn(
        standIn(() => {}),
        true,
        keepTo,
      ),
    );
    expect(copyOnly).toMatchObject({ code: "ENOENT" });
    expect(
      thrown(() =>
        afterStandIn(
          standIn(() => {}),
          false,
          keepTo,
        ),
      ),
    ).toBeNull();
  });
});
