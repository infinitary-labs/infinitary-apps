import { createHash } from "node:crypto";
import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type { FreshAuthentication } from "../../core/secrets/approvals";

/**
 * Fresh system authentication on Windows (docs/secrets.md, "Trusted
 * approvals"): Windows Hello - a PIN, a fingerprint or a face - through
 * `UserConsentVerifier`, asked anew every time, and the person's Windows
 * password where Hello is off. The password is checked by Windows itself
 * (`LogonUserW`), and only for this same Windows user: another account's
 * password confirms nothing. A dismissed, failed or impossible confirmation
 * approves nothing, and a Hello the person dismissed never falls back to the
 * password.
 */

/** What `UserConsentVerifier.CheckAvailabilityAsync` answers (`UserConsentVerifierAvailability`). */
export const HELLO_AVAILABILITY = {
  available: 0,
  deviceNotPresent: 1,
  notConfiguredForUser: 2,
  disabledByPolicy: 3,
  deviceBusy: 4,
} as const;

/** `UserConsentVerificationResult.Verified`: the only answer that confirms. */
const HELLO_VERIFIED = 0;

/** What a window is to Windows: its handle, as Electron's `getNativeWindowHandle` gives it. */
export type WindowHandle = Buffer;

/** The few native calls a confirmation makes, so the choice between them is testable without Windows. */
export type WindowsAuthenticationApi = {
  /** Hello's availability, or undefined where Windows could not answer. */
  helloAvailability(): Promise<number | undefined>;
  /** Hello's answer, or "unstarted" where Windows could not show it at all. */
  helloVerify(reason: string, window: WindowHandle | undefined): Promise<number | "unstarted">;
  /** Whether the person typed this Windows user's own password. */
  passwordConfirm(reason: string, window: WindowHandle | undefined): Promise<boolean>;
};

export type WindowsAuthenticationOptions = {
  /** The window the system's dialog belongs to: the app's focused one, absent in a run with no window. */
  window?: () => WindowHandle | undefined;
};

/** Hello's answers that mean Hello cannot be asked on this PC now, so the password is. */
const PASSWORD_INSTEAD = new Set<number>([
  HELLO_AVAILABILITY.deviceNotPresent,
  HELLO_AVAILABILITY.notConfiguredForUser,
  HELLO_AVAILABILITY.disabledByPolicy,
]);

export function createWindowsFreshAuthentication(
  options: WindowsAuthenticationOptions = {},
  api: WindowsAuthenticationApi | undefined = loadWindowsAuthenticationApi(),
): FreshAuthentication | undefined {
  if (!api) return undefined;
  const window = () => {
    try {
      return options.window?.();
    } catch {
      return undefined;
    }
  };
  const confirmOnce = async (reason: string): Promise<boolean> => {
    const availability = await api.helloAvailability();
    if (availability === HELLO_AVAILABILITY.available) {
      const answer = await api.helloVerify(reason, window());
      if (answer !== "unstarted") return answer === HELLO_VERIFIED;
    } else if (availability !== undefined && !PASSWORD_INSTEAD.has(availability)) {
      // Busy: someone is using the sensor; this confirmation fails rather than switch to the password.
      return false;
    }
    return api.passwordConfirm(reason, window());
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    // The password is always there to ask, so a PC whose bindings load can confirm.
    available: async () => true,
    confirm: (reason) => {
      const turn = queue.then(() => confirmOnce(reason)).catch(() => false);
      queue = turn;
      return turn;
    },
  };
}

/**
 * A parameterized WinRT interface's id, from its signature, as the Windows
 * Runtime derives it: a version 5 UUID over the WinRT namespace.
 */
