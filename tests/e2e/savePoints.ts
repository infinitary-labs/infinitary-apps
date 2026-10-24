import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { requireConventional } from "../../src/core/workspace/conventional";

/**
 * A workspace's save points as a journey reads them (docs/testing.md, the
 * e2e assertion contract): how many there are, what the newest touched and
 * carries, and whether anything is left unsaved. The exact subject the host
 * writes is composed and tested where it is written (`panelInstructions.test.ts`,
 * `liveWorkspace.test.ts`, `personalExtensions.test.ts`), so a journey asks
 * only that the newest is one the host's own naming guard accepts
 * (`requireConventional`, whose rule `conventional.test.ts` owns).
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** How many save points the workspace's history holds. */
export function savePointCount(dir: string): number {
  return Number(git(dir, "rev-list", "--count", "HEAD").trim());
}

/** A save point: its subject, its whole message, and the paths it touched. */
export type SavePoint = { subject: string; message: string; paths: string[] };

/** The workspace's newest save point. */
export function newestSavePoint(dir: string): SavePoint {
  return {
    subject: git(dir, "log", "-1", "--format=%s").trim(),
    message: git(dir, "log", "-1", "--format=%B"),
    paths: git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean),
  };
}

/** Whether nothing in the workspace is left unsaved. */
export function workspaceClean(dir: string): boolean {
  return git(dir, "status", "--porcelain") === "";
}

/**
 * Exactly one new save point since `before`, named so the host's guard
 * takes it, with nothing left unsaved: returned so the journey can check
 * that what it asked for is what was saved.
 */
export async function oneNewSavePoint(dir: string, before: number): Promise<SavePoint> {
  await expect.poll(() => savePointCount(dir), { timeout: 30_000 }).toBe(before + 1);
  const saved = newestSavePoint(dir);
  expect(() => requireConventional(saved.subject)).not.toThrow();
  expect(workspaceClean(dir)).toBe(true);
  return saved;
}
