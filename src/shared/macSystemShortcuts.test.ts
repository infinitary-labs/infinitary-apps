import { describe, expect, it } from "vitest";
import { isMacOwnKey, isSystemHotKey, systemHotKeys } from "./macSystemShortcuts";

// Intent: the captain's answer to the review of the card overlay's key - "Also refuse the Mac's
// own shortcuts, like the screenshot key" - since a Mac registers a key macOS itself uses
// without complaint.

/**
 * `AppleSymbolicHotKeys` as a Mac running macOS 26 kept it: the input-source and Spotlight keys
 * turned off, the Space-moving keys left on with no value of their own, and the zoom keys off.
 */
const SAVED_ON_A_MAC = {
  "15": { enabled: false },
  "17": { enabled: false },
  "21": { enabled: false },
  "60": { enabled: false, value: { parameters: [32, 49, 262144], type: "standard" } },
  "61": { enabled: false, value: { parameters: [32, 49, 786432], type: "standard" } },
  "64": { enabled: false, value: { parameters: [32, 49, 1048576], type: "standard" } },
  "65": { enabled: false, value: { parameters: [32, 49, 1572864], type: "standard" } },
  "79": { enabled: true },
  "81": { enabled: true },
  "164": { enabled: true, value: { parameters: [262144, 4294705151], type: "modifier" } },
};

describe("macOS's own shortcuts", () => {
  const onThisMac = systemHotKeys(SAVED_ON_A_MAC);

  it("finds the screenshot key the Mac never wrote down, however the recorder spelled it", () => {
    expect(isSystemHotKey({ key: "4", meta: true, shift: true }, onThisMac)).toBe(true);
    expect(isSystemHotKey({ key: "$", meta: true, shift: true }, onThisMac)).toBe(true);
    expect(isSystemHotKey({ key: "ArrowLeft", ctrl: true }, onThisMac)).toBe(true);
  });

  it("passes a shortcut the person turned off, and the overlay's own key", () => {
    expect(isSystemHotKey({ key: " ", meta: true }, onThisMac)).toBe(false);
    expect(isSystemHotKey({ key: "8", alt: true, meta: true }, onThisMac)).toBe(false);
    expect(isSystemHotKey({ key: "o", ctrl: true, shift: true }, onThisMac)).toBe(false);
  });

  it("follows a shortcut the person moved to another key", () => {
    // Mission Control moved from ⌃↑ to ⌃⌥M: m is key 46.
    const moved = systemHotKeys({
      "32": { enabled: true, value: { parameters: [109, 46, 786432] } },
    });
    expect(isSystemHotKey({ key: "m", ctrl: true, alt: true }, moved)).toBe(true);
    expect(isSystemHotKey({ key: "ArrowUp", ctrl: true }, moved)).toBe(false);
  });

  it("falls back to the shortcuts a new Mac has when the list cannot be read", () => {
    expect(isSystemHotKey({ key: "3", meta: true, shift: true }, systemHotKeys(null))).toBe(true);
  });

  it("counts the keys every Mac app answers as the Mac's own, and not the overlay's key", () => {
    expect(isMacOwnKey({ key: "c", meta: true }, onThisMac)).toBe(true);
    expect(isMacOwnKey({ key: "f", ctrl: true, meta: true }, onThisMac)).toBe(true);
    expect(isMacOwnKey({ key: "a", ctrl: true }, onThisMac)).toBe(true);
    expect(isMacOwnKey({ key: "o", ctrl: true, shift: true }, onThisMac)).toBe(false);
  });
});
