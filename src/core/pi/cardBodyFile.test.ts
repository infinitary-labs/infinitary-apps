import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { MAX_CARD_BODY_LENGTH, readCardBodyFile } from "./cardBodyFile";

it("confines paths and symlinks to this task's body folder", async () => {
  const root = scratchDir("body-file-");
  const dir = join(root, "card-bodies");
  await mkdir(dir);
  await writeFile(join(root, "outside.html"), "outside");
  await symlink(join(root, "outside.html"), join(dir, "escape.html"));
  for (const path of ["../outside.html", join(root, "outside.html"), "escape.html"]) {
    await expect(readCardBodyFile(path, dir)).rejects.toThrow(/must stay inside/);
  }
  await expect(readCardBodyFile("missing.html", dir)).rejects.toThrow(/file not found/);
  await mkdir(join(dir, "directory"));
  await expect(readCardBodyFile("directory", dir)).rejects.toThrow(/regular file/);
  await writeFile(join(dir, "answer.html"), "<p>Résumé.</p>");
  await symlink(join(dir, "answer.html"), join(dir, "inside.html"));
  expect(await readCardBodyFile("inside.html", dir)).toBe("<p>Résumé.</p>");
});

it("bounds encoded reads and refuses invalid UTF-8 without changing the character limit", async () => {
  const dir = scratchDir("body-file-size-");
  const path = join(dir, "answer.html");
  const body = "界".repeat(MAX_CARD_BODY_LENGTH);
  await writeFile(path, body);
  expect(await readCardBodyFile(path, dir)).toBe(body);
  await writeFile(path, `${body}界`);
  await expect(readCardBodyFile(path, dir)).rejects.toThrow(/too large/);
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  await expect(readCardBodyFile(path, dir)).rejects.toThrow(/UTF-8/);
});
