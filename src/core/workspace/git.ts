import { appendFile, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { cutText } from "@shared/textCut";
import { bundledGit, gitHelperResetParameters, hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";
import { runGitProcess } from "./gitProcess";

/**
 * The one identity the app commits under for itself (a fresh fleet init, the
 * personal workspace's managed files) and for the batch's scratch commits:
 * never a user's, never a global config write. The address is plain, with no
 * account on any forge behind it, so where a project lives links these
 * commits to nobody.
 */
export const APP_GIT_NAME = "Infinitary";
export const APP_GIT_EMAIL = "infinitary@localhost";

export const APP_GIT_IDENTITY = [
  "-c",
  `user.name=${APP_GIT_NAME}`,
  "-c",
  `user.email=${APP_GIT_EMAIL}`,
];

export const APP_GIT_ENV = {
  GIT_AUTHOR_NAME: APP_GIT_NAME,
  GIT_AUTHOR_EMAIL: APP_GIT_EMAIL,
  GIT_COMMITTER_NAME: APP_GIT_NAME,
  GIT_COMMITTER_EMAIL: APP_GIT_EMAIL,
};

/**
 * How long one fetch or push may wait on the place a project lives. A slow
 * or silent remote must not hold what waits behind the call: a dispatch
 * falls back to the last fetched commit, and a batch's pass reads again.
 */
export const REMOTE_TIMEOUT_MS = 30 * 1000;

/**
 * Thin git runner for the work substrate. Always explicit about the repo via
 * -C; never touches the user's global config beyond what git reads itself.
 */
export async function git(
  repoDir: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    trim?: boolean;
    /**
     * Ends git when it aborts, as the timeout does: git and every program
     * it started, its remote helpers included (`gitProcess.ts`).
     */
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  if (args[0] !== "worktree") return runGit(repoDir, args, options);
  return withWorktreeFiles(repoDir, () => runGit(repoDir, args, options), options);
}

/** Canonical-common-directory queue for worktree operations and task remote writes. */
async function withWorktreeFiles<T>(
  repoDir: string,
  run: () => Promise<T>,
  options: NonNullable<Parameters<typeof git>[2]> = {},
): Promise<T> {
  const common = await realpath(
    await runGit(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      ...options,
      trim: true,
    }),
  );
  const previous = worktreeCommands.get(common) ?? Promise.resolve();
  const command = previous.catch(() => {}).then(run);
  worktreeCommands.set(common, command);
  try {
    return await command;
  } finally {
    if (worktreeCommands.get(common) === command) worktreeCommands.delete(common);
  }
}

/** Only app-owned task branches get a saved native remote; no repository format changes. */
export const taskRemoteName = (branch: string): string => `infinitary-${branch}`;

export async function preserveWorktreeRemotes(
  repo: string,
  copies: { dir: string; branch: string }[],
): Promise<void> {
  for (const { dir, branch } of copies) {
    const present = await stat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!present) continue;
    if (
      !branch ||
      (await git(dir, ["config", "--get", `branch.${branch}.remote`]).catch(() => "")) ===
        taskRemoteName(branch)
    )
      continue;
    await inheritWorktreeRemotes(repo, dir, undefined, branch);
  }
}

