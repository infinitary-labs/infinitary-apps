import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostPlatform } from "@core/platform";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SavedCardFileStore } from "./savedCardFiles";

it("remembers only saved card and file pairs on this computer and forgets moved targets", async () => {
  const root = await realpath(scratchDir("saved-card-files-"));
  const folder = join(root, "Heating repairs");
  const path = join(folder, "invoice.csv");
  await mkdir(folder);
  await writeFile(path, "Part,Cost\nValve,19\n");
  const records = join(root, "records");
  const writer = new SavedCardFileStore(records);
  await writer.remember(
    "repairs",
    [{ id: "invoice", path, savedAs: "invoice.csv", folder: "Heating repairs" }],
    {
      path: folder,
      savedAs: "Heating repairs",
      saved: 1,
      failed: [{ id: "estimate", why: "The kept copy changed." }],
      ids: ["invoice", "estimate"],
    },
  );

  const restarted = new SavedCardFileStore(records);
  const system = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  expect(await restarted.snapshot("repairs", ["invoice", "estimate"])).toEqual({
    files: [{ id: "invoice", savedAs: "invoice.csv", folder: "Heating repairs" }],
    batch: {
      savedAs: "Heating repairs",
      saved: 1,
      failed: [{ id: "estimate", why: "The kept copy changed." }],
    },
  });
  expect(await restarted.snapshot("repairs", ["invoice"])).toMatchObject({ batch: null });
  expect(await restarted.open("other-card", "invoice", system)).toBe("missing");
  expect(await restarted.open("repairs", "estimate", system)).toBe("missing");
  expect(
    await new SavedCardFileStore(join(root, "other-computer")).open("repairs", "invoice", system),
  ).toBe("missing");
  expect(system.openPath).not.toHaveBeenCalled();
  expect(await restarted.open("repairs", null, system)).toBe("opened");
  expect(system.openPath).toHaveBeenLastCalledWith(folder);

  await rename(folder, join(root, "Moved repairs"));
  expect(await restarted.open("repairs", "invoice", system)).toBe("missing");
  expect(await restarted.open("repairs", null, system)).toBe("missing");
  expect(system.openPath).toHaveBeenCalledTimes(1);
  expect(await restarted.snapshot("repairs", ["invoice", "estimate"])).toEqual({
    files: [],
    batch: null,
  });
});

it("does not open a saved path that has become a link", async () => {
  const root = scratchDir("saved-card-link-");
  const path = join(root, "invoice.csv");
  const actual = join(root, "edited-invoice.csv");
  const store = new SavedCardFileStore(join(root, "records"));
  await writeFile(actual, "Part,Cost\nValve,19\n");
  // Use a directory junction on Windows so the test needs no symlink privilege.
  if (hostPlatform() === "win32") {
    const moved = join(root, "Moved");
    await mkdir(moved);
    await symlink(moved, path, "junction");
  } else {
    await symlink(actual, path);
  }
  await store.remember("repairs", [{ id: "invoice", path, savedAs: "invoice.csv" }]);
  const system = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  expect(await store.open("repairs", "invoice", system)).toBe("missing");
  expect(system.openPath).not.toHaveBeenCalled();
});
