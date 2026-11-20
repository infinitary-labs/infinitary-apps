import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  capturePhoneIdleTimeout,
  capturePhoneKeyboardTimeout,
  type PhoneProcess,
} from "./helpers/phoneStacks";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1066: the captain requested a stack at this actual PR-run UIKit timeout,
// with the photo-selection/tap order unchanged. This is the retained iPad reading.
const fault =
  "2026-10-24 16:41:17.302 F  Infinitary[7496:f94e] [com.apple.UIKit:KeyboardTaskQueue] -[UIKeyboardTaskQueue _lockWhenReadyForMainThread] Keyboard queue task timeout detected";
const pid = Number(/Infinitary\[(\d+):/.exec(fault)?.[1]);

function fixture(
  currentPid = pid,
  sample = vi.fn(async (_pid: number, _destination: string) => {}),
) {
  const evidence = scratchDir("phone-timeout-stack-");
  const readPid = vi.fn(async () => currentPid);
  const reader = capturePhoneKeyboardTimeout({ evidence, currentPid: readPid, sample });
  return {
    evidence,
    readPid,
    sample,
    reader,
    status: () => readFileSync(join(evidence, "keyboard-timeout-capture.log"), "utf8"),
  };
}

describe("the requested fault-time stack capture", () => {
  it("samples the owned app once on the real fault and joins it before cleanup", async () => {
    let finish!: () => void;
    const sampled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture(
      pid,
      vi.fn(async () => sampled),
    );
    f.reader.receive(fault);
    f.reader.receive(fault);
    let closed = false;
    const closing = f.reader.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(f.readPid).toHaveBeenCalledTimes(1);
    expect(f.sample).toHaveBeenCalledExactlyOnceWith(
      pid,
      join(f.evidence, "keyboard-timeout-stack.log"),
    );
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(f.status()).toContain("Completed owned app stack capture");
    f.reader.receive(fault);
    expect(f.sample).toHaveBeenCalledTimes(1);
  });

  it("does not sample a PID no longer owned by the simulator's current app", async () => {
    // The same journey's pre-relaunch application PID, read from its XCTest log.
    const f = fixture(7374);
    f.reader.receive(fault);
    await f.reader.close();
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.status()).toContain("no longer owns that PID");
  });

  it("keeps a failed capture honestly and never retries it", async () => {
    const f = fixture(
      pid,
      vi.fn(async () => {
        throw new Error("sampler exited before capture");
      }),
    );
    f.reader.receive(fault);
    await f.reader.close();
    f.reader.receive(fault);
    expect(f.sample).toHaveBeenCalledTimes(1);
    expect(f.status()).toContain("Stack capture failed: Error: sampler exited before capture");
    expect(f.status()).not.toContain("Completed owned app stack capture");
  });

  it("does not treat an ordinary text-input reading as a reproduced timeout", async () => {
    const f = fixture();
    f.reader.receive(
      "2026-10-24 16:41:16.145 Df Infinitary[7496:f94e] [com.apple.UIKit:KeyboardSceneDelegate] _reloadInputViewsForKeyWindowSceneResponder: 1 force: 0, fromBecomeFirstResponder: 1 (automaticKeyboard: 1, reloadIdentifier: AF19F76C-B83D-4B2B-9530-8EDCD2F883CD)",
    );
    await f.reader.close();
    expect(f.readPid).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.status()).toContain("no stack capture or reproduction is claimed");
  });
});

// INF-2767: XCTest's own line from the iPhone talk-tasks part on main whose app stopped right after the turn to landscape
// (run 43649590939). That gate kept no host reading of the processes a turn waits on, so the simulator's processes are a
// later talk-tasks part's (run 44164570607): its recorded owner, and the app, peers and WebContent with their PIDs and
// first lines in its simulator log.
const idleTimeout =
  "    t =   122.45s         App event loop idle notification not received, will attempt to continue.";
const simulator = "E87EDBF5-BF9B-4923-A106-557FEA5B22C7";
const runtime =
  "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.weBjjh/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot";
