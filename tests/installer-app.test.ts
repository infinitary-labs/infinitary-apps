import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  APP_RECORDS,
  describeProcesses,
  keepAppRecords,
  lingering,
  mainThreadFrame,
  parseAppProcesses,
  startedPage,
} from "../scripts/installer-app";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2949: the published-alpha update check stopped the app ShipIt restarted 1.7 s into
// its start, waited only for its main process to end, and its next launch showed no page,
// with nothing kept to say why. These readings decide when the check stops the restarted
// copy, what must end before it launches again, and what a launch with no page names.
// The listings are `ps -axww -o pid=,ppid=,etime=,stat=,comm=` and `-o pid=,command=`
// as macOS prints them for an Electron app and its helpers.
const app = "/Applications/Infinitary.app";
const helper = (name: string) => `${app}/Contents/Frameworks/${name}.app/Contents/MacOS/${name}`;
const programs = [
  `    1     0 10-01:00:18 Ss   /sbin/launchd`,
  ` 1514     1       00:03 S    ${app}/Contents/MacOS/Infinitary`,
  ` 1520  1514       00:03 S    ${helper("Infinitary Helper (GPU)")}`,
  ` 1522  1514       00:03 S    ${helper("Infinitary Helper")}`,
  ` 1530  1514       00:02 S    ${helper("Infinitary Helper (Renderer)")}`,
  ` 1541  1514       00:02 S    ${app}/Contents/Resources/git/darwin-arm64/bin/git`,
  ` 1544  1514       00:01 S    ${app}/Contents/MacOS/Infinitary`,
  ` 1605     1       00:09 S    ${app}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt`,
  ` 1188     1       00:40 U    ${helper("Infinitary Helper (GPU)")}`,
  ` 7001  6990 01:12:00 S    /Applications/Other.app/Contents/Frameworks/Other Helper (Renderer).app/Contents/MacOS/Other Helper (Renderer)`,
].join("\n");
const commands = [
  `    1 /sbin/launchd`,
  ` 1514 ${app}/Contents/MacOS/Infinitary --remote-debugging-port=0 --enable-logging --log-level=1 --disable-gpu`,
  ` 1520 ${helper("Infinitary Helper (GPU)")} --type=gpu-process --user-data-dir=/x --gpu-preferences=AAA`,
  ` 1522 ${helper("Infinitary Helper")} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US`,
  ` 1530 ${helper("Infinitary Helper (Renderer)")} --type=renderer --app-path=${app}/Contents/Resources/app.asar`,
  ` 1541 ${app}/Contents/Resources/git/darwin-arm64/bin/git status --porcelain`,
  ` 1544 ${app}/Contents/MacOS/Infinitary /tmp/axi.js`,
  ` 1605 ${app}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.getinfinitary.infinitary.ShipIt /x/ShipItState.plist`,
  ` 1188 ${helper("Infinitary Helper (GPU)")} --type=gpu-process --user-data-dir=/x`,
  ` 7001 /Applications/Other.app/Contents/Frameworks/Other Helper (Renderer).app/Contents/MacOS/Other Helper (Renderer) --type=renderer`,
].join("\n");

it("reads every process from the app's bundle with its kind, and nothing from another app", () => {
  const processes = parseAppProcesses(programs, commands, [app]);
  expect(
    processes.map(({ pid, ppid, program, kind, state }) => ({ pid, ppid, program, kind, state })),
  ).toEqual([
    { pid: 1514, ppid: 1, program: "Infinitary", kind: "main", state: "S" },
    { pid: 1520, ppid: 1514, program: "Infinitary Helper (GPU)", kind: "gpu-process", state: "S" },
    {
      pid: 1522,
      ppid: 1514,
      program: "Infinitary Helper",
      kind: "utility network.mojom.NetworkService",
      state: "S",
    },
    {
      pid: 1530,
      ppid: 1514,
      program: "Infinitary Helper (Renderer)",
      kind: "renderer",
      state: "S",
    },
    { pid: 1541, ppid: 1514, program: "git", kind: "git", state: "S" },
    { pid: 1544, ppid: 1514, program: "Infinitary", kind: "child", state: "S" },
    { pid: 1605, ppid: 1, program: "ShipIt", kind: "ShipIt", state: "S" },
    { pid: 1188, ppid: 1, program: "Infinitary Helper (GPU)", kind: "gpu-process", state: "U" },
  ]);
  // A bundle reached through a link is listed under the path the system resolved.
  expect(parseAppProcesses(programs, commands, ["/Users/x/Infinitary.app", app])).toHaveLength(8);
  expect(parseAppProcesses(programs, commands, ["/Applications/Infinitary"])).toEqual([]);
});

