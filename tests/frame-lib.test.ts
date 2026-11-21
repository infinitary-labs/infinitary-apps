import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildFrameLib } from "../scripts/frame-lib";
import { scratchDir } from "./helpers/scratchDirs";

vi.setConfig({ testTimeout: 10_000 });

/** The output files that call a JSX function, with the calls each makes to React's development-only one. */
function devJsxCalls(dir: string): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const path = join(entry.parentPath, entry.name);
    const found = readFileSync(path, "utf8").match(/\bjsxDEV\)?\(/g)?.length ?? 0;
    if (found) calls[path.slice(dir.length + 1)] = found;
  }
  return calls;
}

describe("the frame realm's library", () => {
  // The captain's ask on INF-5635's plan: fix pnpm dev, whose panels threw
  // "jsxDEV is not a function". electron-vite dev sets NODE_ENV=development
  // before the main build builds the library, which carries React's
  // production runtime, where jsxDEV is undefined.
  it("compiles production JSX calls when built under pnpm dev's NODE_ENV", async () => {
    const out = scratchDir("infinitary-frame-lib-");
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await buildFrameLib(join(import.meta.dirname, ".."), out);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
    expect(readdirSync(out)).toContain("boot.mjs");
    expect(devJsxCalls(out)).toEqual({});
  });
});
