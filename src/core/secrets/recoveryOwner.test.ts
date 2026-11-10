import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writePrivateFile } from "./custody";
import { ProtectedSecrets } from "./protected";
import { openRecovery, type RecoveryFiles } from "./recoveryArchive";
import { SecretVault } from "./vault";

// Intent: INF-1109's recovery export is a fresh, private native operation. A
// cancelled/locked/changed store writes nothing; uncertain file writes never retry.
const TOKEN = "ya29.invented-recovery-owner-token";
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const dir = scratchDir("secret-recovery-owner-");
  const custody = disposableCustody();
  let confirmed = true;
  let confirmations = 0;
  const owner = await ProtectedSecrets.open({
    dir,
    custody,
    initialize: true,
    environment: () => ({}),
    authentication: {
      available: async () => true,
      confirm: async () => {
        confirmations += 1;
        return confirmed;
      },
    },
  });
  await owner.putSecret("calendar", "Calendar", Buffer.from(TOKEN), { discoverable: false });
  return {
    dir,
    custody,
    owner,
    confirmations: () => confirmations,
    confirm: (value: boolean) => {
      confirmed = value;
    },
  };
}

describe("protected recovery export", () => {
  it("writes only encrypted data and a separate key through the private writer after confirmation", async () => {
    const f = await fixture();
    const destination = scratchDir("secret-recovery-output-");
    let delivered: RecoveryFiles | undefined;
    expect(
      await f.owner.backupRecovery(async (files) => {
        delivered = files;
        expect(f.confirmations()).toBe(1);
        await writePrivateFile(join(destination, "archive"), files.archive);
        await writePrivateFile(join(destination, "separate-key"), files.key);
        return "saved";
      }),
    ).toBe("saved");
    const archive = await readFile(join(destination, "archive"));
    const key = await readFile(join(destination, "separate-key"));
    const recovered = openRecovery(archive, key);
    expect(
      recovered?.values.map((entry) => ({
        ref: entry.ref,
        discoverable: entry.discoverable,
        value: Buffer.from(entry.value, "base64").toString(),
      })),
    ).toEqual([{ ref: "calendar", discoverable: false, value: TOKEN }]);
    expect(archive.includes(Buffer.from(TOKEN))).toBe(false);
    expect(delivered?.key).toEqual(Buffer.alloc(key.length));
    expect(delivered?.archive).toEqual(Buffer.alloc(archive.length));
    expect(f.confirmations()).toBe(1);
  });

  it("refuses cancelled confirmation or locked custody before the writer receives anything", async () => {
    const f = await fixture();
    const writer = vi.fn(async () => "saved" as const);
    f.confirm(false);
    expect(await f.owner.backupRecovery(writer)).toBe("refused");
    f.custody.state = "locked";
    f.confirm(true);
    expect(await f.owner.backupRecovery(writer)).toBe("unavailable");
    expect(writer).not.toHaveBeenCalled();
    expect(f.confirmations()).toBe(1);
  });

  it("refuses a damaged record instead of silently producing an incomplete backup", async () => {
    const f = await fixture();
    const [file] = await readdir(join(f.dir, "values"));
    if (!file) throw new Error("No sealed fixture file.");
    await writeFile(join(f.dir, "values", file), "interrupted or edited value");
    const writer = vi.fn(async () => "saved" as const);
    expect(await f.owner.backupRecovery(writer)).toBe("unavailable");
    expect(writer).not.toHaveBeenCalled();
  });

  it("refuses a lock during opening and clears the opened value before returning", async () => {
    const f = await fixture();
    const open = SecretVault.prototype.open;
    let opened: Buffer | undefined;
    vi.spyOn(SecretVault.prototype, "open").mockImplementationOnce(async function (
      this: SecretVault,
      ref: string,
    ) {
      const value = await open.call(this, ref);
      opened = value?.value;
      f.custody.state = "locked";
      return value;
    });
    const writer = vi.fn(async () => "saved" as const);
    expect(await f.owner.backupRecovery(writer)).toBe("unavailable");
    expect(writer).not.toHaveBeenCalled();
    expect(opened).toEqual(Buffer.alloc(Buffer.byteLength(TOKEN)));
  });

  it("reports an uncertain writer once and clears its buffers without retrying or deleting files", async () => {
    const f = await fixture();
    const destination = scratchDir("secret-recovery-partial-");
    let delivered: RecoveryFiles | undefined;
    const writer = vi.fn(async (files: RecoveryFiles) => {
      delivered = files;
      await writePrivateFile(join(destination, "separate-key"), files.key);
      throw new Error("Fixture lost its file-write response.");
    });
    expect(await f.owner.backupRecovery(writer)).toBe("unknown");
    expect(writer).toHaveBeenCalledTimes(1);
    expect((await readFile(join(destination, "separate-key"))).length).toBe(32);
    expect(delivered?.key).toEqual(Buffer.alloc(32));
    expect(delivered?.archive.every((byte) => byte === 0)).toBe(true);
  });
});
