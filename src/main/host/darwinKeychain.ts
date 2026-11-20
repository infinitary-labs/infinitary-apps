import type {
  HostKeychain,
  HostKeychainOutcome,
  HostKeychainQuery,
  HostKeychainUnlockOutcome,
} from "@core/host";
import { KEYCHAIN_READ_INCOMPLETE_CODE } from "@shared/quota";
import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import { keychainLockFromFlags } from "../runEnvironment";
import {
  appleToolMayRead,
  type ClaudeAclEntry,
  readClaudeThroughTrustedTool,
} from "./claudeKeychainTool";

import type { KeychainLockState } from "./keychainProcess";

type KeychainUnlocker = (keychainPath: string) => Promise<number>;

/**
 * Native reader used only inside a disposable Keychain process (and native tests).
 * INF-2308's full slim supersedes CD-5=B's direct-first order; INF-2321's
 * captain choice retains the exact-item guard against background prompts.
 * Metadata and access rules are read silently, then an unlocked Claude item
 * already trusting Apple's tool is read there first. Other items keep the
 * native path and its explicit interaction flag. No ACL is changed.
 * Every production call, including presence and unlock, runs off the main
 * thread through keychainProcessMain. A fresh unlock process enables dialogs
 * before its first touch, unlike the old main process's silent first touch.
 */

/** errSecSuccess */
const SEC_SUCCESS = 0;
/** errSecItemNotFound - a definite absence. Not the `security(1)` exit 44. */
export const SEC_ITEM_NOT_FOUND = -25300;

/** errSecInteractionNotAllowed */
const SEC_INTERACTION_NOT_ALLOWED = -25308;
/** kSecUnlockStateStatus in SecKeychainGetStatus's bit field. */
const UNLOCK_STATE_STATUS = 1;
/** kSecModDateItemAttr ('mdat') and kSecAccountItemAttr ('acct'). */
const MODIFIED_AT_TAG = 0x6d646174;
const ACCOUNT_TAG = 0x61636374;
/** CSSM_DB_ATTRIBUTE_FORMAT_TIME_DATE and CSSM_DB_ATTRIBUTE_FORMAT_BLOB. */
const FORMAT_TIME_DATE = 5;
const FORMAT_BLOB = 6;
const PATH_BUFFER_BYTES = 4096;

const STATUS_MESSAGE: Record<number, string> = {
  [-128]: "User canceled the request.",
  [-25293]: "Auth failed.",
  [-25308]: "User interaction is not allowed.",
  [-60008]: "The macOS dialog could not be shown.",
};

export type DarwinPresence = {
  status: number;
  modifiedAt?: string;
  /** The found item's own account attribute, when it could be read. */
  account?: string;
  /** Whether the store holding the item is locked, when it could be read. */
  locked?: boolean;
  /** That store's file, for the unlock helper. Never leaves the host. */
  keychainPath?: string;
};

export type DarwinKeychainApi = {
  setUserInteractionAllowed: (allowed: boolean) => void;
  /** An undefined account matches any: the first item of that exact service. */
  findGenericPassword: (service: string, account?: string) => DarwinPresence;
  readGenericPassword: (service: string, account?: string) => { status: number; value?: string };
  /**
   * Whether Claude's one item already trusts Apple's tool, judged in process.
   * Absent on a stand-in: the tool must not be used.
   */
  claudeItemTrustsAppleTool?: (service: string, account: string) => boolean;
  unlockKeychain?: (path: string) => number;
  keychainStatus?: (path: string) => KeychainLockState;
};

let cached: DarwinKeychainApi | undefined | "missing";

/** Reset between tests that exercise the real loader. */
export function resetDarwinKeychainApiForTest(): void {
  cached = undefined;
}

export function loadDarwinKeychainApi(): DarwinKeychainApi | undefined {
  if (cached === "missing") return undefined;
  if (cached) return cached;
  if (hostPlatform() !== "darwin") {
    cached = "missing";
    return undefined;
  }
  try {
    cached = bindSecurityFramework();
    return cached;
  } catch {
    cached = "missing";
    return undefined;
  }
}

