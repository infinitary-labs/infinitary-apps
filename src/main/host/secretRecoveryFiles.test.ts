import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openRecovery, sealRecovery } from "../../core/secrets/recoveryArchive";
import { readSecretRecoveryFiles, saveSecretRecoveryFiles } from "./secretRecoveryFiles";

// Intent: INF-1109 recovery keeps an earlier working archive/key intact, saves
// separate private files and reports a partial save without deleting either file.
function files() {
  return sealRecovery({
    format: 1,
    sourceHome: "fixture-home",
    createdAt: 1700000000000,
    values: [
      {
        ref: "calendar",
        label: "Calendar",
        discoverable: false,
        value: Buffer.from("invented-file-writer-credential").toString("base64"),
      },
    ],
    history: [],
  });
}

describe("native recovery files", () => {
  it("reads only selected regular files and an exact recovery key, never a link or folder", async () => {
    const dir = scratchDir("recovery-native-read-");
    const paths = { archive: join(dir, "backup"), key: join(dir, "key") };
    const data = files();
    expect(await saveSecretRecoveryFiles(paths, data)).toBe("saved");
    const linkedKey = join(dir, "linked-key");
    await symlink(paths.key, linkedKey);
    expect(await readSecretRecoveryFiles({ ...paths, key: linkedKey })).toBeUndefined();
    expect(await readSecretRecoveryFiles({ ...paths, archive: dir })).toBeUndefined();
    await writeFile(paths.key, "not-a-recovery-key");
    expect(await readSecretRecoveryFiles(paths)).toBeUndefined();
    expect(await readFile(paths.archive)).toEqual(data.archive);
  });

  it("writes separate private files that open together, never a plaintext credential", async () => {
    const dir = scratchDir("recovery-native-files-");
    const paths = { archive: join(dir, "backup"), key: join(dir, "separate-key") };
    const data = files();
    expect(await saveSecretRecoveryFiles(paths, data)).toBe("saved");
    const archive = await readFile(paths.archive);
    const key = await readFile(paths.key);
    expect(openRecovery(archive, key)?.values[0]?.ref).toBe("calendar");
    const selected = await readSecretRecoveryFiles(paths);
    expect(selected?.archive.equals(archive)).toBe(true);
    expect(selected?.key.equals(key)).toBe(true);
    expect(archive.includes(Buffer.from("invented-file-writer-credential"))).toBe(false);
    expect((await stat(paths.archive)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.key)).mode & 0o777).toBe(0o600);
  });

  it.each(["archive", "key"] as const)(
    "leaves an existing %s untouched and creates no other file",
    async (existing) => {
      const dir = scratchDir("recovery-native-existing-");
      const paths = { archive: join(dir, "backup"), key: join(dir, "separate-key") };
      await writeFile(paths[existing], "earlier working file");
      expect(await saveSecretRecoveryFiles(paths, files())).toBe("unavailable");
      expect(await readFile(paths[existing], "utf8")).toBe("earlier working file");
      expect(await readdir(dir)).toHaveLength(1);
    },
  );

  it("refuses identical destinations and existing links instead of overwriting their targets", async () => {
    const dir = scratchDir("recovery-native-paths-");
    const target = join(dir, "earlier");
    await writeFile(target, "kept");
    const archive = join(dir, "backup");
    const key = join(dir, "key");
    expect(await saveSecretRecoveryFiles({ archive: key, key }, files())).toBe("unavailable");
    await symlink(target, archive);
    expect(await saveSecretRecoveryFiles({ archive, key }, files())).toBe("unavailable");
    expect(await readFile(target, "utf8")).toBe("kept");
    expect(await readdir(dir)).toHaveLength(2);
  });

  it("keeps the newly saved key and reports partial when the other destination cannot be written", async () => {
    const dir = scratchDir("recovery-native-partial-");
    const keyFolder = join(dir, "chosen-key-folder");
    await mkdir(keyFolder);
    const paths = {
      key: join(keyFolder, "key"),
      archive: join(dir, "no-longer-present", "backup"),
    };
    const data = files();
    expect(await saveSecretRecoveryFiles(paths, data)).toBe("partial");
    expect(await readFile(paths.key)).toEqual(data.key);
    expect(await readdir(dir)).toEqual(["chosen-key-folder"]);
  });
});
