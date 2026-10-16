/**
 * Runs `keychainUnlockHelper` in a fresh process and waits for the person's
 * answer to the macOS unlock dialog. See the helper for why it cannot run in
 * this process. `fork` is Electron's `utilityProcess.fork` in the app; the
 * opt-in scratch-keychain test hands in a plain Node fork of the same file.
 */

/** Resolves with the helper's OSStatus; rejects when the helper could not answer. */
export type KeychainUnlocker = (keychainPath: string) => Promise<number>;

/** The slice of a forked process the unlocker uses (Electron's UtilityProcess or Node's ChildProcess). */
export type UnlockHelperProcess = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
};

export type ForkUnlockHelper = (modulePath: string, args: string[]) => UnlockHelperProcess;

/**
 * Long enough to read a dialog and type a password. When it runs out the
 * helper is killed and the store is still locked; the next Retry asks again.
 */
export const KEYCHAIN_UNLOCK_TIMEOUT_MS = 120_000;

export function createKeychainUnlocker(options: {
  helperPath: string;
  fork: ForkUnlockHelper;
  timeoutMs?: number;
}): KeychainUnlocker {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_UNLOCK_TIMEOUT_MS;
  // One dialog per store: a second Retry while the first dialog is up waits
  // for that answer instead of stacking another dialog behind it.
  const inFlight = new Map<string, Promise<number>>();
  return (keychainPath) => {
    const running = inFlight.get(keychainPath);
    if (running) return running;
    const attempt = new Promise<number>((resolve, reject) => {
      let child: UnlockHelperProcess;
      try {
        child = options.fork(options.helperPath, [keychainPath]);
      } catch (caught) {
        reject(caught instanceof Error ? caught : new Error(String(caught)));
        return;
      }
      let status: number | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.on("message", (message) => {
        const reported = (message as { status?: unknown } | null)?.status;
        if (typeof reported === "number") status = reported;
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (status !== undefined) resolve(status);
        else if (timedOut) reject(new Error("The unlock dialog timed out without an answer."));
        else reject(new Error(`The unlock helper exited (${code ?? "signal"}) without an answer.`));
      });
    }).finally(() => {
      inFlight.delete(keychainPath);
    });
    inFlight.set(keychainPath, attempt);
    return attempt;
  };
}
