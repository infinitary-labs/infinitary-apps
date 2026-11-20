import { afterEach, describe, expect, it, vi } from "vitest";
import { phoneProxyReadings } from "./fixtures/phone-proxy-readings";
import {
  observePhoneProxyLaunches,
  type PhoneProxyLaunch,
  phoneProxyLaunchReading,
} from "./helpers/phoneProxyLaunches";
import { type PhoneProcess, phoneProcessTable, phoneProxyProcess } from "./helpers/phoneStacks";
import { phoneWebLaunchObservationMs } from "./helpers/phoneWebStacks";

afterEach(() => vi.useRealTimers());

// Captain's INF-1936 request: capture pending proxy children, including later delays,
// with the same ownership protections. Native records and owner tables are real;
// the as-yet-unrecorded child ps response is explicitly a controlled dependency.
function fixture(index = 0) {
  const f = phoneProxyReadings[index]!;
  const reading = phoneProxyLaunchReading(f.spawned);
  if (reading?.event !== "spawn") throw new Error("Missing retained proxy spawn reading");
  const launch = reading.launch;
  const child: PhoneProcess = {
    pid: launch.pid,
    parent: f.owner.launcher.pid,
    started: new Date(launch.at).toString(),
    executable: "xpcproxy_sim",
  };
  const table = [...phoneProcessTable(f.table), child];
  return { ...f, launch, child, table };
}

describe("the approved proxy-child diagnostic", () => {
  it.each([0, 1])(
    "reads device %i's actual launcher identity and cancels on its running record",
    async (index) => {
      vi.useFakeTimers();
      const f = fixture(index);
      expect(f.launch.pid).toBe(Number(/spawned with pid (\d+)/.exec(f.spawned)![1]));
      const capture = vi.fn(async () => {});
      const watch = observePhoneProxyLaunches(capture);
      watch.receive(f.spawned);
      watch.receive(f.running);
      await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
      expect(capture).not.toHaveBeenCalled();
      await watch.close();
    },
  );
  it("keeps later captures available after an earlier delayed child, deduplicates and joins", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const capture = vi.fn(
      (_launch: PhoneProxyLaunch, _isPending: () => boolean) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const watch = observePhoneProxyLaunches(capture);
    const first = fixture(0),
      later = fixture(1);
    watch.receive(first.spawned);
    watch.receive(first.spawned);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs - 1);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toEqual(first.launch);
    finish();
    watch.receive(first.running);
    watch.receive(first.spawned);
    watch.receive(later.spawned);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    expect(capture).toHaveBeenCalledTimes(2);
    let closed = false;
    const closing = watch.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
  });
  it("does not rearm a completed child when its spawn arrives out of order", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const capture = vi.fn(async () => {});
    const watch = observePhoneProxyLaunches(capture);
    watch.receive(f.running);
    watch.receive(f.spawned);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    expect(capture).not.toHaveBeenCalled();
    await watch.close();
  });
  it.each(["running", "exited", "not running"])(
    "cancels pending ownership work at %s",
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      let pending!: () => boolean;
      const watch = observePhoneProxyLaunches(async (_launch, isPending) => {
        pending = isPending;
      });
      watch.receive(f.spawned);
      await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
      expect(pending()).toBe(true);
      watch.receive(f.running.replace("state: running", `state: ${state}`));
      expect(pending()).toBe(false);
      await watch.close();
    },
  );
  it("cancels unspent captures and pending ownership work at shutdown", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {});
    const watch = observePhoneProxyLaunches(capture);
    watch.receive(fixture().spawned);
    await watch.close();
    watch.receive(fixture(1).spawned);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    expect(capture).not.toHaveBeenCalled();
  });
  it("ignores another service, malformed identity and mismatched child PID", () => {
    const f = fixture();
    for (const line of [
      f.spawned.replace("WebKit.WebContent", "WebKit.Networking"),
      f.spawned.replace(`pid/${f.launch.app}/`, "user/501/"),
      f.spawned.replace(`[${f.launch.pid}]`, `[${f.owner.launcher.pid}]`),
      f.spawned.replace(f.launch.at, "no native timestamp"),
    ])
      expect(phoneProxyLaunchReading(line)).toBeUndefined();
  });
});

describe("owned proxy process selection", () => {
  it.each([0, 1])(
    "verifies device %i's app, parent, birth and child identity twice",
    async (index) => {
      const f = fixture(index);
      const read = vi.fn(async (_pids: number[]) => f.table);
      expect(await phoneProxyProcess(f.owner, f.launch, read)).toEqual(f.child);
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[0]?.[0]).toContain(f.owner.launcher.pid);
    },
  );
  it("records an already-execed intended target rather than calling it a proxy", async () => {
    const f = fixture();
    f.child.executable = `/RuntimeRoot/com.apple.WebKit.${f.launch.kind}`;
    expect(await phoneProxyProcess(f.owner, f.launch, async () => f.table)).toEqual(f.child);
  });
  it.each(["parent", "birth", "executable", "missing", "app"])(
    "refuses a wrong %s without sampling",
    async (field) => {
      const f = fixture();
      if (field === "parent") f.child.parent = f.owner.manager.pid;
      if (field === "birth") f.child.started = f.owner.launcher.started;
      if (field === "executable") f.child.executable = "/usr/bin/other";
      if (field === "missing") f.table.pop();
      if (field === "app") f.table.find((p) => p.pid === f.launch.app)!.parent = 1;
      await expect(phoneProxyProcess(f.owner, f.launch, async () => f.table)).rejects.toThrow(
        /owned/,
      );
    },
  );
  it.each(["child", "app", "manager", "launcher"])(
    "refuses a %s incarnation change during discovery",
    async (role) => {
      const f = fixture();
      const pid =
        role === "child"
          ? f.child.pid
          : role === "app"
            ? f.launch.app
            : f.owner[role as "manager" | "launcher"].pid;
      const changed = f.table.map((p) =>
        p.pid === pid ? { ...p, started: f.owner.launcher.started + " changed" } : p,
      );
      const read = vi.fn().mockResolvedValueOnce(f.table).mockResolvedValueOnce(changed);
      await expect(phoneProxyProcess(f.owner, f.launch, read)).rejects.toThrow(
        "changed during discovery",
      );
    },
  );
});
