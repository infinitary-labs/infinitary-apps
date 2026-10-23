/** INF-64 piece 2's native gate: disposable real home, a fresh simulator, no signing. */
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { logTime, photosOpened } from "../tests/helpers/phonePhotos.ts";
import { observePhoneKeyboard, type PhoneChord, phoneApplicationPid, withPhoneHardwareKeyboard } from "../tests/helpers/phoneKeyboard.ts";
import { scratchDir } from "../tests/helpers/scratchDirs.ts";
import { ciModeRefusal } from "./checks-mode.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { runEveryCheck } from "./phone-checks.ts";
import { PHONE_PARTS, type PhoneDevice, partSelection, phoneJobs, runSideBySide, testHomeKeys } from "./phone-test-plan.ts";

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
  // INF-662 piece 1: check and build once, then the iPhone and the iPad side by side.
  both: { type: "boolean", default: false },
  // INF-662 piece 2: the journey's parts to run (all of them unless named), and how many simulators at once.
  part: { type: "string", multiple: true },
  simulators: { type: "string", default: "6" },
  // One part on one device: its test plan from the gate's build.
  xctestrun: { type: "string" },
} });
if (process.platform !== "darwin") throw new Error("The native gate needs Xcode on a Mac");
if (!values.evidence) throw new Error("Pass --evidence with a folder outside the working copy");
const evidence = resolve(values.evidence);
if (evidence === REPO_ROOT || evidence.startsWith(REPO_ROOT + "/"))
  throw new Error("Native evidence must stay outside the working copy");
