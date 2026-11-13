import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BatchChange } from "@shared/batches";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { combine, LEFT_OUT_WORDS, landedCommits, pushBatch } from "./combine";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Integration budget (docs/test-cohorts.md): real git against a bare host, the slowest
// test took 1.1 s on the Mac, five times that rounded up.
vi.setConfig({ testTimeout: 10_000 });

// Intent: the captain's approved plan for batches of their own, piece 1: the app combines
// the whole line at home, in approval order, onto the freshly fetched default branch, one
// commit per change with the change's checked title as its subject; a change that does
// not combine is left out and the rest go on; each member's receipt names its own commit.

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

type Host = {
  /** The project where it lives: a bare repository. */
  bare: string;
  /** The project's folder at home, where the combine runs. */
  home: string;
  /** A crewmate's working copy, where branches are written and pushed. */
  work: string;
};

/** A small project where it lives, its folder at home and a working copy, with one commit on main. */
function host(): Host {
  const root = scratchDir("infinitary-batch-combine-");
  const bare = join(root, "meter.git");
  const home = join(root, "home");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", bare, work], { stdio: "pipe" });
  run(work, "config", "user.name", "Ada Crew");
  run(work, "config", "user.email", "ada@example.com");
  write(work, "src/parser.ts", "export const parse = (text: string) => new Date(text);\n");
  write(work, "src/report.ts", "export const rows = ['date', 'total'];\n");
  run(work, "add", "-A");
  run(work, "commit", "-m", "chore: start the meter");
  run(work, "push", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["clone", bare, home], { stdio: "pipe" });
  return { bare, home, work };
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Push a branch with one commit that writes `files`, started from `from`, and answer it as an approved change. */
function change(
  at: Host,
  input: {
    taskId: string;
    title: string;
    body?: string;
    files: Record<string, string>;
    from?: string;
    approvedAt: number;
    author?: string;
  },
): BatchChange {
  const branch = `fm/${input.taskId}`;
  run(at.work, "fetch", "--quiet", "origin");
  run(at.work, "checkout", "--quiet", "-B", branch, input.from ?? "origin/main");
  for (const [path, text] of Object.entries(input.files)) write(at.work, path, text);
  run(at.work, "add", "-A");
  run(
    at.work,
    "-c",
    `user.name=${input.author ?? "Ada Crew"}`,
    "commit",
    "-m",
    `wip: ${input.taskId}`,
  );
  run(at.work, "push", "--force", "origin", `HEAD:refs/heads/${branch}`);
  return {
    taskId: input.taskId,
    branch,
    head: run(at.work, "rev-parse", "HEAD"),
    title: input.title,
    body: input.body ?? "",
    at: input.approvedAt,
  };
}

const PARSER = {
  taskId: "task-parser",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.\n\nBREAKING CHANGE: a date without a zone is read as UTC.",
  files: {
    "src/parser.ts": "export const parse = (text: string) => new Date(text.concat('Z'));\n",
  },
  approvedAt: 1_000,
};
const EXPORT = {
  taskId: "task-export",
  title: "feat(export): add a CSV export",
  body: "- A report exports as CSV.",
  files: { "src/export.ts": "export const csv = (rows: string[]) => rows.join(',');\n" },
  approvedAt: 2_000,
  author: "Grace Crew",
};

const AT = Date.UTC(2026, 10, 11, 18, 30);

/** The time limit these tests give a call: a local fetch takes a small part of it. */
const SOON = 500;

/**
 * From its `after`-th connection on, the place the project lives takes a
 * connection and stays silent for ten times the limit these tests give a
 * call, then gives up. Git's own `ext` transport runs this script in place
 * of the network, so a real fetch or push from the project's folder at home
 * waits on it as it would on a silent host. Answers whether the host gave
 * up by itself: a call its own limit ended never lets it get that far.
 */
function goesSilent(at: Host, after: number): () => boolean {
  const root = dirname(at.bare);
  const calls = join(root, "calls");
  const gaveUp = join(root, "gave-up");
  const script = join(root, "host.sh");
  mkdirSync(calls);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `n=$(ls "${calls}" | wc -l)`,
      `: > "${calls}/$$"`,
      `if [ "$n" -ge ${after} ]; then sleep ${(SOON * 10) / 1000}; : > "${gaveUp}"; exit 1; fi`,
      `exec git "$1" "${at.bare}"`,
      "",
    ].join("\n"),
  );
  run(at.home, "config", "protocol.ext.allow", "always");
  run(at.home, "remote", "set-url", "origin", `ext::sh ${script.replaceAll(" ", "% ")} %s`);
  return () => existsSync(gaveUp);
}

