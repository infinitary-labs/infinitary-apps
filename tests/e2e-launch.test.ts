import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtAppDir } from "./e2e/launch";
import { scratchDir } from "./helpers/scratchDirs";

const temporaryDirs: string[] = [];

function temporaryCheckout() {
  const dir = scratchDir("infinitary-e2e-launch-");
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("e2e Electron launch guard", () => {
  it("refuses an unbuilt worktree before Electron can show its missing-app dialog", () => {
    const worktree = temporaryCheckout();

    expect(() => builtAppDir(worktree)).toThrow(/E2E requires a built Electron app/);
    expect(() => builtAppDir(worktree)).toThrow(/pnpm test:e2e/);
  });

  it("accepts a checkout with electron-vite's main output", () => {
    const worktree = temporaryCheckout();
    const main = join(worktree, "out", "main");
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, "index.js"), "// built main entry");

    expect(builtAppDir(worktree)).toBe(worktree);
  });

  it("makes the e2e command build before starting Playwright", () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:e2e"]).toMatch(/^pnpm build && playwright test$/);
  });
});
