import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeLocally, readComposition } from "../scripts/batch.mjs";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2430 piece 3, the captain's approved plan: "Each sweep job applies them
// one by one onto main, the same way in every job, and pushes nothing", and
// "A conflict sends that change back with 'conflicts with main' before the
// sweep starts." Real git on a scratch project: a main, three approved
// changes as branches, and a job's shallow clone of main, as actions/checkout
// leaves it.
const compose = fileURLToPath(new URL("../scripts/batch-compose.sh", import.meta.url));
const git = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const identity = ["-c", "user.name=crewmate", "-c", "user.email=crewmate@localhost"];
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...identity, ...args], { cwd, env: git, encoding: "utf8" }).trim();

function project() {
  const root = scratchDir("infinitary-batch-compose-");
  const origin = join(root, "origin");
  run(root, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "notes.md"), "one\ntwo\nthree\n");
  run(origin, "add", ".");
  run(origin, "commit", "-q", "-m", "main");
  const change = (branch: string, file: string, contents: string) => {
    run(origin, "checkout", "-q", "-b", branch, "main");
    writeFileSync(join(origin, file), contents);
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", branch);
    run(origin, "checkout", "-q", "main");
    return run(origin, "rev-parse", branch);
  };
  const changes = {
    first: change("first", "notes.md", "ONE\ntwo\nthree\n"),
    second: change("second", "added.md", "new file\n"),
    // Edits the line the first change edits: it merges onto main alone.
    third: change("third", "notes.md", "uno\ntwo\nthree\n"),
  };
  // main moves on after the changes branched, as it does while they wait.
  writeFileSync(join(origin, "notes.md"), "one\ntwo\nTHREE\n");
  run(origin, "commit", "-q", "-am", "main moves");
  const job = () => {
    const clone = join(scratchDir("infinitary-batch-job-"), "checkout");
    run(root, "clone", "-q", "--depth", "1", "--branch", "main", `file://${origin}`, clone);
    return clone;
  };
  return { origin, changes, job };
}

const script = (cwd: string, ...args: string[]) =>
  spawnSync("bash", ["--noprofile", "--norc", compose, ...args], {
    cwd,
    env: git,
    encoding: "utf8",
  });

describe("composing a swept batch onto main", () => {
  it("merges every change it can, in batch order, and names a conflict with an earlier change", () => {
    const { changes, job } = project();
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
      { number: 903, head: changes.third },
    ];
    const result = script(job(), "compose", ...members.map((m) => `${m.number}:${m.head}`));
    expect(result.status, result.stderr).toBe(0);
    const composed = readComposition(result.stdout, members);
    expect(composed.merged.map((m) => m.number)).toEqual([901, 902]);
    expect(composed.conflictsBatch.map((m) => m.number)).toEqual([903]);
    expect(composed.conflictsMain).toEqual([]);
  });

  it("names a change that conflicts with main itself", () => {
    const { origin, job } = project();
    run(origin, "checkout", "-q", "-b", "stale", "main~1");
    writeFileSync(join(origin, "notes.md"), "one\ntwo\ntres\n");
    run(origin, "commit", "-q", "-am", "stale");
    const stale = run(origin, "rev-parse", "stale");
    const members = [{ number: 904, head: stale }];
    const composed = readComposition(script(job(), "compose", `904:${stale}`).stdout, members);
    expect(composed.conflictsMain.map((m) => m.number)).toEqual([904]);
    expect(composed.merged).toEqual([]);
  });

  it("builds the same commit in every job, with main's change and both batch changes", () => {
    const { changes, job } = project();
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const composed = readComposition(script(job(), "compose", ...heads).stdout, [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ]);
    const commits = [job(), job()].map((clone) => {
      const applied = script(clone, "apply", composed.tree, ...heads);
      expect(applied.status, applied.stderr).toBe(0);
      expect(run(clone, "show", "HEAD:notes.md")).toBe("ONE\ntwo\nTHREE");
      expect(run(clone, "show", "HEAD:added.md")).toBe("new file");
      return run(clone, "rev-parse", "HEAD");
    });
    expect(commits[0]).toBe(commits[1]);
  });

  it("fails a job whose composition is not the batch's tree", () => {
    const { changes, job } = project();
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const tree = readComposition(script(job(), "compose", ...heads).stdout, [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ]).tree;
    // The same changes in another order build the same tree; one missing does not.
    expect(script(job(), "apply", tree, heads[1]!, heads[0]!).status).toBe(0);
    const short = script(job(), "apply", tree, heads[0]!);
    expect(short.status).toBe(1);
    expect(short.stdout).toContain("Batch composed differently");
    expect(script(job(), "apply", tree, ...heads, `903:${changes.third}`).status).toBe(1);
  });
});

