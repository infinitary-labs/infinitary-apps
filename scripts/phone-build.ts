/**
 * INF-6039's plan, part 1: one phone app build for testing, shared among the jobs of one phone check.
 *
 * A dealt request's first job builds the app for testing in a step of its own (`node scripts/phone-build.ts --out
 * <folder>`) and shares the folder as an artifact of its run; a job of the same check that starts after that looks for
 * it and uses it only when it was built from this very version, from a checkout with no changes, with the same Xcode,
 * simulator SDK and chip, and its archive is whole (`phoneBuildRefusal`, `useSharedPhoneBuild`). Anything else, a
 * missing build included, and the job builds the app itself, as every job did before.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ciModeRefusal } from "./checks-mode.ts";
import { phoneXcode } from "./phone-simulator.ts";

/** The archive of the built products and the record of what they were built from, side by side in a shared folder. */
export const PHONE_BUILD_ARCHIVE = "phone-build.tar";
export const PHONE_BUILD_MANIFEST = "phone-build.json";

/** What a build for testing is made from: the checked-out version and whether it has changes, Xcode, the SDK, the chip. */
export type PhoneBuildIdentity = { commit: string; clean: boolean; xcode: string; sdk: string; arch: string };
/** A shared build's record: its identity, its test plan's file name and its archive's SHA-256. */
export type PhoneBuildManifest = PhoneBuildIdentity & { plan: string; sha256: string };
/** Runs a command in the working copy and answers its output. */
export type PhoneBuildRun = (command: string, args: string[]) => Promise<string>;

/** The one build-for-testing command every phone check runs, whether a job builds for itself or for its check. */
export function phoneBuildArguments(derivedData: string, packageCache: string, arch: string = process.arch): string[] {
  return ["-project", "ios/Infinitary/Infinitary.xcodeproj", "-scheme", "Infinitary", "-xcconfig", "ios/Infinitary/SimulatorTests.xcconfig",
    "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derivedData, "-packageCachePath", packageCache,
    `ARCHS=${arch === "x64" ? "x86_64" : "arm64"}`, "build-for-testing"];
}

/**
 * This working copy's identity, read from git and Xcode. The checkout counts as changed when a tracked file differs
 * from its commit or the phone app's folder holds a file git does not track, since Xcode builds every file there.
 */
