export type MainProcessErrorTarget = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type MainProcessErrorLogger = (message: string, error: unknown) => void;

/**
 * Electron's default response to an uncaught main-process error is a native
 * modal. A test or development run may be hidden, but the modal is not, so it
 * blocks the desktop and the suite. Own both process-level error channels,
 * log the failure, and leave lifecycle policy to the app instead of Electron.
 */
export function installMainProcessErrorHandlers(
  target: MainProcessErrorTarget = process,
  log: MainProcessErrorLogger = defaultErrorLog,
): void {
  target.on("uncaughtException", (error) => {
    log("uncaught main-process exception", error);
  });
  target.on("unhandledRejection", (reason) => {
    log("unhandled main-process rejection", reason);
  });
}

function defaultErrorLog(message: string, error: unknown): void {
  console.error(`[infinitary] ${message}:`, error);
}