/** Bind a task's default fetch/push to its own remote, supported by system Git 2.43. */
export function inheritWorktreeRemotes(
  repo: string,
  dir: string,
  remote?: { origin: string; pushOrigin?: string },
  assignedBranch?: string,
): Promise<void> {
  return withWorktreeFiles(repo, async () => {
    const branch = assignedBranch ?? (await git(dir, ["branch", "--show-current"]));
    if (!branch) throw new Error("The task working copy has no branch to bind.");
    const name = taskRemoteName(branch);
    const origins = remote
      ? [remote.origin]
      : effectiveConfigValues(await configValues(dir, [], "remote.origin.url"));
    if (!origins.length) return;
    const pushes = remote
      ? [remote.pushOrigin ?? remote.origin]
      : effectiveConfigValues(await configValues(dir, [], "remote.origin.pushurl"));
    const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "config"]);
    await editGitConfig(
      file,
      async (lock) => {
        for (const key of [
          `remote.${name}.url`,
          `remote.${name}.pushurl`,
          `remote.${name}.fetch`,
          `remote.${name}.push`,
          `branch.${branch}.remote`,
          `branch.${branch}.pushRemote`,
          `branch.${branch}.merge`,
        ])
          await unsetConfig(repo, ["config", "--file", lock, "--unset-all", key]);
        await appendFile(
          lock,
          `\n[remote ${gitConfigValue(name)}]\n${origins.map((value) => `\turl = ${gitConfigValue(value)}\n`).join("")}${pushes.map((value) => `\tpushurl = ${gitConfigValue(value)}\n`).join("")}\tfetch = ${gitConfigValue(`+refs/heads/*:refs/remotes/${name}/*`)}\n\tpush = ${gitConfigValue(`refs/heads/${branch}:refs/heads/${branch}`)}\n[branch ${gitConfigValue(branch)}]\n\tremote = ${gitConfigValue(name)}\n\tpushRemote = ${gitConfigValue(name)}\n\tmerge = ${gitConfigValue(`refs/heads/${branch}`)}\n`,
        );
      },
      true,
    );
  });
}

/** Release only this app task's remote and tracking refs when its tree is retired. */
export function releaseTaskRemote(repo: string, branch: string): Promise<void> {
  return withWorktreeFiles(repo, async () => {
    const name = taskRemoteName(branch);
    if (!(await configValues(repo, [], `remote.${name}.url`)).length) return;
    if (
      (await git(repo, ["config", "--get", `branch.${branch}.pushRemote`]).catch(() => "")) === name
    )
      await unsetConfig(repo, ["config", "--unset-all", `branch.${branch}.pushRemote`]);
    await git(repo, ["remote", "remove", name]);
  });
}

/** Save a temporary folder push override and its original values in native private Git config. */
export function setManagedOriginPush(repo: string, push: string): Promise<void> {
  return withWorktreeFiles(repo, async () => {
    const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "config"]);
    await editGitConfig(
      file,
      async (lock) => {
        const previous = await configValues(repo, ["--file", lock], "remote.origin.pushurl");
        const effective = await configValues(repo, [], "remote.origin.pushurl");
        // A person's other config scope remains theirs; tasks use their own remote regardless.
        if (
          JSON.stringify(previous) !== JSON.stringify(effective) ||
          (previous.length && previous.every((value) => value === push))
        )
          return;
        await unsetConfig(repo, ["config", "--file", lock, "--unset-all", "remote.origin.pushurl"]);
        await appendFile(
          lock,
          `\n[remote "origin"]\n\tpushurl = ${gitConfigValue(push)}\n[infinitary]\n\tcontributionPush = ${gitConfigValue(push)}\n\tcontributionPushPrevious = ${gitConfigValue(JSON.stringify(previous))}\n`,
        );
      },
      true,
    );
  });
}

export function clearManagedOriginPush(repo: string): Promise<void> {
  return withWorktreeFiles(repo, async () => {
    const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "config"]);
    await editGitConfig(file, async (lock) => {
      const scope = ["--file", lock];
      const managed = (await configValues(repo, scope, "infinitary.contributionPush"))[0];
      if (managed === undefined) return;
      const pushes = await configValues(repo, scope, "remote.origin.pushurl");
      const saved: unknown = JSON.parse(
        (await configValues(repo, scope, "infinitary.contributionPushPrevious"))[0] ?? "[]",
      );
      if (!Array.isArray(saved) || saved.some((value) => typeof value !== "string"))
        throw new Error("The saved project push configuration is unreadable.");
      const retained =
        pushes.length === 1 && pushes[0] === managed
          ? saved
          : pushes.filter((value) => value !== managed);
      for (const key of [
        "remote.origin.pushurl",
        "infinitary.contributionPush",
        "infinitary.contributionPushPrevious",
      ])
        await unsetConfig(repo, ["config", "--file", lock, "--unset-all", key]);
      if (retained.length)
        await appendFile(
          lock,
          `\n[remote "origin"]\n${retained.map((value) => `\tpushurl = ${gitConfigValue(value)}\n`).join("")}`,
        );
    });
  });
}

async function unsetConfig(repo: string, args: string[]): Promise<void> {
  await git(repo, args).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as Error & { code?: number }).code !== 5
    )
      throw error;
  });
}

async function configValues(repo: string, scope: string[], key: string): Promise<string[]> {
  const data = await git(repo, ["config", ...scope, "--null", "--get-all", key], {
    trim: false,
  }).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: number }).code === 1
    )
      return "";
    throw error;
  });
  return data ? data.split("\0").slice(0, -1) : [];
}

function effectiveConfigValues(values: string[]): string[] {
  return values.slice(values.lastIndexOf("") + 1);
}

/** Git's quoted-value grammar; private values never become process arguments. */
function gitConfigValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .split("\b")
    .join("\\b")}"`;
}

/** Git's native lock excludes other config writers; rename publishes the complete configuration. */
async function editGitConfig(
  file: string,
  edit: (lock: string) => Promise<void>,
  privateValues = false,
): Promise<void> {
  file = await realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return file;
  });
  const mode = await stat(file)
    .then((entry) => entry.mode & 0o777)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return 0o600;
    });
  const lock = `${file}.lock`;
  const handle = await open(lock, "wx", privateValues ? mode & 0o600 : mode);
  try {
    const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return Buffer.alloc(0);
    });
    await handle.writeFile(previous);
    await handle.close();
    await edit(lock);
    await rename(lock, file);
  } finally {
    await handle.close().catch(() => {});
    await rm(lock, { force: true });
  }
}

const worktreeCommands = new Map<string, Promise<unknown>>();

async function runGit(
  repoDir: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    trim?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  const app = bundledGit();
  // Checkouts and removals can touch tens of thousands of files: below the UI.
  const command = atUtilityQos(app?.binary ?? "git", ["-C", repoDir, ...args]);
  const stdout = await runGitProcess(command.file, command.args, {
    maxBuffer: 16 * 1024 * 1024,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    env: {
      ...hostEnv(),
      ...options.env,
      // Where that git's own parts are: never the caller's to change.
      ...app?.env,
      // Worktree/commit plumbing must not stall on user hooks or signing,
      // and GitHub answers only to the app's own sign-in (`hostEnv.ts`).
      GIT_CONFIG_PARAMETERS: [
        "'commit.gpgsign=false'",
        "'core.hooksPath=/dev/null'",
        ...gitHelperResetParameters(),
      ].join(" "),
    },
  });
  return options.trim === false ? stdout : stdout.trim();
}

/** A git failure's first meaningful line, for a timeline-sized reason. */
export function gitFailure(caught: unknown): string {
  const failure = caught as { stderr?: string; message?: string };
  const lines = `${failure.stderr ?? ""}\n${failure.message ?? String(caught)}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? "unknown error";
  return reason.length > 200 ? `${cutText(reason, 200)}...` : reason;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}
