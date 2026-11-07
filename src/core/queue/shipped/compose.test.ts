import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import { readComposition } from "./rules.mjs";

// INF-2952 piece 1, the captain's approved merge-route answer: "the queue
// composes it in each check job". The form job composes the batch onto the
// default branch it checked out, and every check job applies the same batch
// onto that same version, even after the default branch moved on, and must
// build the tree the form job named. Real git on a scratch project: a
// default branch, approved changes as branches, and each job's shallow
// clone, as actions/checkout leaves it.
const compose = fileURLToPath(new URL("./compose.sh", import.meta.url));
const git = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const identity = ["-c", "user.name=crewmate", "-c", "user.email=crewmate@localhost"];
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...identity, ...args], { cwd, env: git, encoding: "utf8" }).trim();

function project() {
  const root = scratchDir("infinitary-queue-compose-");
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
  const job = () => {
    const clone = join(scratchDir("infinitary-queue-job-"), "checkout");
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

describe("composing a batch of the shipped queue", () => {
  it("composes what merges in batch order and names each conflict", () => {
    const { origin, changes, job } = project();
    run(origin, "checkout", "-q", "-b", "stale", "main");
    writeFileSync(join(origin, "notes.md"), "one\ntwo\ntres\n");
    run(origin, "commit", "-q", "-am", "stale");
    run(origin, "checkout", "-q", "main");
    const stale = run(origin, "rev-parse", "stale");
    // The default branch moves on after the changes branched.
    writeFileSync(join(origin, "notes.md"), "one\ntwo\nTHREE\n");
    run(origin, "commit", "-q", "-am", "main moves");
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
      { number: 903, head: changes.third },
      { number: 904, head: stale },
    ];
    const result = script(job(), "compose", ...members.map((m) => `${m.number}:${m.head}`));
    expect(result.status, result.stderr).toBe(0);
    const composed = readComposition(result.stdout, members);
    expect(composed.merged.map((m) => m.number)).toEqual([901, 902]);
    expect(composed.conflictsBatch.map((m) => m.number)).toEqual([903]);
    expect(composed.conflictsMain.map((m) => m.number)).toEqual([904]);
  });

  it("applies the batch in every check job onto the version it formed on, after the default branch moves", () => {
    const { origin, changes, job } = project();
    const form = job();
    const base = run(form, "rev-parse", "HEAD");
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ];
    const { tree } = readComposition(script(form, "compose", ...heads).stdout, members);
    // A teammate's change merges while the checks wait for a runner.
    writeFileSync(join(origin, "later.md"), "later\n");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "a later merge");
    const commits = [job(), job()].map((clone) => {
      const applied = script(clone, "apply", base, tree, ...heads);
      expect(applied.status, applied.stderr).toBe(0);
      expect(run(clone, "rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(run(clone, "show", "HEAD:notes.md")).toBe("ONE\ntwo\nthree");
      expect(run(clone, "show", "HEAD:added.md")).toBe("new file");
      expect(spawnSync("git", ["cat-file", "-e", "HEAD:later.md"], { cwd: clone }).status).not.toBe(
        0,
      );
      return run(clone, "rev-parse", "HEAD");
    });
    expect(commits[0]).toBe(commits[1]);
  });

  it("fails a check job whose batch is not the one the queue composed", () => {
    const { changes, job } = project();
    const form = job();
    const base = run(form, "rev-parse", "HEAD");
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const { tree } = readComposition(script(form, "compose", ...heads).stdout, [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ]);
    const short = script(job(), "apply", base, tree, heads[0] as string);
    expect(short.status).toBe(1);
    expect(short.stdout).toContain("Batch composed differently");
    const conflict = script(job(), "apply", base, tree, ...heads, `903:${changes.third}`);
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toContain("Batch did not compose");
  });
});