if (values.both && (values.ipad || values.xctestrun)) throw new Error("--both runs the iPhone and the iPad itself");
if (values.xctestrun && values.part?.length !== 1) throw new Error("--xctestrun runs exactly one --part");
const devices: PhoneDevice[] = values.both ? ["iphone", "ipad"] : [values.ipad ? "ipad" : "iphone"];
const jobs = phoneJobs(devices, values.part ?? PHONE_PARTS.map((part) => part.name));
const simulators = Number(values.simulators);
mkdirSync(evidence, { recursive: true });
const root = scratchDir("infinitary-native-");
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.CFFIXED_USER_HOME = home;
process.env.PI_OFFLINE = "1";
process.env.INFINITARY_LOCAL_CODESIGN_DIR = join(home, "signing-unused");
const runner = await openModuleRunner();
const { hostEnv } = await runner.import<typeof import("../src/core/hostEnv")>(join(REPO_ROOT, "src/core/hostEnv.ts"));
const env = { ...hostEnv(), HOME: home, CFFIXED_USER_HOME: home };
let number = 0;
const children = new Set<ChildProcess>();
let interrupted = false;
let cleaningUp = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
});
const run = async (command: string, args: string[]) => {
  if (interrupted && !cleaningUp) throw new Error("The native gate was interrupted");
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
let simulator: string | undefined;
const phoneBundle = "com.getinfinitary.infinitary";
// The processes behind a failed part's photo and card steps: the app, its card pages and Photos.
const SIMULATOR_LOG = 'process == "Infinitary" OR process BEGINSWITH "com.apple.WebKit" OR process CONTAINS[c] "photo"'
  + ' OR process == "assetsd" OR process == "mediaanalysisd"'
  + ' OR (process == "runningboardd" AND (eventMessage CONTAINS "WebKit" OR eventMessage CONTAINS "Infinitary"))';
// INF-819: the simulator's own system, keyboard and accessibility processes, which answer XCUITest's
// "Check for interrupting elements"; on a few iPhone talk parts they stopped answering after a keyboard switch.
const SYSTEM_LOG = 'process IN {"SpringBoard", "backboardd", "AccessibilityUIServer", "testmanagerd", "kbd"}'
  + ' OR process ENDSWITH "-Runner" OR subsystem BEGINSWITH[c] "com.apple.accessibility"';
let keyboard: Awaited<ReturnType<typeof observePhoneKeyboard>> | undefined;
let recorder: ChildProcess | undefined;
let recorded: Promise<void> | undefined;
let recordingLog = "";
const recordings: { name: string; raw: string }[] = [];
const recording = {
  keyboardBeforeLaunch: async () => {
    if (!keyboard) throw new Error("No owned simulator keyboard observer exists");
    return keyboard.beforeLaunch();
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
  display: async (appearance: "light" | "dark", large: boolean) => {
    if (!simulator) throw new Error("No owned simulator exists");
    await run("xcrun", ["simctl", "ui", simulator, "appearance", appearance]);
    await run("xcrun", ["simctl", "ui", simulator, "content_size", large ? "extra-extra-extra-large" : "large"]);
  },
  appearance: async (theme: "dark" | "light") => {
    if (!simulator) throw new Error("No owned simulator exists");
    await run("xcrun", ["simctl", "ui", simulator, "appearance", theme]);
  },
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
    if (!values.demo || recorder || !simulator) return;
    if (!["reconnect", "talk", "composer", "character", "conversation", "card-form", "card-paging", "card-reply", "card-picture", "card-recording", "review-recovery"].includes(name)) throw new Error("Unknown phone recording");
    const raw = join(root, `${name}.mp4`);
    recordings.push({ name, raw });
    recordingLog = "";
    const child = spawn("xcrun", ["simctl", "io", simulator, "recordVideo", "--codec=h264", raw], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    recorder = child;
    recorded = new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
    await new Promise<void>((resolveStarted, reject) => {
      const timeout = setTimeout(() => reject(new Error("The simulator recorder did not start")), 15_000);
      const hear = (part: Buffer) => {
        recordingLog += part.toString();
        if (recordingLog.includes("Recording started")) { clearTimeout(timeout); resolveStarted(); }
      };
      child.stdout?.on("data", hear); child.stderr?.on("data", hear);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => {
        clearTimeout(timeout);
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
// Builds once for any simulator, then runs each part on each device as its own gate from that
// build, with its own simulator and test home, at most --simulators at once.
const everyPart = async () => {
  await run("xcodebuild", [...project, "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", join(root, "DerivedData"), `ARCHS=${process.arch === "x64" ? "x86_64" : "arm64"}`, "build-for-testing"]);
  const products = join(root, "DerivedData", "Build", "Products");
  const plans = readdirSync(products).filter((name) => name.endsWith(".xctestrun"));
  const [plan] = plans;
  if (!plan || plans.length !== 1) throw new Error(`The build made ${plans.length} test plans, not one`);
  // A --both run keeps a folder per device, as piece 1 did; each part writes its own folder in it.
  const folder = (device: PhoneDevice, part: string) => values.both ? join(evidence, device, part) : join(evidence, part);
  // INF-827: each part's minutes on each device, which a pull request's chooser reads from the
  // newest passing check of main (scripts/affected-phone.ts).
  const times: Record<string, Record<string, number>> = {};
  const gate = async ({ device, part }: { device: PhoneDevice; part: string }) => {
    const name = `${device} ${part}`;
    const began = Date.now();
    console.log(`${name}: began at ${new Date(began).toISOString()}`);
    const child = spawn(process.execPath, ["scripts/test-phone.ts", ...(device === "ipad" ? ["--ipad"] : []),
      ...(values.demo ? ["--demo"] : []), "--part", part, "--evidence", folder(device, part), "--xctestrun", join(products, plan)],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    for (const stream of [child.stdout, child.stderr])
      createInterface({ input: stream }).on("line", (line) => console.log(`${name}: ${line}`));
    const status = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject); child.once("close", resolveExit);
    }).finally(() => children.delete(child));
    console.log(`${name}: ended with ${status} after ${((Date.now() - began) / 60_000).toFixed(1)} minutes`);
    (times[part] ??= {})[device] = Date.now() - began;
    return status === 0 ? [] : [name];
  };
  // No part stops another; any part failing fails the gate.
  const failed = (await runSideBySide(jobs, simulators, gate)).flat();
  // Only a full gate, every part on both devices, writes them.
  if (values.both && !values.part) writeFileSync(join(evidence, "part-times.json"), `${JSON.stringify(times, null, 2)}\n`);
  if (failed.length) throw new Error(`The phone gate failed: ${failed.join(", ")}; see its results in ${evidence}`);
};
// A test plan copy beside the built one, naming this device's own test home.
const planFor = async (built: string, url: string) => {
  const plan = join(dirname(built), `${values.ipad ? "ipad" : "iphone"}-${values.part![0]}.xctestrun`);
  copyFileSync(built, plan);
  for (const key of testHomeKeys(JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", built]))))
    await run("plutil", ["-replace", key, "-string", url, plan]);
  return plan;
};
const onePart = async () => {
  // Do not borrow or erase a developer's simulator. Own exactly one, from create to delete.
  const catalog = JSON.parse(await run("xcrun", ["simctl", "list", "--json"]));
  const runtime = catalog.runtimes.filter((item: { identifier: string; isAvailable: boolean; version: string }) =>
    item.isAvailable && item.identifier.includes(".iOS-") && Number(item.version.split(".")[0]) >= 18)
    .sort((a: { version: string }, b: { version: string }) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const device = catalog.devicetypes.find((item: { name: string }) => item.name === (values.ipad ? "iPad Pro 11-inch (M4)" : "iPhone 16"));
  if (!runtime || !device) throw new Error("Install an iOS 18 or newer simulator runtime and the requested device type in Xcode");
  simulator = (await run("xcrun", ["simctl", "create", "Infinitary isolated test", device.identifier, runtime.identifier])).trim();
  // CoreSimulator is a host service, not a signing operation. This new device owns its own Keychain.
  const booting = new Date();
  await run("xcrun", ["simctl", "bootstatus", simulator, "-b"]);
  await run("xcrun", ["simctl", "addmedia", simulator, join(REPO_ROOT, "release-notes/pictures/activity-settles-setting-runs-light.png")]);
  // Photos opens its libraries while the rest of the part gets ready; the part's tests start once it has.
  const photos = PHONE_PARTS.find((part) => part.name === values.part![0])?.photos
    ? photosOpened({ device: simulator, booting, env, evidence, children, run, failureLog: SIMULATOR_LOG }) : undefined;
  photos?.catch(() => {});
  keyboard = await observePhoneKeyboard({ simulator, env, evidence, children });
  const { startPhoneHome } = await runner.import<typeof import("../tests/helpers/phoneHome")>(join(REPO_ROOT, "tests/helpers/phoneHome.ts"));
  if (values.demo) await run("ffmpeg", ["-version"]);
  fixture = await startPhoneHome(root, recording);
  writeFileSync(join(evidence, "published-client.json"), JSON.stringify(await fixture.checkPublishedClient(), null, 2));
  const destination = ["-parallel-testing-enabled", "NO", "-destination", `platform=iOS Simulator,id=${simulator}`,
    "-resultBundlePath", join(evidence, "phone.xcresult")];
  const plan = await planFor(values.xctestrun!, fixture.url);
  await photos;
  const testing = new Date();
  await run("xcodebuild", ["-xctestrun", plan, ...destination, ...partSelection(values.part![0]!), "test-without-building"])
    .catch(async (error: Error & { output?: string }) => {
      // The CI job log names why a part failed; its results archive is often too large to fetch.
      for (const line of (error.output ?? "").split("\n").filter((each) => / error: |Test Case .* failed/.test(each)).slice(0, 20))
        console.log(line);
      // INF-804: what the app, Photos and WebKit logged on this simulator, kept with the command logs.
      await run("xcrun", ["simctl", "spawn", simulator!, "log", "show", "--last", "20m", "--style", "compact", "--info",
        "--predicate", SIMULATOR_LOG])
        .then(() => console.log(`The simulator's log is in ${number}-xcrun.log`))
        .catch((problem: Error) => console.log(`The simulator's log could not be kept: ${problem.message}`));
      // INF-819: what the simulator's system logged from the part's first test to its failure, in its own log.
      await run("xcrun", ["simctl", "spawn", simulator!, "log", "show", "--start", logTime(testing), "--style", "compact",
        "--info", "--predicate", SYSTEM_LOG])
        .then(() => console.log(`The simulator's system log is in ${number}-xcrun.log`))
        .catch((problem: Error) => console.log(`The simulator's system log could not be kept: ${problem.message}`));
      throw error;
    });
  if (values.demo) for (const { name, raw } of recordings) {
    const crop = name === "reconnect" ? "crop=iw:trunc(ih*0.55/2)*2:0:0," : "";
    await run("ffmpeg", ["-y", "-i", raw, "-vf", `${crop}scale=-2:720,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,tpad=stop_mode=clone:stop_duration=5`, "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, `${name}.mp4`)]);
    await run("ffmpeg", ["-y", "-sseof", "-0.25", "-i", join(evidence, `${name}.mp4`), "-frames:v", "1", join(evidence, `${name}-poster.png`)]);
  }
};
let failures: string[] = [];
try {
  // A part skips these: its gate checked them once for every part.
  if (!values.xctestrun) {
    // A failed check here is reported, and the simulator tests still run (INF-663).
    failures = await runEveryCheck([
      () => run("node", ["scripts/generate-phone-contract.ts", "--check"]),
      () => run("node", ["scripts/generate-phone-theme.ts", "--check"]),
      () => run("node", ["scripts/generate-phone-cards.ts", "--check"]),
      () => run("swift", ["test", "--package-path", "ios/Infinitary/InfinitaryKit", "--scratch-path", join(root, "swift-build")]),
    ], () => interrupted);
    for (const failure of failures) console.log(`::error::${failure}`);
  }
  await (values.xctestrun ? onePart() : everyPart());
  if (failures.length > 0) throw new Error(`The simulator tests passed, but ${failures.length} earlier check(s) failed: ${failures.join("; ")}`);
  console.log(values.xctestrun ? `The ${values.part![0]} part passed on its own simulator and disposable Mac.`
    : `Every part passed on ${devices.join(" and ")}, each on its own simulator and disposable Mac.`);
} finally {
  cleaningUp = true;
  try {
    try {
      if (fixture) writeFileSync(join(evidence, "home-observations.json"), JSON.stringify(fixture.observations(), null, 2));
    } finally {
      try { await recording.stop(); }
      finally { await keyboard?.close(); }
    }
  } finally {
    try { await fixture?.close(); }
    finally {
      try {
        if (simulator) {
          await run("xcrun", ["simctl", "shutdown", simulator]).catch(() => {});
          await run("xcrun", ["simctl", "delete", simulator]);
        }
      } finally { await runner.close(); }
    }
  }
}
