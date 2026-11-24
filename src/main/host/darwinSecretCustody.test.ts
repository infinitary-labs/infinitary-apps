import { describe, expect, it } from "vitest";
import { createDarwinSecretCustody, type DarwinCustodyApi } from "./darwinSecretCustody";

// Intent: INF-1105 - native custody with no plaintext or unprotected fallback:
// what the Keychain answers is what the owner hears, and a locked store is
// never opened with a dialog the person did not ask for (docs/secrets.md,
// "Native custody"). The real Keychain is the opt-in scratch probe's.
const SERVICE = "Infinitary Secrets (development)";

function keychain(status?: number) {
  const items = new Map<string, Buffer>();
  const interaction: boolean[] = [];
  const offThread: string[] = [];
  const api: DarwinCustodyApi = {
    setUserInteractionAllowed: (allowed) => {
      interaction.push(allowed);
    },
    read: (service, account) => {
      if (status !== undefined) return { status };
      const bytes = items.get(`${service}/${account}`);
      return bytes ? { status: 0, bytes: Buffer.from(bytes) } : { status: -25300 };
    },
    readOffThread: async (service, account) => {
      offThread.push(account);
      return api.read(service, account);
    },
    write: (service, account, bytes) => {
      if (status !== undefined) return status;
      items.set(`${service}/${account}`, Buffer.from(bytes));
      return 0;
    },
    remove: (service, account) => {
      if (status !== undefined) return status;
      return items.delete(`${service}/${account}`) ? 0 : -25300;
    },
  };
  return { api, items, interaction, offThread };
}

describe("macOS Keychain custody", () => {
  it("keeps each slot as its own item under the flavor's service, silently unless asked", async () => {
    const { api, items, interaction } = keychain();
    const custody = createDarwinSecretCustody(api, { service: SERVICE });
    const root = Buffer.alloc(32, 7);
    expect(await custody.read("root")).toEqual({ kind: "absent" });
    expect(await custody.write("root", root)).toBe("stored");
    expect([...items.keys()]).toEqual([`${SERVICE}/root`]);
    expect(await custody.read("root")).toEqual({ kind: "value", bytes: root });
    expect(await custody.read("authority-head")).toEqual({ kind: "absent" });
    expect(interaction.every((allowed) => !allowed)).toBe(true);

    const asking = keychain();
    await createDarwinSecretCustody(asking.api, { service: SERVICE, interactive: true }).read(
      "root",
    );
    expect(asking.interaction).toEqual([true]);
  });

  // Intent: INF-6556 - Unlock's read with the Keychain's dialog allowed waits
  // off the main thread (INF-6543 measured 15.6 s stopped while it waited),
  // and silent reads keep their synchronous call.
  it("reads off the main thread only when the dialog is allowed", async () => {
    const { api, offThread } = keychain();
    const silent = createDarwinSecretCustody(api, { service: SERVICE });
    await silent.write("root", Buffer.alloc(32, 5));
    expect(await silent.read("root")).toEqual({ kind: "value", bytes: Buffer.alloc(32, 5) });
    expect(offThread).toEqual([]);
    const asking = createDarwinSecretCustody(api, { service: SERVICE, interactive: true });
    expect(await asking.read("root")).toEqual({ kind: "value", bytes: Buffer.alloc(32, 5) });
    expect(await asking.read("authority-head")).toEqual({ kind: "absent" });
    expect(offThread).toEqual(["root", "authority-head"]);
  });

  // Intent: INF-6556 - the dialog switch is one for the whole process, so no
  // other custody call may flip it while an interactive read waits on its dialog.
  it("holds every other custody call until a waiting interactive read settles", async () => {
    const { api, interaction } = keychain();
    let answer: (found: { status: number }) => void = () => {};
    api.readOffThread = () => new Promise((resolve) => (answer = resolve));
    const waiting = createDarwinSecretCustody(api, { service: SERVICE, interactive: true }).read(
      "root",
    );
    const other = keychain();
    const silent = createDarwinSecretCustody(other.api, { service: `${SERVICE} other` });
    const order: string[] = [];
    const held = [
      silent.read("root").then(() => order.push("read")),
      silent.write("root", Buffer.alloc(32)).then(() => order.push("write")),
      silent.remove?.("root").then(() => order.push("remove")),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    expect(interaction).toEqual([true]);
    expect(other.interaction).toEqual([]);
    expect(order).toEqual([]);

    answer({ status: -128 });
    expect(await waiting).toEqual({ kind: "locked" });
    await Promise.all(held);
    expect(order).toEqual(["read", "write", "remove"]);
    expect(other.interaction).toEqual([false, false, false]);
  });

  it.each([
    [-25308, "locked"],
    [-25293, "locked"],
    [-128, "locked"],
    [-60008, "locked"],
    [-25291, "unavailable"],
    [-34018, "unavailable"],
  ] as const)("reports OSStatus %i as %s, for reads and writes alike", async (status, kind) => {
    const custody = createDarwinSecretCustody(keychain(status).api, { service: SERVICE });
    expect(await custody.read("root")).toEqual({ kind });
    expect(await custody.write("root", Buffer.alloc(32))).toBe(kind);
  });

  // INF-1109 recovery must retain a staged generation after a lost native write reply.
  it("does not turn a lost native write reply into a definite refusal", async () => {
    const { api } = keychain();
    const write = api.write;
    let submitted: Buffer | undefined;
    api.write = (service, account, bytes) => {
      submitted = bytes;
      write(service, account, bytes);
      throw new Error("Fixture lost the reply after the native write.");
    };
    const custody = createDarwinSecretCustody(api, { service: SERVICE });
    const root = Buffer.alloc(32, 7);
    await expect(custody.write("root", root)).rejects.toThrow("write outcome is unknown");
    expect(await custody.read("root")).toEqual({ kind: "value", bytes: root });
    expect(submitted?.every((byte) => byte === 0)).toBe(true);
  });

  it("is unavailable without a Keychain, or when the binding throws", async () => {
    const none = createDarwinSecretCustody(undefined, { service: SERVICE });
    expect(await none.read("root")).toEqual({ kind: "unavailable" });
    expect(await none.write("root", Buffer.alloc(32))).toBe("unavailable");
    const broken = createDarwinSecretCustody(
      {
        setUserInteractionAllowed: () => {
          throw new Error("Security.framework is missing");
        },
        read: () => ({ status: 0 }),
        readOffThread: async () => ({ status: 0 }),
        write: () => 0,
        remove: () => 0,
      },
      { service: SERVICE },
    );
    expect(await broken.read("root")).toEqual({ kind: "unavailable" });
    expect(await broken.write("root", Buffer.alloc(32))).toBe("unavailable");
    expect(await broken.remove?.("root")).toBe("unavailable");
  });

  // Intent: Reset Infinitary clears its Secrets items, or Secrets would open
  // as tampered beside the fresh folder (docs/reset.md, "Outside the folder").
  it("removes one slot's item under its own service, and says when none was there", async () => {
    const { api, items } = keychain();
    const custody = createDarwinSecretCustody(api, { service: SERVICE });
    await custody.write("root", Buffer.alloc(32, 1));
    await custody.write("authority-head", Buffer.alloc(32, 2));
    expect(await custody.remove?.("root")).toBe("removed");
    expect([...items.keys()]).toEqual([`${SERVICE}/authority-head`]);
    expect(await custody.remove?.("root")).toBe("absent");
  });

  it("reports a locked Keychain's removal as locked, never removed", async () => {
    const custody = createDarwinSecretCustody(keychain(-25308).api, { service: SERVICE });
    expect(await custody.remove?.("root")).toBe("locked");
  });
});
