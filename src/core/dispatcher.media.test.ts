import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fakeHost } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { startCore } from "./index";
import { catalogRefreshesSettled } from "./pi/modelRuntime";

// The dispatcher split must preserve the card recording reader's EOF behavior.
it("returns an empty recording piece beyond the end without changing its size", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const userData = scratchDir("dispatcher-media-");
  const core = await startCore(fakeHost(userData).host);
  try {
    const recording = readFileSync("tests/fixtures/demo/moving-box.mp4");
    const name = `task-media-${"a".repeat(32)}.mp4`;
    const directory = join(core.paths.crewmatesDir, "task-media", "cards");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), recording);
    expect(await core.dispatch("inf:cards:media", [name, recording.length + 1, 10])).toEqual({
      contentType: "video/mp4",
      size: recording.length,
      data: "",
    });
  } finally {
    await core.dispose();
    await catalogRefreshesSettled();
    rmSync(userData, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 20_000);
