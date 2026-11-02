import { createHash } from "node:crypto";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PlacedTasks } from "../helper/placedTasks";
import { writeEvidenceFile } from "./evidenceFile";

// INF-2330: a recording reaches evidence whole, outside a working copy, without replacing files.
const RECORDING = readFileSync("tests/fixtures/demo/moving-box.mp4");
const sha256 = createHash("sha256").update(RECORDING).digest("hex");

async function* recording() {
  yield RECORDING;
}

describe("verified workflow evidence files", () => {
  it("keeps a real playable recording unchanged and refuses overwrite or a linked folder", async () => {
    const dir = scratchDir("evidence-file-");
    const saved = await writeEvidenceFile(dir, "recording.mp4", recording());
    expect(saved).toEqual({ path: join(dir, "recording.mp4"), bytes: RECORDING.length, sha256 });
    expectBytesEqual(readFileSync(saved.path), RECORDING);
    await expect(writeEvidenceFile(dir, "recording.mp4", recording())).rejects.toMatchObject({
      code: "EEXIST",
    });
    const link = join(dir, "linked");
    symlinkSync(scratchDir("evidence-link-target-"), link);
    await expect(writeEvidenceFile(link, "other.mp4", recording())).rejects.toThrow(
      "plain directory",
    );
    expect(readdirSync(dir).sort()).toEqual(["linked", "recording.mp4"]);
  });

  it("removes unpublished local bytes when the stream fails", async () => {
    const dir = scratchDir("evidence-interrupted-");
    async function* broken() {
      yield RECORDING;
      throw new Error("interrupted");
    }
    await expect(writeEvidenceFile(dir, "recording.mp4", broken())).rejects.toThrow("interrupted");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("receives a recording in pieces, accepts a repeated piece, verifies it, and never overwrites evidence", async () => {
    const receiver = new PlacedTasks(scratchDir("evidence-receive-"));
    const task = "task-2330";
    const base = {
      task,
      name: "recording.mp4",
      size: RECORDING.length,
      sha256,
      evidence: true as const,
    };
    const half = Math.floor(RECORDING.length / 2);
    const first = { ...base, offset: 0, data: RECORDING.subarray(0, half).toString("base64") };
    expect((await receiver.sourceFile(first)).complete).toBe(false);
    expect((await receiver.sourceFile(first)).complete).toBe(false);
    expect(readdirSync(receiver.folders(task).evidence)).toEqual([]);
    const saved = await receiver.sourceFile({
      ...base,
      offset: half,
      data: RECORDING.subarray(half).toString("base64"),
    });
    expect(saved.complete).toBe(true);
    expect(saved.file).toBe(join(receiver.folders(task).evidence, base.name));
    expectBytesEqual(readFileSync(saved.file), RECORDING);
    expect((await receiver.sourceFile(first)).complete).toBe(true);
    await expect(receiver.sourceFile({ ...first, sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expectBytesEqual(readFileSync(saved.file), RECORDING);
  });

  it("refuses corrupt, out-of-order and linked destinations, leaving no published evidence", async () => {
    const receiver = new PlacedTasks(scratchDir("evidence-refusal-"));
    const task = "task-2330";
    const folders = receiver.ensure(task);
    const piece = {
      task,
      name: "recording.mp4",
      size: RECORDING.length,
      sha256,
      evidence: true as const,
      offset: 0,
      data: RECORDING.toString("base64"),
    };
    await expect(receiver.sourceFile({ ...piece, sha256: "0".repeat(64) })).rejects.toThrow(
      "unchanged",
    );
    await expect(receiver.sourceFile({ ...piece, offset: 1 })).rejects.toThrow("incomplete");
    expect(readdirSync(folders.evidence)).toEqual([]);
    expect(readdirSync(folders.temp).filter((name) => name.endsWith(".part"))).toEqual([]);
    const outside = join(scratchDir("evidence-outside-"), "kept.mp4");
    writeFileSync(outside, RECORDING);
    symlinkSync(outside, join(folders.evidence, piece.name));
    await expect(receiver.sourceFile(piece)).rejects.toMatchObject({ code: "EEXIST" });
    expectBytesEqual(readFileSync(outside), RECORDING);
  });
});
