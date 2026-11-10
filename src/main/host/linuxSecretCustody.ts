import koffi from "koffi";
import type {
  CustodyRead,
  CustodySlot,
  CustodyWrite,
  SecretCustody,
} from "../../core/secrets/custody";

/**
 * Linux Secret Service custody. The protocol requires no app-specific access
 * control: the GNOME Keyring backend used by our proof lets another same-user
 * program read these items while unlocked and bypass app approval. Other
 * providers may add prompts; this is no portable app-bound guarantee.
 * Ordinary reads/writes never request an unlock or run a returned prompt.
 * Potentially blocking native calls use Koffi's worker pool, not the main thread.
 * Nothing falls back to a file, another backend or another collection.
 */
export type LibsecretAnswer =
  | { kind: "value"; bytes: Buffer }
  | { kind: "absent" }
  | { kind: "stored" }
  | { kind: "error"; locked: boolean };

export type LibsecretApi = {
  lookup(store: string, slot: CustodySlot): Promise<LibsecretAnswer>;
  store(
    store: string,
    slot: CustodySlot,
    label: string,
    password: Buffer,
  ): Promise<LibsecretAnswer>;
  /** Only the person's explicit Unlock request reaches this method. */
  unlock(store: string): Promise<boolean>;
};

/** The low-level service operations: none but unlock may invoke Secret Service Unlock/Prompt. */
export type LibsecretService = {
  search(store: string, slot: CustodySlot): Promise<{ unlocked: string[]; locked: string[] }>;
  read(path: string): Promise<Buffer | undefined>;
  replace(path: string, password: Buffer): Promise<void>;
  collection(): Promise<{ path: string; locked: boolean } | undefined>;
  create(
    collection: string,
    store: string,
    slot: CustodySlot,
    label: string,
    password: Buffer,
  ): Promise<boolean>;
  unlock(paths: string[]): Promise<void>;
};

/** Classified native failure, never a library message that might contain private data. */
export class LibsecretFailure extends Error {
  readonly locked: boolean;

  constructor(locked: boolean) {
    super(locked ? "The secret store is locked." : "The secret store is unavailable.");
    this.locked = locked;
  }
}

export type LinuxCustodyOptions = { store: string };
export type LinuxSecretCustody = SecretCustody & { unlock(): Promise<boolean> };

const LABEL: Record<CustodySlot, string> = {
  root: "Infinitary Secrets root key",
  "authority-head": "Infinitary Secrets rules check",
};
const SLOTS: readonly CustodySlot[] = ["root", "authority-head"];

