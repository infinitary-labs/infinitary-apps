import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { git } from "./git";

// Integration fence: imports the Git runner and resolves actual filesystem
// aliases. The ordering cases measured 5 ms together; no Git child is launched.
vi.setConfig({ testTimeout: 1_000 });

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

// Git is the external boundary. Its process stays open until the test releases
// it, representing add's observed interval with an unfinished commondir.
vi.mock("./gitProcess", () => ({
  runGitProcess: (...args: unknown[]) => execute(...args),
}));
// Resolve real aliases without leaving filesystem callbacks pending when the
// test observes admission order at the next event-loop turn.
vi.mock("node:fs/promises", async () => {
  const { realpathSync } = await import("node:fs");
  return { realpath: async (path: string) => realpathSync(path) };
});
vi.mock("../hostEnv", () => ({
  bundledGit: () => undefined,
  hostEnv: () => ({}),
  gitHelperResetParameters: () => [],
}));
vi.mock("../utilityQos", () => ({
  atUtilityQos: (file: string, args: string[]) => ({ file, args }),
}));

afterEach(() => execute.mockReset());

function repository() {
  const root = scratchDir("infinitary-worktree-command-");
  mkdirSync(join(root, ".git"));
  return { root, common: realpathSync(join(root, ".git")) };
}

/** Match Git's own common-directory answers for actual checkout aliases. */
function runner(repos: Map<string, string>, command: (args: string[]) => Promise<string>) {
  execute.mockImplementation(async (_file: string, args: string[]) => {
    const [, cwd, ...gitArgs] = args;
    if (!cwd) throw new Error("Git needs an explicit working directory");
    if (gitArgs[0] === "rev-parse") return `${repos.get(cwd)}\n`;
    return await command(gitArgs);
  });
}

// Captain's flake-root-cause direction: the failed freeze journey's nine
// concurrent starts hit another add's empty commondir. No retries may hide it.
it("orders worktree commands across checkout aliases until the first process exits", async () => {
  const repo = repository();
  const alias = join(scratchDir("infinitary-worktree-alias-"), "linked-common");
  symlinkSync(repo.root, alias, "dir");
  const entered = deferred<void>();
  const release = deferred<string>();
  const calls: string[][] = [];
  runner(
    new Map([
      [repo.root, repo.common],
      [alias, join(alias, ".git")],
    ]),
    async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        entered.resolve();
        return release.promise;
      }
      return args.join(" ");
    },
  );
  const first = git(repo.root, ["worktree", "add", "first"]);
  await entered.promise;
  const commands = [
    ["worktree", "add", "next"],
    ["worktree", "prune"],
    ["worktree", "move", "next", "moved"],
    ["worktree", "remove", "moved"],
    ["worktree", "list"],
  ];
  const queued = commands.map((args) => git(alias, args));
  try {
    // One event-loop turn admits every caller; not a timing budget or a sleep.
    await setImmediate();
    expect(calls).toEqual([["worktree", "add", "first"]]);
  } finally {
    release.resolve("first\n");
    await Promise.all([first, ...queued]);
  }
  expect(calls).toEqual([["worktree", "add", "first"], ...commands]);
});

it("does not hold another repository or ordinary git reads behind a worktree command", async () => {
  const one = repository();
  const two = repository();
  const entered = deferred<void>();
  const release = deferred<string>();
  runner(
    new Map([
      [one.root, one.common],
      [two.root, two.common],
    ]),
    async (args) => {
      if (args[1] === "add") {
        entered.resolve();
        return release.promise;
      }
      return args.join(" ");
    },
  );
  const first = git(one.root, ["worktree", "add", "first"]);
  await entered.promise;
  try {
    expect(await git(two.root, ["worktree", "prune"])).toBe("worktree prune");
    expect(await git(one.root, ["status", "--short"])).toBe("status --short");
  } finally {
    release.resolve("first");
    await first;
  }
});

it("keeps untrimmed command output while canonicalizing Git's newline-terminated common path", async () => {
  const repo = repository();
  runner(new Map([[repo.root, repo.common]]), async () => "worktree output\n");
  expect(await git(repo.root, ["worktree", "list"], { trim: false })).toBe("worktree output\n");
});

it("releases a failed command without retrying it or failing the next start", async () => {
  const repo = repository();
  const entered = deferred<void>();
  const release = deferred<void>();
  const failure = new Error("The worktree command failed");
  const calls: string[][] = [];
  runner(new Map([[repo.root, repo.common]]), async (args) => {
    calls.push(args);
    if (calls.length === 1) {
      entered.resolve();
      await release.promise;
      throw failure;
    }
    return "started";
  });
  const failed = git(repo.root, ["worktree", "add", "first"]);
  const observedFailure = expect(failed).rejects.toBe(failure);
  await entered.promise;
  const next = git(repo.root, ["worktree", "add", "second"]);
  release.resolve();
  await observedFailure;
  expect(await next).toBe("started");
  expect(calls).toEqual([
    ["worktree", "add", "first"],
    ["worktree", "add", "second"],
  ]);
});
