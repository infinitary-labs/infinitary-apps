import { describe, expect, it, vi } from "vitest";
import {
  type PhoneProcess,
  type PhoneWebProcess,
  phoneRenderProcesses,
} from "./helpers/phoneStacks";

// INF-1936: the captain asks for the owned WebContent and GPU on a rendering
// fault, never processes on another simulator. App/service identities come from
// run 41091833322's host readings. Child PIDs and observation times come from its
// native running-state readings; the process reader stands in for live ps using
// those launch seconds and the owned simulator's parent and extension paths.
const simulator = "170359FF-E464-4165-8B99-0D6B0CF7B768";
const launcher: PhoneProcess = {
  pid: 5868,
  parent: 1,
  started: "Fri Oct 30 16:44:12 2026",
  executable: "launchd_sim",
};
const manager: PhoneProcess = {
  pid: 5889,
  parent: launcher.pid,
  started: "Fri Oct 30 16:44:13 2026",
  executable: "/RuntimeRoot/usr/libexec/runningboardd",
};
const app: PhoneProcess = {
  pid: 7109,
  parent: launcher.pid,
  started: "Fri Oct 30 16:48:24 2026",
  executable: `/Users/admin/Library/Developer/CoreSimulator/Devices/${simulator}/data/Containers/Bundle/Application/B7D618A6-F4D5-4EC0-91B6-6516C3C7A0AD/Infinitary.app/Infinitary`,
};
const owner = { simulator, launcher, manager };
const web: PhoneProcess = {
  pid: 7441,
  parent: launcher.pid,
  started: "Fri Oct 30 16:50:14 2026",
  executable:
    "/RuntimeRoot/System/Library/ExtensionKit/Extensions/WebContentExtension.appex/com.apple.WebKit.WebContent",
};
const gpu: PhoneProcess = {
  pid: 7170,
  parent: launcher.pid,
  started: "Fri Oct 30 16:48:54 2026",
  executable:
    "/RuntimeRoot/System/Library/ExtensionKit/Extensions/GPUExtension.appex/com.apple.WebKit.GPU",
};
const extensions: PhoneWebProcess[] = [
  { app: app.pid, pid: web.pid, kind: "WebContent", observedAt: "2026-10-30 16:50:14.571" },
  { app: app.pid, pid: gpu.pid, kind: "GPU", observedAt: "2026-10-30 16:48:54.360" },
];
const base = [app, manager, launcher];
const all = [...base, web, gpu];

describe("INF-1936 samples only the fault's app-owned WebKit processes", () => {
  it("confirms stable host identities and places the fault's children first", async () => {
    const read = vi.fn(async (_pids: number[]) => all);
    expect(await phoneRenderProcesses(owner, app.pid, extensions, read)).toEqual({
      targets: [web, gpu, ...base],
      unavailable: [],
    });
    expect(read.mock.calls).toEqual([
      [[...base, web, gpu].map((p) => p.pid)],
      [[...base, web, gpu].map((p) => p.pid)],
    ]);
  });

  it("excludes an exited, replaced or foreign child without losing the other samples", async () => {
    for (const changed of [
      undefined,
      { ...web, parent: 5875 }, // the other simulator's actual launcher
      { ...web, executable: gpu.executable },
      { ...web, started: "Fri Oct 30 16:50:45 2026" }, // born after the recorded PID witness
      { ...web, started: launcher.started }, // predates the owning app
    ]) {
      const current = [...base, gpu, ...(changed ? [changed] : [])];
      const result = await phoneRenderProcesses(owner, app.pid, extensions, async () => current);
      expect(result.targets).toEqual([gpu, ...base]);
      expect(result.unavailable).toEqual([
        `WebContent PID ${web.pid}: absent, replaced, or not owned by this app and simulator.`,
      ]);
    }
  });

  it("refuses a child's unrelated app witness even when the executable matches", async () => {
    const result = await phoneRenderProcesses(
      owner,
      app.pid,
      [extensions[0]!, { ...extensions[1]!, app: 7309 }],
      async () => all,
    );
    expect(result.targets).toEqual([web, ...base]);
    expect(result.unavailable).toEqual([
      `GPU PID ${gpu.pid}: absent, replaced, or not owned by this app and simulator.`,
    ]);
  });

  it("records a missing GPU witness rather than scanning unrelated host processes", async () => {
    const read = vi.fn(async (_pids: number[]) => [...base, web]);
    const result = await phoneRenderProcesses(owner, app.pid, [extensions[0]!], read);
    expect(result).toEqual({
      targets: [web, ...base],
      unavailable: ["No GPU PID was observed for this app."],
    });
    expect(read.mock.calls.every(([pids]) => !pids.includes(gpu.pid))).toBe(true);
  });

  it("excludes a child whose identity changes between host readings", async () => {
    const read = vi
      .fn(async () => all)
      .mockResolvedValueOnce(all)
      .mockResolvedValueOnce([...base, web, { ...gpu, started: web.started }]);
    const result = await phoneRenderProcesses(owner, app.pid, extensions, read);
    expect(result.targets).toEqual([web, ...base]);
    expect(result.unavailable).toEqual([
      `PID ${gpu.pid}: exited or changed identity during the rendering-fault lookup.`,
    ]);
  });

  it("refuses the entire capture when the owning app changes during lookup", async () => {
    const read = vi
      .fn(async () => all)
      .mockResolvedValueOnce(all)
      .mockResolvedValueOnce([{ ...app, started: web.started }, manager, launcher, web, gpu]);
    await expect(phoneRenderProcesses(owner, app.pid, extensions, read)).rejects.toThrow(
      "owned app or simulator changed",
    );
  });
});
