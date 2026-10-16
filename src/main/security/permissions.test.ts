import { describe, expect, it } from "vitest";
import { isAllowedPermission } from "./permissions";

const options = {
  devServerUrl: "http://localhost:5573/",
  bundledRendererFile: "/app/out/renderer/index.html",
};

describe("isAllowedPermission", () => {
  it("allows media for our own renderer only", () => {
    expect(isAllowedPermission("media", "http://localhost:5573/", options)).toBe(true);
    expect(isAllowedPermission("media", "file:///app/out/renderer/index.html", options)).toBe(true);
  });

  it("denies media while dictation is off without disabling clipboard writes", () => {
    expect(isAllowedPermission("media", "http://localhost:5573/", options, false)).toBe(false);
    expect(
      isAllowedPermission("clipboard-sanitized-write", "http://localhost:5573/", options, false),
    ).toBe(true);
  });

  it("denies media for foreign sources", () => {
    expect(isAllowedPermission("media", "https://example.com/", options)).toBe(false);
    expect(isAllowedPermission("media", undefined, options)).toBe(false);
  });

  it("allows clipboard writes only for our own renderer, never a card or foreign document", () => {
    expect(
      isAllowedPermission("clipboard-sanitized-write", "http://localhost:5573/", options),
    ).toBe(true);
    expect(
      isAllowedPermission(
        "clipboard-sanitized-write",
        "file:///app/out/renderer/index.html",
        options,
      ),
    ).toBe(true);
    for (const source of [
      undefined,
      "https://example.com/",
      "about:srcdoc",
      "app-frame://card/body",
      "file:///app/out/renderer/other.html",
    ]) {
      expect(isAllowedPermission("clipboard-sanitized-write", source, options)).toBe(false);
    }
  });

  it("denies every other permission, including clipboard reads, even for our renderer", () => {
    for (const permission of [
      "geolocation",
      "notifications",
      "clipboard-read",
      "deprecated-sync-clipboard-read",
      "camera",
      "usb",
    ]) {
      for (const source of ["http://localhost:5573/", "file:///app/out/renderer/index.html"]) {
        expect(isAllowedPermission(permission, source, options)).toBe(false);
      }
    }
  });
});
