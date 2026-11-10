import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { RootKeys } from "./custody";
import { SecretVault } from "./vault";

// Intent: INF-1105 - native custody holds only the root key, values are sealed,
// and there is no plaintext or unprotected fallback (docs/secrets.md, "Native custody").
const TOKEN = "ghp_invented0StagingDeploy7Q2xV9mK4tR8wL1nB6cZ3";

async function openKeys(custody = disposableCustody()) {
  const keys = await RootKeys.open(custody, { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error(keys);
  return { keys, custody };
}

describe("root custody", () => {
  it("creates a root only when asked on an empty owner, and refuses a locked or missing store", async () => {
    const custody = disposableCustody();
    expect(await RootKeys.open(custody, { initialize: false, hasRecords: false })).toBe(
      "uninitialized",
    );
    expect(custody.writes).toEqual([]);
    expect(await RootKeys.open(custody, { initialize: true, hasRecords: false })).toBeInstanceOf(
      RootKeys,
    );
    custody.state = "locked";
    expect(await RootKeys.open(custody, { initialize: true, hasRecords: true })).toBe("locked");
    custody.state = "unavailable";
    expect(await RootKeys.open(custody, { initialize: true, hasRecords: true })).toBe(
      "unavailable",
    );
  });

  it("clears temporary native root buffers without changing custody or the sealed values", async () => {
    // INF-1109 recovery: native roots remain private even while copying a home.
    const custody = disposableCustody();
    const read = custody.read;
    const write = custody.write;
    const temporary: Buffer[] = [];
    custody.read = async (slot) => {
      const result = await read(slot);
      if (result.kind === "value") temporary.push(result.bytes);
      return result;
    };
    custody.write = async (slot, bytes) => {
      temporary.push(bytes);
      return write(slot, bytes);
    };
    const { keys } = await openKeys(custody);
    const dir = scratchDir("secrets-root-lifetime-");
    await new SecretVault(dir, keys).put("calendar", "Calendar", Buffer.from(TOKEN));
    const retiredKeys = (["values", "entries", "authority", "journal"] as const).map((purpose) =>
      keys.key(purpose),
    );
    keys.destroy();
    for (const key of retiredKeys) expect(key.every((byte) => byte === 0)).toBe(true);
    expect(() => keys.key("values")).toThrow();
    const { keys: reopened } = await openKeys(custody);
    expect((await new SecretVault(dir, reopened).open("calendar"))?.value.toString()).toBe(TOKEN);
    expect(temporary.length).toBeGreaterThan(0);
    for (const bytes of temporary) expect(bytes).toEqual(Buffer.alloc(bytes.length));
    expect(custody.slots.get("root")).not.toEqual(Buffer.alloc(32));
  });

  it("never creates a new root beside sealed records, which would orphan them", async () => {
    const custody = disposableCustody();
    expect(await RootKeys.open(custody, { initialize: true, hasRecords: true })).toBe("lost");
    expect(custody.writes).toEqual([]);
  });
});

describe("sealed vault", () => {
  it("keeps no value readable on disk and opens the current version for delivery", async () => {
    const dir = scratchDir("secrets-vault-");
    const { keys } = await openKeys();
    const vault = new SecretVault(dir, keys, () => 1_000);
    expect((await vault.put("staging-deploy", "Staging deploy", Buffer.from("old"))).version).toBe(
      1,
    );
    const entry = await vault.put("staging-deploy", "Staging deploy", Buffer.from(TOKEN), {
      discoverable: true,
    });
    expect(entry).toEqual({
      ref: "staging-deploy",
      label: "Staging deploy",
      version: 2,
      revision: expect.any(String),
      discoverable: true,
      updatedAt: 1_000,
    });
    for (const file of readdirSync(join(dir, "values"))) {
      const text = readFileSync(join(dir, "values", file), "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(Buffer.from(TOKEN).toString("base64"));
    }
    expect((await vault.open("staging-deploy"))?.value.toString()).toBe(TOKEN);
    expect(await vault.list()).toEqual([entry]);
  });

  it("refuses a relabelled or swapped record instead of showing or delivering it", async () => {
    const dir = scratchDir("secrets-vault-");
    const { keys } = await openKeys();
    const vault = new SecretVault(dir, keys);
    await vault.put("staging-deploy", "Staging deploy", Buffer.from(TOKEN));
    await vault.put("prod-deploy", "Production deploy", Buffer.from("prod-invented"));
    const [first, second] = readdirSync(join(dir, "values")).map((file) =>
      join(dir, "values", file),
    );
    if (!first || !second) throw new Error("two records expected");
    const edited = JSON.parse(readFileSync(first, "utf8"));
    edited.entry.label = "Harmless read-only token";
    writeFileSync(first, JSON.stringify(edited));
    copyFileSync(first, second);
    expect(await vault.list()).toEqual([]);
    expect(await vault.open("staging-deploy")).toBeUndefined();
    expect(await vault.open("prod-deploy")).toBeUndefined();
  });

  it("opens nothing under a different root", async () => {
    const dir = scratchDir("secrets-vault-");
    await new SecretVault(dir, (await openKeys()).keys).put(
      "staging-deploy",
      "Staging deploy",
      Buffer.from(TOKEN),
    );
    const other = new SecretVault(dir, (await openKeys()).keys);
    expect(await other.list()).toEqual([]);
    expect(await other.open("staging-deploy")).toBeUndefined();
  });
});
