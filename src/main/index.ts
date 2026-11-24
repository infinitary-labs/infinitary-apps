import { statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { armWatchdog, isFreezeRecorderEnabled } from "../core/freeze/watchdog";
import { hostPlatform } from "../core/platform";
import { appExecutable } from "./appExecutable";
import { compileCacheBuild, startCompileCache } from "./compileCache";
import { keepFaultSignalsFatal } from "./faultSignals";
import { linkCommand, runLinkCommand } from "./linkCommand";
import { hasNoScreen, NO_SCREEN_WORDS } from "./noScreen";
import { personWordArg } from "./personWordArg";
import { installMainProcessErrorHandlers } from "./processErrors";
import { resetCommand } from "./reset/command";
import { askLoginShellEarly, runCommand } from "./runCommand";
import { takeRunAgentMark } from "./runEnvironment";
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
 * says how to start it (./startAtBoot.ts); `<app> reset` resets Infinitary
 * on this computer once the person confirms (./reset/command.ts); any
 * other start is the app itself, its window and its core (./app.ts). Each is
 * a chunk of its own, so the work mode never evaluates the app's modules.
 */

// A Mac app's start that shows no window runs from the background file beside
// the app's main executable (./appExecutable.ts); every place that starts the
// app again names the main executable, as before.
process.execPath = appExecutable(process.execPath, hostPlatform());

// Own process failures before startup does any work. Electron otherwise
// presents uncaught main-process errors as blocking native dialogs.
installMainProcessErrorHandlers();

// A fatal check in Electron's own code ends the process, whichever module
// loaded later listens for its signal (./faultSignals.ts): a listener would
// freeze it at full processor use instead.
keepFaultSignalsFatal();

// Both modes set things Electron reads only before the app is ready - the
// privileged schemes, userData, hardware acceleration - and Electron is
// ready once this module has finished, so each load is awaited here, at
// the top level, rather than left to resolve after it.
// A copy that shows one word for a window launch refused the folder's lock (./personWord.ts): it
// asks for no lock and opens nothing else.
const word = personWordArg(process.argv);
const work = word ? null : workCommand(process.argv, Boolean(process.defaultApp));
const run = word || work ? null : runCommand(process.argv, Boolean(process.defaultApp));
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
const reset =
  work || run || status || link || boot || help
    ? null
    : resetCommand(process.argv, Boolean(process.defaultApp));

/**
 * The data folder `run` opens in this account, chosen as it chooses it but
 * neither made nor opened: status and link read the app running on it.
 */
async function commandDataDir(): Promise<string> {
  return (await commandDataChoice()).dataDir;
}

async function commandDataChoice() {
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
  return { choice, dataDir: choice.kind === "switch" ? app.getPath("userData") : choice.dir };
}

/**
 * Finishes a reset the person asked before the app quit (./reset/atStart.ts,
 * docs/reset.md), before anything of this start opens the data folder - the
 * compile cache below writes into it. False when this start goes no further:
 * another start is finishing it, or another program holds the folder, which
 * one box then says. Never awaits readiness, which waits for this module.
 */
async function finishAskedReset(windowless = false): Promise<boolean> {
  try {
    const { choice, dataDir } = await commandDataChoice();
    const { readResetMark } = await import("../core/reset/mark");
    if (!readResetMark(dataDir)) return true;
    const { finishResetAtStart } = await import("./reset/atStart");
    const finished = await finishResetAtStart({ choice, dataDir });
    if (finished.kind === "busy") process.exit(0);
    if (finished.kind !== "held") return true;
    if (windowless) {
      const m = await import("@shared/i18n/messages.generated");
      process.stderr.write(`${m.resetHeldMessage()}. ${m.resetHeldDetail()}\n`, () =>
        process.exit(1),
      );
      return false;
    }
    const { showResetHeld } = await import("./reset/held");
    void showResetHeld();
    return false;
  } catch (error) {
    console.warn(`[reset] could not finish the reset: ${(error as Error).message}`);
    return true;
  }
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

/**
 * Turns on the compile cache in the data folder the app opens, before its
 * code loads (./compileCache.ts). Returns the step to take once it has
 * loaded. A cache that cannot start never stops the app from starting.
 */
async function cacheCompiledCode(): Promise<(() => void) | null> {
  try {
    const { app } = await import("electron");
    const build = compileCacheBuild(app.getVersion(), statSync(fileURLToPath(import.meta.url)));
    return startCompileCache(await commandDataDir(), build);
  } catch {
    return null;
  }
}

if (word) {
  const { showPersonWord } = await import("./personWord");
  void showPersonWord(word);
} else if (work) {
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
} else if (reset) {
  // Reset Infinitary from a terminal (./reset/command.ts): no Dock icon or
  // window, and readiness awaited off this module's own top level.
  if (hostPlatform() === "darwin") (await import("electron")).app.setActivationPolicy("prohibited");
  const { choice, dataDir } = await commandDataChoice();
  const { runResetCommand } = await import("./reset/commandRun");
  void runResetCommand({ words: reset, choice, dataDir }).then(
    async (result) => {
      if (result.out) await new Promise((done) => process.stdout.write(result.out, done));
      if (result.error) await new Promise((done) => process.stderr.write(result.error, done));
      process.exit(result.code);
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`, () => process.exit(1));
    },
  );
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
  // app's own start, which on Linux awaits a display of its own first. The
  // person's login shell is asked now, while the app's code loads.
  // Its agent's mark is taken first, so nothing this run starts inherits it.
  const agentMark = takeRunAgentMark(process.env);
  askLoginShellEarly(run);
  if (await finishAskedReset(true)) {
    await armFreezeRecorder();
    const loaded = await cacheCompiledCode();
    const { startApp } = await import("./app");
    loaded?.();
    await startApp(dirname(fileURLToPath(import.meta.url)), { args: run, agentMark });
  }
} else if (hasNoScreen(hostPlatform(), process.env, process.argv)) {
  // The window cannot open with no screen: say what to do instead, with no crash.
  process.stderr.write(`${NO_SCREEN_WORDS.join("\n")}\n`);
  process.exit(1);
} else if (await finishAskedReset()) {
  await armFreezeRecorder();
  const loaded = await cacheCompiledCode();
  const { startApp } = await import("./app");
  loaded?.();
  await startApp(dirname(fileURLToPath(import.meta.url)));
}
