import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  changedExtensionIds,
  committedTrees,
  commitWorkspace,
  extensionSources,
  readStamp,
  splitMessage,
  stampOrigin,
  writeCommittedTree,
} from "./liveWorkspace";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The live workspace's git bookkeeping (Step 4), over a real temp repo: what
 * a turn touched, the provenance stamp, the commit with the report as its
 * message, and a removal that git remembers.
 */
function repo(): string {
  const dir = scratchDir("infinitary-live-ws-");
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "AGENTS.md"), "# ws\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "-m",
    "seed",
  ]);
  return dir;
}

function log(dir: string): string[] {
  return execFileSync("git", ["-C", dir, "log", "--format=%s%n%b"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("liveWorkspace", () => {
  it("names the extensions with uncommitted changes, by first path segment, tracked edits and untracked files alike", async () => {
    const dir = repo();
    expect(await changedExtensionIds(dir)).toEqual([]);
    mkdirSync(join(dir, "open-prs"));
    writeFileSync(join(dir, "open-prs", "panel.tsx"), "export default () => null;");
    mkdirSync(join(dir, ".claude", "skills", "x"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "x", "SKILL.md"), "not an extension");
    writeFileSync(join(dir, "AGENTS.md"), "# edited managed file\n");
    expect(await changedExtensionIds(dir)).toEqual(["open-prs"]);
    // A tracked edit is the FIRST status line, whose leading space the git
    // runner trims away: the id must still come out whole.
    await commitWorkspace(dir, "Open PRs added");
    expect(await changedExtensionIds(dir)).toEqual([]);
    writeFileSync(join(dir, "open-prs", "panel.tsx"), "export default () => 1;");
    expect(await changedExtensionIds(dir)).toEqual(["open-prs"]);
    mkdirSync(join(dir, "tokyo-clock"));
    writeFileSync(join(dir, "tokyo-clock", "panel.tsx"), "export default () => null;");
    expect(await changedExtensionIds(dir)).toEqual(["open-prs", "tokyo-clock"]);
  });

  // INF-1055: a panel is a folder named like a panel id holding panel.tsx or
  // server.ts, now or in the last commit; a record folder is never one.
  it("attributes only panels: never lesson files or notes, a deleted or renamed panel through its last commit, a half-built one once its panel.tsx lands", async () => {
    const dir = repo();
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    // Real lesson files (docs/lessons.md, "Files") and a folder of notes.
    write("lessons/learner.md", "# Learner\nLikes short rounds.\n");
    write("lessons/chess/progress.md", "# Chess\nGoal: beat my dad at chess\n");
    write("lessons/chess/record.json", JSON.stringify({ goal: "beat my dad at chess" }));
    write("recipes/soup.md", "# Soup\n");
    write("clock/panel.tsx", "export default () => null;");
    write("weather/server.ts", "export const actions = {};");
    expect(await changedExtensionIds(dir)).toEqual(["clock", "weather"]);
    await commitWorkspace(dir, "feat: panels and records");
    expect([...(await committedTrees(dir)).keys()].sort()).toEqual(["clock", "weather"]);

    write("lessons/chess/record.json", JSON.stringify({ goal: "win a game" }));
    write("recipes/soup.md", "# Soup, spicier\n");
    expect(await changedExtensionIds(dir)).toEqual([]);

    // Deleted, renamed, and an entry file removed mid-rewrite.
    rmSync(join(dir, "clock"), { recursive: true });
    renameSync(join(dir, "weather"), join(dir, "forecast"));
    expect(await changedExtensionIds(dir)).toEqual(["clock", "forecast", "weather"]);
    await commitWorkspace(dir, "chore: rename");
    rmSync(join(dir, "forecast", "server.ts"));
    expect(await changedExtensionIds(dir)).toEqual(["forecast"]);
    await commitWorkspace(dir, "chore: forecast emptied");

    // A half-built folder is no panel until its entry file lands.
    write("half/manifest.json", JSON.stringify({ title: "Half" }));
    expect(await changedExtensionIds(dir)).toEqual([]);
    write("half/panel.tsx", "export default () => null;");
    expect(await changedExtensionIds(dir)).toEqual(["half"]);
  });

  it("stamps origin.taskId onto the manifest, creating one, leaving broken JSON alone, and is idempotent", async () => {
    const dir = repo();
    mkdirSync(join(dir, "clock"));
    writeFileSync(join(dir, "clock", "panel.tsx"), "export default () => null;");
    expect(await stampOrigin(dir, "clock", "t1")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "clock", "manifest.json"), "utf8"))).toEqual({
      origin: { taskId: "t1" },
    });
    expect(await stampOrigin(dir, "clock", "t1")).toBe(false);

    writeFileSync(
      join(dir, "clock", "manifest.json"),
      JSON.stringify({ title: "Clock", presence: { always: true } }),
    );
    expect(await stampOrigin(dir, "clock", "t2")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "clock", "manifest.json"), "utf8"))).toEqual({
      title: "Clock",
      presence: { always: true },
      origin: { taskId: "t2" },
    });

    writeFileSync(join(dir, "clock", "manifest.json"), "{ not json");
    expect(await stampOrigin(dir, "clock", "t3")).toBe(false);
    expect(readFileSync(join(dir, "clock", "manifest.json"), "utf8")).toBe("{ not json");
    expect(await stampOrigin(dir, "missing", "t3")).toBe(false);
  });

  it("commits everything under the app's identity with the report as subject and body, and nothing when clean", async () => {
    const dir = repo();
    expect(await commitWorkspace(dir, "nothing changed")).toEqual({ committed: false, paths: [] });
    mkdirSync(join(dir, "clock"));
    writeFileSync(join(dir, "clock", "panel.tsx"), "export default () => null;");
    const commit = await commitWorkspace(
      dir,
      "Tokyo clock panel added. It shows the time in Tokyo, and nothing else.",
    );
    expect(commit.committed).toBe(true);
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.paths).toEqual(["clock/panel.tsx"]);
    expect(log(dir).slice(0, 2)).toEqual([
      "chore: Tokyo clock panel added.",
      "It shows the time in Tokyo, and nothing else.",
    ]);
    expect(
      execFileSync("git", ["-C", dir, "log", "-1", "--format=%an <%ae>"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("Infinitary <infinitary@localhost>");
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      "",
    );
  });

  it("commits every turn while the live task's reconcile keeps reading what changed", async () => {
    // A live task's watcher reconciles (`changedExtensionIds`) while the
    // host commits the turn (`commitWorkspace`). A read that took git's
    // index lock made the turn's `git add` die on `index.lock: File exists`,
    // and the build closed with nothing committed.
    const dir = repo();
    mkdirSync(join(dir, "clock"));
    let reading = true;
    const readers = Array.from({ length: 3 }, async () => {
      while (reading) await changedExtensionIds(dir);
    });
    try {
      for (let round = 1; round <= 10; round++) {
        writeFileSync(join(dir, "clock", "panel.tsx"), `export default () => ${round};`);
        expect(await commitWorkspace(dir, `Round ${round}.`)).toMatchObject({ committed: true });
      }
    } finally {
      reading = false;
      await Promise.all(readers);
    }
    expect(log(dir).filter((line) => line.startsWith("chore: Round"))).toHaveLength(10);
  });

  it("bounds the subject line and never commits an empty message", () => {
    expect(splitMessage("Rows are smaller now")).toEqual({
      subject: "Rows are smaller now",
      body: "",
    });
    expect(splitMessage("First line\nsecond line")).toEqual({
      subject: "First line",
      body: "second line",
    });
    const long = `${"a".repeat(80)}. tail`;
    expect(splitMessage(long).subject).toHaveLength(72);
    // A cut subject keeps the whole report as the body: nothing is lost.
    expect(splitMessage(long).body).toBe(long);
    expect(splitMessage("   ")).toEqual({ subject: "Update the personal workspace", body: "" });
  });

  it("lists an extension's lintable sources relative to it, skipping dotdirs", async () => {
    const dir = repo();
    mkdirSync(join(dir, "clock", "lib"), { recursive: true });
    mkdirSync(join(dir, "clock", ".cache"), { recursive: true });
    writeFileSync(join(dir, "clock", "panel.tsx"), "p");
    writeFileSync(join(dir, "clock", "lib", "util.ts"), "u");
    writeFileSync(join(dir, "clock", "manifest.json"), "{}");
    writeFileSync(join(dir, "clock", "notes.md"), "n");
    writeFileSync(join(dir, "clock", ".cache", "x.ts"), "x");
    expect(await extensionSources(dir, "clock")).toEqual([
      { path: "lib/util.ts", text: "u" },
      { path: "manifest.json", text: "{}" },
      { path: "panel.tsx", text: "p" },
    ]);
    expect(await extensionSources(dir, "missing")).toEqual([]);
  });

  it("copies an extension as its last commit holds it, byte for byte, leaving out what no compile reads", async () => {
    const dir = repo();
    expect(await committedTrees(dir)).toEqual(new Map());
    mkdirSync(join(dir, "clock", "lib"), { recursive: true });
    const panel = "export default () => null;\n\n";
    writeFileSync(join(dir, "clock", "panel.tsx"), panel);
    writeFileSync(join(dir, "clock", "lib", "zone.ts"), 'export const zone = "Tōkyō";\n');
    writeFileSync(join(dir, "clock", "board.css"), "a { color: var(--fg-1); }\n");
    writeFileSync(join(dir, "clock", "icon.png"), Buffer.from([0x89, 0x50, 0xff, 0x00]));
    await commitWorkspace(dir, "feat: a clock");
    const tree = (await committedTrees(dir)).get("clock");
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    // A working edit after the commit is not the commit's.
    writeFileSync(join(dir, "clock", "panel.tsx"), "export default () => 1;\n");
    const copy = join(scratchDir("infinitary-committed-"), "clock");
    await writeCommittedTree(dir, tree as string, copy);
    expect(readFileSync(join(copy, "panel.tsx"), "utf8")).toBe(panel);
    expect(readFileSync(join(copy, "lib", "zone.ts"), "utf8")).toBe(
      'export const zone = "Tōkyō";\n',
    );
    expect(readFileSync(join(copy, "board.css"), "utf8")).toBe("a { color: var(--fg-1); }\n");
    expect(existsSync(join(copy, "icon.png"))).toBe(false);
    // A file at the top, or a directory no id could name, is no extension's tree.
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "x.md"), "x");
    await commitWorkspace(dir, "chore: a dot directory");
    expect([...(await committedTrees(dir)).keys()]).toEqual(["clock"]);
    expect(await committedTrees(scratchDir("infinitary-not-a-repo-"))).toEqual(new Map());
  });

  it("reads the task a working manifest names, and nothing from one that names none", async () => {
    const dir = repo();
    expect(await readStamp(dir, "clock")).toBeNull();
    mkdirSync(join(dir, "clock"));
    await stampOrigin(dir, "clock", "t-1");
    expect(await readStamp(dir, "clock")).toBe("t-1");
    writeFileSync(join(dir, "clock", "manifest.json"), "{ not json");
    expect(await readStamp(dir, "clock")).toBeNull();
    writeFileSync(join(dir, "clock", "manifest.json"), JSON.stringify({ origin: {} }));
    expect(await readStamp(dir, "clock")).toBeNull();
  });
});