export async function readPhoneBuildIdentity(run: PhoneBuildRun, xcode?: string): Promise<PhoneBuildIdentity> {
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  const changes = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).trim()
    + (await run("git", ["status", "--porcelain", "--untracked-files=all", "--", "ios"])).trim();
  return { commit, clean: changes === "", xcode: (xcode ?? await run("xcodebuild", ["-version"])).trim(),
    sdk: (await run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-build-version"])).trim(), arch: process.arch };
}

/** Why a shared build must not stand in for this job's own build, or undefined when it may. */
export function phoneBuildRefusal(shared: unknown, own: PhoneBuildIdentity): string | undefined {
  if (!own.clean) return `this checkout of ${own.commit} has changes a shared build would not hold`;
  const record = shared as Partial<PhoneBuildManifest> | undefined;
  if (!record || typeof record !== "object" || typeof record.plan !== "string" || typeof record.sha256 !== "string")
    return "its record is unreadable";
  if (record.clean !== true) return `it was built from a checkout of ${record.commit} with changes`;
  if (record.commit !== own.commit) return `it was built from ${record.commit}, not this version ${own.commit}`;
  if (record.xcode !== own.xcode) return `it was built with ${JSON.stringify(record.xcode)}, not ${JSON.stringify(own.xcode)}`;
  if (record.sdk !== own.sdk) return `it was built with simulator SDK ${record.sdk}, not ${own.sdk}`;
  if (record.arch !== own.arch) return `it was built for ${record.arch}, not ${own.arch}`;
  return undefined;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Keeps the built products folder whole, with its test plan's name and the build's identity, in `out` for the check's
 * other jobs. Whole, since Xcode's test plan names the whole configuration folder its tests load libraries from.
 */
export async function keepPhoneBuild(products: string, plan: string, identity: PhoneBuildIdentity, out: string,
  run: PhoneBuildRun): Promise<PhoneBuildManifest> {
  if (!existsSync(join(products, plan))) throw new Error(`The build's products hold no test plan ${plan}`);
  mkdirSync(out, { recursive: true });
  const archive = join(out, PHONE_BUILD_ARCHIVE);
  await run("tar", ["-cf", archive, "-C", products, "."]);
  const manifest: PhoneBuildManifest = { ...identity, plan, sha256: await sha256(archive) };
  writeFileSync(join(out, PHONE_BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Unpacks the shared build in `shared` into `products` when it may stand in for this job's own build, and answers
 * its test plan's file name; otherwise answers why not, having unpacked nothing.
 */
export async function useSharedPhoneBuild(shared: string, products: string, own: PhoneBuildIdentity,
  run: PhoneBuildRun): Promise<{ plan: string } | { refusal: string }> {
  const record = join(shared, PHONE_BUILD_MANIFEST);
  if (!existsSync(record)) return { refusal: "this check's first job has not shared its build yet" };
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(record, "utf8")); }
  catch { return { refusal: "its record is unreadable" }; }
  const refusal = phoneBuildRefusal(manifest, own);
  if (refusal) return { refusal };
  const { plan, sha256: expected } = manifest as PhoneBuildManifest;
  const archive = join(shared, PHONE_BUILD_ARCHIVE);
  if (!existsSync(archive)) return { refusal: "its archive is missing" };
  const actual = await sha256(archive);
  if (actual !== expected) return { refusal: `its archive's SHA-256 is ${actual}, not the ${expected} its first job recorded` };
  mkdirSync(products, { recursive: true });
  await run("tar", ["-xf", archive, "-C", products]);
  if (!existsSync(join(products, plan))) throw new Error(`The shared build's archive holds no test plan ${plan}`);
  return { plan };
}

// The first job's own step: build once, as the gate would, and keep the build for the check's other jobs. The
// build's whole output goes to a log in the evidence folder, as the gate's does; its errors and warnings go to the step.
async function main() {
  const refusal = ciModeRefusal("phone");
  if (refusal) throw new Error(refusal);
  const { values } = parseArgs({ options: { out: { type: "string" }, evidence: { type: "string" } } });
  if (process.platform !== "darwin") throw new Error("The phone build needs Xcode on a Mac");
  if (!values.out || !values.evidence) throw new Error("Pass --out with the folder to keep the shared build in and --evidence for its log");
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "phone-build-"));
  // As the gate builds: a disposable home, and the Swift packages CI restores or a folder of the build's own.
  const home = join(scratch, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home };
  const run: PhoneBuildRun = (command, args) => new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stdout}${stderr}`));
      else resolveRun(stdout);
    });
  });
  const xcode = await run("xcodebuild", ["-version"]);
  phoneXcode(xcode);
  const identity = await readPhoneBuildIdentity(run, xcode);
  // A checkout with changes shares nothing, and every job of the check, this one included, builds for itself.
  if (!identity.clean) {
    console.log(`::notice::This checkout of ${identity.commit} has changes, so no build is shared; each job builds the app itself.`);
    return;
  }
  const derivedData = join(scratch, "DerivedData");
  const packageCache = process.env.INFINITARY_PHONE_PACKAGE_CACHE || join(scratch, "swift-packages");
  mkdirSync(values.evidence, { recursive: true });
  const log = join(resolve(values.evidence), "shared-build-xcodebuild.log");
  const building = Date.now();
  const status = await new Promise<number | null>((resolveBuild, reject) => {
    const child = spawn("xcodebuild", phoneBuildArguments(derivedData, packageCache), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const file = createWriteStream(log);
    for (const stream of [child.stdout, child.stderr]) {
      stream.pipe(file, { end: false });
      createInterface({ input: stream }).on("line", (line) => { if (/error:|warning:|\*\* .* \*\*/.test(line)) console.log(line); });
    }
    child.once("error", reject);
    child.once("close", (code) => file.end(() => resolveBuild(code)));
  });
  if (status !== 0) throw new Error(`The phone app's build for testing failed (${status}); its whole output is in ${log}`);
  console.log(`Built the app for testing in ${((Date.now() - building) / 60_000).toFixed(1)} minutes`);
  const products = join(derivedData, "Build", "Products");
  const plans = readdirSync(products).filter((name) => name.endsWith(".xctestrun"));
  const [plan] = plans;
  if (!plan || plans.length !== 1) throw new Error(`The build made ${plans.length} test plans, not one`);
  const manifest = await keepPhoneBuild(products, plan, identity, resolve(values.out), run);
  console.log(`Kept the build of ${manifest.commit} (${manifest.xcode.replace(/\n/g, ", ")}, simulator SDK ${manifest.sdk}, ${manifest.arch}) `
    + `for this check's other jobs, archive SHA-256 ${manifest.sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
