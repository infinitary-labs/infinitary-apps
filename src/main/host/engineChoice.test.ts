import type { HostBrowserOpen, HostBrowserPage, HostChromeFallback } from "@core/host";
import { describe, expect, it } from "vitest";
import { installedEngineOrder, openInEngine } from "./engineChoice";

const input = {} as HostBrowserOpen;
const pageIn = (kind: "chrome" | "edge" | "built-in") =>
  ({
    engine: kind === "built-in" ? { kind } : { kind, version: "157.0.0.0" },
  }) as HostBrowserPage;

function openWith(chrome?: HostChromeFallback | Error, edge?: HostChromeFallback) {
  const tried: string[] = [];
  const lines: string[] = [];
  const open = (env: NodeJS.ProcessEnv = {}) =>
    openInEngine(input, {
      installed: installedEngineOrder(env).map((kind) => ({
        kind,
        open: async () => {
          tried.push(kind);
          const failure = kind === "chrome" ? chrome : edge;
          if (failure instanceof Error) throw failure;
          if (failure) throw Object.assign(new Error(failure), { reason: failure });
          return pageIn(kind);
        },
      })),
      builtIn: async () => {
        tried.push("built-in");
        return pageIn("built-in");
      },
      declined: (error) =>
        error instanceof Error && "reason" in error
          ? { reason: error.reason as HostChromeFallback }
          : undefined,
      log: (line) => lines.push(line),
    });
  return { open, tried, lines };
}

describe("which engine a task browser opens in", () => {
  it("prefers Chrome when both installed browsers work", async () => {
    const { open, tried } = openWith();
    expect((await open()).engine?.kind).toBe("chrome");
    expect(tried).toEqual(["chrome"]);
  });

  it.each(["not-installed", "too-old", "would-not-start"] as const)(
    "tries Edge when Chrome declines (%s)",
    async (reason) => {
      const { open, tried, lines } = openWith(reason);
      expect((await open()).engine?.kind).toBe("edge");
      expect(tried).toEqual(["chrome", "edge"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`chrome declined (${reason})`);
    },
  );

  it("uses built-in when neither installed browser can open and records why", async () => {
    const { open, tried, lines } = openWith("not-installed", "would-not-start");
    expect((await open()).engine).toEqual({ kind: "built-in", fallback: "would-not-start" });
    expect(tried).toEqual(["chrome", "edge", "built-in"]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("edge declined (would-not-start)");
  });

  it("does not try either installed browser in ordinary journeys", async () => {
    const { open, tried } = openWith();
    expect((await open({ INFINITARY_TASK_BROWSER_ENGINE: "built-in" })).engine).toEqual({
      kind: "built-in",
    });
    expect(tried).toEqual(["built-in"]);
  });

  it("does not substitute Edge in an explicit Chrome trial", async () => {
    const { open, tried } = openWith("not-installed");
    expect((await open({ INFINITARY_TASK_BROWSER_ENGINE: "chrome" })).engine?.kind).toBe(
      "built-in",
    );
    expect(tried).toEqual(["chrome", "built-in"]);
  });

  it("never hides a failure that is not an installed engine declining", async () => {
    const { open, tried } = openWith(new Error("the page broke"));
    await expect(open()).rejects.toThrow("the page broke");
    expect(tried).toEqual(["chrome"]);
  });
});
