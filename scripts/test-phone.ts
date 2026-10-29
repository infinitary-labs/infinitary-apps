/** INF-64 piece 2's native gate: disposable real home, one simulator per device, no signing. */
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { budgetTimer, GRADES_BUDGETS, startPhoneLoadClock } from "../tests/helpers/budgets.ts";
import { observePhoneLog } from "../tests/helpers/phoneLogs.ts";
import { capturePhoneKeyboardTimeout } from "../tests/helpers/phoneStacks.ts";
import { libraryPhotoAdded, logTime, photosOpened } from "../tests/helpers/phonePhotos.ts";
import { changePhoneTextSize, hardwareKeyboardArguments, observePhoneKeyboard, type PhoneChord, type PhoneDisplayReport, type PhoneTextSize, phoneApplicationPid, phoneDisplayDeadline, withPhoneHardwareKeyboard } from "../tests/helpers/phoneKeyboard.ts";
import { removeScratchDirs, scratchDir } from "../tests/helpers/scratchDirs.ts";
import { ciModeRefusal } from "./checks-mode.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { takeHeavyRunPlace } from "./heavy-run-place.ts";
import { startPhoneActivity } from "./phone-activity.ts";
import { runEveryCheck } from "./phone-checks.ts";
import { GATE_SIMULATOR, removePhoneLeftovers, SCRATCH_PREFIX } from "./phone-leftovers.ts";
import { phoneRecording } from "./phone-recording.ts";
import { phoneSimulator, phoneXcode } from "./phone-simulator.ts";
import { PHONE_PARTS, type PhoneDevice, partSelection, phoneAnimationWaits, phoneExecutionArguments, phoneJobs, runDeviceLanes, testHomeKeys } from "./phone-test-plan.ts";

// INF-800: with CI mode on, the phone check runs only through CI (docs/testing.md).
const refusal = ciModeRefusal("phone");
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
const { values } = parseArgs({ options: {
  evidence: { type: "string" },
  ipad: { type: "boolean", default: false },
  demo: { type: "boolean", default: false },
  // CI needs no encoder: keep simctl's H.264 capture for conversion on the evidence reader's Mac.
  "raw-demo": { type: "boolean", default: process.env.PHONE_RECORDING === "1" },
  waits: { type: "boolean", default: process.env.INFINITARY_PHONE_WAITS_ONLY === "1" },
  starve: { type: "boolean", default: process.env.INFINITARY_STARVE_CHECK === "1" },
  // INF-662 piece 1: check and build once, then the iPhone and the iPad side by side.
  both: { type: "boolean", default: false },
  // INF-662 piece 2: the journey's parts to run (all of them unless named), and how many devices at once.
  part: { type: "string", multiple: true },
  // INF-1343 (the captain's "Stop a failing pull request check at its first failed part"): the first
  // failed part ends the parts still running and starts no other; a pull request's check sets it.
  "stop-early": { type: "boolean", default: process.env.INFINITARY_PHONE_STOP_EARLY === "1" },
  simulators: { type: "string", default: "6" },
  // One part on one device: its test plan from the gate's build, and the simulator the gate started for it.
  xctestrun: { type: "string" },
  simulator: { type: "string" },
} });
if (process.platform !== "darwin") throw new Error("The native gate needs Xcode on a Mac");
if (!values.evidence) throw new Error("Pass --evidence with a folder outside the working copy");
const evidence = resolve(values.evidence);
if (evidence === REPO_ROOT || evidence.startsWith(REPO_ROOT + "/"))
  throw new Error("Native evidence must stay outside the working copy");
