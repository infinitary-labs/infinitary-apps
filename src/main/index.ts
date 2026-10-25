import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPlatform } from "../core/platform";
import { hasNoScreen, NO_SCREEN_WORDS } from "./noScreen";
import { installMainProcessErrorHandlers } from "./processErrors";
import { runCommand } from "./runCommand";
import { workCommand } from "./workCommand";

/**
 * The main entry: it decides which app this process is, and loads only
 * that one. Started as `<app> work ...`, it runs work for another Mac's
 * Firstmate with no window (./work.ts, docs/helper.md); started as
 * `<app> run`, it is the app itself with no window (./runCommand.ts,
 * docs/run.md); any other start is the app itself, its window and its core
 * (./app.ts). Each is a chunk of its own, so the work mode never evaluates
 * the app's modules.
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
if (work) {
  const { prepareWorkMode, runWorkMode } = await import("./work");
  // On Linux with no display, the work mode's own starts here, before
  // Chromium opens one (./ownDisplay.ts).
  if (await prepareWorkMode(work)) runWorkMode(work, dirname(fileURLToPath(import.meta.url)));
} else if (run) {
  // Started by a command with no window (./runCommand.ts, docs/run.md): the
  // app's own start, which on Linux awaits a display of its own first.
  const { startApp } = await import("./app");
  await startApp(dirname(fileURLToPath(import.meta.url)), { args: run });
} else if (hasNoScreen(hostPlatform(), process.env, process.argv)) {
  // The window cannot open with no screen: say what to do instead, with no crash.
  process.stderr.write(`${NO_SCREEN_WORDS.join("\n")}\n`);
  process.exit(1);
} else {
  const { startApp } = await import("./app");
  await startApp(dirname(fileURLToPath(import.meta.url)));
}
