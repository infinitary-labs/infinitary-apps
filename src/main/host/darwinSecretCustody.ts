import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type {
  CustodyRead,
  CustodySlot,
  CustodyWrite,
  SecretCustody,
} from "../../core/secrets/custody";

/**
 * Secrets custody in the macOS Keychain (docs/secrets.md, "Native custody").
 * Two generic-password items under one service, one per slot: the root key
 * and the protected authority head, each stored as base64 text. Values are
 * never here. The item the app creates trusts only the app that created it,
 * so another program asking for it meets the Keychain's own dialog.
 *
 * Every call is silent unless `interactive` is set: a locked store answers
 * `locked`, never a dialog the person did not ask for. Nothing falls back to
 * a file or another store when the Keychain refuses.
 */

const SEC_SUCCESS = 0;
const SEC_ITEM_NOT_FOUND = -25300;
/** What a locked store, or a dialog the person dismissed or could not see, answers. */
const SEC_LOCKED = new Set([
  -25308, // errSecInteractionNotAllowed
  -25293, // errSecAuthFailed
  -128, // errSecUserCanceled
  -60008, // errAuthorizationInternal: the dialog could not be shown
]);

/** The few Keychain calls custody makes, so the status mapping is testable without a Keychain. */
export type DarwinCustodyApi = {
  setUserInteractionAllowed(allowed: boolean): void;
  read(service: string, account: string): { status: number; bytes?: Buffer };
  write(service: string, account: string, bytes: Buffer): number;
};

export type DarwinCustodyOptions = {
  /** One service per app flavor (`SECRETS_CUSTODY_NAMES`): the dev bundle never reads the release root. */
  service: string;
  interactive?: boolean;
};

export function createDarwinSecretCustody(
  api: DarwinCustodyApi | undefined,
  options: DarwinCustodyOptions,
): SecretCustody {
  return {
    async read(slot: CustodySlot): Promise<CustodyRead> {
      if (!api) return { kind: "unavailable" };
      try {
        api.setUserInteractionAllowed(options.interactive === true);
        const { status, bytes } = api.read(options.service, slot);
        if (status === SEC_SUCCESS && bytes) {
          const decoded = Buffer.from(bytes.toString("ascii"), "base64");
          bytes.fill(0);
          return { kind: "value", bytes: decoded };
        }
        if (status === SEC_ITEM_NOT_FOUND) return { kind: "absent" };
        return { kind: SEC_LOCKED.has(status) ? "locked" : "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async write(slot: CustodySlot, bytes: Buffer): Promise<CustodyWrite> {
      if (!api) return "unavailable";
      const encoded = Buffer.from(bytes.toString("base64"), "ascii");
      let attempted = false;
      try {
        api.setUserInteractionAllowed(options.interactive === true);
        attempted = true;
        const status = api.write(options.service, slot, encoded);
        if (status === SEC_SUCCESS) return "stored";
        return SEC_LOCKED.has(status) ? "locked" : "unavailable";
      } catch {
        if (attempted) throw new Error("The native Secrets write outcome is unknown.");
        return "unavailable";
      } finally {
        encoded.fill(0);
      }
    },
  };
}

/**
 * The Security.framework binding. `keychainPath` aims every call at one
 * keychain file - the account's own login keychain in the app, a scratch one
 * in a probe - instead of the default search list and default keychain.
 * Undefined off macOS, or where the framework cannot load.
 */
export function loadDarwinCustodyApi(keychainPath?: string): DarwinCustodyApi | undefined {
  if (hostPlatform() !== "darwin") return undefined;
  try {
    return bindKeychain(keychainPath);
  } catch {
    return undefined;
  }
}

function bindKeychain(keychainPath?: string): DarwinCustodyApi {
  const security = koffi.load("/System/Library/Frameworks/Security.framework/Security");
  const coreFoundation = koffi.load(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  );
  const voidPtr = koffi.pointer("void");
  const voidPtrPtr = koffi.pointer(voidPtr);
  const find = security.func("SecKeychainFindGenericPassword", "int32", [
    "void *",
    "uint32",
    "const char *",
    "uint32",
    "const char *",
    koffi.out(koffi.pointer("uint32")),
    koffi.out(voidPtrPtr),
    koffi.out(voidPtrPtr),
  ]);
  const add = security.func("SecKeychainAddGenericPassword", "int32", [
    "void *",
    "uint32",
    "const char *",
    "uint32",
    "const char *",
    "uint32",
    "void *",
    "void *",
  ]);
  const modify = security.func("SecKeychainItemModifyAttributesAndData", "int32", [
    "void *",
    "void *",
    "uint32",
    "void *",
  ]);
  const freeContent = security.func("SecKeychainItemFreeContent", "int32", ["void *", "void *"]);
  const setInteraction = security.func("SecKeychainSetUserInteractionAllowed", "int32", ["uint8"]);
  const cfRelease = coreFoundation.func("CFRelease", "void", ["void *"]);

  // null is the default search list; the app and the probe name a file.
  let keychain: unknown = null;
  if (keychainPath !== undefined) {
    const open = security.func("SecKeychainOpen", "int32", ["const char *", koffi.out(voidPtrPtr)]);
    const opened: [unknown] = [null];
    const status = open(keychainPath, opened) as number;
    if (status !== SEC_SUCCESS || opened[0] == null)
      throw new Error(`SecKeychainOpen failed: OSStatus ${status}`);
    keychain = opened[0];
  }

  const lookup = (service: string, account: string, wantItem: boolean) => {
    const length = [0];
    const data: [unknown] = [null];
    const item: [unknown] = [null];
    const status = find(
      keychain,
      Buffer.byteLength(service),
      service,
      Buffer.byteLength(account),
      account,
      length,
      data,
      wantItem ? item : null,
    ) as number;
    return { status, length: Number(length[0]), data: data[0], item: item[0] };
  };

  return {
    setUserInteractionAllowed: (allowed) => {
      setInteraction(allowed ? 1 : 0);
    },
    read: (service, account) => {
      const found = lookup(service, account, false);
      if (found.status !== SEC_SUCCESS || found.data == null) return { status: found.status };
      try {
        const bytes = Buffer.from(
          koffi.decode(found.data, koffi.array("uint8", found.length)) as number[],
        );
        return { status: found.status, bytes };
      } finally {
        freeContent(null, found.data);
      }
    },
    write: (service, account, bytes) => {
      const found = lookup(service, account, true);
      try {
        if (found.status === SEC_SUCCESS && found.item != null)
          return modify(found.item, null, bytes.length, bytes) as number;
        if (found.status !== SEC_ITEM_NOT_FOUND) return found.status;
        return add(
          keychain,
          Buffer.byteLength(service),
          service,
          Buffer.byteLength(account),
          account,
          bytes.length,
          bytes,
          null,
        ) as number;
      } finally {
        if (found.data != null) freeContent(null, found.data);
        if (found.item != null) cfRelease(found.item);
      }
    },
  };
}
