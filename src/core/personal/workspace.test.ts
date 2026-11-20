import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { git } from "../workspace/git";
import { MANAGED_FILES, seedPersonalWorkspace } from "./workspace";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// The app names the seed's commits by its active naming runbook; this is the bundled one, on by default.
const namingRule = () => BUNDLED_NAMING;

describe("seedPersonalWorkspace", () => {
  it("creates the git repo, writes every managed file, and commits the seed", async () => {
    const dir = join(scratchDir("infinitary-personal-ws-"), "personal");
    const result = await seedPersonalWorkspace({ dir, namingRule });
    expect(result.created).toBe(true);
    expect(result.healed.sort()).toEqual(MANAGED_FILES.map((file) => file.path).sort());
    for (const file of MANAGED_FILES) {
      expect(readFileSync(join(dir, file.path), "utf8")).toBe(file.content);
    }
    expect(await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await git(dir, ["log", "--format=%s %an"])).toBe(
      "chore: seed the personal workspace Infinitary",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("heals an edited or missing managed file and leaves the captain's files alone", async () => {
    const dir = join(scratchDir("infinitary-personal-ws-"), "personal");
    await seedPersonalWorkspace({ dir, namingRule });
    writeFileSync(join(dir, "AGENTS.md"), "scribbled over");
    writeFileSync(join(dir, "notes.md"), "mine");
    writeFileSync(join(dir, "clock-panel.txt"), "also mine");
    const again = await seedPersonalWorkspace({ dir, namingRule });
    expect(again.created).toBe(false);
    expect(again.healed).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(MANAGED_FILES[0]?.content);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "clock-panel.txt"), "utf8")).toBe("also mine");
    // Restoring the committed text needs no commit; the captain's untracked
    // files stay untracked and unstaged.
    expect(await git(dir, ["log", "--format=%s"])).toBe("chore: seed the personal workspace");
    expect(await git(dir, ["status", "--porcelain"])).toBe("?? clock-panel.txt\n?? notes.md");
    const third = await seedPersonalWorkspace({ dir, namingRule });
    expect(third.healed).toEqual([]);
  });

  // The Infinitary rename (step 8 of FI3-1780's plan): the workspace's
  // types file takes Infinitary's name, and the one Firstmate 3000 kept goes.
  it("retires the types file a workspace kept under Firstmate 3000's name", async () => {
    const dir = join(scratchDir("infinitary-personal-ws-"), "personal");
    await seedPersonalWorkspace({ dir, namingRule });
    writeFileSync(join(dir, "firstmate-env.d.ts"), 'declare module "@firstmate/contracts" {}\n');
    await git(dir, ["add", "firstmate-env.d.ts"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "older"]);
    await seedPersonalWorkspace({ dir, namingRule });
    expect(await git(dir, ["ls-files", "--", "firstmate-env.d.ts"])).toBe("");
    expect(readFileSync(join(dir, "infinitary-env.d.ts"), "utf8")).toContain(
      'declare module "@infinitary/contracts"',
    );
    expect(await git(dir, ["log", "-1", "--format=%s %an"])).toBe(
      "chore: refresh managed files Infinitary",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
  });

  // The app's start never waits for git to commit a heal (INF-4680's start
  // cuts): it hands the commit to the workspace's queue of git writes.
  it("hands a heal's commit to commitLater with the files already on disk, and commits when it runs", async () => {
    const dir = join(scratchDir("infinitary-personal-ws-"), "personal");
    await seedPersonalWorkspace({ dir, namingRule });
    writeFileSync(join(dir, "firstmate-env.d.ts"), 'declare module "@firstmate/contracts" {}\n');
    await git(dir, ["add", "firstmate-env.d.ts"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "older"]);
    const handed: Array<() => Promise<void>> = [];
    await seedPersonalWorkspace({ dir, namingRule, commitLater: (commit) => handed.push(commit) });
    expect(handed).toHaveLength(1);
    expect(readFileSync(join(dir, "infinitary-env.d.ts"), "utf8")).toContain(
      'declare module "@infinitary/contracts"',
    );
    expect(await git(dir, ["log", "-1", "--format=%s"])).toBe("older");
    await handed[0]?.();
    expect(await git(dir, ["log", "-1", "--format=%s %an"])).toBe(
      "chore: refresh managed files Infinitary",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("commits a workspace it just created before it returns, even with commitLater", async () => {
    const dir = join(scratchDir("infinitary-personal-ws-"), "personal");
    const handed: Array<() => Promise<void>> = [];
    await seedPersonalWorkspace({ dir, namingRule, commitLater: (commit) => handed.push(commit) });
    expect(handed).toEqual([]);
    expect(await git(dir, ["log", "--format=%s"])).toBe("chore: seed the personal workspace");
  });

  it("adopts a pre-existing plain directory, even one inside another repo, without losing what is in it", async () => {
    const outer = scratchDir("infinitary-personal-ws-");
    await git(outer, ["init", "-b", "main"]);
    const dir = join(outer, "fleet", "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x");
    const result = await seedPersonalWorkspace({
      dir,
      namingRule,
      managed: [{ path: "deep/managed.txt", content: "v1" }],
    });
    expect(result.created).toBe(true);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "deep", "managed.txt"), "utf8")).toBe("v1");
    expect(await git(dir, ["rev-parse", "--show-toplevel"])).toBe(realpathSync(dir));
    const v2 = await seedPersonalWorkspace({
      dir,
      namingRule,
      managed: [{ path: "deep/managed.txt", content: "v2" }],
    });
    expect(v2.created).toBe(false);
    expect(v2.healed).toEqual(["deep/managed.txt"]);
    expect(readFileSync(join(dir, "deep", "managed.txt"), "utf8")).toBe("v2");
    // A managed file whose shipped text changed (a new app version) is a commit.
    expect(await git(dir, ["log", "--format=%s"])).toBe(
      "chore: refresh managed files\nchore: seed the personal workspace",
    );
    expect(await git(dir, ["status", "--porcelain"])).toBe("?? keep.txt");
  });
});
