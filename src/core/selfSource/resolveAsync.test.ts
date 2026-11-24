import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { sourceInstall } from "../../../tests/helpers/sourceInstall";
import { readSelfSource, readSelfSourceAsync, SOURCE_CHECKS_AT_ONCE } from "./resolve";

vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

// INF-2186, captain's start-of-task sample: keep fresh source checks, but
// do not synchronously walk every indexed file while opening a conversation.
it("validates fresh installed source without synchronous filesystem calls", async () => {
  const installed = sourceInstall(scratchDir("source-async-"));
  const spies = [
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fs, "realpathSync"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "accessSync"),
  ];
  try {
    const expected = readSelfSource(installed.location);
    expect(expected.availability).toBe("available");
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeGreaterThan(0);
    for (const spy of spies) spy.mockClear();
    expect(await readSelfSourceAsync(installed.location)).toEqual(expected);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  // Each new conversation still verifies what is there now, not a cached success.
  fs.rmSync(join(installed.root, installed.files[0]));
  expect((await readSelfSourceAsync(installed.location)).availability).toBe("unavailable");
  const outside = join(installed.location.resourcesPath, "outside.ts");
  fs.writeFileSync(outside, "outside the installed source");
  fs.symlinkSync(outside, join(installed.root, installed.files[0]));
  expect(await readSelfSourceAsync(installed.location)).toMatchObject({
    availability: "unavailable",
    reason: "An indexed file escapes the source folder.",
  });
});

/** The installed fixture with up to `count` more of the project's own modules indexed after its two. */
function largerInstall(prefix: string, count: number) {
  const installed = sourceInstall(scratchDir(prefix));
  const modules: Record<string, string | string[]> = installed.map.modules;
  const repo = join(__dirname, "../../..");
  const shared = fs
    .readdirSync(join(repo, "src/shared"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .slice(0, count)
    .map((name) => `src/shared/${name}`)
    .filter((file) => !(installed.files as readonly string[]).includes(file));
  for (const file of shared) {
    fs.mkdirSync(dirname(join(installed.root, file)), { recursive: true });
    fs.copyFileSync(join(repo, file), join(installed.root, file));
    modules[file] = "out/main";
  }
  installed.write();
  return { ...installed, indexed: Object.keys(modules) };
}

// The answer check's retry outlasted a journey's deadline on a loaded Linux
// runner because every first-mate turn first walked the installed source one
// file after another, about three seconds a turn there.
it("checks a bounded number of indexed files at once", async () => {
  const installed = largerInstall("source-at-once-", 40);
  expect(SOURCE_CHECKS_AT_ONCE).toBeGreaterThan(1);
  expect(installed.indexed.length).toBeGreaterThan(SOURCE_CHECKS_AT_ONCE);
  const expected = readSelfSource(installed.location);
  expect(expected.availability).toBe("available");
  const held: (() => void)[] = [];
  let holding = true;
  vi.mocked(fsp.realpath).mockClear();
  vi.mocked(fsp.realpath).mockImplementation(async (path, options) => {
    if (holding && path !== installed.root) await new Promise<void>((go) => held.push(go));
    return actual.realpath(path, options);
  });
  try {
    const reading = readSelfSourceAsync(installed.location);
    // A file's check starts with its path, and none can finish while its path is held.
    await vi.waitFor(() => expect(held).toHaveLength(SOURCE_CHECKS_AT_ONCE));
    holding = false;
    for (const go of held) go();
    expect(await reading).toEqual(expected);
    expect(fsp.realpath).toHaveBeenCalledTimes(installed.indexed.length + 1);
  } finally {
    vi.mocked(fsp.realpath).mockReset();
  }
});

it("names the first failing file in index order, as the synchronous walk does", async () => {
  const installed = sourceInstall(scratchDir("source-first-failure-"));
  const [first, second] = installed.files.map((file) => join(installed.root, file));
  fs.rmSync(first as string);
  fs.mkdirSync(first as string);
  fs.rmSync(second as string);
  const expected = readSelfSource(installed.location);
  expect(expected.reason).toBe("An indexed source file is missing.");
  // When the later file's check has started, its failure lands first: its
  // path is found gone before the earlier file's kind is read.
  let laterStarted = false;
  let laterFailed!: () => void;
  const later = new Promise<void>((done) => (laterFailed = done));
  vi.mocked(fsp.realpath).mockImplementation(async (path, options) => {
    if (path === second) laterStarted = true;
    try {
      return await actual.realpath(path, options);
    } catch (error) {
      if (path === second) laterFailed();
      throw error;
    }
  });
  vi.mocked(fsp.stat).mockImplementation(async (path, options) => {
    if (path === first && laterStarted) await later;
    return actual.stat(path, options);
  });
  try {
    expect(await readSelfSourceAsync(installed.location)).toEqual(expected);
  } finally {
    vi.mocked(fsp.realpath).mockReset();
    vi.mocked(fsp.stat).mockReset();
  }
});
