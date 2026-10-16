import { describe, expect, it } from "vitest";
import { answerPluginRequest, hostShimSource, personalCachePath } from "./pluginProtocol";

const ROOT = "/cache/personal";

describe("app-plugin protocol", () => {
  it("serves each host shim as one default export off the renderer's global, and nothing else under host/", async () => {
    for (const key of ["react", "jsxRuntime", "jsxDevRuntime", "ui"] as const) {
      const response = await answerPluginRequest(`app-plugin://host/${key}.mjs`, ROOT);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe(`export default globalThis.__infinitaryHost.${key};\n`);
      expect(hostShimSource(key)).toContain(key);
    }
    for (const bad of ["lodash.mjs", "react", "react.js", "react.mjs/x"]) {
      expect((await answerPluginRequest(`app-plugin://host/${bad}`, ROOT)).status).toBe(404);
    }
  });

  it("maps a personal module URL onto the cache and refuses anything the compiler could not have produced", () => {
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef", "panel.mjs"])).toBe(
      "/cache/personal/clock/0123456789abcdef/panel.mjs",
    );
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef", "lib", "x.mjs"])).toBe(
      "/cache/personal/clock/0123456789abcdef/lib/x.mjs",
    );
    expect(personalCachePath(ROOT, "Clock", ["0123456789abcdef", "panel.mjs"])).toBeNull();
    expect(personalCachePath(ROOT, "clock", ["nothex", "panel.mjs"])).toBeNull();
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef"])).toBeNull();
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef", "..", "x.mjs"])).toBeNull();
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef", "panel.js"])).toBeNull();
    expect(personalCachePath(ROOT, "clock", ["0123456789abcdef", "a b.mjs"])).toBeNull();
  });

  it("reads a mapped module from disk and answers 404 for a missing one", async () => {
    const reads: string[] = [];
    const read = async (path: string) => {
      reads.push(path);
      if (path.endsWith("panel.mjs")) return new TextEncoder().encode("export default 1;");
      throw new Error("ENOENT");
    };
    const ok = await answerPluginRequest(
      "app-plugin://personal/clock/0123456789abcdef/panel.mjs",
      ROOT,
      read,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("export default 1;");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const missing = await answerPluginRequest(
      "app-plugin://personal/clock/0123456789abcdef/gone.mjs",
      ROOT,
      read,
    );
    expect(missing.status).toBe(404);
    expect(reads).toEqual([
      "/cache/personal/clock/0123456789abcdef/panel.mjs",
      "/cache/personal/clock/0123456789abcdef/gone.mjs",
    ]);
    expect((await answerPluginRequest("app-plugin://personal/clock/x", ROOT, read)).status).toBe(
      404,
    );
    expect((await answerPluginRequest("nonsense", ROOT, read)).status).toBe(400);
  });
});
