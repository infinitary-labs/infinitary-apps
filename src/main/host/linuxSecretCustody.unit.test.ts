import { describe, expect, it, vi } from "vitest";
import type { CustodySlot } from "../../core/secrets/custody";
import {
  createLinuxSecretCustody,
  LibsecretFailure,
  type LibsecretService,
  libsecretFromService,
} from "./linuxSecretCustody";

// Intent: INF-1109's explicit instruction: a lookup never unlocks, and only an
// explicit request may unlock. This fake models Secret Service's locked paths,
// separate GetSecret and Unlock calls, and an item locking between those calls.
// It is not native-service or human-confirmation proof.
const STORE = "infinitary-probe";
const COLLECTION = "/org/freedesktop/secrets/collection/login";
const ROOT = Buffer.alloc(32, 5);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type Item = { store: string; slot: CustodySlot; value: Buffer; locked: boolean };
function fixture() {
  const items = new Map<string, Item>();
  let collectionLocked = false;
  let collectionExists = true;
  let acceptUnlock = true;
  const add = (slot: CustodySlot, value = ROOT, store = STORE) => {
    const path = `${COLLECTION}/${items.size + 1}`;
    items.set(path, {
      store,
      slot,
      value: Buffer.from(value.toString("base64")),
      locked: collectionLocked,
    });
    return path;
  };
  const service = {
    search: vi.fn(async (store: string, slot: CustodySlot) => {
      const selected = [...items].filter(([, item]) => item.store === store && item.slot === slot);
      return {
        unlocked: selected.filter(([, item]) => !item.locked).map(([path]) => path),
        locked: selected.filter(([, item]) => item.locked).map(([path]) => path),
      };
    }),
    read: vi.fn(async (path: string) => {
      const item = items.get(path);
      if (item?.locked) throw new LibsecretFailure(true);
      return item ? Buffer.from(item.value) : undefined;
    }),
    replace: vi.fn(async (path: string, password: Buffer) => {
      const item = items.get(path);
      if (!item) throw new LibsecretFailure(false);
      if (item.locked) throw new LibsecretFailure(true);
      item.value = Buffer.from(password);
    }),
    collection: vi.fn(async () =>
      collectionExists ? { path: COLLECTION, locked: collectionLocked } : undefined,
    ),
    create: vi.fn(
      async (
        _collection: string,
        store: string,
        slot: CustodySlot,
        _label: string,
        password: Buffer,
      ) => {
        if (collectionLocked) throw new LibsecretFailure(true);
        items.set(`${COLLECTION}/${items.size + 1}`, {
          store,
          slot,
          value: Buffer.from(password),
          locked: false,
        });
        return true;
      },
    ),
    delete: vi.fn(async (path: string) => {
      const item = items.get(path);
      if (item?.locked) throw new LibsecretFailure(true);
      return items.delete(path);
    }),
    unlock: vi.fn(async (paths: string[]) => {
      if (!acceptUnlock) return;
      if (paths.includes(COLLECTION)) collectionLocked = false;
      for (const [path, item] of items)
        if (paths.includes(COLLECTION) || paths.includes(path)) item.locked = false;
    }),
  } satisfies LibsecretService;
  const custody = createLinuxSecretCustody(libsecretFromService(service), { store: STORE });
  return {
    service,
    custody,
    items,
    add,
    lock() {
      collectionLocked = true;
      for (const item of items.values()) item.locked = true;
    },
    noCollection() {
      collectionExists = false;
    },
    rejectUnlock() {
      acceptUnlock = false;
    },
  };
}

