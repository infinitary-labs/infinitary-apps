import { describe, expect, it, vi } from "vitest";
import {
  type PhoneProcess,
  phoneLaunchOwner,
  phoneLaunchProcesses,
  phoneProcessTable,
} from "./helpers/phoneStacks";

// INF-1941: the iPad request and process metadata from run 41045456509's
// simulator log and samples. The old capture's simctl lookup missed this stall.
const request =
  '2026-10-30 11:24:16.392 I  Infinitary[7375:a2b8] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7375)>[uuid:B9E19B0F-2393-451A-904D-9EDC8483465B]; "(null)">';
const submitted =
  "2026-10-30 11:27:49.247 Df runningboardd[5950:8143] [com.apple.runningboard:job_oversize] 'B9E19B0F-2393-451A-904D-9EDC8483465B' Submitting extension job properties (host PID 7375, path file:///WebContentExtension.appex/com.apple.WebKit.WebContent):";
const simulator = "829AD587-332A-4261-8A34-AA381B9CE6D3";
const app: PhoneProcess = {
  pid: Number(/Infinitary\[(\d+):/.exec(request)?.[1]),
  parent: 5929,
  started: "Fri Oct 30 11:23:41 2026",
  executable: `/Users/admin/Library/Developer/CoreSimulator/Devices/${simulator}/data/Containers/Bundle/Application/80A1FDA3-5C11-4A8F-91F1-D00B742A850E/Infinitary.app/Infinitary`,
};
const manager: PhoneProcess = {
  pid: Number(/runningboardd\[(\d+):/.exec(submitted)?.[1]),
  parent: app.parent,
  started: "Fri Oct 30 11:17:08 2026",
  executable: "/RuntimeRoot/usr/libexec/runningboardd",
};
// The launcher's incarnation is supplied by the pre-journey host reading; use
// the same simulator boot reading to stand in for that identity in this replay.
const launcher: PhoneProcess = {
  pid: app.parent,
  parent: 1,
  started: manager.started,
  executable: "/RuntimeRoot/sbin/launchd_sim",
};
const owner = { simulator, manager, launcher };
const services = `${manager.pid}\t0\tcom.apple.runningboardd\n${app.pid}\t0\tUIKitApplication:com.getinfinitary.infinitary[1b65][rb-legacy]\n`;

describe("INF-1936 carries INF-1941's host-only simulator ownership checks", () => {
  it("reads only the known host PIDs during capture and returns the owned app and services", async () => {
    const processes = vi.fn(async () => [app, manager, launcher]);
    expect(await phoneLaunchProcesses(owner, app.pid, processes)).toEqual([app, manager, launcher]);
    expect(processes).toHaveBeenCalledExactlyOnceWith([app.pid, manager.pid, launcher.pid]);
  });

  it("refuses a replaced app, another simulator or reused service PID", async () => {
    for (const current of [
      [manager, launcher],
      [{ ...app, parent: 5938 }, manager, launcher],
      [
        {
          ...app,
          executable: app.executable.replace(simulator, "30830621-C76E-47BB-8681-C5A50317C419"),
        },
        manager,
        launcher,
      ],
      [app, { ...manager, started: app.started }, launcher],
      [app, manager, { ...launcher, started: app.started }],
    ]) {
      await expect(phoneLaunchProcesses(owner, app.pid, async () => current)).rejects.toThrow(
        "no longer belongs",
      );
    }
  });

  it("establishes the launcher's identity before the journey and refuses a changed manager", async () => {
    const processes = vi.fn(async (_pids: number[]) => [manager, launcher]);
    expect(await phoneLaunchOwner(simulator, services, processes)).toEqual(owner);
    expect(processes.mock.calls).toEqual([[[manager.pid]], [[manager.pid, launcher.pid]]]);
    processes
      .mockResolvedValueOnce([manager])
      .mockResolvedValueOnce([{ ...manager, started: app.started }, launcher]);
    await expect(phoneLaunchOwner(simulator, services, processes)).rejects.toThrow(
      "changed during discovery",
    );
    await expect(phoneLaunchOwner(simulator, "", processes)).rejects.toThrow("no RunningBoard PID");
  });

  it("arms from the real host reading where launchd_sim has no path", async () => {
    // INF-1941: run 41051139970's iPad 8--bin-ps.log. The probe refused
    // this actual comm value and collected no stack, even though the journey passed.
    const reading = phoneProcessTable(` 5844     1 Fri Oct 30 12:09:38 2026     launchd_sim
 5857  5844 Fri Oct 30 12:09:38 2026     /private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.vlaBv1/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/runningboardd`);
    const parent = reading[0]!;
    const service = reading[1]!;
    const owned = await phoneLaunchOwner(
      "469C3C6A-71CC-436E-A0C6-9D9C18FE19A3",
      `${service.pid}\t0\tcom.apple.runningboardd\n`,
      async () => reading,
    );
    expect(owned.manager).toEqual(service);
    expect(owned.launcher).toEqual(parent);
  });

  it("reads the host's process columns without interpreting arguments or environment", () => {
    // Actual host ps reading collected for this probe's preflight, with comm rather than args.
    const row = "20573 95172 Fri Oct 30 04:44:41 2026     /bin/bash";
    expect(phoneProcessTable(row)).toEqual([
      { pid: 20573, parent: 95172, started: "Fri Oct 30 04:44:41 2026", executable: "/bin/bash" },
    ]);
    expect(phoneProcessTable("PID PPID STARTED COMM\n")).toEqual([]);
  });
});