describe("combining approved changes at home", () => {
  it("writes one commit per change, in approval order, onto the default branch", async () => {
    const at = host();
    const parser = change(at, PARSER);
    const exported = change(at, EXPORT);
    const before = run(at.home, "status", "--porcelain=v2", "--branch");

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [parser, exported],
      at: AT,
    });

    expect(result.leftOut).toEqual([]);
    expect(result.base).toBe(run(at.bare, "rev-parse", "main"));
    expect(result.members.map((member) => member.taskId)).toEqual(["task-parser", "task-export"]);
    const [first, second] = result.members.map((member) => member.commit) as [string, string];
    expect(result.head).toBe(second);
    // One commit each, the second on the first, the first on the default branch.
    expect(run(at.home, "rev-list", "--parents", "-n", "1", first)).toBe(`${first} ${result.base}`);
    expect(run(at.home, "rev-list", "--parents", "-n", "1", second)).toBe(`${second} ${first}`);
    // The change's checked title is the subject; its story's words and breaking footer the body.
    expect(run(at.home, "log", "-1", "--format=%B", first)).toBe(
      `${PARSER.title}\n\n${PARSER.body}`,
    );
    expect(run(at.home, "log", "-1", "--format=%s%n%an", second)).toBe(
      `${EXPORT.title}\nGrace Crew`,
    );
    // Each commit carries its own change and nothing else.
    expect(run(at.home, "diff", "--name-only", result.base, first)).toBe("src/parser.ts");
    expect(run(at.home, "diff", "--name-only", first, second)).toBe("src/export.ts");
    // The project's own folder is untouched: no file moved and no branch changed.
    expect(run(at.home, "status", "--porcelain=v2", "--branch")).toBe(before);
    expect(readFileSync(join(at.home, "src/parser.ts"), "utf8")).toContain("new Date(text)");
  });

  it("combines onto the default branch as it is now, not as the home last saw it", async () => {
    const at = host();
    const parser = change(at, PARSER);
    // Someone else's change merges where the project lives after the approval.
    run(at.work, "checkout", "--quiet", "-B", "main", "origin/main");
    write(at.work, "README.md", "# Meter\n");
    run(at.work, "add", "-A");
    run(at.work, "commit", "-m", "docs: add a readme");
    run(at.work, "push", "origin", "HEAD:refs/heads/main");
    const moved = run(at.work, "rev-parse", "HEAD");

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [parser],
      at: AT,
    });

    expect(result.base).toBe(moved);
    expect(run(at.home, "ls-tree", "-r", "--name-only", result.head).split("\n")).toEqual([
      "README.md",
      "src/parser.ts",
      "src/report.ts",
    ]);
  });

  it("leaves out a change that does not combine with one ahead of it, and the rest go on", async () => {
    const at = host();
    const parser = change(at, PARSER);
    const clash = change(at, {
      taskId: "task-strict",
      title: "fix(parser): refuse a date with no year",
      files: { "src/parser.ts": "export const parse = (text: string) => strict(text);\n" },
      approvedAt: 1_500,
    });
    const exported = change(at, EXPORT);

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [parser, clash, exported],
      at: AT,
    });

    expect(result.members.map((member) => member.taskId)).toEqual(["task-parser", "task-export"]);
    expect(result.leftOut).toEqual([{ change: clash, reason: LEFT_OUT_WORDS.conflict }]);
  });

  it("leaves out a change whose pushed branch moved past the approved version", async () => {
    const at = host();
    const approved = change(at, PARSER);
    // The crewmate pushes again after the approval: what was approved is no longer what is pushed.
    change(at, { ...PARSER, files: { "src/parser.ts": "export const parse = Date.parse;\n" } });

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [approved],
      at: AT,
    });

    expect(result.members).toEqual([]);
    expect(result.head).toBe(result.base);
    expect(result.leftOut).toEqual([{ change: approved, reason: LEFT_OUT_WORDS.moved }]);
  });

  it("leaves out a change that changes nothing on the default branch as it is now", async () => {
    const at = host();
    const parser = change(at, PARSER);
    run(at.work, "push", "origin", `${parser.head}:refs/heads/main`);

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [parser],
      at: AT,
    });

    expect(result.leftOut).toEqual([{ change: parser, reason: LEFT_OUT_WORDS.nothing }]);
  });

  it("carries a change stacked on another only once that work is in, never unapproved work", async () => {
    const at = host();
    const parser = change(at, PARSER);
    const stacked: BatchChange = {
      ...change(at, {
        taskId: "task-zones",
        title: "feat(parser): name the time zone in errors",
        files: { "src/zones.ts": "export const zone = 'UTC';\n" },
        from: parser.head,
        approvedAt: 3_000,
      }),
      base: parser.branch,
    };

    // Alone, it would bring the parser change in under its own commit.
    const alone = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [stacked],
      at: AT,
    });
    expect(alone.members).toEqual([]);
    expect(alone.leftOut).toEqual([
      { change: stacked, reason: LEFT_OUT_WORDS.stacked("fm/task-parser") },
    ]);

    // Behind the change it builds on, it adds only its own work.
    const together = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [parser, stacked],
      at: AT,
    });
    expect(together.leftOut).toEqual([]);
    const [first, second] = together.members.map((member) => member.commit) as [string, string];
    expect(run(at.home, "diff", "--name-only", first, second)).toBe("src/zones.ts");
  });
});

