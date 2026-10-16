import { afterEach, describe, expect, it } from "vitest";
import { clearLiveVoiceLevel, readLiveVoiceLevel, setLiveVoiceLevel } from "./liveVoiceLevel";

describe("liveVoiceLevel", () => {
  afterEach(() => {
    clearLiveVoiceLevel();
  });

  it("returns a live sample of zero instead of the fallback", () => {
    setLiveVoiceLevel(0);
    expect(readLiveVoiceLevel(0.6)).toBe(0);
  });

  it("returns the latest sample and clears back to the fallback", () => {
    setLiveVoiceLevel(0.42);
    expect(readLiveVoiceLevel()).toBe(0.42);
    setLiveVoiceLevel(0.9);
    expect(readLiveVoiceLevel()).toBe(0.9);
    clearLiveVoiceLevel();
    expect(readLiveVoiceLevel(0.6)).toBe(0.6);
  });
});
