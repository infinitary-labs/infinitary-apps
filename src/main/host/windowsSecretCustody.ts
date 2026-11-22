import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type {
  CustodyRead,
  CustodySlot,
  CustodyWrite,
  SecretCustody,
} from "../../core/secrets/custody";

/**
 * Secrets custody in Windows Credential Manager (docs/secrets.md, "Native
 * custody"): one generic credential per slot, named `<name>/<slot>`, holding
 * the slot's raw bytes, kept for this person on this PC alone
 * (`CRED_PERSIST_LOCAL_MACHINE`, which a roaming profile never carries to
 * another PC). Values are never here.
 *
 * Credential Manager asks nothing of the person: it opens with their Windows
 * session and has no lock of its own, so there is no Unlock gesture. A run
 * outside a signed-in session, where Windows keeps no credentials, answers
 * `unavailable`. Nothing falls back to a file or another store when Windows
 * refuses.
 */

/** ERROR_NOT_FOUND: no credential of that name. */
const ERROR_NOT_FOUND = 1168;
/** CRED_TYPE_GENERIC */
const CRED_TYPE_GENERIC = 1;
/** CRED_PERSIST_LOCAL_MACHINE: this person, this PC, never roamed. */
const CRED_PERSIST_LOCAL_MACHINE = 2;

/** The two Credential Manager calls custody makes, so the status mapping is testable without Windows. */
export type WindowsCustodyApi = {
  /** The credential's bytes, or the Windows error code that refused it. */
  read(target: string): { error: 0; bytes: Buffer } | { error: number };
  /** 0 once stored, else the Windows error code. */
  write(target: string, bytes: Buffer): number;
};

export type WindowsCustodyOptions = {
  /** One name per app flavor (`SECRETS_CUSTODY_NAMES`): the dev bundle never reads the release root. */
  name: string;
};

/** The credential's name for one slot: what Credential Manager lists under Windows Credentials. */
export function custodyTarget(name: string, slot: CustodySlot): string {
  return `${name}/${slot}`;
}

export function createWindowsSecretCustody(
  api: WindowsCustodyApi | undefined,
  options: WindowsCustodyOptions,
): SecretCustody {
  return {
    async read(slot: CustodySlot): Promise<CustodyRead> {
      if (!api) return { kind: "unavailable" };
      try {
        const answer = api.read(custodyTarget(options.name, slot));
        if ("bytes" in answer) return { kind: "value", bytes: answer.bytes };
        return { kind: answer.error === ERROR_NOT_FOUND ? "absent" : "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async write(slot: CustodySlot, bytes: Buffer): Promise<CustodyWrite> {
      if (!api) return "unavailable";
      const copy = Buffer.from(bytes);
      try {
        return api.write(custodyTarget(options.name, slot), copy) === 0 ? "stored" : "unavailable";
      } catch {
        throw new Error("The native Secrets write outcome is unknown.");
      } finally {
        copy.fill(0);
      }
    },
  };
}

/**
 * The Credential Manager binding (advapi32's CredReadW, CredWriteW and
 * CredFree). Undefined off Windows, or where it cannot load.
 */
export function loadWindowsCustodyApi(): WindowsCustodyApi | undefined {
  if (hostPlatform() !== "win32") return undefined;
  try {
    binding ??= bindCredentialManager();
    return binding;
  } catch {
    return undefined;
  }
}

/** One binding per process: koffi registers its struct type once. */
let binding: WindowsCustodyApi | undefined;

function bindCredentialManager(): WindowsCustodyApi {
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const FileTime = koffi.struct("InfinitarySecretsFILETIME", {
    dwLowDateTime: "uint32",
    dwHighDateTime: "uint32",
  });
  const Credential = koffi.struct("InfinitarySecretsCREDENTIALW", {
    Flags: "uint32",
    Type: "uint32",
    TargetName: "str16",
    Comment: "str16",
    LastWritten: FileTime,
    CredentialBlobSize: "uint32",
    CredentialBlob: "void *",
    Persist: "uint32",
    AttributeCount: "uint32",
    Attributes: "void *",
    TargetAlias: "str16",
    UserName: "str16",
  });
  const voidPtrPtr = koffi.pointer(koffi.pointer("void"));
  const credRead = advapi.func("CredReadW", "bool", [
    "str16",
    "uint32",
    "uint32",
    koffi.out(voidPtrPtr),
  ]);
  const credWrite = advapi.func("CredWriteW", "bool", [koffi.pointer(Credential), "uint32"]);
  const credFree = advapi.func("CredFree", "void", ["void *"]);
  // koffi keeps the calling thread's last error from Node and V8's own calls.
  const lastError = kernel.func("GetLastError", "uint32", []);

  return {
    read: (target) => {
      const out: [unknown] = [null];
      if (!credRead(target, CRED_TYPE_GENERIC, 0, out) || out[0] == null)
        return { error: (lastError() as number) || -1 };
      try {
        const found = koffi.decode(out[0], Credential) as {
          CredentialBlobSize: number;
          CredentialBlob: unknown;
        };
        const size = found.CredentialBlobSize;
        const bytes =
          size > 0 && found.CredentialBlob != null
            ? Buffer.from(
                koffi.decode(found.CredentialBlob, koffi.array("uint8", size)) as number[],
              )
            : Buffer.alloc(0);
        return { error: 0, bytes };
      } finally {
        credFree(out[0]);
      }
    },
    write: (target, bytes) => {
      const stored = credWrite(
        {
          Flags: 0,
          Type: CRED_TYPE_GENERIC,
          TargetName: target,
          Comment: null,
          LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
          CredentialBlobSize: bytes.length,
          CredentialBlob: bytes,
          Persist: CRED_PERSIST_LOCAL_MACHINE,
          AttributeCount: 0,
          Attributes: null,
          TargetAlias: null,
          UserName: "Infinitary",
        },
        0,
      );
      return stored ? 0 : (lastError() as number) || -1;
    },
  };
}