describe("pushing the batch branch the app owns", () => {
  it("pushes a new branch, then the next version over the one it pushed", async () => {
    const at = host();
    const first = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, PARSER)],
      at: AT,
    });
    await pushBatch({
      repoDir: at.home,
      branch: "infinitary-batch/7c41",
      head: first.head,
      expected: null,
    });
    expect(run(at.bare, "rev-parse", "infinitary-batch/7c41")).toBe(first.head);

    const second = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, EXPORT)],
      at: AT,
    });
    await pushBatch({
      repoDir: at.home,
      branch: "infinitary-batch/7c41",
      head: second.head,
      expected: first.head,
    });
    expect(run(at.bare, "rev-parse", "infinitary-batch/7c41")).toBe(second.head);
  });

  it("refuses a branch someone else moved, and never overwrites it", async () => {
    const at = host();
    const first = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, PARSER)],
      at: AT,
    });
    await pushBatch({
      repoDir: at.home,
      branch: "infinitary-batch/7c41",
      head: first.head,
      expected: null,
    });
    // A person pushes to the batch branch by hand.
    run(at.work, "fetch", "--quiet", "origin");
    run(at.work, "checkout", "--quiet", "-B", "by-hand", "origin/infinitary-batch/7c41");
    write(at.work, "NOTES.md", "a note\n");
    run(at.work, "add", "-A");
    run(at.work, "commit", "-m", "docs: a note by hand");
    run(at.work, "push", "origin", "HEAD:refs/heads/infinitary-batch/7c41");
    const byHand = run(at.work, "rev-parse", "HEAD");

    const second = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, EXPORT)],
      at: AT,
    });
    await expect(
      pushBatch({
        repoDir: at.home,
        branch: "infinitary-batch/7c41",
        head: second.head,
        expected: first.head,
      }),
    ).rejects.toThrow();
    expect(run(at.bare, "rev-parse", "infinitary-batch/7c41")).toBe(byHand);
  });
});

