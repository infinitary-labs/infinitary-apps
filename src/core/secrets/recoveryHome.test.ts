import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ProtectedAuthority } from "./authority";
import { RootKeys } from "./custody";
import { ProtectedSecrets } from "./protected";
import {
  commitSecretHome,
  type HomeWitness,
  observeSecretHome,
  openSecretHome,
} from "./recoveryHome";
import { SecretVault } from "./vault";

// Intent: INF-1109 recovery must change native custody, the authority head and
// active files together. Actual sealed records and authority checks are used;
// only platform custody stands in. No personal keychain, phone or account.
async function fixture() {
  const base = scratchDir("secret-recovery-home-");
  const native = disposableCustody();
  const home = await openSecretHome(base, native);
  if (typeof home === "string") throw new Error("No fixture home.");
  const keys = await RootKeys.open(home.custody, { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error("No fixture root.");
  const authority = await ProtectedAuthority.load(home.dir, keys, home.custody);
  if (typeof authority === "string") throw new Error("No fixture authority.");
  const previous = authority.proposal({
    rules: [{ id: "old", effect: "ask", secret: "calendar" }],
    devices: [],
  });
  expect(await authority.save(previous.authority)).toBe("stored");
  const vault = new SecretVault(home.dir, keys);
  await vault.put("calendar", "Old calendar", Buffer.from("old-fixture-token"));
  const expected = await observeSecretHome(native);
  if (typeof expected === "string") throw new Error("No native observation.");
  return { base, native, home, keys, expected };
}
async function stage(base: string) {
  const generation = randomUUID();
  const dir = join(base, "recovered", generation);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const staged = disposableCustody();
  const keys = await RootKeys.open(staged, { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error("No staged root.");
  const authority = await ProtectedAuthority.load(dir, keys, staged);
  if (typeof authority === "string") throw new Error("No staged authority.");
  const vault = new SecretVault(dir, keys);
  await vault.put("calendar", "Recovered calendar", Buffer.from("recovered-fixture-token"));
  const root = staged.slots.get("root");
  const head = staged.slots.get("authority-head");
  if (!root || !head) throw new Error("Incomplete staged custody.");
  return { generation, root, head, dir, authority: authority.authority };
}
async function readHome(base: string, native: ReturnType<typeof disposableCustody>) {
  const home = await openSecretHome(base, native);
  if (typeof home === "string") return home;
  const keys = await RootKeys.open(home.custody, { initialize: false, hasRecords: true });
  if (typeof keys === "string") return keys;
  const authority = await ProtectedAuthority.load(home.dir, keys, home.custody);
  if (typeof authority === "string") return authority;
  return { home, authority, entry: await new SecretVault(home.dir, keys).open("calendar") };
}

describe("native recovery activation", () => {
  it("leaves staging inactive, then reopens the new root, head and files after one native write", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    const before = await readHome(f.base, f.native);
    if (typeof before === "string") throw new Error("Old home did not open.");
    expect(before.entry?.value.toString()).toBe("old-fixture-token");
    const writes = f.native.writes.length;
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("committed");
    expect(f.native.writes.slice(writes)).toEqual(["root"]);
    const reopened = await readHome(f.base, f.native);
    if (typeof reopened === "string") throw new Error("New home did not open.");
    expect(reopened.home.dir).toBe(next.dir);
    expect(reopened.entry?.value.toString()).toBe("recovered-fixture-token");
    expect(reopened.authority.authority).toEqual(next.authority);
    expect(reopened.authority.authority.home).not.toBe(before.authority.authority.home);
    expect(reopened.authority.authority.rules).toEqual([]);
    expect(reopened.authority.authority.devices).toEqual([]);
    const owner = await ProtectedSecrets.open({
      dir: f.base,
      custody: f.native,
      environment: () => ({}),
    });
    expect(await owner.status()).toBe("available");
    expect((await owner.metadata())[0]?.label).toBe("Recovered calendar");
    expect(
      (
        await owner.putSecret(
          "calendar",
          "Updated recovered calendar",
          Buffer.from("updated-fixture-token"),
        )
      )?.version,
    ).toBe(2);
    // A held writer of the earlier directory cannot overwrite the new head.
    expect(await f.home.custody.write("authority-head", next.head)).toBe("unavailable");
    // Older apps fail closed on the opaque native envelope, never initialize a replacement.
    expect(await RootKeys.open(f.native, { initialize: true, hasRecords: true })).toBe("lost");
  });

  it("continues to save protected authority in the selected home, not the legacy head slot", async () => {
    const f = await fixture();
    expect(await commitSecretHome(f.native, f.expected, await stage(f.base))).toBe("committed");
    const reopened = await readHome(f.base, f.native);
    if (typeof reopened === "string") throw new Error("No recovered home.");
    const legacyHead = Buffer.from(f.native.slots.get("authority-head") ?? []);
    const proposal = reopened.authority.proposal({
      rules: [{ id: "new", effect: "never", secret: "calendar" }],
      devices: [],
    });
    expect(await reopened.authority.save(proposal.authority)).toBe("stored");
    expect(f.native.slots.get("authority-head")).toEqual(legacyHead);
    const again = await readHome(f.base, f.native);
    if (typeof again === "string") throw new Error("Saved authority did not reopen.");
    expect(again.authority.authority).toEqual(proposal.authority);
    const witness = await observeSecretHome(f.native);
    if (typeof witness === "string") throw new Error("No current witness.");
    const another = await stage(f.base);
    expect(await commitSecretHome(f.native, witness, another)).toBe("committed");
    const last = await readHome(f.base, f.native);
    if (typeof last === "string") throw new Error("Repeated restore did not reopen.");
    expect(last.home.dir).toBe(another.dir);
  });

  // INF-3042: a lost native reply is not a refusal; both layouts retain the
  // exact pending record, refuse further saves and reconcile without replay.
  it.each([false, true])(
    "retains uncertain authority writes in a recovered=%s home",
    async (recovered) => {
      const f = await fixture();
      if (recovered)
        expect(await commitSecretHome(f.native, f.expected, await stage(f.base))).toBe("committed");
      const home = await readHome(f.base, f.native);
      if (typeof home === "string") throw new Error("No fixture authority.");
      const proposal = home.authority.proposal({
        rules: [{ id: "new", effect: "never", secret: "calendar" }],
        devices: [],
      });
      const write = f.native.write;
      let attempts = 0;
      let finish!: () => Promise<unknown>;
      f.native.write = async (slot, bytes) => {
        attempts++;
        const pending = Buffer.from(bytes);
        finish = async () => {
          try {
            return await write(slot, pending);
          } finally {
            pending.fill(0);
          }
        };
        throw new Error("Fixture lost the native write response.");
      };
      await expect(home.authority.save(proposal.authority)).rejects.toThrow("lost the native");
      const path = join(home.home.dir, "authority.next.json");
      const pending = await readFile(path);
      await expect(home.authority.save(proposal.authority)).rejects.toThrow("Reopen Secrets");
      expect(await readHome(f.base, f.native)).toBe("unavailable");
      expect(await readFile(path)).toEqual(pending);
      expect(await finish()).toBe("stored");
      const reopened = await readHome(f.base, f.native);
      if (typeof reopened === "string") throw new Error("Pending authority did not reconcile.");
      expect(reopened.authority.authority).toEqual(proposal.authority);
      expect(attempts).toBe(1);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps the old home when a native write refuses, and never retries a lost response", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    const write = f.native.write;
    let calls = 0;
    f.native.write = async () => {
      calls += 1;
      return "unavailable";
    };
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("unavailable");
    const old = await readHome(f.base, f.native);
    if (typeof old === "string") throw new Error("Old home was changed by refusal.");
    expect(old.entry?.value.toString()).toBe("old-fixture-token");
    f.native.write = async (slot, bytes) => {
      calls += 1;
      await write(slot, bytes);
      throw new Error("Fixture lost the native response after committing.");
    };
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("committed");
    expect(calls).toBe(2);
    const current = await readHome(f.base, f.native);
    if (typeof current === "string") throw new Error("Committed home did not reopen.");
    expect(current.entry?.value.toString()).toBe("recovered-fixture-token");
  });

  it("leaves an unreadable outcome unknown and reconciles it on a later open", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    const write = f.native.write;
    let calls = 0;
    f.native.write = async (slot, bytes) => {
      calls += 1;
      await write(slot, bytes);
      f.native.state = "unavailable";
      throw new Error("Fixture lost the native connection.");
    };
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("unknown");
    expect(calls).toBe(1);
    f.native.state = "open";
    const reopened = await readHome(f.base, f.native);
    if (typeof reopened === "string") throw new Error("Recovery could not reconcile.");
    expect(reopened.home.dir).toBe(next.dir);
    expect(calls).toBe(1);
  });

  it("refuses stale observations, reused roots, invalid paths and locked custody", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    const writes = f.native.writes.length;
    expect(await commitSecretHome(f.native, { kind: "absent" }, next)).toBe("changed");
    expect(
      await commitSecretHome(f.native, f.expected, { ...next, generation: "../outside" }),
    ).toBe("invalid");
    const oldRoot = f.native.slots.get("root");
    if (!oldRoot) throw new Error("No old root.");
    expect(await commitSecretHome(f.native, f.expected, { ...next, root: oldRoot })).toBe(
      "invalid",
    );
    f.native.state = "locked";
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("locked");
    expect(await openSecretHome(f.base, f.native)).toBe("locked");
    expect(f.native.writes.length).toBe(writes);
  });

  it("does not fall back to legacy files when a selected generation is missing or invalid", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    expect(await commitSecretHome(f.native, f.expected, next)).toBe("committed");
    await rm(next.dir, { recursive: true });
    expect(await readHome(f.base, f.native)).toBe("tampered");
    f.native.slots.set(
      "root",
      Buffer.from('{"format":"infinitary-secrets-home/1","generation":"../../elsewhere"}'),
    );
    expect(await openSecretHome(f.base, f.native)).toBe("lost");
  });

  it("never initializes over recovered values when their native root was lost", async () => {
    const base = scratchDir("secret-recovery-missing-root-");
    const native = disposableCustody();
    const next = await stage(base);
    expect(await commitSecretHome(native, { kind: "absent" }, next)).toBe("committed");
    native.slots.delete("root");
    const writes = native.writes.length;
    const owner = await ProtectedSecrets.open({
      dir: base,
      custody: native,
      initialize: true,
      environment: () => ({}),
    });
    expect(owner.availability).toBe("lost");
    expect(native.writes.length).toBe(writes);
  });

  it("snapshots stage inputs and the native observation before an asynchronous write", async () => {
    const f = await fixture();
    const next = await stage(f.base);
    const expected: HomeWitness = structuredClone(f.expected);
    const committed = commitSecretHome(f.native, expected, next);
    next.root.fill(0);
    next.head.fill(0);
    next.generation = randomUUID();
    if (expected.kind === "value") expected.digest = randomBytes(32).toString("hex");
    expect(await committed).toBe("committed");
    const reopened = await readHome(f.base, f.native);
    if (typeof reopened === "string") throw new Error("Copied inputs did not open.");
    expect(reopened.home.dir).toBe(next.dir);
    expect(reopened.entry?.value.toString()).toBe("recovered-fixture-token");
  });
});
