import { describe, expect, it } from "vitest";
import { chromeArguments, chromeMajor } from "./chromeEngine";

describe("installed browser compatibility", () => {
  it("reads the version from either Chromium product response", () => {
    expect(chromeMajor("Chrome/157.0.8103.51")).toBe(157);
    expect(chromeMajor("Edg/157.0.4341.60")).toBe(157);
    expect(chromeMajor("unknown")).toBeUndefined();
  });

  it("starts Edge with a private pipe and a guarded, isolated profile", () => {
    const args = chromeArguments(
      "/scratch/task-browser-edge-kept",
      "darwin",
      "127.0.0.1:8123",
      "edge",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--remote-debugging-pipe",
        "--user-data-dir=/scratch/task-browser-edge-kept",
        "--proxy-server=127.0.0.1:8123",
        "--proxy-bypass-list=<-loopback>",
      ]),
    );
  });
});