describe("each member's own commit on the default branch after its batch merged", () => {
  async function pushed(at: Host) {
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, PARSER), change(at, EXPORT)],
      at: AT,
    });
    await pushBatch({
      repoDir: at.home,
      branch: "infinitary-batch/7c41",
      head: result.head,
      expected: null,
    });
    return result;
  }

  it("is the batch's own commit where the merge kept them, as a merge commit does", async () => {
    const at = host();
    const result = await pushed(at);
    run(at.work, "fetch", "--quiet", "origin");
    run(at.work, "checkout", "--quiet", "-B", "main", "origin/main");
    run(at.work, "merge", "--no-ff", "-m", "Merge the batch", "origin/infinitary-batch/7c41");
    run(at.work, "push", "origin", "HEAD:refs/heads/main");

    const landed = await landedCommits({
      repoDir: at.home,
      defaultBranch: "main",
      members: result.members,
      merged: run(at.work, "rev-parse", "HEAD"),
    });

    expect([...landed]).toEqual(result.members.map((member) => [member.taskId, member.commit]));
  });

  it("is the commit a rebase merge wrote for it, read in the batch's order by its title", async () => {
    const at = host();
    const result = await pushed(at);
    // The default branch moved, so the host's rebase merge writes new commits.
    run(at.work, "fetch", "--quiet", "origin");
    run(at.work, "checkout", "--quiet", "-B", "main", "origin/main");
    write(at.work, "README.md", "# Meter\n");
    run(at.work, "add", "-A");
    run(at.work, "commit", "-m", "docs: add a readme");
    run(at.work, "checkout", "--quiet", "-B", "rebased", "origin/infinitary-batch/7c41");
    run(at.work, "rebase", "--quiet", "main");
    run(at.work, "push", "origin", "HEAD:refs/heads/main");
    const tip = run(at.work, "rev-parse", "HEAD");

    const landed = await landedCommits({
      repoDir: at.home,
      defaultBranch: "main",
      members: result.members,
      merged: tip,
    });

    expect(landed.get("task-export")).toBe(tip);
    expect(landed.get("task-parser")).toBe(run(at.work, "rev-parse", "HEAD~1"));
    expect(landed.get("task-parser")).not.toBe(result.members[0]?.commit);
    expect(run(at.work, "log", "-1", "--format=%s", landed.get("task-parser") as string)).toBe(
      PARSER.title,
    );
  });

  it("names no commit when the default branch does not hold the batch", async () => {
    const at = host();
    const result = await pushed(at);

    const landed = await landedCommits({
      repoDir: at.home,
      defaultBranch: "main",
      members: result.members,
    });

    expect([...landed.values()]).toEqual([undefined, undefined]);
  });
});

// Intent: the independent review's finding on this change, a bug being fixed: every writer
// of a project's batch waits behind its fetches and pushes, so a remote that stops
// answering has to end the call, and a change is never left out for a slow remote.
describe("a place the project lives that stops answering", () => {
  it("ends the combine at the time limit, and leaves out no change whose branch it could not read in time", async () => {
    const at = host();
    const approved = change(at, PARSER);
    // The default branch is read; the change's own branch never answers.
    const gaveUp = goesSilent(at, 1);

    await expect(
      combine({
        repoDir: at.home,
        defaultBranch: "main",
        changes: [approved],
        at: AT,
        timeoutMs: SOON,
      }),
    ).rejects.toMatchObject({ killed: true });
    expect(gaveUp()).toBe(false);
  });

  it("ends the combine too when the branch a stacked change builds on never answers", async () => {
    const at = host();
    const parser = change(at, PARSER);
    const stacked: BatchChange = {
      ...change(at, {
        taskId: "task-zones",
        title: "feat(parser): name the time zone in errors",
        files: { "src/zones.ts": "export const zone = 'UTC';\n" },
        from: parser.head,
        approvedAt: 3_000,
      }),
      base: parser.branch,
    };
    // The default branch and the change's own branch are read; the branch it builds on never answers.
    const gaveUp = goesSilent(at, 2);

    await expect(
      combine({
        repoDir: at.home,
        defaultBranch: "main",
        changes: [stacked],
        at: AT,
        timeoutMs: SOON,
      }),
    ).rejects.toMatchObject({ killed: true });
    expect(gaveUp()).toBe(false);
  });

  it("ends the push of the batch branch at the time limit", async () => {
    const at = host();
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, PARSER)],
      at: AT,
    });
    const gaveUp = goesSilent(at, 0);

    await expect(
      pushBatch({
        repoDir: at.home,
        branch: "infinitary-batch/7c41",
        head: result.head,
        expected: null,
        timeoutMs: SOON,
      }),
    ).rejects.toMatchObject({ killed: true });
    expect(gaveUp()).toBe(false);
    expect(run(at.bare, "branch", "--list", "infinitary-batch/*")).toBe("");
  });

  it("names no merged commit it could not read in time", async () => {
    const at = host();
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [change(at, PARSER)],
      at: AT,
    });
    await pushBatch({
      repoDir: at.home,
      branch: "infinitary-batch/7c41",
      head: result.head,
      expected: null,
    });
    // The batch merged keeping its commit, which an answering host would name.
    run(at.work, "fetch", "--quiet", "origin");
    run(at.work, "push", "origin", "origin/infinitary-batch/7c41:refs/heads/main");
    const gaveUp = goesSilent(at, 0);

    const landed = await landedCommits({
      repoDir: at.home,
      defaultBranch: "main",
      members: result.members,
      timeoutMs: SOON,
    });

    expect([...landed.values()]).toEqual([undefined]);
    expect(gaveUp()).toBe(false);
  });
});