export function createLinuxSecretCustody(
  api: LibsecretApi | undefined,
  options: LinuxCustodyOptions,
): LinuxSecretCustody {
  return {
    async read(slot): Promise<CustodyRead> {
      if (!api) return { kind: "unavailable" };
      try {
        const answer = await api.lookup(options.store, slot);
        if (answer.kind === "value") {
          try {
            return { kind: "value", bytes: Buffer.from(answer.bytes.toString("ascii"), "base64") };
          } finally {
            answer.bytes.fill(0);
          }
        }
        if (answer.kind === "absent") return { kind: "absent" };
        return { kind: answer.kind === "error" && answer.locked ? "locked" : "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async write(slot, bytes): Promise<CustodyWrite> {
      if (!api) return "unavailable";
      const password = Buffer.from(bytes.toString("base64"), "ascii");
      try {
        const answer = await api.store(options.store, slot, LABEL[slot], password);
        if (answer.kind === "stored") return "stored";
        return answer.kind === "error" && answer.locked ? "locked" : "unavailable";
      } catch {
        throw new Error("The native Secrets write outcome is unknown.");
      } finally {
        password.fill(0);
      }
    },
    async unlock() {
      try {
        return (await api?.unlock(options.store)) ?? false;
      } catch {
        return false;
      }
    },
  };
}

/** Shared with fake-store tests; task, renderer and saved data never supply this capability. */
export function libsecretFromService(service: LibsecretService): LibsecretApi {
  const failure = (error: unknown): LibsecretAnswer => ({
    kind: "error",
    locked: error instanceof LibsecretFailure && error.locked,
  });
  // Serialize operations over the service session without blocking the event loop.
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  return {
    lookup: (store, slot) =>
      run(async () => {
        try {
          const found = await service.search(store, slot);
          if (found.locked.length) return { kind: "error", locked: true };
          if (found.unlocked.length === 0) return { kind: "absent" };
          // A custody slot is one item; conflicting native records identify no unique root/head.
          if (found.unlocked.length !== 1) return { kind: "error", locked: false };
          const bytes = await service.read(found.unlocked[0] as string);
          if (bytes) return { kind: "value", bytes };
          // GetSecrets omits locked items rather than raising IsLocked. A racing
          // lock must not masquerade as an absent root that may be initialized.
          const current = await service.search(store, slot);
          if (current.locked.length) return { kind: "error", locked: true };
          return current.unlocked.length === 0
            ? { kind: "absent" }
            : { kind: "error", locked: false };
        } catch (error) {
          return failure(error);
        }
      }),
    store: (store, slot, label, password) =>
      run(async () => {
        let attempted = false;
        try {
          const found = await service.search(store, slot);
          if (found.locked.length) return { kind: "error", locked: true };
          if (found.unlocked.length > 1) return { kind: "error", locked: false };
          if (found.unlocked.length === 1) {
            attempted = true;
            await service.replace(found.unlocked[0] as string, password);
            return { kind: "stored" };
          }
          const collection = await service.collection();
          if (!collection) return { kind: "error", locked: false };
          if (collection.locked) return { kind: "error", locked: true };
          attempted = true;
          if (await service.create(collection.path, store, slot, label, password))
            return { kind: "stored" };
          const current = await service.collection();
          return { kind: "error", locked: current?.path === collection.path && current.locked };
        } catch (error) {
          if (attempted && !(error instanceof LibsecretFailure && error.locked))
            throw new Error("The native Secrets write outcome is unknown.");
          return failure(error);
        }
      }),
    unlock: (store) =>
      run(async () => {
        try {
          const paths = new Set<string>();
          let needsCollection = false;
          for (const slot of SLOTS) {
            const found = await service.search(store, slot);
            for (const path of found.locked) paths.add(path);
            if (!found.locked.length && !found.unlocked.length) needsCollection = true;
          }
          const collection = needsCollection ? await service.collection() : undefined;
          if (needsCollection && !collection) return false;
          if (collection?.locked) paths.add(collection.path);
          if (paths.size) await service.unlock([...paths]);
          for (const slot of SLOTS) {
            if ((await service.search(store, slot)).locked.length) return false;
          }
          if (!needsCollection) return true;
          const current = await service.collection();
          return current !== undefined && !current.locked;
        } catch {
          return false;
        }
      }),
  };
}

/** Koffi dispatches this call on a native worker; no synchronous store call is made here. */
export function secretNativeCall(
  fn: { async: (...args: unknown[]) => unknown },
  ...args: unknown[]
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      fn.async(...args, (error: unknown, value: unknown) => {
        if (error) reject(new LibsecretFailure(false));
        else resolve(value);
      });
    } catch {
      reject(new LibsecretFailure(false));
    }
  });
}

let bound: LibsecretApi | undefined;

/** No session bus, missing native library or selected file backend means unavailable. */
export function loadLibsecretApi(env: NodeJS.ProcessEnv = process.env): LibsecretApi | undefined {
  if (env.SECRET_BACKEND !== undefined && env.SECRET_BACKEND !== "service") return undefined;
  if (env.SECRET_FILE_TEST_PATH !== undefined || env.SECRET_FILE_TEST_PASSWORD !== undefined)
    return undefined;
  try {
    bound ??= libsecretFromService(bindLibsecret());
    return bound;
  } catch {
    return undefined;
  }
}

const isNull = (pointer: unknown) => pointer == null || pointer === 0n || pointer === 0;