if (values.both && (values.ipad || values.xctestrun)) throw new Error("--both runs the iPhone and the iPad itself");
if (values.xctestrun && values.part?.length !== 1) throw new Error("--xctestrun runs exactly one --part");
if (!!values.xctestrun !== !!values.simulator) throw new Error("A part needs both its built plan and the gate's simulator");
const devices: PhoneDevice[] = values.both ? ["iphone", "ipad"] : [values.ipad ? "ipad" : "iphone"];
const jobs = phoneJobs(devices, values.waits ? ["rest"] : values.part ?? PHONE_PARTS.map((part) => part.name));
const simulators = Number(values.simulators);
mkdirSync(evidence, { recursive: true });
// INF-1541 piece 4 and INF-1664: a local gate waits in its computer's load line, or without one in the
// Mac mini's crew places, never for a quieter Mac; its parts ride the gate's place. CI's job starts at once.
const runPlace = values.xctestrun ? { close() {} }
  : await takeHeavyRunPlace("phone", `test:phone ${devices.join(" and ")}: ${jobs.length} part(s)`);
// Capture the account home before the disposable app/test HOME replaces it.
const invokingHome = userInfo().homedir;
const root = scratchDir(SCRATCH_PREFIX);
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.CFFIXED_USER_HOME = home;
process.env.PI_OFFLINE = "1";
process.env.INFINITARY_LOCAL_CODESIGN_DIR = join(home, "signing-unused");
startPhoneLoadClock();
const runner = await openModuleRunner();
const { hostEnv } = await runner.import<typeof import("../src/core/hostEnv")>(join(REPO_ROOT, "src/core/hostEnv.ts"));
const env = { ...hostEnv(), HOME: home, CFFIXED_USER_HOME: home };
let activity: ReturnType<typeof startPhoneActivity>;
try { activity = startPhoneActivity(env, invokingHome); }
catch (error) { await runner.close(); runPlace.close(); throw error; }
let number = 0;
const children = new Set<ChildProcess>();
let interrupted = false;
let cleaningUp = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
});
// A cleanup command, such as deleting a simulator the gate started, still runs after an interruption.
const run = async (command: string, args: string[], cleanup = false) => {
  if (interrupted && !cleaningUp && !cleanup) throw new Error("The native gate was interrupted");
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject); child.once("close", resolveExit);
  }).finally(() => children.delete(child));
  const log = join(evidence, `${++number}-${command.replaceAll("/", "-")}.log`);
  writeFileSync(log, output);
  if (status !== 0) throw Object.assign(new Error(`${command} failed (${status}); see ${log}`), { output });
  return output;
};
const demo = phoneRecording(values["raw-demo"] ? "raw" : values.demo ? "encoded" : "off", run);
// The part's simulator, which the gate started and owns; the part only uses it.
let simulator: string | undefined = values.simulator;
const phoneBundle = "com.getinfinitary.infinitary";
// The UI test runner Xcode installs beside the app, which a part's `xcodebuild` reinstalls.
const runnerBundle = `${phoneBundle}.uitests.xctrunner`;
// The processes behind a failed part's photo and card steps: the app, its card pages and Photos.
const SIMULATOR_LOG = 'process == "Infinitary" OR process BEGINSWITH "com.apple.WebKit" OR process CONTAINS[c] "photo"'
  + ' OR process == "assetsd" OR process == "mediaanalysisd"'
  + ' OR (process == "runningboardd" AND (eventMessage CONTAINS "WebKit" OR eventMessage CONTAINS "Infinitary"))';
// INF-819: the simulator's own system, keyboard and accessibility processes, which answer XCUITest's
// "Check for interrupting elements"; on a few iPhone talk parts they stopped answering after a keyboard switch.
// INF-1645: iOS 27.0's backboardd repeats one IOSurface line about 1.2 thousand times a second (346 MB in
// 20 minutes, against 758 lines on iOS 26.4), so the phone check's log leaves that line out.
const SYSTEM_LOG = '(process IN {"SpringBoard", "backboardd", "AccessibilityUIServer", "testmanagerd", "kbd"}'
  + ' OR process ENDSWITH "-Runner" OR subsystem BEGINSWITH[c] "com.apple.accessibility")'
  + ' AND NOT eventMessage CONTAINS "IOSurfaceQueryTransactionList"';
