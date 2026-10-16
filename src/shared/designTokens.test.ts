import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLOR_TOKENS,
  nearestColorToken,
  nearestRadiusToken,
  nearestShadowToken,
  nearestTextSizeToken,
  RADIUS_TOKENS,
  SPACE_TOKENS,
  TEXT_SIZE_TOKENS,
} from "./designTokens";

/**
 * The table in designTokens.ts is a mirror, not a source: these tests read
 * the real stylesheets and fail if a token moves, is added, or is removed
 * without the table following.
 */

const TOKENS_DIR = join(__dirname, "../renderer/src/design/tokens");

function declarations(file: string, selector: string): Map<string, string> {
  const css = readFileSync(join(TOKENS_DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`${file}: no ${selector} block`);
  const open = css.indexOf("{", at);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(match[1] as string, (match[2] as string).trim());
  }
  return out;
}

function scaleFromCss(file: string, prefix: string): { name: string; px: number }[] {
  return [...declarations(file, ":root {")]
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, value]) => ({ name, px: Number.parseFloat(value) }));
}

describe("the token table mirrors the stylesheets", () => {
  it("carries every literal color token, in both themes", () => {
    const dark = declarations("colors.css", ":root {");
    const light = declarations("colors.css", '[data-theme="light"] {');
    const literal = [...dark].filter(([, value]) => /^(#|rgba?\()/i.test(value));
    expect(COLOR_TOKENS.map((token) => token.name)).toEqual(literal.map(([name]) => name));
    for (const token of COLOR_TOKENS) {
      expect(token.dark, token.name).toBe(dark.get(token.name));
      expect(token.light, token.name).toBe(light.get(token.name) ?? dark.get(token.name));
    }
  });

  it("carries the type, spacing and radius scales", () => {
    expect(TEXT_SIZE_TOKENS).toEqual(scaleFromCss("typography.css", "--text-"));
    expect(SPACE_TOKENS).toEqual(scaleFromCss("spacing.css", "--space-"));
    expect(RADIUS_TOKENS).toEqual(scaleFromCss("effects.css", "--radius-"));
  });
});

describe("naming the nearest token", () => {
  it("recognises a token's own value, in either theme", () => {
    expect(nearestColorToken("#7fdcff")).toBe("--accent");
    expect(nearestColorToken("#0e8fd0")).toBe("--accent");
    expect(nearestColorToken("rgb(255, 162, 87)")).toBe("--hot");
  });

  it("names a neighbour for a value the scale does not have", () => {
    // A slightly-off cyan and a slightly-off ember, as a hand-written panel
    // tends to produce.
    expect(nearestColorToken("#80ddff")).toBe("--accent");
    expect(nearestColorToken("#ff9f50")).toBe("--hot");
    expect(nearestColorToken("#000000")).toBe("--bg-0");
    expect(nearestColorToken("not a color")).toBeUndefined();
  });

  it("rounds a raw size to the scale rung beside it", () => {
    expect(nearestTextSizeToken(12)).toBe("--text-sm");
    expect(nearestTextSizeToken(13.5)).toBe("--text-base");
    expect(nearestRadiusToken(9)).toBe("--radius-m");
    expect(nearestRadiusToken(4)).toBe("--radius-xs");
  });

  it("keys a raw shadow on its blur", () => {
    expect(nearestShadowToken("0 1px 3px rgba(0,0,0,0.4)")).toBe("--shadow-1");
    expect(nearestShadowToken("0 8px 24px -10px rgba(0,0,0,0.5)")).toBe("--shadow-2");
    expect(nearestShadowToken("0 14px 44px -16px rgba(0,0,0,0.6)")).toBe("--shadow-card");
  });
});
