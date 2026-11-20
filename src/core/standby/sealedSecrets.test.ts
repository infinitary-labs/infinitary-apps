import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openRecovery, sealRecovery } from "../secrets/recoveryArchive";
import {
  makeLock,
  openKeyWith,
  readSealedSecrets,
  type SealedSecrets,
  sealKeyTo,
  writeSealedSecrets,
} from "./sealedSecrets";

// Intent: decision 10 of INF-4207's approved plan, "sealed, opened with that
// standby's own lock": the archive's key opens only with the lock it was
// sealed to, and only for that exact archive.
function sealed(locks: { device: string; key: string }[]) {
  const files = sealRecovery({
    format: 1,
    createdAt: 1,
    sourceHome: "home",
    values: [
      { ref: "calendar", label: "Planning calendar", discoverable: true, value: "dG9rZW4=" },
    ],
    history: [],
  });
  const file: SealedSecrets = {
    format: 1,
    source: "home",
    made: "0".repeat(64),
    at: 1,
    archive: files.archive.toString("base64"),
    keys: locks.map((lock) => sealKeyTo(lock, files.archive, files.key)),
  };
  return { file, files };
}

describe("the sealed secrets each copy carries", () => {
  it("opens with the confirmed computer's own lock and no other", () => {
    const mini = makeLock();
    const laptop = makeLock();
    const { file, files } = sealed([{ device: "mini", key: mini.publicKey }]);
    const key = openKeyWith(mini, file);
    expect(key?.equals(files.key)).toBe(true);
    expect(key && openRecovery(Buffer.from(file.archive, "base64"), key)?.values[0]?.ref).toBe(
      "calendar",
    );
    expect(openKeyWith(laptop, file)).toBeUndefined();
  });

  it("never opens a key sealed for one archive beside another", () => {
    const mini = makeLock();
    const one = sealed([{ device: "mini", key: mini.publicKey }]).file;
    const other = sealed([{ device: "mini", key: mini.publicKey }]).file;
    expect(openKeyWith(mini, { ...other, keys: one.keys })).toBeUndefined();
  });

  it("is written whole and removed with the last lock", () => {
    const record = scratchDir("sealed-secrets-");
    const mini = makeLock();
    const { file } = sealed([{ device: "mini", key: mini.publicKey }]);
    writeSealedSecrets(record, file);
    expect(readSealedSecrets(record)).toEqual(file);
    writeSealedSecrets(record, null);
    expect(readSealedSecrets(record)).toBeUndefined();
  });
});