let keyboard: Awaited<ReturnType<typeof observePhoneKeyboard>> | undefined;
let simulatorLog: Awaited<ReturnType<typeof observePhoneLog>> | undefined;
let timeoutStack: ReturnType<typeof capturePhoneKeyboardTimeout> | undefined;
let recorder: ChildProcess | undefined;
let recorded: Promise<void> | undefined;
let recordingLog = "";
const recordings: { name: string; raw: string }[] = [];
// INF-1785: the appearance this part last asked for; its gate set light before the part began.
let askedAppearance: "light" | "dark" = "light";
// An appearance SpringBoard misses leaves no line to prove it, so it is confirmed and never set again. Its witness
// runs while the text size changes, and every witness of one display control answers by `until` (INF-1799), so its
// unknown reaches the journey before the journey's own request ends.
const changeAppearance = async (style: "light" | "dark", until: number) => {
  if (!simulator || !keyboard) throw new Error("No owned simulator display observer exists");
  const observer = keyboard;
  const since = Date.now();
  await run("xcrun", ["simctl", "ui", simulator, "appearance", style]);
  const confirmed = async (): Promise<PhoneDisplayReport["appearance"]> => {
    // The simulator writes nothing for the appearance it already has, so SpringBoard has nothing to change.
    if (style === askedAppearance) return { outcome: "unchanged" };
    askedAppearance = style;
    const outcome = await observer.appearance(since, style, until);
    if (outcome.outcome !== "applied") console.log(`Appearance ${style}: ${JSON.stringify(outcome)}`);
    return outcome;
  };
  return { confirmed: confirmed() };
};
const recording = {
  keyboardBeforeLaunch: async () => {
    if (!keyboard) throw new Error("No owned simulator keyboard observer exists");
    return keyboard.beforeLaunch();
  },
  // INF-1477: what backboardd did with the tap the runner began at `since`, from the same renewed subscription.
  touchOutcome: async (since: number) => {
    if (!keyboard) throw new Error("No owned simulator keyboard observer exists");
    return keyboard.touch(since);
  },
  // INF-1477: whether the photo picker read the photo tap the runner began at `since` as a press-and-hold.
  pickerPreview: async (since: number) => {
    if (!keyboard) throw new Error("No owned simulator keyboard observer exists");
    return keyboard.preview(since);
  },
  keyboardReady: async (chord: PhoneChord) => {
    if (!simulator || !keyboard) throw new Error("No owned simulator keyboard observer exists");
    const owned = simulator;
    const observer = keyboard;
    // The app publishes its key commands only while this keyboard is attached; the chord's own press detaches it again.
    return withPhoneHardwareKeyboard(run, owned, async () => {
      const services = await run("xcrun", ["simctl", "spawn", owned, "launchctl", "list"]);
      return observer.wait(phoneApplicationPid(services, phoneBundle), chord);
    });
  },
  display: async (appearance: "light" | "dark", large: boolean): Promise<PhoneDisplayReport> => {
    const until = phoneDisplayDeadline();
    const { confirmed } = await changeAppearance(appearance, until);
    if (!simulator || !keyboard) throw new Error("No owned simulator display observer exists");
    const [owned, observer] = [simulator, keyboard];
    const size: PhoneTextSize = large ? "extra-extra-extra-large" : "large";
    const textSize = await changePhoneTextSize(size,
      () => run("xcrun", ["simctl", "ui", owned, "content_size", size]),
      (since) => observer.textSize(since, size, until));
    for (const outcome of textSize) if (outcome.outcome !== "applied") console.log(`Text size ${size}: ${JSON.stringify(outcome)}`);
    return { appearance: await confirmed, textSize };
  },
  appearance: async (theme: "dark" | "light"): Promise<PhoneDisplayReport> => ({ appearance: await (await changeAppearance(theme, phoneDisplayDeadline())).confirmed }),
  damageRecord: async () => {
    if (!simulator) throw new Error("No owned simulator exists");
    const container = resolve((await run("xcrun", ["simctl", "get_app_container", simulator, phoneBundle, "data"])).trim());
    if (!container.split("/").includes(simulator)) throw new Error("The app container is not on this run's simulator");
    const saved = join(container, "Library", "Application Support", "JoinedMac.json");
    const bytes = readFileSync(saved);
    // Reproduce a truncated version of the actual saved record, never another simulator's data.
    writeFileSync(saved, bytes.subarray(0, bytes.length - 8));
  },
  start: async (name = "reconnect") => {
    if (!demo.enabled || recorder || !simulator) return;
    if (!["reconnect", "talk", "composer", "character", "conversation", "native-scene-pan", "native-scene-keyboard", "native-orbit-gap", "card-form", "card-paging", "card-reply", "card-picture", "card-recording", "review-recovery"].includes(name)) throw new Error("Unknown phone recording");
    const raw = join(root, `${name}.mp4`);
    recordings.push({ name, raw });
    recordingLog = "";
    const child = spawn("xcrun", ["simctl", "io", simulator, "recordVideo", "--codec=h264", raw], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    recorder = child;
    recorded = new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
    await new Promise<void>((resolveStarted, reject) => {
      const timeout = budgetTimer(() => reject(new Error("The simulator recorder did not start")), 15_000);
      const hear = (part: Buffer) => {
        recordingLog += part.toString();
        if (recordingLog.includes("Recording started")) { timeout.cancel(); resolveStarted(); }
      };
      child.stdout?.on("data", hear); child.stderr?.on("data", hear);
      child.once("error", (error) => { timeout.cancel(); reject(error); });
      child.once("exit", () => {
        timeout.cancel();
        if (!recordingLog.includes("Recording started")) reject(new Error("The simulator recorder exited before starting"));
      });
    });
  },
  stop: async () => {
    if (!recorder) return;
    recorder.kill("SIGINT"); await recorded; recorder = undefined;
    writeFileSync(join(evidence, `${recordings.at(-1)!.name}-recording.log`), recordingLog);
  },
};
let fixture: Awaited<ReturnType<typeof import("../tests/helpers/phoneHome").startPhoneHome>> | undefined;
const project = ["-project", "ios/Infinitary/Infinitary.xcodeproj", "-scheme", "Infinitary",
  "-xcconfig", "ios/Infinitary/SimulatorTests.xcconfig"];
// INF-1438 (the captain's "Start each simulated device once per phone check, not once per part"): the gate
// owns one simulator per device, from create to delete, and runs the device's parts on it one after the
// other, each as its own gate with its own test home and a clean app. Do not borrow or erase a developer's
// simulator.
const ownedSimulators = new Set<string>();
type Lane = { device: PhoneDevice; owned: string; booted: Date; photos?: Promise<void> };
const startSimulator = async (device: PhoneDevice): Promise<Lane> => {
  const catalog = JSON.parse(await run("xcrun", ["simctl", "list", "--json"]));
  const { kind, runtime } = phoneSimulator(catalog, device);
  const owned = (await run("xcrun", ["simctl", "create", GATE_SIMULATOR, kind.identifier, runtime.identifier])).trim();
  ownedSimulators.add(owned);
  // CoreSimulator is a host service, not a signing operation. This new device owns its own Keychain.
  const booted = new Date();
  await run("xcrun", ["simctl", "bootstatus", owned, "-b"]);
  console.log(`${device}: started simulator ${owned} in ${((Date.now() - booted.getTime()) / 60_000).toFixed(1)} minutes`);
  return { device, owned, booted };
};
const deleteSimulator = async (owned: string) => {
  await run("xcrun", ["simctl", "shutdown", owned], true).catch(() => {});
  await run("xcrun", ["simctl", "delete", owned], true);
  ownedSimulators.delete(owned);
};
const simulatorState = async (owned: string): Promise<string> => {
  const listed = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "-j"])).devices as Record<string, { udid: string; state: string }[]>;
  const state = Object.values(listed).flat().find((item) => item.udid === owned)?.state;
  if (!state) throw new Error(`The gate's simulator ${owned} is gone`);
  return state;
};
const installedApps = async (owned: string): Promise<Record<string, unknown>> => {
  const listed = join(root, `${owned}-apps.plist`);
  writeFileSync(listed, await run("xcrun", ["simctl", "listapps", owned]));
  return JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", listed]));
};
// Every part starts from a clean app on the device: the previous part's app and test runner, Keychain,
// permission answers, appearance, type size and hardware keyboard are gone, as on a new simulator.
const readyForPart = async (lane: Lane, name: string) => {
  const { owned, device } = lane;
  const state = await simulatorState(owned);
  if (state !== "Booted") {
    // INF-1265's run 40260276185: Xcode shut a device down after a failed part, and the parts after it failed to start.
    console.log(`${name}: the simulator was ${state} after the previous part; booting it again`);
    lane.booted = new Date();
    // Photos opens its library again after the boot; a part that chooses a photo waits for it again.
    lane.photos = undefined;
    await run("xcrun", ["simctl", "bootstatus", owned, "-b"]);
  }
  const apps = await installedApps(owned);
  for (const bundle of [phoneBundle, runnerBundle]) if (apps[bundle]) await run("xcrun", ["simctl", "uninstall", owned, bundle]);
  await run("xcrun", ["simctl", "keychain", owned, "reset"]);
  await run("xcrun", ["simctl", "privacy", owned, "reset", "all"]);
  await run("xcrun", ["simctl", "ui", owned, "appearance", "light"]);
  await run("xcrun", ["simctl", "ui", owned, "content_size", "large"]);
  await run("xcrun", hardwareKeyboardArguments(owned, false));
  if ((await installedApps(owned))[phoneBundle]) throw new Error(`${device}: the previous part's app survived its uninstall`);
};
// The library photo a part that chooses a photo picks.
const LIBRARY_PHOTO = "release-notes/pictures/activity-settles-setting-runs-light.png";
// A device's Photos is made ready once, from the device's start beside its first part: the wait for Photos to
// open its library since boot, then the library photo. INF-1170: the photo goes in once Photos is ready, so a
// restart of Photos never cuts its import short; INF-1438: and again after the restart that frees a photo
// Photos' background migration held. A part that chooses a photo waits for the whole of it.
const photosReady = (lane: Lane, stopping: AbortSignal) => lane.photos ??= (async () => {
  await photosOpened({ device: lane.owned, booting: lane.booted, stopping, env,
    evidence: values.both ? join(evidence, lane.device) : evidence, children, run, failureLog: SIMULATOR_LOG });
  await libraryPhotoAdded({ device: lane.owned, picture: join(REPO_ROOT, LIBRARY_PHOTO), run });
})();
// Builds once for any simulator, then runs each device's parts in order on the one simulator it starts
// for that device, each part as its own gate from that build with its own test home, the devices side
// by side, at most --simulators of them at once.
const everyPart = async () => {
  phoneXcode(await run("xcodebuild", ["-version"]));
  await run("xcodebuild", [...project, "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", join(root, "DerivedData"), `ARCHS=${process.arch === "x64" ? "x86_64" : "arm64"}`, "build-for-testing"]);
  const products = join(root, "DerivedData", "Build", "Products");
  const plans = readdirSync(products).filter((name) => name.endsWith(".xctestrun"));
  const [plan] = plans;
  if (!plan || plans.length !== 1) throw new Error(`The build made ${plans.length} test plans, not one`);
  // A --both run keeps a folder per device, as piece 1 did; each part writes its own folder in it.
  const folder = (device: PhoneDevice, part: string) => values.both ? join(evidence, device, part) : join(evidence, part);
  if (values.both) for (const device of devices) mkdirSync(join(evidence, device), { recursive: true });
  // INF-827: each part's minutes on each device, which a pull request's chooser reads from the
  // newest passing check of main (scripts/affected-phone.ts).
  const times: Record<string, Record<string, number>> = {};
  const gate = async ({ device, part }: { device: PhoneDevice; part: string }, lane: Lane, stopping: AbortSignal) => {
    const name = `${device} ${part}`;
    const began = Date.now();
    const minutes = () => ((Date.now() - began) / 60_000).toFixed(1);
    const ended = (outcome: "passed" | "stopped" | "failed") => {
      (times[part] ??= {})[device] = Date.now() - began;
      return { name, outcome };
    };
    console.log(`${name}: began at ${new Date(began).toISOString()}`);
    try {
      await readyForPart(lane, name);
      if (!values.waits && PHONE_PARTS.find((each) => each.name === part)?.photos) await photosReady(lane, stopping);
    } catch (error) {
      console.log(`${name}: ${(error as Error).message}`);
      console.log(`${name}: ${stopping.aborted ? "stopped after another part failed" : "failed before its tests"} after ${minutes()} minutes`);
      return ended(stopping.aborted ? "stopped" : "failed");
    }
    const command = [process.execPath, "scripts/test-phone.ts", ...(device === "ipad" ? ["--ipad"] : []),
      ...demo.childArgs, ...(values.waits ? ["--waits"] : []), "--part", part, "--evidence", folder(device, part),
      "--xctestrun", join(products, plan), "--simulator", lane.owned];
    if (values.starve) command.unshift("python3", "scripts/starve-check.py", "--timeout", "3600", "--stall-seconds", "12", "--");
    const child = spawn(command[0]!, command.slice(1), { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    // Another part failed: this one ends as an interrupted part does.
    let stopped = false;
    const stop = () => { stopped = true; child.kill("SIGTERM"); };
    stopping.addEventListener("abort", stop, { once: true });
    for (const stream of [child.stdout, child.stderr])
      createInterface({ input: stream }).on("line", (line) => console.log(`${name}: ${line}`));
    const status = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject); child.once("close", resolveExit);
    }).finally(() => { children.delete(child); stopping.removeEventListener("abort", stop); });
    console.log(`${name}: ${stopped ? "stopped after another part failed" : `ended with ${status}`} after ${minutes()} minutes`);
    return ended(status === 0 ? "passed" : stopped ? "stopped" : "failed");
  };
  // Any part failing fails the gate; with --stop-early the first failure stops the rest.
  const outcomes = await runDeviceLanes(jobs, simulators, {
    open: async (device, stopping) => {
      const lane = await startSimulator(device).catch((error: Error) => {
        throw new Error(`${device}: its simulator could not start, so none of its parts ran: ${error.message}`);
      });
      // Photos gets ready beside the device's first part; the device's first part that chooses a photo hears how it went.
      if (!values.waits && jobs.some((job) => job.device === device && PHONE_PARTS.find((each) => each.name === job.part)?.photos))
        photosReady(lane, stopping).catch(() => {});
      return lane;
    },
    run: gate,
    close: async ({ device, owned }) => {
      console.log(`${device}: deleting simulator ${owned}`);
      await deleteSimulator(owned);
    },
  }, values["stop-early"] ? (({ outcome }) => outcome === "failed") : undefined);
  const named = (outcome: string) => outcomes.filter((each) => each?.outcome === outcome).map((each) => each!.name);
  const [failed, stopped] = [named("failed"), named("stopped")];
  const unstarted = jobs.filter((_, index) => !outcomes[index]).map(({ device, part }) => `${device} ${part}`);
  // Only a full gate, every part on both devices run to its end, writes them.
  if (values.both && !values.part && !values.waits && !stopped.length && !unstarted.length)
    writeFileSync(join(evidence, "part-times.json"), `${JSON.stringify(times, null, 2)}\n`);
  if (failed.length) throw new Error([`The phone gate failed: ${failed.join(", ")}`,
    ...(stopped.length ? [`it stopped ${stopped.join(", ")}`] : []),
    ...(unstarted.length ? [`it never started ${unstarted.join(", ")}`] : []), `see its results in ${evidence}`].join("; "));
};
// A test plan copy beside the built one, naming this device's own test home.
const planFor = async (built: string, url: string) => {
  const plan = join(dirname(built), `${values.ipad ? "ipad" : "iphone"}-${values.part![0]}.xctestrun`);
  copyFileSync(built, plan);
  for (const key of testHomeKeys(JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", built])))) {
    await run("plutil", ["-replace", key, "-string", url, plan]);
    // Xcode does not inherit the launcher's environment into its test targets.
    await run("plutil", ["-replace", key.replace(/PHONE_TEST_HOME$/, "INFINITARY_PERF_BUDGETS"),
      "-string", GRADES_BUDGETS ? "1" : "0", plan]);
  }
  return plan;
};
// One part on the simulator the gate started for its device, with its own test home; the gate made the
// device clean before it and waited for Photos where the part chooses a photo.
const onePart = async () => {
  const owned = simulator!;
  keyboard = await observePhoneKeyboard({ simulator: owned, env, evidence, children });
  const { startPhoneHome } = await runner.import<typeof import("../tests/helpers/phoneHome")>(join(REPO_ROOT, "tests/helpers/phoneHome.ts"));
  await demo.prepare();
  fixture = await startPhoneHome(root, recording);
  writeFileSync(join(evidence, "published-client.json"), JSON.stringify(await fixture.checkPublishedClient(), null, 2));
  const destination = ["-parallel-testing-enabled", "NO", "-destination", `platform=iOS Simulator,id=${owned}`,
    "-resultBundlePath", join(evidence, "phone.xcresult")];
  const plan = await planFor(values.xctestrun!, fixture.url);
  // INF-1066: keep the talk journey's exact Photos/tap order and waits. Capture once
  // at the actual UIKit fault, while the blocked stack still exists, not on retry.
  if (values.part![0] === "talk") {
    timeoutStack = capturePhoneKeyboardTimeout({ evidence,
      currentPid: async () => phoneApplicationPid(await run("xcrun", ["simctl", "spawn", owned, "launchctl", "list"]), phoneBundle),
      sample: async (pid, destination) => { await run("/usr/bin/sample", [String(pid), "1", "1", "-mayDie", "-file", destination]); },
    });
  }
  simulatorLog = await observePhoneLog({ device: owned, env, evidence, children,
    predicate: `(${SIMULATOR_LOG}) OR (${SYSTEM_LOG})`, onLine: timeoutStack?.receive });
  const testing = new Date();
  let output = "";
  await run("xcodebuild", ["-xctestrun", plan, ...destination, ...partSelection(values.part![0]!, values.waits),
    ...phoneExecutionArguments(GRADES_BUDGETS), "test-without-building"])
    .then((log) => { output = log; })
    .finally(async () => { await recording.stop(); await demo.finish(recordings, evidence); })
    .catch(async (error: Error & { output?: string }) => {
      output = error.output ?? "";
      // The CI job log names why a part failed; its results archive is often too large to fetch.
      for (const line of (error.output ?? "").split("\n").filter((each) => / error: |Test Case .* failed/.test(each)).slice(0, 20))
        console.log(line);
      console.log("The pre-failure simulator log is kept in simulator-live.log, even if XCTest tore its domain down.");
      // INF-804: what the app, Photos and WebKit logged on this simulator, kept with the command logs.
      await run("xcrun", ["simctl", "spawn", owned, "log", "show", "--last", "20m", "--style", "compact", "--info",
        "--predicate", SIMULATOR_LOG])
        .then(() => console.log(`The simulator's log is in ${number}-xcrun.log`))
        .catch((problem: Error) => console.log(`The simulator's log could not be kept: ${problem.message}`));
      // INF-819: what the simulator's system logged from the part's first test to its failure, in its own log.
      await run("xcrun", ["simctl", "spawn", owned, "log", "show", "--start", logTime(testing), "--style", "compact",
        "--info", "--predicate", SYSTEM_LOG])
        .then(() => console.log(`The simulator's system log is in ${number}-xcrun.log`))
        .catch((problem: Error) => console.log(`The simulator's system log could not be kept: ${problem.message}`));
      throw error;
    })
    .finally(() => console.log(`XCTest animation waits that ran out: ${phoneAnimationWaits(output).missed}`));
  // INF-1541 piece 1: the native wait-clock tests launch no app, so only a journey part must say it skipped the wait.
  if (!values.waits && !phoneAnimationWaits(output).skipped)
    throw new Error(`The ${values.part![0]} part ran with XCTest's animation wait: its journey never printed "Phone animation wait skipped", so the hook in PhoneAnimationWait.swift is missing`);
};
let failures: string[] = [];
try {
  // A part skips these: its gate checked them once for every part.
  if (!values.xctestrun) {
    // INF-1596: a killed run never deleted its simulator or scratch folder; neither stops this gate.
    await removePhoneLeftovers(run, env).catch((error: Error) =>
      console.log(`Leftovers of earlier phone checks were not removed: ${error.message}`));
    // A failed check here is reported, and the simulator tests still run (INF-663).
    failures = await runEveryCheck([
      () => run("node", ["scripts/generate-phone-contract.ts", "--check"]),
      () => run("node", ["scripts/generate-phone-theme.ts", "--check"]),
      () => run("node", ["scripts/generate-phone-scene.ts", "--check"]),
      () => run("node", ["scripts/generate-phone-cards.ts", "--check"]),
      () => run("swift", ["test", "--package-path", "ios/Infinitary/InfinitaryKit", "--scratch-path", join(root, "swift-build")]),
    ], () => interrupted);
    for (const failure of failures) console.log(`::error::${failure}`);
  }
  await (values.xctestrun ? onePart() : everyPart());
  if (failures.length > 0) throw new Error(`The simulator tests passed, but ${failures.length} earlier check(s) failed: ${failures.join("; ")}`);
  console.log(values.waits ? `Native wait-clock tests passed on ${devices.join(" and ")}, with disposable simulators and homes.`
    : values.xctestrun ? `The ${values.part![0]} part passed on the gate's simulator and its own disposable Mac.`
    : `Every part passed on ${devices.join(" and ")}, each device started once and every part on its own disposable Mac.`);
} finally {
  cleaningUp = true;
  try {
    try {
      if (fixture) writeFileSync(join(evidence, "home-observations.json"), JSON.stringify(fixture.observations(), null, 2));
    } finally {
      try { await recording.stop(); }
      finally {
        try { await keyboard?.close(); }
        finally {
          try { await simulatorLog?.close(); }
          finally { await timeoutStack?.close(); }
        }
      }
    }
  } finally {
    try { await fixture?.close(); }
    finally {
      try {
        // A lane deletes its own simulator at its end; this catches one a failure left behind.
        for (const owned of [...ownedSimulators]) await deleteSimulator(owned).catch((error: Error) =>
          console.log(`The gate's simulator ${owned} could not be deleted: ${error.message}`));
      } finally {
        try { await runner.close(); }
        finally {
          // Keep activity visible through the scratch owner's filesystem teardown too.
          try { removeScratchDirs(); }
          finally {
            try { activity.close(); }
            finally { runPlace.close(); }
          }
        }
      }
    }
  }
}
