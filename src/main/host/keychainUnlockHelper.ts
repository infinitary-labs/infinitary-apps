import koffi from "koffi";

/**
 * The unlock helper: a process of its own (an Electron utility process in
 * the app) whose ONE job is to ask macOS to unlock the store holding the
 * Claude login, with the macOS password dialog.
 *
 * Why a second process: Security.framework decides once per process, per
 * store, whether that process may ever show the unlock dialog, at the
 * process's first touch of the store. Infinitary's first touch is the silent
 * startup quota tick, so no later in-process call - legacy or SecItem, any
 * per-call UI option, a reopened handle - can raise the dialog again.
 * Measured on scratch stores: `fm3000-keychain-locked-retry-unlock-fix-r1`.
 * A fresh process whose first touch is the interactive unlock can.
 *
 * It never reads an item. The VALUE read stays in the app, so the "Always
 * Allow" grant still lands on Infinitary and not on this helper's identity.
 *
 * Nothing before the unlock may touch the store: a silent call first would
 * make this process decide "no dialog" too. Entry-point only - it runs on
 * load, so nothing imports it.
 */

const SECURITY_FRAMEWORK = "/System/Library/Frameworks/Security.framework/Security";
/** errSecParam: the path handed over was not a keychain file. */
const SEC_PARAM = -50;

type Report = { status: number };

function unlockKeychainInteractively(keychainPath: string): number {
  if (!keychainPath.startsWith("/") || !/\.keychain(-db)?$/.test(keychainPath)) return SEC_PARAM;
  const security = koffi.load(SECURITY_FRAMEWORK);
  const setInteraction = security.func("SecKeychainSetUserInteractionAllowed", "int32", ["uint8"]);
  const open = security.func("SecKeychainOpen", "int32", [
    "const char *",
    koffi.out(koffi.pointer(koffi.pointer("void"))),
  ]);
  const unlock = security.func("SecKeychainUnlock", "int32", [
    "void *",
    "uint32",
    "void *",
    "uint8",
  ]);
  setInteraction(1);
  const keychain: [unknown] = [null];
  const opened = open(keychainPath, keychain) as number;
  if (opened !== 0) return opened;
  if (keychain[0] == null) return SEC_PARAM;
  // No password: macOS asks for it in its own dialog.
  return unlock(keychain[0], 0, null, 0) as number;
}

type ParentPort = { postMessage: (message: Report) => void };

function report(message: Report): void {
  const parentPort = (process as { parentPort?: ParentPort }).parentPort;
  if (parentPort) {
    parentPort.postMessage(message);
    process.exit(0);
  }
  if (process.send) {
    process.send(message, () => process.exit(0));
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const keychainPath = process.argv.at(-1);
if (process.argv.length > 2 && keychainPath) {
  report({ status: unlockKeychainInteractively(keychainPath) });
}
