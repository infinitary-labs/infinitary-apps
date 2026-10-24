import koffi from "koffi";
import type {
  CustodyRead,
  CustodySlot,
  CustodyWrite,
  SecretCustody,
} from "../../core/secrets/custody";

/**
 * Secrets custody in the Linux Secret Service (docs/secrets.md, "Native
 * custody"), through libsecret: two items in the default collection under
 * this app's schema, one per slot, each stored as base64 text. Values are
 * never here. While the collection is unlocked, any program of the same user
 * on the same session can ask the Secret Service for these items; the
 * approval, the rules and the sealed vault are what keep an agent from using
 * them, and the docs say so.
 *
 * Nothing falls back: no session bus, no Secret Service, or libsecret's
 * file backend answer `unavailable`.
 */

/** SECRET_ERROR_IS_LOCKED */
const SECRET_IS_LOCKED = 2;
/** G_IO_ERROR_CANCELLED: the unlock prompt was dismissed or could not show. */
const IO_CANCELLED = 19;

/** What libsecret answered, so the mapping is testable without a session bus. */
export type LibsecretAnswer =
  | { kind: "value"; bytes: Buffer }
  | { kind: "absent" }
  | { kind: "stored" }
  | { kind: "error"; locked: boolean };

export type LibsecretApi = {
  lookup(store: string, slot: CustodySlot): LibsecretAnswer;
  store(store: string, slot: CustodySlot, label: string, password: Buffer): LibsecretAnswer;
};

export type LinuxCustodyOptions = {
  /** One store per app flavor, so a development run never reads the release root. */
  store: string;
};

const LABEL: Record<CustodySlot, string> = {
  root: "Infinitary Secrets root key",
  "authority-head": "Infinitary Secrets rules check",
};

export function createLinuxSecretCustody(
  api: LibsecretApi | undefined,
  options: LinuxCustodyOptions,
): SecretCustody {
  return {
    async read(slot: CustodySlot): Promise<CustodyRead> {
      if (!api) return { kind: "unavailable" };
      try {
        const answer = api.lookup(options.store, slot);
        if (answer.kind === "value") {
          const decoded = Buffer.from(answer.bytes.toString("ascii"), "base64");
          answer.bytes.fill(0);
          return { kind: "value", bytes: decoded };
        }
        if (answer.kind === "absent") return { kind: "absent" };
        return { kind: answer.kind === "error" && answer.locked ? "locked" : "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async write(slot: CustodySlot, bytes: Buffer): Promise<CustodyWrite> {
      if (!api) return "unavailable";
      // A C string: base64 text and its terminating NUL.
      const password = Buffer.concat([
        Buffer.from(bytes.toString("base64"), "ascii"),
        Buffer.alloc(1),
      ]);
      try {
        const answer = api.store(options.store, slot, LABEL[slot], password);
        if (answer.kind === "stored") return "stored";
        return answer.kind === "error" && answer.locked ? "locked" : "unavailable";
      } catch {
        return "unavailable";
      } finally {
        password.fill(0);
      }
    },
  };
}

/** One binding per process: koffi registers its struct type once. */
let bound: LibsecretApi | undefined;

/**
 * The libsecret binding, or undefined where libsecret cannot load (off Linux,
 * or a system without it), or where its environment selects a backend other
 * than the Secret Service. Its calls are synchronous D-Bus round trips. The
 * file imports nothing of the app's, so a probe's child process runs it as is.
 */
export function loadLibsecretApi(env: NodeJS.ProcessEnv = process.env): LibsecretApi | undefined {
  // libsecret's file backend keeps items in a file of its own, with a test password if one is set.
  if (env.SECRET_BACKEND !== undefined && env.SECRET_BACKEND !== "service") return undefined;
  if (env.SECRET_FILE_TEST_PATH !== undefined || env.SECRET_FILE_TEST_PASSWORD !== undefined)
    return undefined;
  try {
    bound ??= bindLibsecret();
    return bound;
  } catch {
    return undefined;
  }
}

const isNull = (pointer: unknown) => pointer == null || pointer === 0n || pointer === 0;

function bindLibsecret(): LibsecretApi {
  const secret = koffi.load("libsecret-1.so.0");
  const glib = koffi.load("libglib-2.0.so.0");
  const gio = koffi.load("libgio-2.0.so.0");
  const libc = koffi.load("libc.so.6");
  const GError = koffi.struct("InfinitarySecretsGError", {
    domain: "uint32",
    code: "int",
    message: "void *",
  });
  const errorOut = koffi.out(koffi.pointer("void *"));
  const schemaNew = secret.func("secret_schema_new", "void *", ["const char *", "int", "..."]);
  const lookup = secret.func("secret_password_lookup_sync", "void *", [
    "void *",
    "void *",
    errorOut,
    "...",
  ]);
  const store = secret.func("secret_password_store_sync", "int", [
    "void *",
    "const char *",
    "const char *",
    "void *",
    "void *",
    errorOut,
    "...",
  ]);
  const passwordFree = secret.func("secret_password_free", "void", ["void *"]);
  const secretErrorQuark = secret.func("secret_error_get_quark", "uint32", []);
  const ioErrorQuark = gio.func("g_io_error_quark", "uint32", []);
  const errorFree = glib.func("g_error_free", "void", ["void *"]);
  const strlen = libc.func("strlen", "size_t", ["void *"]);

  // SECRET_SCHEMA_NONE: the schema's name is matched too, so another app's items never answer.
  const schema = schemaNew(
    "app.infinitary.Secrets",
    0,
    "const char *",
    "store",
    "int",
    0,
    "const char *",
    "slot",
    "int",
    0,
    "void *",
    null,
  );
  if (isNull(schema)) throw new Error("libsecret made no schema");

  const failure = (error: unknown): LibsecretAnswer => {
    const { domain, code } = koffi.decode(error, GError) as { domain: number; code: number };
    errorFree(error);
    const locked =
      (domain === secretErrorQuark() && code === SECRET_IS_LOCKED) ||
      (domain === ioErrorQuark() && code === IO_CANCELLED);
    return { kind: "error", locked };
  };
  const attributes = (name: string, slot: string) => [
    "const char *",
    "store",
    "const char *",
    name,
    "const char *",
    "slot",
    "const char *",
    slot,
    "void *",
    null,
  ];

  return {
    lookup: (name, slot) => {
      const error: [unknown] = [null];
      const found = lookup(schema, null, error, ...attributes(name, slot));
      if (!isNull(error[0])) return failure(error[0]);
      if (isNull(found)) return { kind: "absent" };
      try {
        const length = Number(strlen(found));
        return {
          kind: "value",
          bytes: Buffer.from(koffi.decode(found, koffi.array("uint8", length)) as number[]),
        };
      } finally {
        // Clears the memory before freeing it.
        passwordFree(found);
      }
    },
    store: (name, slot, label, password) => {
      const error: [unknown] = [null];
      const stored = store(schema, null, label, password, null, error, ...attributes(name, slot));
      if (!isNull(error[0])) return failure(error[0]);
      return stored ? { kind: "stored" } : { kind: "error", locked: false };
    },
  };
}
