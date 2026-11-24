import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomFileConnection } from "@shared/customApiFile";
import { afterEach, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CustomApiFileSource } from "./customApiFileSource";

const fixture = readFileSync(join(__dirname, "fixtures", "connectionFile.json"), "utf8");
const sources: CustomApiFileSource[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
});

function source(watchRetryMs?: number) {
  let saved: string | null = null;
  const applied: (string[] | null)[] = [];
  const result = new CustomApiFileSource({
    path: () => saved,
    save: (path) => {
      saved = path;
    },
    apply: (connections: CustomFileConnection[] | null) =>
      applied.push(connections?.map((connection) => connection.name) ?? null),
    ...(watchRetryMs ? { watchRetryMs } : {}),
  });
  result.start();
  sources.push(result);
  return { source: result, applied, saved: () => saved };
}

it("reads the chosen file now and again whenever it changes, and never writes it", async () => {
  const path = join(scratchDir("connection-file-"), "models.json");
  writeFileSync(path, fixture);
  const { source: file, applied, saved } = source();

  const view = await file.set(path);
  expect(saved()).toBe(path);
  expect(view.path).toBe(path);
  expect(view.connections.map((connection) => connection.name)).toEqual([
    "my-provider",
    "my-local-server",
  ]);
  expect(applied).toEqual([["my-provider", "my-local-server"]]);

  // An editor saving the file: picked up without a restart.
  const edited = JSON.parse(fixture);
  delete edited.providers["my-local-server"];
  writeFileSync(path, JSON.stringify(edited));
  await expect.poll(() => applied.length, { timeout: 5000 }).toBe(2);
  expect(applied[1]).toEqual(["my-provider"]);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(edited));
});

it("keeps the last good reading while the file is broken or gone, and says why", async () => {
  const path = join(scratchDir("connection-file-"), "models.json");
  writeFileSync(path, fixture);
  const { source: file, applied } = source();
  await file.set(path);

  writeFileSync(path, '{ "providers": ');
  await expect.poll(() => file.view().failure, { timeout: 5000 }).toBe("invalid");
  expect(file.view().connections).toHaveLength(2);

  rmSync(path);
  await expect.poll(() => file.view().failure, { timeout: 5000 }).toBe("missing");
  expect(file.view().connections).toHaveLength(2);
  expect(applied).toHaveLength(1);

  // Choosing no file ends every hold the file made.
  const none = await file.set(null);
  expect(none).toEqual({ path: null, connections: [] });
  expect(applied.at(-1)).toBeNull();
});

it("picks up a file whose folder appears only after it was chosen", async () => {
  const folder = join(scratchDir("connection-file-"), "synced-later");
  const path = join(folder, "models.json");
  const { source: file, applied } = source(100);
  expect((await file.set(path)).failure).toBe("missing");

  mkdirSync(folder);
  writeFileSync(path, fixture);
  await expect.poll(() => applied, { timeout: 5000 }).toEqual([["my-provider", "my-local-server"]]);

  // Watched now: a later edit is read too.
  const edited = JSON.parse(fixture);
  delete edited.providers["my-local-server"];
  writeFileSync(path, JSON.stringify(edited));
  await expect.poll(() => applied.at(-1), { timeout: 5000 }).toEqual(["my-provider"]);
});

it("refuses a path that is not a full one", async () => {
  const { source: file, saved } = source();
  await expect(file.set("models.json")).rejects.toThrow();
  expect(saved()).toBeNull();
});