it("waits for the restarted copy until its own main process starts a renderer", () => {
  const all = parseAppProcesses(programs, commands, [app]);
  expect(startedPage(all)).toBe(true);
  // A renderer left from a stopped copy, now launchd's, is not the restarted copy's page.
  const orphaned = all.map((process) =>
    process.kind === "renderer" ? { ...process, ppid: 1 } : process,
  );
  expect(startedPage(orphaned)).toBe(false);
  expect(startedPage(all.filter(({ kind }) => kind !== "renderer"))).toBe(false);
  expect(startedPage(all.filter(({ kind }) => kind !== "main"))).toBe(false);
});

it("names every process but ShipIt as one that must end before the next launch", () => {
  const left = lingering(parseAppProcesses(programs, commands, [app]));
  expect(left.map(({ pid }) => pid)).toEqual([1514, 1520, 1522, 1530, 1541, 1544, 1188]);
  expect(describeProcesses(left.filter(({ pid }) => pid === 1188))).toBe(
    "Infinitary Helper (GPU) (gpu-process) 1188 of 1, up 00:40, U",
  );
  expect(describeProcesses([])).toBe("none");
});

// The call graph `sample` writes, trimmed: the main thread spent all 2,450 samples under
// a window's creation, then split between two frames below it.
const report = `Analysis of sampling Infinitary (pid 1514) every 1 millisecond
Call graph:
    2450 Thread_9610   DispatchQueue_1: com.apple.main-thread  (serial)
    + 2450 start  (in dyld) + 6652  [0x18f5a4d7c]
    +   2450 ElectronMain  (in Electron Framework) + 388  [0x112505dc0]
    +     2450 -[NSWindow _commonInitFrame:styleMask:backing:defer:]  (in AppKit) + 1200  [0x18a0]
    +       2450 CA::Context::commit_transaction(CA::Transaction*, double, double*)  (in QuartzCore) + 300  [0x19b0]
    +       ! 2400 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x18f8]
    +       ! 50 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x18f9]
    2450 Thread_9611
    + 2450 thread_start  (in libsystem_pthread.dylib) + 8  [0x18f9]

Total number in stack (recursive counted multiple times):
`;

it("names the deepest frame a sampled main thread stayed in for every sample", () => {
  expect(mainThreadFrame(report)).toBe(
    "CA::Context::commit_transaction(CA::Transaction*, double, double*) (in QuartzCore)",
  );
  expect(
    mainThreadFrame("Analysis of sampling Infinitary (pid 1514)\nCall graph:\n"),
  ).toBeUndefined();
});

it("keeps the app's stall and memory records and leaves its database behind", () => {
  const data = scratchDir("installer-app-data-");
  const evidence = join(scratchDir("installer-app-evidence-"), "kept");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "freezes.jsonl"), '{"status":"started"}\n');
  writeFileSync(join(data, "firstmate.db"), "saved work");
  expect(APP_RECORDS).toContain("memory.jsonl");
  expect(keepAppRecords(data, evidence, "launch-2")).toEqual(["launch-2-freezes.jsonl"]);
  expect(readFileSync(join(evidence, "launch-2-freezes.jsonl"), "utf8")).toBe(
    '{"status":"started"}\n',
  );
  expect(keepAppRecords(data, evidence, "final")).toEqual(["final-freezes.jsonl"]);
});
