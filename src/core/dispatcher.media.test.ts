import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_LOG_TYPES } from "@shared/cardPictures";
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

// INF-3887: a view or a phone reads a merge card's proof log by its kept name,
// as the window's log reader reads it from the frame scheme.
it("answers a kept proof log's text by its name, and refuses a name it never keeps", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const userData = scratchDir("dispatcher-log-");
  const core = await startCore(fakeHost(userData).host);
  try {
    // A real kept transcript: the readings a live validation run keeps.
    const text = readFileSync(
      "tests/fixtures/replay/sep14-real/crewmates/59f43063/sessions/2026-09-14T02-11-24-528Z_01a09dae-f6f0-7b9c-b1a3-76412d9ff08d.jsonl",
    ).subarray(0, 40_000);
    const name = `task-log-${createHash("sha256").update(text).digest("hex")}.json`;
    const directory = join(core.paths.crewmatesDir, "task-log", "cards");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), text);
    expect(await core.dispatch("inf:cards:log", [name])).toEqual({
      contentType: CARD_LOG_TYPES.json,
      data: text.toString("base64"),
    });
    await expect(core.dispatch("inf:cards:log", ["task-log-session.jsonl"])).rejects.toThrow();
  } finally {
    await core.dispose();
    await catalogRefreshesSettled();
    rmSync(userData, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 20_000);
