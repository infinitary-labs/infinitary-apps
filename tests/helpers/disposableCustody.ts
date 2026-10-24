import type {
  CustodyRead,
  CustodySlot,
  CustodyWrite,
  SecretCustody,
} from "../../src/core/secrets/custody";

/**
 * A disposable stand-in for platform custody (docs/secrets.md, "Native
 * custody"): slots held in this process's memory, with switches for the
 * states a real Keychain or Secret Service reports. A fixture only - the
 * native adapters' own probes prove the platform stores.
 */
export type DisposableCustody = SecretCustody & {
  state: "open" | "locked" | "unavailable";
  slots: Map<CustodySlot, Buffer>;
  writes: CustodySlot[];
};

export function disposableCustody(): DisposableCustody {
  const custody: DisposableCustody = {
    state: "open",
    slots: new Map(),
    writes: [],
    async read(slot): Promise<CustodyRead> {
      if (custody.state !== "open") return { kind: custody.state };
      const bytes = custody.slots.get(slot);
      return bytes ? { kind: "value", bytes: Buffer.from(bytes) } : { kind: "absent" };
    },
    async write(slot, bytes): Promise<CustodyWrite> {
      if (custody.state !== "open") return custody.state;
      custody.slots.set(slot, Buffer.from(bytes));
      custody.writes.push(slot);
      return "stored";
    },
  };
  return custody;
}
