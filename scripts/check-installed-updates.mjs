import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { userDataFolderOf } from "../src/shared/userDataFolders.ts";
import { checkInstalledHomebrew } from "./check-installed-homebrew.mjs";
import { detachDiskImage, runInstallerCommand } from "./installer-command.ts";
import { installerHomebrewEnvironment, prepareInstallerHomebrew } from "./installer-homebrew.ts";
import { installStageRecorder, keepShipItLogs } from "./installer-update-trace.ts";
import { answeredHere, resolverAnswers, restoreHosts, routeHostsHere } from "./installer-hosts.ts";
import { removeScratchHome } from "./installer-app.ts";
import { makeTamperedCopy } from "./installer-tampered-copy.ts";
import { virtualMacSwitches } from "../tests/e2e/virtualMac.ts";

import { assertInstallerEnvironment, installerAppEnvironment, installerServerEnvironment } from "./installer-environment.ts";

// This probe owns the entire disposable guest, never the placement service's physical host.
assertInstallerEnvironment();
const fixtures = resolve(process.env.INSTALLER_FIXTURES);
const evidence = resolve(process.env.INSTALLER_EVIDENCE);
const work = join(process.env.RUNNER_TEMP, "installed-updates");
const home = join(work, "home");
const data = join(home, "Library/Application Support", userDataFolderOf("inf", "release"));
const legacy = join(home, "Library/Application Support", userDataFolderOf("fm", "release"));
const installed = "/Applications/Infinitary.app";
assert(!existsSync(installed), "The disposable Mac must have no Infinitary installation");
mkdirSync(join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
const versions = JSON.parse(readFileSync(join(fixtures, "versions.json"), "utf8"));
const source = JSON.parse(readFileSync("packaging/release-source.json", "utf8"));
const ownership = JSON.parse(readFileSync("packaging/mac-installation.json", "utf8"));
// The byte-tampered copy the "signature" download serves is made here, not uploaded.
checkpoint("Making the byte-tampered copy from the next alpha's verified zip");
await makeTamperedCopy(fixtures, versions.alphaAfter, work);
const { env: appEnv, launch: launchValues } = installerAppEnvironment(home, process.env);
assert.notEqual(spawnSync("/usr/bin/which", ["brew"], { env: appEnv }).status, 0);
function run(command, args, options = {}) {
  return runInstallerCommand(command, args, appEnv, options);
}
function record(check, result) {
  appendFileSync(join(evidence, "observed.jsonl"), `${JSON.stringify({ check, result, chip: process.arch })}\n`);
  console.log(`${check}: ${result}`);
}
function checkpoint(phase) {
  appendFileSync(join(evidence, "phases.jsonl"), `${JSON.stringify({ phase, chip: process.arch })}\n`);
  console.log(`Checking: ${phase}`);
}
async function bounded(name, action, timeout = 60_000) {
  checkpoint(name);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
const runner = await openModuleRunner();
const saved = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/savedWork.ts"));
const { readInstalledVersion } = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/readVersion.ts"));
const { resetMacDownloadCache } = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/downloadCache.ts"));
const { runningWorkFixture } = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/runningWork.ts"));
let runningWork;
const { UPDATE_CHANNEL_MARKER } = await runner.import(join(REPO_ROOT, "src/core/update/updateChannels.ts"));
let browser;
let appChild;
let server;
let mounted;
let hostsChanged = false;
let fixtureSha1;
let verificationFailed = false;
let bundleId;
const disabledBrew = [];
const launchEnvironment = new Map();
const executable = `${installed}/Contents/MacOS/Infinitary`;
const processPattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
const certificate = join(work, "loopback.pem");
const brewPath = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(path => existsSync(path));
const key = join(work, "loopback.key");
const trust = join(home, "verification-trust.keychain-db");
const systemKeychain = "/Library/Keychains/System.keychain";
const control = join(work, "feed.json");
const state = { alpha: versions.alphaAfter, stable: versions.promotedStable, mode: "normal" };
function feed(patch) { Object.assign(state, patch); writeFileSync(control, JSON.stringify(state)); }
function installedVersion() {
  return readInstalledVersion(installed, join(work, "observed-installation.asar"));
}
function bundleVersions() {
  return ["CFBundleVersion", "CFBundleShortVersionString"].map(name => run("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", join(installed, "Contents/Info.plist")]));
}
async function stopApp() {
  await bounded("Disconnecting application inspection", () => browser?.close(), 30_000).catch(error => record("Cleanup", error.message)); browser = undefined;
  appChild?.kill("SIGTERM");
  spawnSync("/usr/bin/pkill", ["-TERM", "-f", processPattern]);
  await expect.poll(() => spawnSync("/usr/bin/pgrep", ["-f", processPattern]).status, { timeout: 30_000 }).not.toBe(0);
  if (appChild && appChild.exitCode === null && appChild.signalCode === null) await bounded("Waiting for the launched app to exit", () => once(appChild, "exit"), 30_000);
  appChild = undefined;
}
async function launch(app = installed) {
  rmSync(join(data, "DevToolsActivePort"), { force: true });
  const log = openSync(join(evidence, "application.log"), "a");
  appChild = spawn(`${app}/Contents/MacOS/Infinitary`, ["--remote-debugging-port=0", ...virtualMacSwitches()], { env: appEnv, stdio: ["ignore", log, log] });
  closeSync(log);
  await expect.poll(() => existsSync(join(data, "DevToolsActivePort")), { timeout: 60_000 }).toBe(true);
  const port = readFileSync(join(data, "DevToolsActivePort"), "utf8").split("\n")[0];
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await expect.poll(() => browser.contexts()[0]?.pages().length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => typeof window.infinitary?.update?.status === "function");
  return page;
}
const status = page => bounded("Reading the installed app's update offer", async () => {
  const value = await page.evaluate(() => window.infinitary.update.status());
  writeFileSync(join(evidence, "update-status.json"), JSON.stringify(value, null, 2));
  return value;
});
const choose = (page, channel) => bounded(`Choosing ${channel}`, () => page.evaluate(channel => window.infinitary.update.setChannel(channel), channel));
const install = page => bounded("Waiting for an installation or refusal", () => page.evaluate(() => window.infinitary.update.install()), 180_000);
async function fresh(version, channel, legacyData = false) {
  await stopApp();
  rmSync(installed, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
  resetMacDownloadCache(home, join(REPO_ROOT, "packaging/app-update.yml"));
  saved.seedSavedWork(legacyData ? legacy : data);
  // Fresh copies must establish their own subscription; only migration seeds an explicit choice.
  if (legacyData) writeFileSync(join(legacy, UPDATE_CHANNEL_MARKER), JSON.stringify({ schemaVersion: 1, channel }));
  const dmg = join(fixtures, `Infinitary-${version}-mac-universal.dmg`);
  mounted = join(work, "image"); mkdirSync(mounted, { recursive: true });
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, dmg]);
  if (!existsSync(join(evidence, `installer-${channel}.png`))) {
    try {
      run("/usr/bin/open", ["-a", "Finder", mounted]);
      const bounds = run("/usr/bin/osascript", ["-e", 'tell application "Finder" to get bounds of front window'], { timeout: 10_000 }).split(",").map(Number);
      assert.equal(bounds.length, 4); assert(bounds.every(Number.isFinite));
      const [left, top, right, bottom] = bounds;
      run("/usr/sbin/screencapture", ["-x", "-R", `${left},${top},${right-left},${bottom-top}`, join(evidence, `installer-${channel}.png`)]);
    } catch (error) { record("Installer picture", `The isolated Finder capture was unavailable: ${error.message}`); }
  }
  run("/usr/bin/ditto", [join(mounted, "Infinitary.app"), installed]);
  bundleId ??= run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(installed, "Contents/Info.plist")]);
  assert.equal(run("/usr/bin/xattr", ["-p", ownership.attribute, join(installed, ownership.path)]), ownership.direct);
  detachDiskImage(mounted, appEnv); mounted = undefined;
  const page = await launch();
  const initial = await status(page);
  assert.equal(initial.problem, undefined, "The installed app must trust and read the fixture feed before preparing active work");
  assert.equal(initial.currentVersion, version);
  assert.equal(initial.channel, channel);
  assert(saved.savedWorkPresent(data));
  record(`Fresh ${channel} installation${legacyData ? " with the legacy handover" : ""}`, "The copied signed app runs and preserves the saved task and draft without Homebrew.");
  return page;
}
async function sampleInstall(page) {
  const running = pattern => spawnSync("/usr/bin/pgrep", ["-f", pattern]).status === 0;
  let phase = null, problem = null, timer;
  try {
    const value = await Promise.race([
      page.evaluate(() => window.infinitary.update.status()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer")), 2_000); }),
    ]);
    phase = value?.phase ?? null;
    problem = value?.problem === undefined ? null : JSON.stringify(value.problem);
  } catch { /* The page closes when the app quits to install. */ }
  finally { clearTimeout(timer); }
  let version = null;
  try { version = installedVersion(); } catch { /* ShipIt may be moving the bundle. */ }
  return { appRunning: running(processPattern), shipItRunning: running("/ShipIt( |$)"), installedVersion: version, phase, problem };
}
async function stalledInstall(page, label) {
  try {
    const value = await bounded("Reading the update status after the stalled installation", () => page.evaluate(() => window.infinitary.update.status()), 10_000);
    writeFileSync(join(evidence, `${label}-update-status.json`), JSON.stringify(value, null, 2));
  } catch (error) { record("Stalled installation status", `The app gave no status: ${error.message}`); }
  if (bundleId) record("Stalled installation ShipIt logs", JSON.stringify(keepShipItLogs(home, bundleId, evidence, label)));
  const system = spawnSync("/usr/bin/log", ["show", "--last", "10m", "--style", "compact", "--predicate", 'process == "ShipIt" OR process == "Infinitary" OR subsystem CONTAINS "Squirrel"'], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(evidence, `${label}-system.log`), `${system.stdout ?? ""}${system.stderr ?? ""}${system.error ? `\n${system.error.message}` : ""}`);
}
async function upgrade(page, version) {
  rmSync(`${control}.download`, { force: true });
  const offered = await status(page);
  assert.equal(offered.latestVersion, version); assert.equal(offered.updateAvailable, true);
  assert(!existsSync(`${control}.download`), "Checking must not download before consent");
  // Native replacement closes the transport. A reply is not used as proof of installation.
  void page.evaluate(() => window.infinitary.update.install()).catch(() => {});
  const label = `upgrade-${version}`;
  const stage = installStageRecorder(evidence, label);
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      stage(await sampleInstall(page));
      await new Promise(done => setTimeout(done, 2_000));
    }
  })();
  try { await expect.poll(installedVersion, { timeout: 180_000 }).toBe(version); }
  catch (error) { sampling = false; await sampler; await stalledInstall(page, label); throw error; }
  finally { sampling = false; await sampler; }
  await expect.poll(() => spawnSync("/usr/bin/pgrep", ["-f", processPattern]).status, { timeout: 60_000 }).toBe(0);
  record("Native signed replacement", `The installed bundle now contains ${version} and the app restarted.`);
  await stopApp();
  page = await launch(); // Reattach the inspection port, which macOS need not preserve on restart.
  const updated = await status(page);
  assert.equal(updated.currentVersion, version);
  assert.equal(updated.channelChoice, true);
  assert.equal(updated.problem, undefined);
  assert.equal(run("/usr/bin/xattr", ["-p", ownership.attribute, join(installed, ownership.path)]), ownership.direct);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
  assert(saved.savedWorkPresent(data));
  record("Direct ownership after replacement", "The installed replacement retained its direct receipt, valid signature and in-app channels.");
  return page;
}
try {
  assert(brewPath, "The disposable Mac must have Homebrew for the later signed-cask checks");
  checkpoint("Preparing the disposable Homebrew runtime before isolating network addresses");
  run(brewPath, ["ruby", "-e", "puts RUBY_VERSION"], { env: { ...appEnv, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1" }, timeout: 180_000 });
  const brewEnv = installerHomebrewEnvironment(appEnv, work);
  mkdirSync(brewEnv.HOMEBREW_TEMP, { recursive: true });
  checkpoint("Preparing Homebrew core before isolating network addresses");
  record("Homebrew prerequisite", JSON.stringify(prepareInstallerHomebrew(brewPath, brewEnv, run)));
  // Remove both standard entrypoints for this disposable run, not merely from our own PATH.
  for (const [index, path] of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].entries()) {
    if (existsSync(path)) {
      const backup = join(work, `brew-${index}`);
      run("/usr/bin/sudo", ["/bin/mv", path, backup]);
      disabledBrew.push({ path, backup });
    }
  }
  // A private local CA, trusted only on this disposable Mac. No production provider override
  // or weakened signature/checksum check enters the application build.
  writeFileSync(join(work, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Infinitary isolated installer verification\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature\nsubjectAltName=DNS:downloads.getinfinitary.com,DNS:github.com,DNS:raw.githubusercontent.com,IP:127.0.0.1\n");
  run("/usr/bin/openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-config", join(work, "openssl.cnf"), "-keyout", key, "-out", certificate]);
  chmodSync(key, 0o600);
  // Empty password: disposable public trust material, no signing secret in this keychain.
  run("/usr/bin/security", ["create-keychain", "-p", "", trust]);
  run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", trust]);
  assert(run("/usr/bin/security", ["list-keychains", "-d", "user"]).split("\n").some(line => line.trim().replace(/^"|"$/g, "") === trust), "The disposable trust keychain must be in the scratch user's persisted search list");
  // Chromium enumerates admin-trusted roots from the System keychain, not the user search list.
  // Keep the fingerprint before registration so a partially imported certificate can be removed.
  fixtureSha1 = new X509Certificate(readFileSync(certificate)).fingerprint.replaceAll(":", "");
  run("/usr/bin/sudo", ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", systemKeychain, certificate]);
  // security's successful dump, including certificate labels, is written to stdout.
  assert(run("/usr/bin/security", ["dump-trust-settings", "-d"]).includes("Infinitary isolated installer verification"), "Chromium's admin trust listing must include the fixture root");
  const rerouted = ["downloads.getinfinitary.com", "github.com", "raw.githubusercontent.com"];
  routeHostsHere(rerouted, work, run, () => { hostsChanged = true; });
  await expect.poll(() => resolverAnswers(rerouted), { timeout: 60_000, message: "The system resolver must answer every rerouted address with this Mac before a feed is read" }).toEqual(answeredHere(rerouted));
  for (const [name, value] of Object.entries(launchValues)) {
    launchEnvironment.set(name, spawnSync("/bin/launchctl", ["getenv", name], { encoding: "utf8" }).stdout?.trim());
    run("/bin/launchctl", ["setenv", name, value]);
  }
  feed({});
  const serverLog = openSync(join(evidence, "feed-server.log"), "a");
  server = spawn("/usr/bin/sudo", ["-E", process.execPath, "scripts/installer-feed-server.mjs", fixtures, control, certificate, key], { env: installerServerEnvironment(appEnv, process.env), stdio: ["ignore", serverLog, serverLog] });
  closeSync(serverLog);
  await expect.poll(() => existsSync(`${control}.ready`), { timeout: 20_000 }).toBe(true);

  checkpoint("Verifying HTTPS trust before launching the app");
  const feedUrl = `${source.downloadBase}feeds/alpha-mac.yml`;
  const preflight = JSON.parse(run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--max-time", "30", feedUrl]));
  assert.equal(preflight.version, versions.alphaAfter);
  record("Disposable HTTPS trust", "The system HTTPS reader verified the fixture certificate and read the expected Alpha feed without bypassing trust.");
  let page = await fresh(versions.alphaBefore, "alpha");
  checkpoint("Reading numeric bundle versions");
  const alphaBundleVersions = bundleVersions();
  assert.deepEqual(alphaBundleVersions, [versions.alphaBefore.split("-")[0], versions.alphaBefore.split("-")[0]]);
  runningWork = await runningWorkFixture(installedVersion, checkpoint);
  await bounded("Preparing active work", () => runningWork.start(page));
  await expect.poll(() => runningWork.started, { timeout: 60_000 }).toBe(true);
  page = await upgrade(page, versions.alphaAfter);
  assert.equal(runningWork.closedAtVersion, versions.alphaBefore);
  assert(runningWork.messageSurvived(data));
  assert.deepEqual(bundleVersions(), alphaBundleVersions);
  record("Logical alpha ordering", "The next alpha replaced its predecessor while both numeric bundle-version fields remained unchanged.");
  record("Running work during replacement", "The live provider stream closed before replacement, and the captain's message survived restart.");
  feed({ alpha: versions.promotedStable }); await choose(page, "alpha");
  page = await upgrade(page, versions.promotedStable);
  assert.equal((await status(page)).channel, "alpha");
  feed({ alpha: versions.nextAlpha }); await choose(page, "alpha");
  page = await upgrade(page, versions.nextAlpha);
  assert.equal((await status(page)).channel, "alpha");
  await choose(page, "stable");
  assert.equal((await status(page)).updateAvailable, false);
  assert.equal(installedVersion(), versions.nextAlpha);
  record("Alpha membership and safe channel switching", "Alpha survived a promoted stable, received the next alpha, and switching to stable did not downgrade.");

  page = await fresh(versions.promotedStable, "stable");
  feed({ stable: versions.nextStable, alpha: versions.nextAlpha }); await choose(page, "stable");
  page = await upgrade(page, versions.nextStable);
  assert.equal((await status(page)).channel, "stable");
  assert.equal((await status(page)).updateAvailable, false);
  record("Stable-only subscription", "Stable installed the next stable and never selected an alpha.");

  for (const mode of ["corrupt", "signature"]) {
    feed({ alpha: versions.alphaAfter, mode });
    page = await fresh(versions.alphaBefore, "alpha");
    const result = await install(page);
    assert.equal(result.ok, false); assert.equal(installedVersion(), versions.alphaBefore);
    assert(saved.savedWorkPresent(data));
    record(`Rejected ${mode} download`, "The old installed app and saved work remain intact.");
  }
  feed({ mode: "normal" });
  page = await fresh(versions.alphaBefore, "alpha");
  chmodSync(installed, 0o555);
  try { assert.equal((await install(page)).ok, false); }
  finally { chmodSync(installed, 0o755); }
  assert.equal(installedVersion(), versions.alphaBefore);
  record("Unwritable installation", "The updater refused replacement and kept the old app.");

  // That refusal withdraws Update and restart for the rest of the run (docs/alpha.md,
  // "Consent before replacement"), so the cancellation check needs a new run of the restored copy.
  await stopApp();
  page = await launch();
  feed({ mode: "pause" }); await choose(page, "alpha");
  rmSync(`${control}.download`, { force: true });
  const attempt = page.evaluate(() => window.infinitary.update.install());
  await expect.poll(() => existsSync(`${control}.download`), { timeout: 30_000 }).toBe(true);
  await choose(page, "stable");
  assert.equal((await bounded("Waiting for download cancellation", () => attempt)).ok, false); assert.equal(installedVersion(), versions.alphaBefore);
  record("Switch during download", "Changing channels cancelled the old download without installing it.");

  feed({ mode: "normal", alpha: versions.nextAlpha });
  page = await fresh(versions.promotedStable, "alpha", true);
  saved.assertSavedWorkMoved(legacy, data);
  assert.equal((await status(page)).channel, "alpha");
  await page.screenshot({ path: join(evidence, "installed-app.png") });
  record("Legacy saved work", "The handover finished, preserving the task, draft and Alpha choice; the original recovery copy remains intact and refused.");
  await stopApp();
  rmSync(data, { recursive: true, force: true });
  saved.seedSavedWork(data);
  writeFileSync(join(data, UPDATE_CHANNEL_MARKER), JSON.stringify({ schemaVersion: 1, channel: "alpha" }));
  mounted = join(work, "image");
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, join(fixtures, `Infinitary-${versions.alphaBefore}-mac-universal.dmg`)]);
  page = await launch(join(mounted, "Infinitary.app"));
  const readOnly = await install(page);
  assert.equal(readOnly.ok, false); assert.match(readOnly.problem, /Applications/);
  await stopApp();
  detachDiskImage(mounted, appEnv); mounted = undefined;
  record("Read-only disk image", "The running image refused an update and asked for an Applications installation.");
  // Homebrew returns only after the native path has proved it works without Homebrew.
  for (const { path, backup } of disabledBrew) run("/usr/bin/sudo", ["/bin/mv", backup, path]);
  disabledBrew.length = 0;
  await checkInstalledHomebrew({ runner, root: REPO_ROOT, work, home, data, installed, fixtures,
    versions, env: appEnv, brewPath, run, launch, stopApp, status, install, feed, record, checkpoint,
    saved, installedVersion });
  record("Download origin", `${new URL(source.downloadBase).hostname}, with its unchanged production HTTPS reader served locally for this proof only.`);
} catch (error) {
  verificationFailed = true;
  try { record("Verification failure", error.stack ?? String(error)); }
  finally { throw error; }
} finally {
  const cleanupErrors = [];
  async function cleanup(name, action) {
    try { await action(); }
    catch (error) {
      cleanupErrors.push(error);
      try { record("Cleanup", `${name}: ${error.stack ?? String(error)}`); }
      catch (recordError) { console.error("Could not record cleanup failure", name, error, recordError); }
    }
  }
  await cleanup("Recording cleanup", () => checkpoint("Cleaning up the disposable proof"));
  await cleanup("Stopping the app", () => stopApp());
  await cleanup("Detaching the disk image", () => { if (mounted) detachDiskImage(mounted, appEnv); });
  await cleanup("Stopping the fixture server", async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      // The HTTPS server was started through sudo; signal that exact disposable child
      // with the same privilege, and never hide a check failure behind an unbounded wait.
      const exited = once(server, "exit");
      try {
        run("/usr/bin/sudo", ["/bin/kill", "-TERM", String(server.pid)]);
        await bounded("Stopping the fixture HTTPS server", () => exited, 30_000);
      } catch (error) {
        record("Cleanup", error.message);
        run("/usr/bin/sudo", ["/bin/kill", "-KILL", String(server.pid)], { timeout: 10_000 });
        await bounded("Reaping the stopped fixture server", () => exited, 10_000);
      } finally { server.unref(); }
    }
  });
  await cleanup("Closing active work", () => bounded("Closing the active-work fixture", () => runningWork?.close(), 30_000));
  for (const [name, value] of launchEnvironment) {
    await cleanup(`Restoring launch environment ${name}`, () => {
      if (value) run("/bin/launchctl", ["setenv", name, value]); else run("/bin/launchctl", ["unsetenv", name]);
    });
  }
  await cleanup("Restoring hosts", () => { if (hostsChanged) restoreHosts(work, run); });
  // Removing the last admin trust record prompts for a password even as root. Delete only
  // this certificate; its admin record disappears when the entire hosted Mac is discarded.
  await cleanup("Deleting the fixture certificate", () => { if (fixtureSha1) run("/usr/bin/sudo", ["/usr/bin/security", "delete-certificate", "-Z", fixtureSha1, systemKeychain]); });
  await cleanup("Deleting the scratch keychain", () => { if (existsSync(trust)) run("/usr/bin/security", ["delete-keychain", trust]); });
  for (const { path, backup } of disabledBrew) await cleanup(`Restoring ${path}`, () => run("/usr/bin/sudo", ["/bin/mv", backup, path]));
  await cleanup("Removing the installed fixture", () => rmSync(installed, { recursive: true, force: true }));
  await cleanup("Closing the fixture module reader", () => bounded("Closing the fixture module reader", () => runner.close(), 30_000));
  await cleanup("Keeping ShipIt's logs", () => { if (bundleId) keepShipItLogs(home, bundleId, evidence, "final"); });
  // No copy of the saved database leaves this disposable proof. What another program wrote
  // into the home while it was removed stays with the disposable Mac, named (scripts/installer-app.ts).
  await cleanup("Removing the scratch home", () => {
    const left = removeScratchHome(home, [data, legacy]);
    if (left.length) record("Scratch home written while removed", `Another program wrote into the scratch home while it was removed; left for the disposable Mac: ${left.join(", ")}`);
  });
  if (!verificationFailed && cleanupErrors.length) throw new AggregateError(cleanupErrors, "Disposable proof cleanup failed");
}
