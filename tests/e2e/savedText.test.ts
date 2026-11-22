import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../helpers/scratchDirs";
import { savedText } from "./savedText";

// INF-1504: PR #496's device sign-in journey (run 40413730182) failed when
// the running app's Chromium renamed `.org.chromium.Chromium.eAskHR` away
// after savedText listed the app's folder and before it read that file.

/** What a running app does to a folder right after the scan lists it. */
const afterListing = vi.hoisted(() => new Map<string, () => void>());

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const readdirSync = ((path: string, options: unknown) => {
    const listed = actual.readdirSync(path, options as never);
    afterListing.get(path)?.();
    return listed;
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync };
});

const TYPED = "sk-or-v1-e2e-typed-key-7731";
const KEPT_KEY = JSON.stringify({ type: "api_key", key: TYPED });

/** A user data folder as the device sign-in journey scans it: Chromium's preferences and a computer's account store. */
function userData() {
  const dir = scratchDir("infinitary-saved-text-");
  const preferences = join(dir, "Preferences");
  writeFileSync(preferences, JSON.stringify({ browser: { has_seen_welcome_page: false } }));
  mkdirSync(join(dir, "accounts"));
  const account = join(dir, "accounts", "openrouter.json");
  writeFileSync(account, KEPT_KEY);
  return { dir, preferences, account };
}

it("leaves out a file gone since its folder was listed, and still reads every file kept", () => {
  const { dir, preferences, account } = userData();
  // Chromium's atomic write: the next Preferences, written beside it, then renamed over it.
  const writing = join(dir, ".org.chromium.Chromium.eAskHR");
  writeFileSync(writing, JSON.stringify({ browser: { has_seen_welcome_page: true } }));
  afterListing.set(dir, () => renameSync(writing, preferences));

  const kept = savedText(dir);

  expect(kept.map(({ file }) => file).sort()).toEqual([account, preferences].sort());
  expect(kept.filter(({ text }) => text.includes(TYPED))).toEqual([
    { file: account, text: KEPT_KEY },
  ]);
});

it("leaves out a folder gone since its folder was listed, and still reads every file kept", () => {
  const { dir, preferences, account } = userData();
  const scoped = join(dir, ".org.chromium.Chromium.Q2mZ8k");
  mkdirSync(scoped);
  writeFileSync(join(scoped, "download"), "partial");
  afterListing.set(dir, () => rmSync(scoped, { recursive: true }));

  const kept = savedText(dir);

  expect(kept.map(({ file }) => file).sort()).toEqual([account, preferences].sort());
  expect(kept.filter(({ text }) => text.includes(TYPED))).toEqual([
    { file: account, text: KEPT_KEY },
  ]);
});

it("fails on a file it cannot read for any other reason", () => {
  const { dir, preferences } = userData();
  afterListing.set(dir, () => {
    unlinkSync(preferences);
    mkdirSync(preferences);
  });

  expect(() => savedText(dir)).toThrow(expect.objectContaining({ code: "EISDIR" }));
});

it("fails when the folder it is asked to search is not there", () => {
  const { dir } = userData();

  expect(() => savedText(join(dir, "forges"))).toThrow(
    expect.objectContaining({ code: "ENOENT", path: join(dir, "forges") }),
  );
});
