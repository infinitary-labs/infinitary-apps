import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { armWatchdog, isFreezeRecorderEnabled } from "../core/freeze/watchdog";
import { hostPlatform } from "../core/platform";
import { linkCommand, runLinkCommand } from "./linkCommand";
import { hasNoScreen, NO_SCREEN_WORDS } from "./noScreen";
import { installMainProcessErrorHandlers } from "./processErrors";
import { runCommand } from "./runCommand";
import { statusCommand } from "./runStatus";
import { helpCommand, startAtBootCommand } from "./startAtBoot";
import { workCommand } from "./workCommand";

/**
 * The main entry: it decides which app this process is, and loads only
 * that one. Started as `<app> work ...`, it runs work for another Mac's
 * Firstmate with no window (./work.ts, docs/helper.md); started as
 * `<app> run`, it is the app itself with no window (./runCommand.ts,
 * docs/run.md); `<app> status` and `<app> link` read that app's status or ask
 * it for a link, and start nothing (./runStatus.ts, ./linkCommand.ts);
 * `<app> start-at-boot` sets that run up to start at boot, and `<app> help`
 * says how to start it (./startAtBoot.ts); any
 * other start is the app itself, its window and its core (./app.ts). Each is
 * a chunk of its own, so the work mode never evaluates the app's modules.
 */

// Own process failures before startup does any work. Electron otherwise
// presents uncaught main-process errors as blocking native dialogs.
installMainProcessErrorHandlers();

// Both modes set things Electron reads only before the app is ready - the
// privileged schemes, userData, hardware acceleration - and Electron is
// ready once this module has finished, so each load is awaited here, at
// the top level, rather than left to resolve after it.
const work = workCommand(process.argv, Boolean(process.defaultApp));
const run = work ? null : runCommand(process.argv, Boolean(process.defaultApp));
const status = work || run ? null : statusCommand(process.argv, Boolean(process.defaultApp));
const link = work || run || status ? null : linkCommand(process.argv, Boolean(process.defaultApp));
const boot =
  work || run || status || link
    ? null
    : startAtBootCommand(process.argv, Boolean(process.defaultApp));
const help =
  work || run || status || link || boot
    ? null
    : helpCommand(process.argv, Boolean(process.defaultApp));

/**
 * The data folder `run` opens in this account, chosen as it chooses it but
 * neither made nor opened: status and link read the app running on it.
 */
async function commandDataDir(): Promise<string> {
  const { app } = await import("electron");
  const { chooseUserDataDir, folderSpellingFor, readPackageJsonAt } = await import("./userDataDir");
  const choice = chooseUserDataDir({
    packaged: app.isPackaged,
    env: process.env,
    hasUserDataDirSwitch: app.commandLine.hasSwitch("user-data-dir"),
    appData: app.getPath("appData"),
    readAppPackageJson: readPackageJsonAt(app.getAppPath()),
    spelling: folderSpellingFor({ packaged: app.isPackaged, env: process.env }),
  });
  return choice.kind === "switch" ? app.getPath("userData") : choice.dir;
}

/**
 * Arms the freeze recorder's watchdog where this build runs the recorder,
 * before the app's own code loads, so the recorder that takes it names a
 * stall from its first heartbeat (docs/freeze-recorder.md, "At startup").
 */
async function armFreezeRecorder(): Promise<void> {
  const { app } = await import("electron");
  const build = { packaged: app.isPackaged, version: app.getVersion(), env: process.env };
  if (isFreezeRecorderEnabled(build)) armWatchdog();
}

if (work) {
  const { prepareWorkMode, runWorkMode } = await import("./work");
  // On Linux with no display, the work mode's own starts here, before
  // Chromium opens one (./ownDisplay.ts).
  if (await prepareWorkMode(work)) runWorkMode(work, dirname(fileURLToPath(import.meta.url)));
} else if (status) {
  // Read before readiness: no screen, lock, core, migration or saved-data write.
  const { runStatusCommand } = await import("./runStatus");
  const result = runStatusCommand(status, await commandDataDir());
  const stream = result.error ? process.stderr : process.stdout;
  stream.write(result.error || result.out, () => process.exit(result.code));
} else if (link) {
  // Asked and answered before readiness, which waits for this module: no
  // screen, Dock icon, lock or core. The running app's door makes the link.
  if (hostPlatform() === "darwin") (await import("electron")).app.setActivationPolicy("prohibited");
  const result = await runLinkCommand(link, await commandDataDir());
  if (result.out) await new Promise((done) => process.stdout.write(result.out, done));
  if (result.error) await new Promise((done) => process.stderr.write(result.error, done));
  process.exit(result.code);
} else if (boot || help) {
  // Answered before readiness, as link is: no screen, Dock icon, lock or core.
  if (hostPlatform() === "darwin") (await import("electron")).app.setActivationPolicy("prohibited");
  const { answerBootCommand } = await import("./startAtBootContext");
  const result = await answerBootCommand({ boot, help }, await commandDataDir());
  if (result.out) await new Promise((done) => process.stdout.write(result.out, done));
  if (result.error) await new Promise((done) => process.stderr.write(result.error, done));
  process.exit(result.code);
} else if (run) {
  // Started by a command with no window (./runCommand.ts, docs/run.md): the
  // app's own start, which on Linux awaits a display of its own first.
  await armFreezeRecorder();
  const { startApp } = await import("./app");
  await startApp(dirname(fileURLToPath(import.meta.url)), { args: run });
} else if (hasNoScreen(hostPlatform(), process.env, process.argv)) {
  // The window cannot open with no screen: say what to do instead, with no crash.
  process.stderr.write(`${NO_SCREEN_WORDS.join("\n")}\n`);
  process.exit(1);
} else {
  await armFreezeRecorder();
  const { startApp } = await import("./app");
  await startApp(dirname(fileURLToPath(import.meta.url)));
}
