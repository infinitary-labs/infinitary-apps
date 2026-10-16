import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installMainProcessErrorHandlers } from "./processErrors";
import { workCommand } from "./workCommand";

/**
 * The main entry: it decides which app this process is, and loads only
 * that one. Started as `<app> work ...`, it runs work for another Mac's
 * Firstmate with no window (./work.ts, docs/helper.md); any other start is
 * the app itself, its window and its core (./app.ts). Each is a chunk of
 * its own, so the work mode never evaluates the app's modules.
 */

// Own process failures before startup does any work. Electron otherwise
// presents uncaught main-process errors as blocking native dialogs.
installMainProcessErrorHandlers();

// Both modes set things Electron reads only before the app is ready - the
// privileged schemes, userData, hardware acceleration - and Electron is
// ready once this module has finished, so each load is awaited here, at
// the top level, rather than left to resolve after it.
const work = workCommand(process.argv, Boolean(process.defaultApp));
if (work) {
  const { prepareWorkMode, runWorkMode } = await import("./work");
  // On Linux with no display, the work mode's own starts here, before
  // Chromium opens one (./ownDisplay.ts).
  if (await prepareWorkMode(work)) runWorkMode(work, dirname(fileURLToPath(import.meta.url)));
} else {
  const { startApp } = await import("./app");
  startApp(dirname(fileURLToPath(import.meta.url)));
}
