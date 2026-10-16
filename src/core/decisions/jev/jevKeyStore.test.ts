import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import { DecisionKeyStore } from "./jevKeyStore";

/**
 * The key store's whole job is the permissions and the blast radius: one
 * 0700 directory, one 0600 file, and a removal that takes the directory
 * with it. Everything else about it is deliberately boring.
 */

const dirs: string[] = [];

function store(): { store: DecisionKeyStore; userData: string } {
  const userData = scratchDir("infinitary-decisions-");
  dirs.push(userData);
  return { store: new DecisionKeyStore(userData), userData };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DecisionKeyStore", () => {
  it("writes a 0700 directory holding a 0600 file, and reads it back", () => {
    const { store: keys, userData } = store();
    expect(keys.has("jev")).toBe(false);
    keys.set("jev", "  ts-live-1234567890  ");
    expect(keys.has("jev")).toBe(true);
    expect(keys.read("jev")).toBe("ts-live-1234567890");
    const dir = join(userData, "decisions", "jev");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "key")).mode & 0o777).toBe(0o600);
  });

  it("asserts the permissions on a directory that already existed", () => {
    const { store: keys, userData } = store();
    keys.set("jev", "first");
    const dir = join(userData, "decisions", "jev");
    // Something (a restore, a sync tool, a careless hand) widened it.
    writeFileSync(join(dir, "key"), "first", { mode: 0o644 });
    keys.set("jev", "second");
    expect(statSync(join(dir, "key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "key"), "utf8")).toBe("second");
  });

  it("refuses an empty key rather than storing a store that cannot work", () => {
    const { store: keys } = store();
    expect(() => keys.set("jev", "   ")).toThrow();
    expect(keys.has("jev")).toBe(false);
  });

  it("removal takes the whole directory, and reads after it are empty", () => {
    const { store: keys, userData } = store();
    keys.set("jev", "ts-live-1234567890");
    keys.remove("jev");
    expect(keys.has("jev")).toBe(false);
    expect(keys.read("jev")).toBeUndefined();
    expect(() => statSync(join(userData, "decisions", "jev"))).toThrow();
  });
});
