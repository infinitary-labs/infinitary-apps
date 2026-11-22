import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  frameFontFaces,
  frameFontFileNames,
  frameStylesheet,
  hasAppRelativeFontUrl,
} from "./frameStylesheet";

const fontsDir = fileURLToPath(new URL("../../design/assets/fonts/", import.meta.url));

describe("the frame stylesheet", () => {
  it("points every typeface at the host's frame scheme and names only files the app ships", () => {
    const faces = frameFontFaces();
    expect(hasAppRelativeFontUrl(faces)).toBe(false);
    const names = frameFontFileNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(faces).toContain(`url(app-frame://fonts/${name})`);
    }
    expect([...names].sort()).toEqual(readdirSync(fontsDir).sort());
    expect(faces).toContain('font-family: "Space Grotesk"');
    expect(faces).toContain('font-family: "JetBrains Mono"');
  });

  it("carries the tokens, the faces, and the base rules, and is stable", () => {
    const sheet = frameStylesheet();
    expect(sheet).toContain("--bg-0:");
    expect(sheet).toContain("--font-ui:");
    expect(sheet).toContain("--rail-width:");
    expect(sheet).toContain("@font-face");
    expect(sheet).toContain("font-family: var(--font-ui);");
    expect(hasAppRelativeFontUrl(sheet)).toBe(false);
    expect(sheet).not.toMatch(/<\/style/i);
    expect(frameStylesheet()).toBe(sheet);
  });
});
