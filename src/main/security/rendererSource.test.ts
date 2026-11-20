import { describe, expect, it } from "vitest";
import { isAppRendererSource } from "./rendererSource";

const options = {
  devServerUrl: "http://localhost:5573/",
  bundledRendererFile: "/app/out/renderer/index.html",
};

describe("isAppRendererSource", () => {
  it("accepts the dev server origin", () => {
    expect(isAppRendererSource("http://localhost:5573/", options)).toBe(true);
    expect(isAppRendererSource("http://localhost:5573/#settings", options)).toBe(true);
  });

  it("accepts the exact bundled renderer file", () => {
    expect(isAppRendererSource("file:///app/out/renderer/index.html", options)).toBe(true);
  });

  it("rejects other origins, files, and garbage", () => {
    expect(isAppRendererSource("http://localhost:5174/", options)).toBe(false);
    expect(isAppRendererSource("https://example.com/", options)).toBe(false);
    expect(isAppRendererSource("file:///tmp/evil.html", options)).toBe(false);
    expect(isAppRendererSource("not a url", options)).toBe(false);
    expect(isAppRendererSource(undefined, options)).toBe(false);
  });

  it("rejects the dev origin when no dev server is configured", () => {
    expect(
      isAppRendererSource("http://localhost:5573/", {
        bundledRendererFile: "/app/out/renderer/index.html",
      }),
    ).toBe(false);
  });
});