function bindLibsecret(): LibsecretService {
  const secret = koffi.load("libsecret-1.so.0");
  const glib = koffi.load("libglib-2.0.so.0");
  const gio = koffi.load("libgio-2.0.so.0");
  const objects = koffi.load("libgobject-2.0.so.0");
  const GError = koffi.struct("InfinitarySecretsGError", {
    domain: "uint32",
    code: "int",
    message: "void *",
  });
  const outPointer = koffi.out(koffi.pointer("void *"));
  const serviceType = secret.func("uintptr_t secret_service_get_type(void)")();
  const openService = secret.func("secret_service_open_sync", "void *", [
    "uintptr_t",
    "const char *",
    "int",
    "void *",
    outPointer,
  ]);
  const ensureSession = secret.func("secret_service_ensure_session_sync", "int", [
    "void *",
    "void *",
    outPointer,
  ]);
  const search = secret.func("secret_service_search_for_dbus_paths_sync", "int", [
    "void *",
    "void *",
    "void *",
    "void *",
    outPointer,
    outPointer,
    outPointer,
  ]);
  const read = secret.func("secret_service_get_secret_for_dbus_path_sync", "void *", [
    "void *",
    "const char *",
    "void *",
    outPointer,
  ]);
  const alias = secret.func("secret_service_read_alias_dbus_path_sync", "void *", [
    "void *",
    "const char *",
    "void *",
    outPointer,
  ]);
  const unlock = secret.func("secret_service_unlock_dbus_paths_sync", "int", [
    "void *",
    "const char **",
    "void *",
    outPointer,
    outPointer,
  ]);
  const schemaNew = secret.func("secret_schema_new", "void *", ["const char *", "int", "..."]);
  const attributesBuild = secret.func("secret_attributes_build", "void *", ["void *", "..."]);
  const valueNew = secret.func("secret_value_new", "void *", ["void *", "long", "const char *"]);
  const valueGet = secret.func("secret_value_get", "void *", [
    "void *",
    koffi.out(koffi.pointer("size_t")),
  ]);
  const valueUnref = secret.func("secret_value_unref", "void", ["void *"]);
  const encode = secret.func("secret_service_encode_dbus_secret", "void *", ["void *", "void *"]);
  const errorQuark = secret.func("secret_error_get_quark", "uint32", []);
  const remoteError = gio.func("g_dbus_error_get_remote_error", "void *", ["void *"]);
  const errorFree = glib.func("g_error_free", "void", ["void *"]);
  const free = glib.func("g_free", "void", ["void *"]);
  const strvLength = glib.func("g_strv_length", "uint32", ["void *"]);
  const strvFree = glib.func("g_strfreev", "void", ["void *"]);
  const hashUnref = glib.func("g_hash_table_unref", "void", ["void *"]);
  const unref = objects.func("g_object_unref", "void", ["void *"]);
  const connection = gio.func("g_dbus_proxy_get_connection", "void *", ["void *"]);
  const name = gio.func("g_dbus_proxy_get_name", "const char *", ["void *"]);
  const call = gio.func("g_dbus_connection_call_sync", "void *", [
    "void *",
    "const char *",
    "const char *",
    "const char *",
    "const char *",
    "void *",
    "void *",
    "int",
    "int",
    "void *",
    outPointer,
  ]);
  const typeNew = glib.func("g_variant_type_new", "void *", ["const char *"]);
  const typeFree = glib.func("g_variant_type_free", "void", ["void *"]);
  const variantUnref = glib.func("g_variant_unref", "void", ["void *"]);
  const variantSink = glib.func("g_variant_ref_sink", "void *", ["void *"]);
  const string = glib.func("g_variant_new_string", "void *", ["const char *"]);
  const boolean = glib.func("g_variant_new_boolean", "void *", ["int"]);
  const variant = glib.func("g_variant_new_variant", "void *", ["void *"]);
  const dictEntry = glib.func("g_variant_new_dict_entry", "void *", ["void *", "void *"]);
  const array = glib.func("g_variant_new_array", "void *", ["void *", "void **", "size_t"]);
  const tuple = glib.func("g_variant_new_tuple", "void *", ["void **", "size_t"]);
  const child = glib.func("g_variant_get_child_value", "void *", ["void *", "size_t"]);
  const unbox = glib.func("g_variant_get_variant", "void *", ["void *"]);
  const getBoolean = glib.func("g_variant_get_boolean", "int", ["void *"]);
  const getString = glib.func("g_variant_get_string", "const char *", ["void *", "void *"]);

  const schemaName = "app.infinitary.Secrets";
  const schema = schemaNew(
    schemaName,
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
  if (isNull(schema)) throw new LibsecretFailure(false);

  const checked = (error: unknown) => {
    if (isNull(error)) return;
    const { domain, code } = koffi.decode(error, GError) as { domain: number; code: number };
    const remote = remoteError(error);
    const locked =
      (domain === errorQuark() && code === 2) ||
      (!isNull(remote) &&
        koffi.decode(remote, "char", -1) === "org.freedesktop.Secret.Error.IsLocked");
    if (!isNull(remote)) free(remote);
    errorFree(error);
    throw new LibsecretFailure(locked);
  };
  const strings = (pointer: unknown): string[] => {
    const length = isNull(pointer) ? 0 : Number(strvLength(pointer));
    return length === 0
      ? []
      : (koffi.decode(pointer, koffi.array("const char *", length)) as string[]);
  };
  const withService = async <T>(operation: (service: unknown) => Promise<T>): Promise<T> => {
    const error: [unknown] = [null];
    // The process-wide default proxy caches a daemon's encrypted session.
    // Our worker calls have no lasting GLib event loop to refresh that cache
    // after a keeper restart, so each operation owns and releases its proxy.
    const service = await secretNativeCall(openService, serviceType, null, 0, null, error);
    checked(error[0]);
    if (isNull(service)) throw new LibsecretFailure(false);
    try {
      return await operation(service);
    } finally {
      unref(service);
    }
  };
  const session = async (service: unknown) => {
    const error: [unknown] = [null];
    const ok = await secretNativeCall(ensureSession, service, null, error);
    checked(error[0]);
    if (!ok) throw new LibsecretFailure(false);
  };
  const dictionary = (entries: [string, unknown][], signature: "{ss}" | "{sv}") => {
    const type = typeNew(signature);
    try {
      return array(
        type,
        entries.map(([key, value]) => dictEntry(string(key), value)),
        entries.length,
      );
    } finally {
      typeFree(type);
    }
  };
  const rpc = async (
    service: unknown,
    path: string,
    iface: string,
    method: string,
    params: unknown,
    result: string,
  ) => {
    const type = typeNew(result);
    if (!isNull(params)) variantSink(params);
    try {
      const error: [unknown] = [null];
      // -1 is GDBus's own default timeout, not an app-created deadline.
      const answer = await secretNativeCall(
        call,
        connection(service),
        name(service),
        path,
        iface,
        method,
        params,
        type,
        0,
        -1,
        null,
        error,
      );
      checked(error[0]);
      if (isNull(answer)) throw new LibsecretFailure(false);
      return answer;
    } finally {
      typeFree(type);
      if (!isNull(params)) variantUnref(params);
    }
  };

  return {
    search: (store, slot) =>
      withService(async (service) => {
        const attributes = attributesBuild(
          schema,
          "const char *",
          "store",
          "const char *",
          store,
          "const char *",
          "slot",
          "const char *",
          slot,
          "void *",
          null,
        );
        const unlocked: [unknown] = [null];
        const locked: [unknown] = [null];
        const error: [unknown] = [null];
        try {
          const ok = await secretNativeCall(
            search,
            service,
            schema,
            attributes,
            null,
            unlocked,
            locked,
            error,
          );
          checked(error[0]);
          if (!ok) throw new LibsecretFailure(false);
          return { unlocked: strings(unlocked[0]), locked: strings(locked[0]) };
        } finally {
          hashUnref(attributes);
          if (!isNull(unlocked[0])) strvFree(unlocked[0]);
          if (!isNull(locked[0])) strvFree(locked[0]);
        }
      }),
    read: (path) =>
      withService(async (service) => {
        await session(service);
        const error: [unknown] = [null];
        const value = await secretNativeCall(read, service, path, null, error);
        checked(error[0]);
        if (isNull(value)) return undefined;
        try {
          const length = [0];
          const bytes = valueGet(value, length);
          const size = Number(length[0]);
          return size === 0
            ? Buffer.alloc(0)
            : Buffer.from(koffi.decode(bytes, koffi.array("uint8", size)) as number[]);
        } finally {
          valueUnref(value);
        }
      }),
    collection: () =>
      withService(async (service) => {
        const error: [unknown] = [null];
        const named = await secretNativeCall(alias, service, "default", null, error);
        checked(error[0]);
        if (isNull(named)) return undefined;
        let path: string;
        try {
          path = koffi.decode(named, "char", -1) as string;
        } finally {
          free(named);
        }
        if (path === "/") return undefined;
        const params = tuple([string("org.freedesktop.Secret.Collection"), string("Locked")], 2);
        const answer = await rpc(
          service,
          path,
          "org.freedesktop.DBus.Properties",
          "Get",
          params,
          "(v)",
        );
        const boxed = child(answer, 0);
        const value = unbox(boxed);
        try {
          return { path, locked: getBoolean(value) !== 0 };
        } finally {
          variantUnref(value);
          variantUnref(boxed);
          variantUnref(answer);
        }
      }),
    replace: (path, password) =>
      withService(async (service) => {
        await session(service);
        const value = valueNew(password, password.length, "text/plain");
        if (isNull(value)) throw new LibsecretFailure(false);
        let encoded: unknown;
        try {
          encoded = encode(service, value);
        } finally {
          valueUnref(value);
        }
        if (isNull(encoded)) throw new LibsecretFailure(false);
        const params = tuple([encoded], 1);
        const answer = await rpc(
          service,
          path,
          "org.freedesktop.Secret.Item",
          "SetSecret",
          params,
          "()",
        );
        variantUnref(answer);
      }),
    create: (collection, store, slot, label, password) =>
      withService(async (service) => {
        await session(service);
        const attributes = dictionary(
          [
            ["xdg:schema", string(schemaName)],
            ["store", string(store)],
            ["slot", string(slot)],
          ],
          "{ss}",
        );
        const properties = dictionary(
          [
            ["org.freedesktop.Secret.Item.Label", variant(string(label))],
            ["org.freedesktop.Secret.Item.Attributes", variant(attributes)],
          ],
          "{sv}",
        );
        const value = valueNew(password, password.length, "text/plain");
        if (isNull(value)) throw new LibsecretFailure(false);
        let encoded: unknown;
        try {
          encoded = encode(service, value);
        } finally {
          valueUnref(value);
        }
        if (isNull(encoded)) throw new LibsecretFailure(false);
        const params = tuple([properties, encoded, boolean(1)], 3);
        const answer = await rpc(
          service,
          collection,
          "org.freedesktop.Secret.Collection",
          "CreateItem",
          params,
          "(oo)",
        );
        const item = child(answer, 0);
        const prompt = child(answer, 1);
        let created: string;
        let needed: string;
        try {
          created = getString(item, null) as string;
          needed = getString(prompt, null) as string;
        } finally {
          variantUnref(item);
          variantUnref(prompt);
          variantUnref(answer);
        }
        if (needed !== "/") {
          // A provider may ask for a prompt, including after a racing lock. Never run it here.
          const dismissed = await rpc(
            service,
            needed,
            "org.freedesktop.Secret.Prompt",
            "Dismiss",
            null,
            "()",
          );
          variantUnref(dismissed);
          return false;
        }
        return created !== "/";
      }),
    unlock: (paths) =>
      withService(async (service) => {
        const unlocked: [unknown] = [null];
        const error: [unknown] = [null];
        try {
          await secretNativeCall(unlock, service, [...paths, null], null, unlocked, error);
          checked(error[0]);
        } finally {
          if (!isNull(unlocked[0])) strvFree(unlocked[0]);
        }
      }),
  };
}