const launcher: PhoneProcess = {
  pid: 4479,
  parent: 1,
  started: "Tue Nov 17 20:02:27 2026",
  executable: "launchd_sim",
};
const manager: PhoneProcess = {
  pid: 4485,
  parent: 4479,
  started: "Tue Nov 17 20:02:28 2026",
  executable: `${runtime}/usr/libexec/runningboardd`,
};
const stuckApp: PhoneProcess = {
  pid: 7221,
  parent: 4479,
  started: "Tue Nov 17 20:04:48 2026",
  executable: `/Users/admin/Library/Developer/CoreSimulator/Devices/${simulator}/data/Containers/Bundle/Application/2E172892-50EA-4F86-BBD3-FA34E6AC43A6/Infinitary.app/Infinitary`,
};
const peers: PhoneProcess[] = [
  {
    pid: 4482,
    parent: 4479,
    started: "Tue Nov 17 20:04:08 2026",
    executable: `${runtime}/System/Library/CoreServices/SpringBoard.app/SpringBoard`,
  },
  {
    pid: 4503,
    parent: 4479,
    started: "Tue Nov 17 20:04:15 2026",
    executable: `${runtime}/usr/libexec/backboardd`,
  },
  {
    pid: 5609,
    parent: 4479,
    started: "Tue Nov 17 20:04:17 2026",
    executable: `${runtime}/Applications/InputUI.app/InputUI`,
  },
  {
    pid: 7077,
    parent: 4479,
    started: "Tue Nov 17 20:04:23 2026",
    executable: `${runtime}/System/Library/TextInput/kbd`,
  },
];

function idleFixture(
  launched: PhoneProcess[],
  sample = vi.fn(async (_pid: number, _destination: string) => {}),
) {
  const evidence = scratchDir("phone-idle-stack-");
  const host = [launcher, manager, ...launched];
  const children = vi.fn(async () => launched);
  const processes = vi.fn(async (pids: number[]) => host.filter((p) => pids.includes(p.pid)));
  const reader = capturePhoneIdleTimeout({
    evidence,
    owner: { simulator, manager, launcher },
    children,
    processes,
    sample,
  });
  return {
    evidence,
    children,
    sample,
    reader,
    status: () => readFileSync(join(evidence, "idle-timeout-capture.log"), "utf8"),
  };
}

describe("the stack capture when the app never goes idle", () => {
  it("samples the stuck app and the processes its turn waits on, once, and joins them before cleanup", async () => {
    const webContent: PhoneProcess = {
      pid: 7233,
      parent: 4479,
      started: "Tue Nov 17 20:04:50 2026",
      executable: `${runtime}/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/com.apple.WebKit.WebContent`,
    };
    let finish!: () => void;
    const sampled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = idleFixture(
      [manager, stuckApp, ...peers, webContent],
      vi.fn(async () => sampled),
    );
    f.reader.receive(idleTimeout);
    f.reader.receive(idleTimeout);
    let closed = false;
    const closing = f.reader.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.sample).toHaveBeenCalledTimes(5));
    expect(f.children).toHaveBeenCalledTimes(1);
    expect(f.sample.mock.calls.map(([pid, destination]) => [pid, destination])).toEqual(
      [
        [7221, "Infinitary"],
        [4482, "SpringBoard"],
        [4503, "backboardd"],
        [5609, "InputUI"],
        [7077, "kbd"],
      ].map(([pid, name]) => [pid, join(f.evidence, `idle-timeout-${name}-${pid}.log`)]),
    );
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(f.status()).toContain(
      "Observed: t =   122.45s         App event loop idle notification not received",
    );
    expect(f.status()).toContain("Capture completed.");
    f.reader.receive(idleTimeout);
    expect(f.sample).toHaveBeenCalledTimes(5);
  });

  it("samples nothing when the app running is not this simulator's", async () => {
    const elsewhere = {
      ...stuckApp,
      executable: stuckApp.executable.replace(simulator, "9533DAB6-6847-4546-B821-C4BC60EFA8E8"),
    };
    const f = idleFixture([manager, elsewhere, ...peers]);
    f.reader.receive(idleTimeout);
    await f.reader.close();
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.status()).toContain(
      "Capture failed: Error: The owned simulator runs 0 app processes; no process was sampled",
    );
  });

  it("names a peer that is not running and still samples the rest", async () => {
    const f = idleFixture([stuckApp, ...peers.filter((p) => !p.executable.endsWith("/InputUI"))]);
    f.reader.receive(idleTimeout);
    await f.reader.close();
    expect(f.sample).toHaveBeenCalledTimes(4);
    expect(f.status()).toContain("InputUI: not running on the owned simulator.");
  });

  it("keeps a failed sample honestly and still samples the others", async () => {
    const f = idleFixture(
      [stuckApp, ...peers],
      vi.fn(async (pid: number) => {
        if (pid === 4482) throw new Error("sample exited before capture");
      }),
    );
    f.reader.receive(idleTimeout);
    await f.reader.close();
    expect(f.sample).toHaveBeenCalledTimes(5);
    expect(f.status()).toContain(
      "Sample failed for SpringBoard PID 4482: Error: sample exited before capture",
    );
    expect(f.status()).toContain("Sample ended for Infinitary PID 7221.");
  });

  it("does not treat an ordinary wait for the app to idle as the app never going idle", async () => {
    const f = idleFixture([stuckApp, ...peers]);
    f.reader.receive("    t =     3.27s         Wait for com.getinfinitary.infinitary to idle");
    await f.reader.close();
    expect(f.children).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
  });
});
