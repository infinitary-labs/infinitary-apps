import { copyFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { phoneRecording } from "../scripts/phone-recording";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1066: the recording-enabled CI run stopped at spawn ffmpeg ENOENT before any journey.
// Keep simctl's native capture on that Mac; only an explicitly encoded local demo needs FFmpeg.
const evidence = "/evidence/iphone/character";
const capture = { name: "conversation", raw: join(evidence, "conversation-raw.mp4") };
const missingEncoder = async () => {
  throw new Error("spawn ffmpeg ENOENT");
};

describe("native phone recordings", () => {
  it("keeps raw recording enabled and propagates it without needing an encoder", async () => {
    const recording = phoneRecording("raw", missingEncoder);
    expect(recording.enabled).toBe(true);
    expect(recording.childArgs).toEqual(["--raw-demo"]);
    await recording.prepare();
    const root = scratchDir("infinitary-raw-phone-recording-");
    const raw = join(root, "conversation.mp4"),
      kept = join(root, "evidence");
    const clip = join("tests", "fixtures", "demo", "moving-box.mp4");
    mkdirSync(kept);
    copyFileSync(clip, raw);
    await recording.finish([{ name: capture.name, raw }], kept);
    unlinkSync(raw);
    expect(readFileSync(join(kept, "conversation-raw.mp4"))).toEqual(readFileSync(clip));
  });
  it("keeps ordinary checks recording-free", async () => {
    const recording = phoneRecording("off", missingEncoder);
    expect(recording.enabled).toBe(false);
    expect(recording.childArgs).toEqual([]);
    await recording.prepare();
    await recording.finish([], evidence);
  });
  it("preserves the explicit local demo's preflight, encoded clip and poster", async () => {
    const commands: { command: string; args: string[] }[] = [];
    const recording = phoneRecording("encoded", async (command, args) => {
      commands.push({ command, args });
      return "";
    });
    expect(recording.enabled).toBe(true);
    expect(recording.childArgs).toEqual(["--demo"]);
    await recording.prepare();
    await recording.finish([capture], evidence);
    expect(commands.map(({ command }) => command)).toEqual(["ffmpeg", "ffmpeg", "ffmpeg"]);
    expect(commands[0]?.args).toEqual(["-version"]);
    expect(commands[1]?.args).toContain(capture.raw);
    expect(commands[1]?.args.at(-1)).toBe(join(evidence, "conversation.mp4"));
    expect(commands[2]?.args).toContain(join(evidence, "conversation.mp4"));
    expect(commands[2]?.args.at(-1)).toBe(join(evidence, "conversation-poster.png"));
  });
  it("does not hide a missing encoder when encoding was requested", async () => {
    await expect(phoneRecording("encoded", missingEncoder).prepare()).rejects.toThrow(
      "spawn ffmpeg ENOENT",
    );
  });
});