// INF-2961, the captain's plan: "a repair crewmate on a failed batch run that
// reads the failure, composes the batch locally, bisects on the failed file".
// The compose job's log names main's version, the tree and each version; the
// repair runs that line on its own clone, then bisects the composed changes.
describe("a paused batch's repair, on its own clone", () => {
  // A change that breaks what the failed file checks: here, that no
  // broken.md exists.
  const breaking = (origin: string) => {
    run(origin, "checkout", "-q", "-b", "breaking", "main");
    writeFileSync(join(origin, "broken.md"), "broken\n");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "breaking");
    run(origin, "checkout", "-q", "main");
    return run(origin, "rev-parse", "breaking");
  };
  const failedFile = ["test", "!", "-e", "broken.md"];
  // The repair's clone: the whole history, where scripts/batch-compose.sh is
  // the project's own.
  const repairClone = (origin: string) => {
    const dir = scratchDir("infinitary-batch-repair-");
    const clone = join(dir, "checkout");
    run(dir, "clone", "-q", `file://${origin}`, clone);
    return clone;
  };
  const batchOf = (job: () => string, members: { number: number; head: string }[]) => {
    const clone = job();
    const heads = members.map((m) => `${m.number}:${m.head}`);
    const composed = readComposition(script(clone, "compose", ...heads).stdout, members);
    return { base: run(clone, "rev-parse", "HEAD"), composed, heads };
  };
  const settled = (clone: string, base: string) => {
    expect(run(clone, "rev-parse", "HEAD")).toBe(base);
    expect(run(clone, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(existsSync(join(clone, ".git", "BISECT_LOG"))).toBe(false);
  };

  it("composes the swept batch from the line the compose job prints, after main moved on", () => {
    const { origin, changes, job } = project();
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ];
    const { base, composed } = batchOf(job, members);
    const swept = job();
    expect(
      script(swept, "apply", composed.tree, ...members.map((m) => `${m.number}:${m.head}`)).status,
    ).toBe(0);
    // main moves on while the batch is paused; the repair's clone has it.
    writeFileSync(join(origin, "later.md"), "later\n");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "later");
    const clone = repairClone(origin);
    mkdirSync(join(clone, "scripts"));
    copyFileSync(compose, join(clone, "scripts", "batch-compose.sh"));
    const line = composeLocally({ base, tree: composed.tree, members: composed.merged });
    const local = spawnSync("bash", ["--noprofile", "--norc", "-c", line], {
      cwd: clone,
      env: git,
      encoding: "utf8",
    });
    expect(local.status, local.stderr).toBe(0);
    // The very commit every sweep job built.
    expect(run(clone, "rev-parse", "HEAD")).toBe(run(swept, "rev-parse", "HEAD"));
    expect(run(clone, "rev-parse", "HEAD^{tree}")).toBe(composed.tree);
  });

  it("bisects the composed changes on the failed file and names the first that fails it", () => {
    const { origin, changes, job } = project();
    const members = [
      { number: 901, head: changes.first },
      { number: 905, head: breaking(origin) },
      { number: 902, head: changes.second },
    ];
    const { base, composed, heads } = batchOf(job, members);
    const clone = repairClone(origin);
    run(clone, "checkout", "-q", "--detach", base);
    const result = script(clone, "bisect", composed.tree, ...heads, "--", ...failedFile);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("first-fails 905");
    settled(clone, base);
  });

  it("says when the failed file fails on main alone or passes with every change", () => {
    const { origin, changes, job } = project();
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ];
    const { base, composed, heads } = batchOf(job, members);
    const clone = repairClone(origin);
    run(clone, "checkout", "-q", "--detach", base);
    const passes = script(clone, "bisect", composed.tree, ...heads, "--", ...failedFile);
    expect(passes.stdout.trim(), passes.stderr).toBe("passes-batch");
    settled(clone, base);
    const failsMain = script(
      clone,
      "bisect",
      composed.tree,
      ...heads,
      "--",
      "test",
      "-e",
      "absent.md",
    );
    expect(failsMain.stdout.trim(), failsMain.stderr).toBe("fails-main");
    settled(clone, base);
  });

  it("refuses a checkout with uncommitted changes, a missing command or a different tree", () => {
    const { origin, changes, job } = project();
    const members = [{ number: 901, head: changes.first }];
    const { base, composed, heads } = batchOf(job, members);
    const clone = repairClone(origin);
    run(clone, "checkout", "-q", "--detach", base);
    expect(script(clone, "bisect", composed.tree, ...heads).status).toBe(2);
    const otherTree = run(clone, "rev-parse", "HEAD^{tree}");
    const other = script(clone, "bisect", otherTree, ...heads, "--", ...failedFile);
    expect(other.status).toBe(1);
    expect(other.stdout).toContain("Batch composed differently");
    writeFileSync(join(clone, "notes.md"), "edited\n");
    const dirty = script(clone, "bisect", composed.tree, ...heads, "--", ...failedFile);
    expect(dirty.status).toBe(2);
    expect(dirty.stderr).toContain("no uncommitted change");
    expect(run(clone, "show", "HEAD:notes.md")).toBe("one\ntwo\nTHREE");
  });
});
