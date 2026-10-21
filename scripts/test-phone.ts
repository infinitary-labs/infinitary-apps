/** INF-64 piece 2's native gate: disposable real home, a fresh simulator, no signing. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { observePhoneKeyboard, type PhoneChord, phoneApplicationPid, withPhoneHardwareKeyboard } from "../tests/helpers/phoneKeyboard.ts";
import { scratchDir } from "../tests/helpers/scratchDirs.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { runEveryCheck } from "./phone-checks.ts";

const { values } = parseArgs({ options: {
  evidence: { type: "string" },
  ipad: { type: "boolean", default: false },
  demo: { type: "boolean", default: false },
} });
if (process.platform !== "darwin") throw new Error("The native gate needs Xcode on a Mac");
if (!values.evidence) throw new Error("Pass --evidence with a folder outside the working copy");
const evidence = resolve(values.evidence);
if (evidence === REPO_ROOT || evidence.startsWith(REPO_ROOT + "/"))
  throw new Error("Native evidence must stay outside the working copy");
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
  if (status !== 0) throw new Error(`${command} failed (${status}); see ${log}`);
  return output;
};
let simulator: string | undefined;
const phoneBundle = "com.getinfinitary.infinitary";
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
try {
  // A failed check here is reported, and the simulator tests still run (INF-663).
  const failures = await runEveryCheck([
    () => run("node", ["scripts/generate-phone-contract.ts", "--check"]),
    () => run("node", ["scripts/generate-phone-theme.ts", "--check"]),
    () => run("node", ["scripts/generate-phone-cards.ts", "--check"]),
    () => run("swift", ["test", "--package-path", "ios/Infinitary/InfinitaryKit", "--scratch-path", join(root, "swift-build")]),
  ], () => interrupted);
  for (const failure of failures) console.log(`::error::${failure}`);
  // Do not borrow or erase a developer's simulator. Own exactly one, from create to delete.
  const catalog = JSON.parse(await run("xcrun", ["simctl", "list", "--json"]));
  const runtime = catalog.runtimes.filter((item: { identifier: string; isAvailable: boolean; version: string }) =>
    item.isAvailable && item.identifier.includes(".iOS-") && Number(item.version.split(".")[0]) >= 18)
    .sort((a: { version: string }, b: { version: string }) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const device = catalog.devicetypes.find((item: { name: string }) => item.name === (values.ipad ? "iPad Pro 11-inch (M4)" : "iPhone 16"));
  if (!runtime || !device) throw new Error("Install an iOS 18 or newer simulator runtime and the requested device type in Xcode");
  simulator = (await run("xcrun", ["simctl", "create", "Infinitary isolated test", device.identifier, runtime.identifier])).trim();
  // CoreSimulator is a host service, not a signing operation. This new device owns its own Keychain.
  await run("xcrun", ["simctl", "bootstatus", simulator, "-b"]);
  await run("xcrun", ["simctl", "addmedia", simulator, join(REPO_ROOT, "release-notes/pictures/activity-settles-setting-runs-light.png")]);
  keyboard = await observePhoneKeyboard({ simulator, env, evidence, children });
  const { startPhoneHome } = await runner.import<typeof import("../tests/helpers/phoneHome")>(join(REPO_ROOT, "tests/helpers/phoneHome.ts"));
  if (values.demo) await run("ffmpeg", ["-version"]);
  fixture = await startPhoneHome(root, recording);
  writeFileSync(join(evidence, "published-client.json"), JSON.stringify(await fixture.checkPublishedClient(), null, 2));
  await run("xcodebuild", ["-project", "ios/Infinitary/Infinitary.xcodeproj", "-scheme", "Infinitary",
    "-xcconfig", "ios/Infinitary/SimulatorTests.xcconfig", "-parallel-testing-enabled", "NO",
    "-destination", `platform=iOS Simulator,id=${simulator}`, "-derivedDataPath", join(root, "DerivedData"),
    "-resultBundlePath", join(evidence, "phone.xcresult"), `PHONE_TEST_HOME=${fixture.url}`, "test"]);
  if (values.demo) for (const { name, raw } of recordings) {
    const crop = name === "reconnect" ? "crop=iw:trunc(ih*0.55/2)*2:0:0," : "";
    await run("ffmpeg", ["-y", "-i", raw, "-vf", `${crop}scale=-2:720,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,tpad=stop_mode=clone:stop_duration=5`, "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, `${name}.mp4`)]);
    await run("ffmpeg", ["-y", "-sseof", "-0.25", "-i", join(evidence, `${name}.mp4`), "-frames:v", "1", join(evidence, `${name}-poster.png`)]);
  }
  if (failures.length > 0) throw new Error(`The simulator tests passed, but ${failures.length} earlier check(s) failed: ${failures.join("; ")}`);
  console.log("The phone joined its disposable Mac, read its cards and Activity, reconnected, left and was removed.");
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