export function parameterizedIid(signature: string): string {
  const namespace = Buffer.from("11f47ad57b7342c0abae878b1e16adee", "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(signature, "utf8")]))
    .digest()
    .subarray(0, 16);
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `IAsyncOperation<T>` for one of the verifier's enums, each an Int32. */
export function asyncOperationIid(enumName: string): string {
  return parameterizedIid(
    `pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.${enumName};i4))`,
  );
}

const IID = {
  statics: "af4f3f91-564c-4ddc-b8b5-973447627c65",
  interop: "39e050c3-4e74-441a-8dc0-b81104df949c",
  asyncInfo: "00000036-0000-0000-c000-000000000046",
};

/** A GUID as Windows lays it out in memory. */
function guid(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.from(hex, "hex");
  const out = Buffer.alloc(16);
  out.writeUInt32LE(bytes.readUInt32BE(0), 0);
  out.writeUInt16LE(bytes.readUInt16BE(4), 4);
  out.writeUInt16LE(bytes.readUInt16BE(6), 6);
  bytes.copy(out, 8, 8, 16);
  return out;
}

/** The Hello and password bindings. Undefined off Windows, or where they cannot load. */
export function loadWindowsAuthenticationApi(): WindowsAuthenticationApi | undefined {
  if (hostPlatform() !== "win32") return undefined;
  try {
    bound ??= { ...bindHello(), ...bindPassword() };
    return bound;
  } catch {
    return undefined;
  }
}

let bound: WindowsAuthenticationApi | undefined;

/** AsyncStatus */
const ASYNC = { started: 0, completed: 1 } as const;
/** How often a pending Hello answer is read; Windows shows its own dialog meanwhile. */
const POLL_MS = 100;

function bindHello(): Pick<WindowsAuthenticationApi, "helloAvailability" | "helloVerify"> {
  const combase = koffi.load("combase.dll");
  const voidPtrPtr = koffi.pointer(koffi.pointer("void"));
  const roInitialize = combase.func("RoInitialize", "int32", ["uint32"]);
  const createString = combase.func("WindowsCreateString", "int32", [
    "str16",
    "uint32",
    koffi.out(voidPtrPtr),
  ]);
  const deleteString = combase.func("WindowsDeleteString", "int32", ["void *"]);
  const activationFactory = combase.func("RoGetActivationFactory", "int32", [
    "void *",
    "void *",
    koffi.out(voidPtrPtr),
  ]);
  const Release = koffi.proto("uint32 InfinitaryHelloRelease(void *self)");
  const QueryInterface = koffi.proto(
    "int32 InfinitaryHelloQueryInterface(void *self, void *iid, _Out_ void **out)",
  );
  const CheckAvailability = koffi.proto(
    "int32 InfinitaryHelloCheckAvailability(void *self, _Out_ void **operation)",
  );
  const RequestVerification = koffi.proto(
    "int32 InfinitaryHelloRequestVerification(void *self, void *message, _Out_ void **operation)",
  );
  const RequestForWindow = koffi.proto(
    "int32 InfinitaryHelloRequestForWindow(void *self, uintptr_t window, void *message, void *iid, _Out_ void **operation)",
  );
  const GetStatus = koffi.proto("int32 InfinitaryHelloGetStatus(void *self, _Out_ int32 *status)");
  const GetResults = koffi.proto(
    "int32 InfinitaryHelloGetResults(void *self, _Out_ int32 *results)",
  );
  const Close = koffi.proto("int32 InfinitaryHelloClose(void *self)");

  /** The function in an object's table at this slot (IUnknown's three, IInspectable's six, then its own). */
  const method = (object: unknown, slot: number) =>
    (koffi.decode(koffi.decode(object, "void *"), koffi.array("void *", slot + 1)) as unknown[])[
      slot
    ];
  const release = (object: unknown) => {
    if (object != null) koffi.call(method(object, 2), Release, object);
  };
  const failed = (hr: number) => hr < 0;
  const hstring = (text: string) => {
    const out: [unknown] = [null];
    if (failed(createString(text, text.length, out) as number)) throw new Error("no HSTRING");
    return out[0];
  };
  const factory = (iid: string) => {
    // The app's main thread already joined COM; this only makes sure.
    roInitialize(0);
    const name = hstring("Windows.Security.Credentials.UI.UserConsentVerifier");
    try {
      const out: [unknown] = [null];
      const hr = activationFactory(name, guid(iid), out) as number;
      if (failed(hr) || out[0] == null) throw new Error(`no verifier: ${hr}`);
      return out[0];
    } finally {
      deleteString(name);
    }
  };

  /** Wait for an operation to end, then read its Int32 answer; undefined where it did not complete. */
  const settle = (operation: unknown) =>
    new Promise<number | undefined>((resolve) => {
      const info: [unknown] = [null];
      if (
        failed(
          koffi.call(method(operation, 0), QueryInterface, operation, guid(IID.asyncInfo), info),
        )
      ) {
        release(operation);
        return resolve(undefined);
      }
      const finish = (answer: number | undefined) => {
        koffi.call(method(info[0], 10), Close, info[0]);
        release(info[0]);
        release(operation);
        resolve(answer);
      };
      const read = () => {
        const status = [ASYNC.started];
        if (failed(koffi.call(method(info[0], 7), GetStatus, info[0], status)))
          return finish(undefined);
        if (status[0] === ASYNC.started) return void setTimeout(read, POLL_MS);
        if (status[0] !== ASYNC.completed) return finish(undefined);
        const results = [-1];
        const hr = koffi.call(method(operation, 8), GetResults, operation, results) as number;
        finish(failed(hr) ? undefined : results[0]);
      };
      read();
    });

  return {
    helloAvailability: async () => {
      try {
        const statics = factory(IID.statics);
        try {
          const operation: [unknown] = [null];
          const hr = koffi.call(
            method(statics, 6),
            CheckAvailability,
            statics,
            operation,
          ) as number;
          if (failed(hr) || operation[0] == null) return undefined;
          return await settle(operation[0]);
        } finally {
          release(statics);
        }
      } catch {
        return undefined;
      }
    },
    helloVerify: async (reason, window) => {
      let started: unknown;
      try {
        const message = hstring(reason);
        try {
          const operation: [unknown] = [null];
          if (window) {
            // A desktop app's dialog belongs to its window (IUserConsentVerifierInterop).
            const interop = factory(IID.interop);
            try {
              const hr = koffi.call(
                method(interop, 6),
                RequestForWindow,
                interop,
                window.length >= 8 ? window.readBigUInt64LE(0) : BigInt(window.readUInt32LE(0)),
                message,
                guid(asyncOperationIid("UserConsentVerificationResult")),
                operation,
              ) as number;
              if (!failed(hr)) started = operation[0];
            } finally {
              release(interop);
            }
          } else {
            const statics = factory(IID.statics);
            try {
              const hr = koffi.call(
                method(statics, 7),
                RequestVerification,
                statics,
                message,
                operation,
              ) as number;
              if (!failed(hr)) started = operation[0];
            } finally {
              release(statics);
            }
          }
        } finally {
          deleteString(message);
        }
      } catch {
        return "unstarted";
      }
      if (started == null) return "unstarted";
      return (await settle(started)) ?? -1;
    },
  };
}

/** CREDUIWIN_ENUMERATE_CURRENT_USER: the dialog offers only this Windows user. */
const CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;
/** CRED_PACK_PROTECTED_CREDENTIALS: unpack the password Windows protected in the dialog's answer. */
const CRED_PACK_PROTECTED_CREDENTIALS = 0x1;
const LOGON32_LOGON_INTERACTIVE = 2;
const LOGON32_PROVIDER_DEFAULT = 0;
const TOKEN_QUERY = 0x8;
/** TokenUser */
const TOKEN_USER_CLASS = 1;
/** CREDUI_MAX_USERNAME_LENGTH + 1, CREDUI_MAX_DOMAIN_TARGET_LENGTH + 1, CREDUI_MAX_PASSWORD_LENGTH + 1 */
const NAME_CHARS = 514;
const PASSWORD_CHARS = 257;

function bindPassword(): Pick<WindowsAuthenticationApi, "passwordConfirm"> {
  const credui = koffi.load("credui.dll");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const ole = koffi.load("ole32.dll");
  const ntdll = koffi.load("ntdll.dll");
  const Info = koffi.struct("InfinitaryCREDUI_INFOW", {
    cbSize: "uint32",
    hwndParent: "uintptr_t",
    pszMessageText: "str16",
    pszCaptionText: "str16",
    hbmBanner: "void *",
  });
  const prompt = credui.func("CredUIPromptForWindowsCredentialsW", "uint32", [
    koffi.pointer(Info),
    "uint32",
    "void *",
    "void *",
    "uint32",
    "void *",
    "void *",
    "void *",
    "uint32",
  ]);
  const unpack = credui.func("CredUnPackAuthenticationBufferW", "bool", [
    "uint32",
    "uintptr_t",
    "uint32",
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
  ]);
  const zero = ntdll.func("RtlZeroMemory", "void", ["uintptr_t", "uintptr_t"]);
  const free = ole.func("CoTaskMemFree", "void", ["uintptr_t"]);
  const logon = advapi.func("LogonUserW", "bool", [
    "str16",
    "str16",
    "void *",
    "uint32",
    "uint32",
    "void *",
  ]);
  const openToken = advapi.func("OpenProcessToken", "bool", ["void *", "uint32", "void *"]);
  const tokenInfo = advapi.func("GetTokenInformation", "bool", [
    "uintptr_t",
    "uint32",
    "void *",
    "uint32",
    "void *",
  ]);
  const equalSid = advapi.func("EqualSid", "bool", ["uintptr_t", "uintptr_t"]);
  const currentProcess = kernel.func("GetCurrentProcess", "void *", []);
  const closeHandle = kernel.func("CloseHandle", "bool", ["uintptr_t"]);

  const call = <T>(fn: { async: (...args: unknown[]) => void }, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      fn.async(...args, (error: unknown, result: T) => (error ? reject(error) : resolve(result)));
    });
  const handleIn = (buffer: Buffer) => buffer.readBigUInt64LE(0);
  /**
   * Whether two tokens belong to one Windows user, by security identifier.
   * TOKEN_USER starts with the address of its SID, which sits in the same
   * buffer, so each buffer lives until the comparison ends.
   */
  const sameUser = (one: bigint, other: bigint): boolean => {
    const length = Buffer.alloc(4);
    const users = [one, other].map((token) => {
      const info = Buffer.alloc(256);
      return tokenInfo(token, TOKEN_USER_CLASS, info, info.length, length) ? info : undefined;
    });
    const [first, second] = users;
    if (!first || !second) return false;
    return equalSid(first.readBigUInt64LE(0), second.readBigUInt64LE(0)) === true;
  };

  return {
    passwordConfirm: async (reason, window) => {
      const outBuffer = Buffer.alloc(8);
      const outSize = Buffer.alloc(4);
      const save = Buffer.alloc(4);
      const answer = await call<number>(
        prompt,
        {
          cbSize: koffi.sizeof(Info),
          hwndParent: window && window.length >= 8 ? window.readBigUInt64LE(0) : 0,
          pszMessageText: reason,
          pszCaptionText: "Infinitary",
          hbmBanner: null,
        },
        0,
        Buffer.alloc(4),
        null,
        0,
        outBuffer,
        outSize,
        save,
        CREDUIWIN_ENUMERATE_CURRENT_USER,
      );
      const packed = outBuffer.readBigUInt64LE(0);
      const packedSize = outSize.readUInt32LE(0);
      if (answer !== 0 || packed === 0n) return false;
      const user = Buffer.alloc(NAME_CHARS * 2);
      const domain = Buffer.alloc(NAME_CHARS * 2);
      const password = Buffer.alloc(PASSWORD_CHARS * 2);
      const counts = [NAME_CHARS, NAME_CHARS, PASSWORD_CHARS].map((chars) => {
        const count = Buffer.alloc(4);
        count.writeUInt32LE(chars, 0);
        return count;
      });
      try {
        const unpacked = unpack(
          CRED_PACK_PROTECTED_CREDENTIALS,
          packed,
          packedSize,
          user,
          counts[0],
          domain,
          counts[1],
          password,
          counts[2],
        );
        if (!unpacked) return false;
        const [name, place] = accountOf(wide(user), wide(domain));
        const token = Buffer.alloc(8);
        const loggedOn = await call<boolean>(
          logon,
          name,
          place,
          password,
          LOGON32_LOGON_INTERACTIVE,
          LOGON32_PROVIDER_DEFAULT,
          token,
        );
        if (!loggedOn) return false;
        const theirs = handleIn(token);
        const own = Buffer.alloc(8);
        try {
          if (!openToken(currentProcess(), TOKEN_QUERY, own)) return false;
          try {
            return sameUser(theirs, handleIn(own));
          } finally {
            closeHandle(handleIn(own));
          }
        } finally {
          closeHandle(theirs);
        }
      } finally {
        password.fill(0);
        zero(packed, BigInt(packedSize));
        free(packed);
      }
    },
  };
}

function wide(buffer: Buffer): string {
  const text = buffer.toString("utf16le");
  const end = text.indexOf("\0");
  return end === -1 ? text : text.slice(0, end);
}

/**
 * The account `LogonUserW` takes: a `DOMAIN\user` name splits into its user
 * and domain, a `user@domain` name keeps no domain, and a bare name is this
 * PC's own account.
 */
export function accountOf(user: string, domain: string): [string, string | null] {
  if (domain) return [user, domain];
  const slash = user.indexOf("\\");
  if (slash !== -1) return [user.slice(slash + 1), user.slice(0, slash)];
  if (user.includes("@")) return [user, null];
  return [user, "."];
}
