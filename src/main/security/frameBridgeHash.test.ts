import { createHash } from "node:crypto";
import { FRAME_BRIDGE_SCRIPT, FRAME_BRIDGE_SHA256 } from "@shared/plugins/frameScript";
import { describe, expect, it } from "vitest";

const sha256 = (text: string) =>
  `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

describe("frame bridge", () => {
  it("pins the CSP hash to the exact bridge script text", () => {
    expect(sha256(FRAME_BRIDGE_SCRIPT)).toBe(FRAME_BRIDGE_SHA256);
  });
});
