import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, chmodSync, closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { userDataFolderOf } from "../src/shared/userDataFolders.ts";
import { runInstallerCommand } from "./installer-command.ts";
import { installStageRecorder, keepShipItLogs } from "./installer-update-trace.ts";
import { answeredHere, resolverAnswers, restoreHosts, routeHostsHere } from "./installer-hosts.ts";
import { virtualMacSwitches } from "../tests/e2e/virtualMac.ts";
import { assertInstallerEnvironment, installerAppEnvironment, installerServerEnvironment } from "./installer-environment.ts";

// INF-1900 direction D: the release's update check. A disposable Mac installs the
// version alpha subscribers have now, from its public disk image, and updates it
// through a local copy of the alpha feed, and the release's own signed zip
// (UPDATE_TARGET_ZIP) must replace it.
assertInstallerEnvironment();
const evidence = resolve(process.env.INSTALLER_EVIDENCE);
const target = process.env.UPDATE_TARGET_VERSION;
assert.match(target ?? "", /^\d+\.\d+\.\d+(-alpha\.\d+)?$/, "UPDATE_TARGET_VERSION must name the release's version");
assert(process.env.UPDATE_TARGET_ZIP, "UPDATE_TARGET_ZIP must name the release's own signed zip");
const targetZip = resolve(process.env.UPDATE_TARGET_ZIP);
const work = join(process.env.RUNNER_TEMP, "update-from-alpha");
const fixtures = join(work, "feed");
const home = join(work, "home");
const data = join(home, "Library/Application Support", userDataFolderOf("inf", "release"));
const installed = "/Applications/Infinitary.app";
const draft = { path: join(data, "personal-workspace", "installation-guide.md"), text: "Keep the introduction and the annotated installation notes.\n" };
assert(!existsSync(installed), "The disposable Mac must have no Infinitary installation");
mkdirSync(join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
mkdirSync(fixtures, { recursive: true });
mkdirSync(evidence, { recursive: true });
const source = JSON.parse(readFileSync("packaging/release-source.json", "utf8"));
const ownership = JSON.parse(readFileSync("packaging/mac-installation.json", "utf8"));
const { env: appEnv, launch: launchValues } = installerAppEnvironment(home, process.env);
function run(command, args, options = {}) {
  return runInstallerCommand(command, args, appEnv, options);
}
function record(check, result) {
  appendFileSync(join(evidence, "observed.jsonl"), `${JSON.stringify({ check, result, chip: process.arch })}\n`);
  console.log(`${check}: ${result}`);
}
async function bounded(name, action, timeout = 60_000) {
  appendFileSync(join(evidence, "phases.jsonl"), `${JSON.stringify({ phase: name, chip: process.arch })}\n`);
  console.log(`Checking: ${name}`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function digest(path) {
  const sha256 = createHash("sha256"); const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); }
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64"), size: statSync(path).size };
}
const runner = await openModuleRunner();
const { readInstalledVersion } = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/readVersion.ts"));
const { runningWorkFixture } = await runner.import(join(REPO_ROOT, "tests/fixtures/installed-updates/runningWork.ts"));
// The updater's own YAML reader, the one the installed app parses its feed with.
const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve("electron-updater/package.json"))("js-yaml");
let browser;
let appChild;
let server;
let mounted;
let runningWork;
let hostsChanged = false;
let fixtureSha1;
let verificationFailed = false;
let bundleId;
const launchEnvironment = new Map();
const executable = `${installed}/Contents/MacOS/Infinitary`;
const processPattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
const certificate = join(work, "loopback.pem");
const key = join(work, "loopback.key");
const trust = join(home, "verification-trust.keychain-db");
const systemKeychain = "/Library/Keychains/System.keychain";
const control = join(work, "feed.json");
function installedVersion() {
  return readInstalledVersion(installed, join(work, "observed-installation.asar"));
}
async function stopApp() {
  await bounded("Disconnecting application inspection", () => browser?.close(), 30_000).catch(error => record("Cleanup", error.message)); browser = undefined;
  appChild?.kill("SIGTERM");
  spawnSync("/usr/bin/pkill", ["-TERM", "-f", processPattern]);
  await expect.poll(() => spawnSync("/usr/bin/pgrep", ["-f", processPattern]).status, { timeout: 30_000 }).not.toBe(0);
  if (appChild && appChild.exitCode === null && appChild.signalCode === null) await bounded("Waiting for the launched app to exit", () => once(appChild, "exit"), 30_000);
  appChild = undefined;
}
async function launch() {
  rmSync(join(data, "DevToolsActivePort"), { force: true });
  const log = openSync(join(evidence, "application.log"), "a");
  appChild = spawn(executable, ["--remote-debugging-port=0", ...virtualMacSwitches()], { env: appEnv, stdio: ["ignore", log, log] });
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
try {
  // While the real download origin is still reachable: what alpha subscribers have now.
  const feedUrl = `${source.downloadBase}feeds/alpha-mac.yml`;
  const published = load(run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--retry", "5", "--retry-delay", "15", "--retry-all-errors", "--max-time", "60", feedUrl]));
  const from = published?.version;
  assert.match(from ?? "", /^\d+\.\d+\.\d+(-alpha\.\d+)?$/, "The published alpha feed must name a version");
  assert.notEqual(from, target, "The release must be newer than what alpha subscribers have");
  const zipName = `Infinitary-${from}-universal.zip`;
  assert.equal(new URL(published.path).pathname, `/releases/v${from}/${zipName}`);
  const dmgName = `Infinitary-${from}-mac-universal.dmg`;
  const dmgUrl = new URL(dmgName, published.path).href;
  const dmg = join(work, dmgName);
  for (const [url, path] of [[dmgUrl, dmg], [`${dmgUrl}.sha256`, `${dmg}.sha256`]]) {
    run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location", "--retry", "5", "--retry-delay", "15", "--retry-all-errors", "--output", path, url], { timeout: 900_000 });
  }
  assert.equal((await digest(dmg)).sha256, readFileSync(`${dmg}.sha256`, "utf8").split(/\s+/)[0], "The downloaded disk image must match its published checksum");
  record("Published alpha", `${from}, from ${feedUrl}; its disk image matched its published checksum.`);

  // The local feed offers the release's own signed zip.
  const targetName = `Infinitary-${target}-universal.zip`;
  const digests = {};
  copyFileSync(targetZip, join(fixtures, targetName));
  digests[targetName] = await digest(join(fixtures, targetName));
  writeFileSync(join(fixtures, "digests.json"), JSON.stringify(digests, null, 2));
  writeFileSync(control, JSON.stringify({ alpha: target, mode: "normal" }));

  // A private local CA, trusted only on this disposable Mac. No production provider override
  // or weakened signature or checksum check enters either app.
  writeFileSync(join(work, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Infinitary isolated update verification\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature\nsubjectAltName=DNS:downloads.getinfinitary.com,IP:127.0.0.1\n");
  run("/usr/bin/openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-config", join(work, "openssl.cnf"), "-keyout", key, "-out", certificate]);
  chmodSync(key, 0o600);
  // Empty password: disposable public trust material, no signing secret in this keychain.
  run("/usr/bin/security", ["create-keychain", "-p", "", trust]);
  run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", trust]);
  fixtureSha1 = new X509Certificate(readFileSync(certificate)).fingerprint.replaceAll(":", "");
  // Chromium enumerates admin-trusted roots from the System keychain, not the user search list.
  run("/usr/bin/sudo", ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", systemKeychain, certificate]);
  // The real feed and disk image were read from this name moments ago (scripts/installer-hosts.ts).
  const rerouted = [new URL(source.downloadBase).hostname];
  routeHostsHere(rerouted, work, run, () => { hostsChanged = true; });
  await expect.poll(() => resolverAnswers(rerouted), { timeout: 60_000, message: "The system resolver must answer the download address with this Mac before a feed is read" }).toEqual(answeredHere(rerouted));
  for (const [name, value] of Object.entries(launchValues)) {
    launchEnvironment.set(name, spawnSync("/bin/launchctl", ["getenv", name], { encoding: "utf8" }).stdout?.trim());
    run("/bin/launchctl", ["setenv", name, value]);
  }
  const serverLog = openSync(join(evidence, "feed-server.log"), "a");
  server = spawn("/usr/bin/sudo", ["-E", process.execPath, "scripts/installer-feed-server.mjs", fixtures, control, certificate, key], { env: installerServerEnvironment(appEnv, process.env), stdio: ["ignore", serverLog, serverLog] });
  closeSync(serverLog);
  await expect.poll(() => existsSync(`${control}.ready`), { timeout: 20_000 }).toBe(true);
  assert.equal(JSON.parse(run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--max-time", "30", feedUrl])).version, target);
  record("Disposable HTTPS trust", "The system HTTPS reader verified the local certificate and read the release from the local alpha feed.");

  // Installed the way a person installs it: copied out of the published disk image.
  mounted = join(work, "image"); mkdirSync(mounted, { recursive: true });
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, dmg], { timeout: 300_000 });
  run("/usr/bin/ditto", [join(mounted, "Infinitary.app"), installed], { timeout: 300_000 });
  run("/usr/bin/hdiutil", ["detach", mounted]); mounted = undefined;
  bundleId = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(installed, "Contents/Info.plist")]);
  assert.equal(run("/usr/bin/xattr", ["-p", ownership.attribute, join(installed, ownership.path)]), ownership.direct);
  mkdirSync(join(data, "personal-workspace"), { recursive: true });
  writeFileSync(draft.path, draft.text);
  let page = await launch();
  let offer = await status(page);
  assert.equal(offer.problem, undefined, "The published alpha must trust and read the local feed");
  assert.equal(offer.currentVersion, from);
  // A promoted stable installs on Stable; alpha subscribers on it keep Alpha.
  if (offer.channel !== "alpha") {
    await bounded("Choosing alpha", () => page.evaluate(() => window.infinitary.update.setChannel("alpha")));
    offer = await status(page);
  }
  rmSync(`${control}.download`, { force: true });
  assert.equal(offer.channel, "alpha");
  assert.equal(offer.latestVersion, target);
  assert.equal(offer.updateAvailable, true);
  assert(!existsSync(`${control}.download`), "Reading the offer must not download before consent");
  record("Update offer", `The installed ${from} read ${target} from the local alpha feed and downloaded nothing before consent.`);

  runningWork = await runningWorkFixture(installedVersion, phase => console.log(`Checking: ${phase}`));
  await bounded("Preparing active work", () => runningWork.start(page));
  await expect.poll(() => runningWork.started, { timeout: 60_000 }).toBe(true);
  // Native replacement closes the transport. A reply is not used as proof of installation.
  void page.evaluate(() => window.infinitary.update.install()).catch(() => {});
  const stage = installStageRecorder(evidence, `upgrade-${target}`);
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      let version = null;
      try { version = installedVersion(); } catch { /* ShipIt may be moving the bundle. */ }
      stage({ appRunning: spawnSync("/usr/bin/pgrep", ["-f", processPattern]).status === 0, shipItRunning: spawnSync("/usr/bin/pgrep", ["-f", "/ShipIt( |$)"]).status === 0, installedVersion: version, phase: null, problem: null });
      await new Promise(done => setTimeout(done, 2_000));
    }
  })();
  try { await expect.poll(installedVersion, { timeout: 300_000 }).toBe(target); }
  catch (error) {
    if (bundleId) record("Stalled installation ShipIt logs", JSON.stringify(keepShipItLogs(home, bundleId, evidence, "stalled")));
    throw error;
  } finally { sampling = false; await sampler; }
  await expect.poll(() => spawnSync("/usr/bin/pgrep", ["-f", processPattern]).status, { timeout: 60_000 }).toBe(0);
  record("Native signed replacement", `The installed bundle now contains ${target} and the app restarted on its own.`);
  await stopApp();
  page = await launch(); // Reattach the inspection port, which macOS need not preserve on restart.
  const updated = await status(page);
  assert.equal(updated.currentVersion, target);
  assert.equal(updated.channel, "alpha");
  assert.equal(updated.problem, undefined);
  assert.equal(run("/usr/bin/xattr", ["-p", ownership.attribute, join(installed, ownership.path)]), ownership.direct);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed], { timeout: 300_000 });
  assert.equal(runningWork.closedAtVersion, from, "The live reply must stop before the replacement");
  assert(runningWork.messageSurvived(data), "The captain's message must survive the update");
  assert.equal(readFileSync(draft.path, "utf8"), draft.text, "The personal draft must survive the update");
  await page.screenshot({ path: join(evidence, "installed-app.png") });
  record("Saved work after the update", `${target} runs with a valid signature, direct ownership and Alpha; the live reply stopped at ${from}, and the captain's message and the draft survived.`);
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
  await cleanup("Stopping the app", () => stopApp());
  await cleanup("Detaching the disk image", () => { if (mounted) run("/usr/bin/hdiutil", ["detach", mounted]); });
  await cleanup("Stopping the feed server", async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      try {
        run("/usr/bin/sudo", ["/bin/kill", "-TERM", String(server.pid)]);
        await bounded("Stopping the local HTTPS server", () => exited, 30_000);
      } catch (error) {
        record("Cleanup", error.message);
        run("/usr/bin/sudo", ["/bin/kill", "-KILL", String(server.pid)], { timeout: 10_000 });
        await bounded("Reaping the stopped feed server", () => exited, 10_000);
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
  // Delete only this certificate; its admin record disappears with the disposable Mac.
  await cleanup("Deleting the local certificate", () => { if (fixtureSha1) run("/usr/bin/sudo", ["/usr/bin/security", "delete-certificate", "-Z", fixtureSha1, systemKeychain]); });
  await cleanup("Deleting the scratch keychain", () => { if (existsSync(trust)) run("/usr/bin/security", ["delete-keychain", trust]); });
  await cleanup("Removing the installed app", () => rmSync(installed, { recursive: true, force: true }));
  await cleanup("Closing the fixture module reader", () => bounded("Closing the fixture module reader", () => runner.close(), 30_000));
  await cleanup("Keeping ShipIt's logs", () => { if (bundleId) keepShipItLogs(home, bundleId, evidence, "final"); });
  // No copy of the saved database leaves this disposable proof.
  await cleanup("Removing the scratch home", () => rmSync(home, { recursive: true, force: true }));
  if (!verificationFailed && cleanupErrors.length) throw new AggregateError(cleanupErrors, "Disposable proof cleanup failed");
}
