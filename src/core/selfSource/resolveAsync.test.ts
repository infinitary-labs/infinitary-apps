import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { sourceInstall } from "../../../tests/helpers/sourceInstall";
import { readSelfSource, readSelfSourceAsync } from "./resolve";

vi.mock("node:fs", { spy: true });

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