describe("noninteractive Linux custody", () => {
  // Intent: Reset Infinitary clears its Secrets items, or Secrets would open
  // as tampered beside the fresh folder (docs/reset.md, "Outside the folder").
  it("removes only its own store's slot, and leaves a locked item for the person", async () => {
    const f = fixture();
    f.add("root");
    f.add("root", ROOT, "Another store");
    expect(await f.custody.remove?.("root")).toBe("removed");
    expect([...f.items.values()].map((item) => item.store)).toEqual(["Another store"]);
    expect(await f.custody.remove?.("root")).toBe("absent");
    f.add("authority-head");
    f.lock();
    expect(await f.custody.remove?.("authority-head")).toBe("locked");
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("reports a locked item without reading its value, unlocking or creating anything", async () => {
    const f = fixture();
    f.add("root");
    f.lock();
    expect(await f.custody.read("root")).toEqual({ kind: "locked" });
    expect(await f.custody.write("root", ROOT)).toBe("locked");
    expect(f.service.read).not.toHaveBeenCalled();
    expect(f.service.replace).not.toHaveBeenCalled();
    expect(f.service.create).not.toHaveBeenCalled();
    expect(f.service.unlock).not.toHaveBeenCalled();
    expect([...f.items.values()][0]?.locked).toBe(true);
  });

  it("opens only after an explicit unlock and then reads the same root", async () => {
    const f = fixture();
    const root = f.add("root");
    const head = f.add("authority-head", Buffer.from('{"revision":1}'));
    f.lock();
    expect(await f.custody.read("root")).toEqual({ kind: "locked" });
    expect(await f.custody.unlock()).toBe(true);
    expect(f.service.unlock).toHaveBeenCalledExactlyOnceWith([root, head]);
    expect(await f.custody.read("root")).toEqual({ kind: "value", bytes: ROOT });
    expect(f.service.create).not.toHaveBeenCalled();
  });

  it("keeps a refused unlock locked and never reports it as success", async () => {
    const f = fixture();
    f.add("root");
    f.lock();
    f.rejectUnlock();
    expect(await f.custody.unlock()).toBe(false);
    expect(await f.custody.read("root")).toEqual({ kind: "locked" });
    expect(f.service.read).not.toHaveBeenCalled();
  });

  it("refuses a first write to a locked collection until explicit unlock", async () => {
    const f = fixture();
    f.lock();
    expect(await f.custody.write("root", ROOT)).toBe("locked");
    expect(f.service.unlock).not.toHaveBeenCalled();
    expect(f.items.size).toBe(0);
    expect(await f.custody.unlock()).toBe(true);
    expect(f.service.unlock).toHaveBeenCalledExactlyOnceWith([COLLECTION]);
    expect(await f.custody.write("root", ROOT)).toBe("stored");
    expect(await f.custody.read("root")).toEqual({ kind: "value", bytes: ROOT });
  });

  it("reports a lock between search and value reading without attempting unlock", async () => {
    const f = fixture();
    f.add("root");
    const read = f.service.read.getMockImplementation();
    f.service.read.mockImplementationOnce(async (path) => {
      f.lock();
      return read?.(path);
    });
    expect(await f.custody.read("root")).toEqual({ kind: "locked" });
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("rechecks a missing GetSecrets result because the service omits newly locked items", async () => {
    const f = fixture();
    f.add("root");
    f.service.read.mockImplementationOnce(async () => {
      f.lock();
      return undefined;
    });
    expect(await f.custody.read("root")).toEqual({ kind: "locked" });
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("does not report an existing but unreadable item as absent", async () => {
    const f = fixture();
    f.add("root");
    f.service.read.mockResolvedValueOnce(undefined);
    expect(await f.custody.read("root")).toEqual({ kind: "unavailable" });
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("rechecks the collection when creation cannot finish without a prompt", async () => {
    const f = fixture();
    f.service.create.mockImplementationOnce(async () => {
      f.lock();
      return false;
    });
    expect(await f.custody.write("root", ROOT)).toBe("locked");
    expect(f.service.unlock).not.toHaveBeenCalled();
    expect(f.items.size).toBe(0);
  });

  it("reports a lock racing replacement without changing the stored value", async () => {
    const f = fixture();
    const path = f.add("root");
    const replace = f.service.replace.getMockImplementation();
    f.service.replace.mockImplementationOnce(async (item, bytes) => {
      f.lock();
      await replace?.(item, bytes);
    });
    expect(await f.custody.write("root", Buffer.alloc(32, 9))).toBe("locked");
    expect(f.items.get(path)?.value).toEqual(Buffer.from(ROOT.toString("base64")));
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("replaces the existing item rather than copying it into another default collection", async () => {
    const f = fixture();
    const path = f.add("root");
    f.service.collection.mockResolvedValue({
      path: "/org/freedesktop/secrets/collection/other",
      locked: true,
    });
    const next = Buffer.alloc(32, 7);
    expect(await f.custody.write("root", next)).toBe("stored");
    expect(await f.custody.read("root")).toEqual({ kind: "value", bytes: next });
    expect([...f.items.keys()]).toEqual([path]);
    expect(f.service.collection).not.toHaveBeenCalled();
    expect(f.service.create).not.toHaveBeenCalled();
    expect(f.service.unlock).not.toHaveBeenCalled();
  });

  it("does not treat another flavor's items as this store or create a missing collection", async () => {
    const f = fixture();
    f.add("root", ROOT, "infinitary-dev-probe");
    f.noCollection();
    expect(await f.custody.read("root")).toEqual({ kind: "absent" });
    expect(await f.custody.write("root", ROOT)).toBe("unavailable");
    expect(await f.custody.unlock()).toBe(false);
    expect(f.service.create).not.toHaveBeenCalled();
    expect(f.service.unlock).not.toHaveBeenCalled();
    expect(f.items.size).toBe(1);
  });

  it("does not choose between conflicting native custody items", async () => {
    const f = fixture();
    f.add("root");
    f.add("root", Buffer.alloc(32, 7));
    expect(await f.custody.read("root")).toEqual({ kind: "unavailable" });
    expect(await f.custody.write("root", ROOT)).toBe("unavailable");
    expect(f.service.read).not.toHaveBeenCalled();
    expect(f.service.replace).not.toHaveBeenCalled();
  });

  // INF-1109 recovery cannot discard staged files on a lost D-Bus write reply.
  it.each(["create", "replace"] as const)(
    "does not turn a lost native write reply during %s into a definite refusal",
    async (operation) => {
      const f = fixture();
      if (operation === "replace") f.add("root");
      f.service[operation].mockRejectedValueOnce(new LibsecretFailure(false));
      await expect(f.custody.write("root", ROOT)).rejects.toThrow("write outcome is unknown");
      expect(f.service[operation]).toHaveBeenCalledTimes(1);
      expect(f.service.unlock).not.toHaveBeenCalled();
    },
  );

  it("refuses a failed lookup before sending any native write", async () => {
    const f = fixture();
    f.service.search.mockRejectedValueOnce(new LibsecretFailure(false));
    expect(await f.custody.write("root", ROOT)).toBe("unavailable");
    expect(f.service.replace).not.toHaveBeenCalled();
    expect(f.service.create).not.toHaveBeenCalled();
  });

  it("retains a pending native write's buffer until it finishes, then clears it", async () => {
    const f = fixture();
    const entered = deferred<Buffer>();
    const finish = deferred<void>();
    const create = f.service.create.getMockImplementation();
    f.service.create.mockImplementationOnce(async (...args) => {
      entered.resolve(args[4]);
      await finish.promise;
      return (await create?.(...args)) ?? false;
    });
    const write = f.custody.write("root", ROOT);
    const password = await entered.promise;
    expect(password.toString()).toBe(ROOT.toString("base64"));
    finish.resolve(undefined);
    expect(await write).toBe("stored");
    expect(password.every((byte) => byte === 0)).toBe(true);
    expect(await f.custody.read("root")).toEqual({ kind: "value", bytes: ROOT });
  });

  it("clears the native read copy without clearing the store's value", async () => {
    const f = fixture();
    const path = f.add("root");
    expect(await f.custody.read("root")).toEqual({ kind: "value", bytes: ROOT });
    const copy = await f.service.read.mock.results[0]?.value;
    expect(copy?.every((byte: number) => byte === 0)).toBe(true);
    expect(f.items.get(path)?.value).toEqual(Buffer.from(ROOT.toString("base64")));
  });
});
