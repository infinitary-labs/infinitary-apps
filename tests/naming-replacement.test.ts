import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { presentationCommitMessage } from "../src/core/forge";
import { appPathsFor } from "../src/core/paths";
import { commitWorkspace } from "../src/core/personal/liveWorkspace";
import { seedPersonalWorkspace } from "../src/core/personal/workspace";
import { Runbooks } from "../src/core/runbooks/runbooks";
import { openInMemoryDatabase } from "../src/core/storage/db";
import { SettingsStore } from "../src/core/storage/settingsStore";
import { git } from "../src/core/workspace/git";
import { RepoRegistry } from "../src/core/workspace/repoRegistry";
import { keptRefFor, WorkspaceService } from "../src/core/workspace/workspaceService";
import type { NamingRule, RunbookFacts } from "../src/shared/runbooks";
import { freshDatabase } from "./helpers/database";
import { FakeForge, insertDirectPrTask, setup } from "./helpers/prCiHarness";
import { scratchDir } from "./helpers/scratchDirs";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../src/core/utilityQos", async (importOriginal) =>
  (await import("./helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Intent: the captain's ask that no title or commit-message rule lives in the
// app: with the built-in Commit and PR naming runbook turned off and a
// replacement with different rules on, every name the app composes or checks
// follows the replacement.

const BUNDLE = join(__dirname, "../resources/runbooks");
const CODE: RunbookFacts = {
  kind: "implement",
  place: "project",
  delivery: "direct-pr",
  care: "standard",
  backend: "pi",
};
const TEAM: NamingRule = {
  pattern: "^\\[[A-Z][A-Z0-9-]*\\] \\S.+$",
  message: 'Start with the area in capitals and brackets, such as "[DOCS] Explain the export".',
  compose: "[APP] {summary}",
  footer: "^Refs: [^\\r\\n]+",
};
const TEAM_GUIDE =
  "Name every commit and pull request [AREA] Summary, the area in capitals. Name a task's branch team/ and its ticket, such as team/web-1234.";

/** The runbooks the app reads, with the captain's own naming copy on in place of the built-in. */
function teamRunbooks(): Runbooks {
  const books = new Runbooks(
    BUNDLE,
    new SettingsStore(openInMemoryDatabase()),
    () => [],
    join(scratchDir("inf-team-naming-"), "runbooks"),
  );
  books.copy("naming", "team-naming", "Team naming");
  const dir = books.list().find((book) => book.id === "team-naming")?.path;
  if (!dir) throw new Error("The copy did not return its editable folder.");
  const manifest = JSON.parse(readFileSync(join(dir, "runbook.json"), "utf8"));
  writeFileSync(join(dir, "runbook.json"), JSON.stringify({ ...manifest, naming: TEAM }));
  writeFileSync(join(dir, manifest.crew.file), TEAM_GUIDE);
  books.set("team-naming", true);
  return books;
}

const subject = (dir: string, ref = "HEAD") => git(dir, ["log", "-1", "--format=%s", ref]);

describe("a replacement naming runbook decides every name", () => {
  it("turns the built-in off and serves its own rule and guidance", () => {
    const books = teamRunbooks();
    expect(books.list().find((book) => book.id === "naming")?.enabled).toBe(false);
    expect(books.naming()).toEqual(TEAM);
    const served = books.crew(CODE).text;
    expect(served).toContain(TEAM_GUIDE);
    expect(served).not.toContain("Name every commit subject");
    // The first mate names each task's branch by the replacement's words (INF-4195's plan, piece 2).
    const builtIn = readFileSync(join(BUNDLE, "naming/guide.md"), "utf8");
    const branchWords = builtIn.slice(builtIn.indexOf("Name a task's branch")).trim();
    expect(books.firstmate().text).toContain(TEAM_GUIDE);
    expect(books.firstmate().text).not.toContain(branchWords);
  });

  it("checks pull request titles and the branch's commits by its rule", async () => {
    const books = teamRunbooks();
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({
      forge,
      realRange: true,
      namingRule: () => books.naming(),
    });
    await insertDirectPrTask(tasks, repos);
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    run("update-ref", "refs/remotes/origin/main", "HEAD");
    run("checkout", "-b", "fm/task-ab12cd34");
    writeFileSync(join(dir, "export.ts"), "export {};\n");
    run("add", "export.ts");
    run("commit", "-m", "feat: add the export");

    const builtInTitle = await service.publication.open("ab12cd34", {
      title: "feat: add the export",
      body: "b",
    });
    expect(builtInTitle).toContain("The pull request title does not follow the naming runbook.");
    expect(builtInTitle).toContain(TEAM.message);
    const builtInCommit = await service.publication.open("ab12cd34", {
      title: "[APP] Add the export",
      body: "b",
    });
    expect(builtInCommit).toContain('Received: "feat: add the export"');
    expect(builtInCommit).toContain(TEAM.message);
    expect(forge.calls.filter((call) => call.startsWith("openChange"))).toEqual([]);

    run("commit", "--amend", "-m", "[APP] Add the export");
    expect(
      await service.publication.open("ab12cd34", { title: "[APP] Add the export", body: "b" }),
    ).toContain("Opened pull request #42");

    // A title renamed the built-in's way where the project lives is refused at merge.
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: run("rev-parse", "HEAD"),
      title: "feat: add the export",
    };
    const merge = await service.merges.merge("ab12cd34");
    expect(merge.ok).toBe(false);
    expect(merge.text).toContain(TEAM.message);
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("names the commits the app writes itself in its form", async () => {
    const books = teamRunbooks();
    const namingRule = () => books.naming();

    const repos = new RepoRegistry(freshDatabase(), join(scratchDir("inf-team-fleet-"), "fleet"), {
      namingRule,
    });
    const { repo } = await repos.setup({ kind: "init", name: "meter" });
    expect(await subject(repo.path)).toBe("[APP] initialize fleet project");

    const paths = appPathsFor(scratchDir("inf-team-workspace-"));
    const workspace = new WorkspaceService(paths, { namingRule, pool: false });
    const home = await workspace.ensureDefaultRepo();
    expect(await subject(home)).toBe("[APP] initialize default workspace");
    const task = await workspace.createTaskWorktree("team1111");
    writeFileSync(join(task.cwd, "export.ts"), "export {};\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "[APP] Add the export"]);
    writeFileSync(join(home, "notes.md"), "moved\n");
    await git(home, ["add", "-A"]);
    await git(home, ["commit", "-m", "[DOCS] Move main"]);
    expect(await workspace.landTaskWork(task)).toEqual({ mode: "merge" });
    expect(await subject(home)).toBe("[APP] integrate task work");
    const kept = await workspace.createTaskWorktree("team2222");
    writeFileSync(join(kept.cwd, "draft.md"), "draft\n");
    expect(await workspace.keepUnlandedWork(kept, { keepAlways: true })).not.toBeNull();
    expect(await subject(home, keptRefFor("team2222"))).toBe(
      "[APP] keep work of task team2222 (fm/task-team2222)",
    );
    const plain = await workspace.createTaskWorktree("team3333");
    await git(plain.cwd, ["commit", "--allow-empty", "-m", "feat: add the export"]);
    await expect(workspace.landTaskWork(plain)).rejects.toThrow(TEAM.message);

    const personal = join(scratchDir("inf-team-personal-"), "personal");
    await seedPersonalWorkspace({ dir: personal, namingRule });
    expect(await subject(personal)).toBe("[APP] seed the personal workspace");
    writeFileSync(join(personal, "clock.md"), "Tokyo\n");
    await commitWorkspace(personal, "[DOCS] Explain the clock. It shows Tokyo.", {
      namingRule: books.naming(),
    });
    expect(await subject(personal)).toBe("[DOCS] Explain the clock.");
    writeFileSync(join(personal, "clock.md"), "Tokyo and Paris\n");
    await commitWorkspace(personal, "feat: add Paris to the clock.", {
      namingRule: books.naming(),
    });
    expect(await subject(personal)).toBe("[APP] feat: add Paris to the clock.");
  });

  it("carries its own footers, not the built-in's, into a squash commit message", () => {
    const books = teamRunbooks();
    const story = {
      whatChanged: ["Adds the export."],
      projectText: "Closes #3\n\nRefs: APP-12\n\nBREAKING CHANGE: the old export goes.",
    };
    expect(presentationCommitMessage(story, books.naming())).toBe(
      "Adds the export.\n\nRefs: APP-12",
    );
  });

  it("with no naming runbook on, checks no name and gives the app's commits their plain summary", async () => {
    const books = teamRunbooks();
    books.set("team-naming", false);
    expect(books.naming()).toBeNull();
    const workspace = new WorkspaceService(appPathsFor(scratchDir("inf-no-naming-")), {
      namingRule: () => books.naming(),
      pool: false,
    });
    const home = await workspace.ensureDefaultRepo();
    expect(await subject(home)).toBe("initialize default workspace");
    const task = await workspace.createTaskWorktree("none1111");
    await git(task.cwd, ["commit", "--allow-empty", "-m", "whatever the author chose"]);
    expect(await workspace.landTaskWork(task)).toEqual({ mode: "fast-forward" });
  });
});