/**
 * Called inside the fresh child, never by the Electron main thread.
 * `unlocker` is the native unlock in that same child; tests may supply a stand-in.
 */
export function createDarwinKeychain(
  api?: DarwinKeychainApi,
  unlocker?: KeychainUnlocker,
  readTrusted: typeof readClaudeThroughTrustedTool = readClaudeThroughTrustedTool,
): HostKeychain {
  const resolveApi = (): DarwinKeychainApi | undefined => api ?? loadDarwinKeychainApi();

  const run = (query: HostKeychainQuery, secret: boolean): HostKeychainOutcome => {
    const loaded = resolveApi();
    if (!loaded) {
      return { kind: "failed", message: "The host cannot reach the macOS Keychain." };
    }
    try {
      loaded.setUserInteractionAllowed(secret && query.interactive === true);
      if (!secret) return mapFind(loaded.findGenericPassword(query.service, query.account));
      return mapRead(loaded.readGenericPassword(query.service, query.account));
    } catch (caught) {
      return {
        kind: "failed",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
  };

  const unlock = async (
    query: HostKeychainQuery,
    runUnlock: KeychainUnlocker,
  ): Promise<HostKeychainUnlockOutcome> => {
    if (query.interactive !== true) return failed(SEC_INTERACTION_NOT_ALLOWED);
    const loaded = resolveApi();
    if (!loaded) {
      return { kind: "failed", message: "The host cannot reach the macOS Keychain." };
    }
    let presence: DarwinPresence;
    try {
      // This is a fresh, explicitly interactive unlock process. Its first
      // touch must permit the unlock dialog; no background call enters here.
      loaded.setUserInteractionAllowed(true);
      presence = loaded.findGenericPassword(query.service, query.account);
    } catch (caught) {
      return { kind: "failed", message: caught instanceof Error ? caught.message : String(caught) };
    }
    if (presence.status !== SEC_SUCCESS) return failed(presence.status);
    if (presence.locked === false) return { kind: "unlocked" };
    if (presence.keychainPath === undefined) {
      return { kind: "failed", message: "The store holding the item could not be located." };
    }
    try {
      return mapUnlock(await runUnlock(presence.keychainPath));
    } catch (caught) {
      return { kind: "failed", message: caught instanceof Error ? caught.message : String(caught) };
    }
  };

  return {
    findGenericPassword: async (query) => run(query, false),
    readGenericPassword: async (query) => {
      const account = query.account;
      const loaded = resolveApi();
      if (loaded && query.service === "Claude Code-credentials" && account !== undefined) {
        try {
          loaded.setUserInteractionAllowed(false);
          const presence = loaded.findGenericPassword(query.service, account);
          if (presence.status === SEC_ITEM_NOT_FOUND) return { kind: "absent" };
          if (
            presence.status === SEC_SUCCESS &&
            presence.locked === false &&
            presence.keychainPath &&
            loaded.claudeItemTrustsAppleTool?.(query.service, account) === true
          ) {
            const value = await readTrusted(account, presence.keychainPath);
            if (value.kind === "value") return value;
            if (value.kind === "incomplete") {
              return {
                kind: "failed",
                code: KEYCHAIN_READ_INCOMPLETE_CODE,
                message: "The read did not finish.",
              };
            }
          }
        } catch {
          // An unreadable/unknown grant never licenses the tool. The native
          // fallback still enforces the caller's interaction policy itself.
        }
      }
      return run(query, true);
    },
    ...(unlocker ? { unlockKeychain: (query) => unlock(query, unlocker) } : {}),
  };
}

export function mapFind(result: DarwinPresence): HostKeychainOutcome {
  if (result.status === SEC_SUCCESS) {
    return {
      kind: "found",
      ...(result.modifiedAt !== undefined ? { modifiedAt: result.modifiedAt } : {}),
      ...(result.locked !== undefined ? { locked: result.locked } : {}),
      ...(result.account !== undefined ? { account: result.account } : {}),
    };
  }
  if (result.status === SEC_ITEM_NOT_FOUND) return { kind: "absent" };
  return failed(result.status);
}

export function mapRead(result: { status: number; value?: string }): HostKeychainOutcome {
  if (result.status === SEC_SUCCESS) {
    return result.value !== undefined
      ? { kind: "value", value: result.value }
      : { kind: "failed", message: "Keychain VALUE read returned no data." };
  }
  if (result.status === SEC_ITEM_NOT_FOUND) return { kind: "absent" };
  return failed(result.status);
}

/** What a native unlock's status means to the host. */
export function mapUnlock(status: number): HostKeychainUnlockOutcome {
  return status === SEC_SUCCESS ? { kind: "unlocked" } : failed(status);
}

function failed(code: number): { kind: "failed"; code: number; message: string } {
  return { kind: "failed", code, message: STATUS_MESSAGE[code] ?? `OSStatus ${code}` };
}

/**
 * The real binding aimed at ONE keychain file instead of the search list.
 * Tests only: the opt-in scratch-keychain test runs the native path against
 * a throwaway store it creates, locks and deletes, so nothing touches the
 * login keychain. Production searches the default list.
 */
export function openDarwinKeychainApiForTest(keychainPath: string): DarwinKeychainApi {
  return bindSecurityFramework(keychainPath);
}

function bindSecurityFramework(keychainPath?: string): DarwinKeychainApi {
  const security = koffi.load("/System/Library/Frameworks/Security.framework/Security");
  const coreFoundation = koffi.load(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  );

  const voidPtr = koffi.pointer("void");
  const voidPtrPtr = koffi.pointer(voidPtr);
  // Unnamed: koffi registers a named type once per process, and a test opens
  // a binding for each throwaway keychain it makes.
  const attribute = koffi.struct({
    tag: "uint32",
    length: "uint32",
    data: voidPtr,
  });
  const attributeList = koffi.struct({
    count: "uint32",
    attr: koffi.pointer(attribute),
  });
  const attributeInfo = koffi.struct({
    count: "uint32",
    tag: koffi.pointer("uint32"),
    format: koffi.pointer("uint32"),
  });

  const findPresence = security.func("SecKeychainFindGenericPassword", "int32", [
    "void *",
    "uint32",
    "const char *",
    "uint32",
    "const char *",
    "void *",
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const findValue = security.func("SecKeychainFindGenericPassword", "int32", [
    "void *",
    "uint32",
    "const char *",
    "uint32",
    "const char *",
    koffi.out(koffi.pointer("uint32")),
    koffi.out(voidPtrPtr),
    koffi.out(voidPtrPtr),
  ]);
  const copyAttributes = security.func("SecKeychainItemCopyAttributesAndData", "int32", [
    "void *",
    koffi.pointer(attributeInfo),
    "void *",
    koffi.out(koffi.pointer(koffi.pointer(attributeList))),
    "void *",
    "void *",
  ]);
  const freeAttributes = security.func("SecKeychainItemFreeAttributesAndData", "int32", [
    koffi.pointer(attributeList),
    "void *",
  ]);
  const freeContent = security.func("SecKeychainItemFreeContent", "int32", ["void *", "void *"]);
  const copyItemKeychain = security.func("SecKeychainItemCopyKeychain", "int32", [
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const getKeychainStatus = security.func("SecKeychainGetStatus", "int32", [
    "void *",
    koffi.out(koffi.pointer("uint32")),
  ]);
  const getKeychainPath = security.func("SecKeychainGetPath", "int32", [
    "void *",
    koffi.inout(koffi.pointer("uint32")),
    "char *",
  ]);
  const cfRelease = coreFoundation.func("CFRelease", "void", ["void *"]);
  const openKeychain = security.func("SecKeychainOpen", "int32", [
    "const char *",
    koffi.out(voidPtrPtr),
  ]);
  const unlockKeychain = security.func("SecKeychainUnlock", "int32", [
    "void *",
    "uint32",
    "void *",
    "uint8",
  ]);
  const setInteraction = security.func("SecKeychainSetUserInteractionAllowed", "int32", ["uint8"]);
  const copyAccess = security.func("SecKeychainItemCopyAccess", "int32", [
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const copyAclList = security.func("SecAccessCopyACLList", "int32", [
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const copyContents = security.func("SecACLCopyContents", "int32", [
    "void *",
    koffi.out(voidPtrPtr),
    koffi.out(voidPtrPtr),
    koffi.out(koffi.pointer("uint16")),
  ]);
  const copyAuthorizations = security.func("SecACLCopyAuthorizations", voidPtr, ["void *"]);
  const copyApplicationData = security.func("SecTrustedApplicationCopyData", "int32", [
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const cfArrayCount = coreFoundation.func("CFArrayGetCount", "long", ["void *"]);
  const cfArrayGet = coreFoundation.func("CFArrayGetValueAtIndex", voidPtr, ["void *", "long"]);
  const cfStringGet = coreFoundation.func("CFStringGetCString", "uint8", [
    "void *",
    "char *",
    "long",
    "uint32",
  ]);
  const cfDataLength = coreFoundation.func("CFDataGetLength", "long", ["void *"]);
  const cfDataBytes = coreFoundation.func("CFDataGetBytePtr", voidPtr, ["void *"]);
  const UTF8 = 0x08000100;
  /** Names SecACLCopyAuthorizations returns, in the dump's words. */
  const AUTHORIZATION: Record<string, string> = {
    ACLAuthorizationAny: "any",
    ACLAuthorizationLogin: "login",
    ACLAuthorizationGenKey: "genkey",
    ACLAuthorizationDelete: "delete",
    ACLAuthorizationExportWrapped: "export_wrapped",
    ACLAuthorizationExportClear: "export_clear",
    ACLAuthorizationImportWrapped: "import_wrapped",
    ACLAuthorizationImportClear: "import_clear",
    ACLAuthorizationSign: "sign",
    ACLAuthorizationEncrypt: "encrypt",
    ACLAuthorizationDecrypt: "decrypt",
    ACLAuthorizationMAC: "mac",
    ACLAuthorizationDerive: "derive",
    ACLAuthorizationChangeACL: "change_acl",
    ACLAuthorizationChangeOwner: "change_owner",
    ACLAuthorizationPartitionID: "partition_id",
    ACLAuthorizationIntegrity: "integrity",
  };

  const cfString = (ref: unknown): string | undefined => {
    if (ref == null) return undefined;
    const buf = Buffer.alloc(1024);
    return cfStringGet(ref, buf, buf.length, UTF8)
      ? buf.toString("utf8").replace(/\0.*$/s, "")
      : undefined;
  };

  /** The trusted app's stored path, with no signature check. */
  const applicationPath = (app: unknown): string | undefined => {
    const data: [unknown] = [null];
    if ((copyApplicationData(app, data) as number) !== SEC_SUCCESS || data[0] == null)
      return undefined;
    try {
      const length = Number(cfDataLength(data[0]));
      const bytes = cfDataBytes(data[0]);
      if (bytes == null || length <= 0 || length > 4096) return undefined;
      const decoded = koffi.decode(bytes, koffi.array("uint8", length)) as number[];
      const buffer = Buffer.from(decoded);
      const end = buffer.indexOf(0);
      const path = buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
      return path.startsWith("/") ? path : undefined;
    } finally {
      cfRelease(data[0]);
    }
  };

  /**
   * The one item's access rules. False on any unfamiliar layout, so the
   * Apple tool is not used. Never changes the item.
   */
  const itemTrustsAppleTool = (item: unknown): boolean => {
    const access: [unknown] = [null];
    if ((copyAccess(item, access) as number) !== SEC_SUCCESS || access[0] == null) return false;
    const acls: [unknown] = [null];
    try {
      if ((copyAclList(access[0], acls) as number) !== SEC_SUCCESS || acls[0] == null) return false;
      const entries: ClaudeAclEntry[] = [];
      const count = Number(cfArrayCount(acls[0]));
      for (let index = 0; index < count; index += 1) {
        const acl = cfArrayGet(acls[0], index);
        const apps: [unknown] = [null];
        const description: [unknown] = [null];
        // The prompt selector is not judged (appleToolMayRead).
        const prompt = [0];
        const authorizations = copyAuthorizations(acl);
        try {
          if ((copyContents(acl, apps, description, prompt) as number) !== SEC_SUCCESS)
            return false;
          const text = cfString(description[0]);
          if (text === undefined || authorizations == null) return false;
          const tags: string[] = [];
          const tagCount = Number(cfArrayCount(authorizations));
          for (let tag = 0; tag < tagCount; tag += 1) {
            const name = cfString(cfArrayGet(authorizations, tag));
            const mapped = name === undefined ? undefined : AUTHORIZATION[name];
            if (mapped === undefined) return false;
            tags.push(mapped);
          }
          const paths: string[] = [];
          if (apps[0] != null) {
            const appCount = Number(cfArrayCount(apps[0]));
            for (let app = 0; app < appCount; app += 1) {
              const path = applicationPath(cfArrayGet(apps[0], app));
              if (path !== undefined) paths.push(path);
            }
          }
          entries.push({
            authorizations: tags,
            description: text,
            applicationPaths: paths,
          });
        } finally {
          if (description[0] != null) cfRelease(description[0]);
          if (apps[0] != null) cfRelease(apps[0]);
          if (authorizations != null) cfRelease(authorizations);
        }
      }
      return appleToolMayRead(entries);
    } finally {
      if (acls[0] != null) cfRelease(acls[0]);
      cfRelease(access[0]);
    }
  };

  // null searches the default list; a test names one keychain file.
  let keychain: unknown = null;
  if (keychainPath !== undefined) {
    const opened: [unknown] = [null];
    const status = openKeychain(keychainPath, opened) as number;
    if (status !== SEC_SUCCESS || opened[0] == null) {
      throw new Error(`SecKeychainOpen failed: OSStatus ${status}`);
    }
    keychain = opened[0];
  }

  /** The store holding a found item: its lock state and its file. */
  const storeOf = (item: unknown): { locked?: boolean; keychainPath?: string } => {
    const store: [unknown] = [null];
    if ((copyItemKeychain(item, store) as number) !== SEC_SUCCESS || store[0] == null) return {};
    try {
      const facts: { locked?: boolean; keychainPath?: string } = {};
      const status = [0];
      if ((getKeychainStatus(store[0], status) as number) === SEC_SUCCESS) {
        facts.locked = (Number(status[0]) & UNLOCK_STATE_STATUS) === 0;
      }
      const length = [PATH_BUFFER_BYTES];
      const path = Buffer.alloc(PATH_BUFFER_BYTES);
      if ((getKeychainPath(store[0], length, path) as number) === SEC_SUCCESS) {
        const bytes = Math.min(Number(length[0] ?? 0), PATH_BUFFER_BYTES);
        if (bytes > 0) facts.keychainPath = path.subarray(0, bytes).toString("utf8");
      }
      return facts;
    } finally {
      cfRelease(store[0]);
    }
  };

  return {
    setUserInteractionAllowed: (allowed) => {
      setInteraction(allowed ? 1 : 0);
    },
    keychainStatus: (path) => {
      if (setInteraction(0) !== SEC_SUCCESS) return "unknown";
      const opened: [unknown] = [null];
      const result = openKeychain(path, opened) as number;
      if (result !== SEC_SUCCESS || opened[0] === null) return "unknown";
      try {
        const flags = [0];
        const status = getKeychainStatus(opened[0], flags) as number;
        if (status === -25294) return "absent";
        return status === SEC_SUCCESS ? keychainLockFromFlags(flags[0] ?? 0) : "unknown";
      } finally {
        cfRelease(opened[0]);
      }
    },
    unlockKeychain: (path) => {
      if (!path.startsWith("/") || !/\.keychain(-db)?$/.test(path)) return -50;
      setInteraction(1);
      const opened: [unknown] = [null];
      const status = openKeychain(path, opened) as number;
      if (status !== SEC_SUCCESS || opened[0] == null) return status || -50;
      try {
        // macOS owns the password dialog; no password reaches this process.
        return unlockKeychain(opened[0], 0, null, 0) as number;
      } finally {
        cfRelease(opened[0]);
      }
    },
    findGenericPassword: (service, account) => {
      const itemRef: [unknown] = [null];
      // A NULL account leaves it out of the search: any item of this service.
      const status = findPresence(
        keychain,
        Buffer.byteLength(service),
        service,
        account === undefined ? 0 : Buffer.byteLength(account),
        account ?? null,
        null,
        null,
        itemRef,
      ) as number;
      let modifiedAt: string | undefined;
      let foundAccount: string | undefined;
      let store: { locked?: boolean; keychainPath?: string } = {};
      const attributes: [unknown] = [null];
      try {
        if (status === SEC_SUCCESS && itemRef[0] != null) {
          const tags = [MODIFIED_AT_TAG, ACCOUNT_TAG];
          const formats = [FORMAT_TIME_DATE, FORMAT_BLOB];
          const attributeStatus = copyAttributes(
            itemRef[0],
            { count: tags.length, tag: tags, format: formats },
            null,
            attributes,
            null,
            null,
          ) as number;
          if (attributeStatus === SEC_SUCCESS && attributes[0] != null) {
            const list = koffi.decode(attributes[0], attributeList) as {
              count: number;
              attr: unknown;
            };
            const found =
              list.count > 0 && list.attr != null
                ? (koffi.decode(list.attr, attribute, list.count) as {
                    tag: number;
                    length: number;
                    data: unknown;
                  }[])
                : [];
            for (const entry of found) {
              if (entry.data == null || entry.length <= 0) continue;
              if (entry.tag === MODIFIED_AT_TAG) {
                modifiedAt = koffi.decode.string(entry.data, entry.length);
              } else if (entry.tag === ACCOUNT_TAG) {
                const bytes = koffi.decode(entry.data, koffi.array("uint8", entry.length));
                foundAccount = Buffer.from(bytes as number[]).toString("utf8");
              }
            }
          }
          store = storeOf(itemRef[0]);
        }
      } finally {
        if (attributes[0] != null) freeAttributes(attributes[0], null);
        if (itemRef[0] != null) cfRelease(itemRef[0]);
      }
      return {
        status,
        ...(modifiedAt !== undefined ? { modifiedAt } : {}),
        ...(foundAccount !== undefined ? { account: foundAccount } : {}),
        ...store,
      };
    },
    readGenericPassword: (service, account) => {
      const passwordLength = [0];
      const passwordData: [unknown] = [null];
      const itemRef: [unknown] = [null];
      const status = findValue(
        keychain,
        Buffer.byteLength(service),
        service,
        account === undefined ? 0 : Buffer.byteLength(account),
        account ?? null,
        passwordLength,
        passwordData,
        itemRef,
      ) as number;
      let value: string | undefined;
      try {
        if (status === SEC_SUCCESS && passwordData[0] != null) {
          const length = Number(passwordLength[0] ?? 0);
          value = length > 0 ? koffi.decode.string(passwordData[0], length) : "";
        }
      } finally {
        if (passwordData[0] != null) freeContent(null, passwordData[0]);
        if (itemRef[0] != null) cfRelease(itemRef[0]);
      }
      return { status, ...(value !== undefined ? { value } : {}) };
    },
    claudeItemTrustsAppleTool: (service, account) => {
      setInteraction(0);
      const itemRef: [unknown] = [null];
      const status = findPresence(
        keychain,
        Buffer.byteLength(service),
        service,
        Buffer.byteLength(account),
        account,
        null,
        null,
        itemRef,
      ) as number;
      try {
        return status === SEC_SUCCESS && itemRef[0] != null && itemTrustsAppleTool(itemRef[0]);
      } finally {
        if (itemRef[0] != null) cfRelease(itemRef[0]);
      }
    },
  };
}
