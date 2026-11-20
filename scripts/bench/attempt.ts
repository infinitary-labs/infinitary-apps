/**
 * One headless attempt of the task-success benchmark (plan S1): boot the
 * whole Infinitary core in this process against a state directory of its own,
 * hand it one task the way the captain would, answer its decision cards
 * the way a scripted captain would, and turn what the crewmate left in its
 * working copy into a scored row with every usage and routing record.
 *
 * Nothing here is product code and the core never learns it is being
 * driven: every lever is a primitive the app already has - `startCore`,
 * the repository row `configure_repo` and Settings write (delivery and
 * rigor), the persisted model pin `route()` reads first, `inf:converse`,
 * `inf:cards:act`, the task record's working copy and its kept ref, and the
 * published `v_usage_v1` / `v_routing_v1` / `v_tasks_v1` views.
 *
 * Loaded through the Vite module runner (`scripts/moduleRunner.ts`) by
 * `scripts/bench/run-attempt.ts`, because core modules import by alias.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { absentKeychain, type HostCapabilities, type HostKeychain } from "@core/host";
import { type Core, startCore } from "@core/index";
import type { Card } from "@shared/cards";
import type { Rigor } from "@shared/rigor";
import Database from "better-sqlite3";
import { REPO_ROOT } from "../moduleRunner.ts";
import { assertIsolatedStateDir, type Care, captainMove, RIGOR_FOR_CARE } from "./policy.ts";
import type { Reward, Verifier } from "./verifier.ts";
import { SETTING_PREFIXES } from "../../src/shared/envSettings.ts";

export type ModelPin = { provider: string; id: string };

export type AttemptOptions = {
  /** The task's id, as the verifier and the pool name it. */
  taskId: string;
  /** The task's words, sent verbatim as the captain's message. */
  instruction: string;
  /** A git source (path or URL) holding `baseCommit`. */
  repo: string;
  baseCommit: string;
  care: Care;
  /** Absent = auto: routing as shipped. */
  pin?: ModelPin;
  /**
   * The careful arm lands through a pull request, so its repository must be
   * a remote the app can open one on (a private mirror). Required for
   * `careful`, refused otherwise.
   */
  mirror?: string;
  /** Everything the attempt writes: the state directory, the working repo, the row. */
  outDir: string;
  /** Written into the working repo as its instructions for the crew (AGENTS.md). */
  repoInstructions: string;
  verifier: Verifier;
  /**
   * The environment the core boots in. `mock` is the e2e mock provider
   * served at `mockPort` (no model spend); `live` uses this machine's
   * subscriptions.
   */
  provider: { kind: "mock"; port: number; modelsJson: string } | { kind: "live" };
  /** Hard cap on the attempt (plan: 3 hours). */
  capMs?: number;
  /** How long everything must sit still before an idle attempt is over. */
  quietMs?: number;
  /** Decisions the scripted captain answers before the attempt ends as over-asking. */
  maxDecisions?: number;
  /** The Infinitary commit the row names. */
  infinitaryCommit?: string;
  log?: (line: string) => void;
};

export type EndReason =
  /** A crewmate's completion card offers to land the change: the work is done. */
  | "ready"
  /** Every work task closed. */
  | "closed"
  /** Everything went still with the work reported and no card to answer. */
  | "idle"
  /** The host raised its own attention card (a stall or a sign-in): the attempt stopped. */
  | "host-card"
  /** The scripted captain answered `maxDecisions` decisions and more came. */
  | "over-asking"
  /** The Firstmate finished without starting any work. */
  | "no-work"
  | "timeout"
  /** The attempt never got going: no model to serve it, a refused ask, a boot failure. */
  | "infra";

export type UsageRow = {
  at: number;
  task_id: string;
  key: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
};

export type RoutingRow = {
  at: number;
  task_id: string;
  key: string | null;
  provider: string | null;
  model: string | null;
  bucket: string;
  served: number | null;
  rule: string | null;
};

export type TaskRow = {
  task_id: string;
  key: string;
  parent_id: string | null;
  kind: string;
  status: string;
  closed_reason: string | null;
  title: string;
  model: string | null;
  provider: string | null;
  tier: string | null;
  rigor: string | null;
  delivery: string | null;
};

export type AttemptRow = {
  schema: 1;
  task_id: string;
  arm: "auto" | "pinned";
  pin: ModelPin | null;
  care: Care;
  /** The rigor the care level asked the repository for. */
  rigor_asked: Rigor;
  /** The rigor the host stamped on the graded work (the served care level). */
  rigor_served: string | null;
  provider_kind: "mock" | "live";
  infinitary_commit: string | null;
  started_at: string;
  ended_at: string;
  wall_clock_ms: number;
  end: { reason: EndReason; detail: string };
  captain: { decisions: { card: string; action: string }[] };
  graded: {
    task_id: string;
    key: string;
    title: string;
    source: "worktree" | "kept-ref" | "branch" | "landed";
    /** Other work tasks that also changed the tree: grading one of several is flagged, never silent. */
    also_changed: string[];
  } | null;
  patch: { path: string; bytes: number; files: string[] };
  verifier: { kind: string; error: string | null };
  reward: Reward | null;
  usage: {
    rows: UsageRow[];
    totals: {
      turns: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      cost: number;
    };
  };
  routing: RoutingRow[];
  tasks: TaskRow[];
};

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

const INSTRUCTIONS_FILE = "AGENTS.md";
const DRIVER_IDENTITY = [
  "-c",
  "user.name=infinitary-bench",
  "-c",
  "user.email=infinitary-bench@localhost",
  "-c",
  "commit.gpgsign=false",
];
const START_COMMIT_DATE = "2026-01-01T00:00:00Z";

/**
 * The attempt's own copy of the task repository: a clone at the base
 * commit on `main`, with the crew's instructions committed on top as the
 * start commit. The remote is dropped (a local-only attempt has nowhere to
 * push); the careful arm points it at the mirror instead and sends the
 * start commit to the mirror's `main`, since a task's working copy is cut
 * from the remote's default branch. The start commit is dated and signed
 * by a fixed identity, so every attempt on a task makes the same commit and
 * that send is a fast-forward the first time and a no-op after. Returns
 * the start commit every diff is taken against, and whether the
 * instructions file is the driver's own (then it never rides the graded
 * patch).
 */
export function prepareWorkingRepo(options: {
  source: string;
  baseCommit: string;
  dir: string;
  instructions: string;
  mirror?: string;
}): { startCommit: string; ownsInstructions: boolean } {
  const { source, baseCommit, dir, instructions, mirror } = options;
  mkdirSync(dirname(dir), { recursive: true });
  git(process.cwd(), ["clone", "--quiet", "--no-checkout", source, dir]);
  git(dir, ["checkout", "--quiet", "-B", "main", baseCommit]);
  git(dir, ["remote", "remove", "origin"]);
  if (mirror) git(dir, ["remote", "add", "origin", mirror]);
  const path = join(dir, INSTRUCTIONS_FILE);
  const ownsInstructions = !existsSync(path);
  const existing = ownsInstructions ? "" : `${readFileSync(path, "utf8").trimEnd()}\n\n`;
  writeFileSync(path, `${existing}${instructions.trimEnd()}\n`);
  git(dir, ["add", INSTRUCTIONS_FILE]);
  git(dir, [...DRIVER_IDENTITY, "commit", "--quiet", "--no-verify", "-m", "Task instructions"], {
    GIT_AUTHOR_DATE: START_COMMIT_DATE,
    GIT_COMMITTER_DATE: START_COMMIT_DATE,
  });
  if (mirror) {
    git(dir, ["push", "--quiet", "origin", "main"]);
    git(dir, ["fetch", "--quiet", "origin"]);
  }
  return { startCommit: git(dir, ["rev-parse", "HEAD"]), ownsInstructions };
}

/**
 * The tree a task's work amounts to, and where it was read from: the live
 * working copy (committed or not, through a temporary index so the
 * crewmate's own index is untouched), else the kept ref the close saved,
 * else its branch, else - landed into the checkout - the checkout's head.
 */
export function workTree(
  repoDir: string,
  task: { id: string; worktreeDir: string; branch: string; closedReason: string | null },
): { tree: string; source: "worktree" | "kept-ref" | "branch" | "landed" } | null {
  if (task.worktreeDir && existsSync(task.worktreeDir)) {
    const cwd = task.worktreeDir;
    const index = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "infinitary-bench-index"]));
    const env = { GIT_INDEX_FILE: index };
    try {
      git(cwd, ["read-tree", "HEAD"], env);
      git(cwd, ["add", "-A"], env);
      return { tree: git(cwd, ["write-tree"], env), source: "worktree" };
    } finally {
      execFileSync("rm", ["-f", index]);
    }
  }
  const resolveRef = (ref: string): string | null => {
    try {
      return git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
    } catch {
      return null;
    }
  };
  // Infinitary's kept ref, or Firstmate 3000's from before the rename.
  const kept =
    resolveRef(`refs/infinitary/kept/${task.id}`) ?? resolveRef(`refs/fm3000/kept/${task.id}`);
  if (kept) return { tree: kept, source: "kept-ref" };
  const branch = task.branch ? resolveRef(`refs/heads/${task.branch}`) : null;
  if (branch) return { tree: branch, source: "branch" };
  if (task.closedReason === "landed" || task.closedReason === "merged") {
    const head = resolveRef("HEAD");
    if (head) return { tree: head, source: "landed" };
  }
  return null;
}

/** The graded patch: the work's tree against the start commit, minus the driver's own file. */
export function diffAgainst(
  repoDir: string,
  startCommit: string,
  tree: string,
  ownsInstructions: boolean,
): string {
  const exclude = ownsInstructions ? [`:(exclude)${INSTRUCTIONS_FILE}`] : [];
  const out = execFileSync(
    "git",
    ["diff", "--binary", "--no-color", "--no-ext-diff", startCommit, tree, "--", ".", ...exclude],
    { cwd: repoDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return out;
}

function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1] as string);
}

function headlessHost(stateDir: string, keychain: HostKeychain): HostCapabilities {
  return {
    app: {
      version: "0.0.0-bench",
      platform: process.platform,
      packaged: false,
      userDataDir: stateDir,
      // Unpackaged core reads bundled guidance from its checkout, not userData.
      appDir: REPO_ROOT,
      resourcesDir: join(REPO_ROOT, "resources"),
    },
    // Nothing is opened from a headless attempt: a link the core wants
    // shown lands in the log instead.
    openExternal: async () => {},
    notifications: { supported: () => false, focused: () => true, show: () => {} },
    presence: { getStartAtLogin: () => false, setStartAtLogin: () => {}, setShowInDock: () => {} },
    keychain,
  };
}

/**
 * The environment a mock attempt boots in - the same isolation the e2e
 * suite gives the app (tests/e2e/launch.ts): no catalog fetch, quota from
 * a fixture with no providers, a throwaway HOME, and a Claude client path
 * that does not exist, so no real sign-in is ever read or started.
 */
function isolateForMock(outDir: string): void {
  const home = join(outDir, "home");
  const quota = join(outDir, "quota-fixture");
  mkdirSync(home, { recursive: true });
  mkdirSync(quota, { recursive: true });
  writeFileSync(
    join(quota, "snapshot.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), providers: [] }),
  );
  process.env.PI_OFFLINE = "1";
  process.env.INFINITARY_QUOTA_FIXTURE_DIR = quota;
  process.env.INFINITARY_CLAUDE_CLI = join(home, "no-claude-client");
  process.env.HOME = home;
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CLAUDE_CONFIG_DIR",
  ]) {
    delete process.env[key];
  }
}

/**
 * A live attempt must reach this machine's subscriptions exactly as the app
 * does, and never an API key: refuse to start with any usage-billed key or
 * test isolation in the environment.
 */
function assertLiveEnvironment(): void {
  const refused = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "PI_OFFLINE",
    ...SETTING_PREFIXES.flatMap((prefix) => [`${prefix}CLAUDE_CLI`, `${prefix}QUOTA_FIXTURE_DIR`]),
  ].filter((key) => process.env[key] !== undefined);
  if (refused.length > 0) {
    throw new Error(`A live attempt refuses these environment variables: ${refused.join(", ")}.`);
  }
}

async function liveKeychain(): Promise<HostKeychain> {
  if (process.platform !== "darwin") return absentKeychain;
  // The Security.framework lookup the desktop shell uses, without Electron.
  // Background reads never raise a dialog (`interactive` is only set by a
  // sign-in or an explicit retry, and this driver starts neither).
  const { createDarwinKeychain } = await import("../../src/main/host/darwinKeychain.ts");
  return createDarwinKeychain();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Views = {
  usage: () => UsageRow[];
  routing: () => RoutingRow[];
  tasks: () => TaskRow[];
  inboxRows: () => number;
  close: () => void;
};

function openViews(databasePath: string): Views {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  return {
    usage: () =>
      db
        .prepare(
          "SELECT at, task_id, key, title, provider, model, input, output, cache_read, cache_write, cost FROM v_usage_v1 ORDER BY at, id",
        )
        .all() as UsageRow[],
    routing: () =>
      db
        .prepare(
          "SELECT at, task_id, key, provider, model, bucket, served, rule FROM v_routing_v1 ORDER BY at",
        )
        .all() as RoutingRow[],
    tasks: () =>
      db
        .prepare(
          "SELECT task_id, key, parent_id, kind, status, closed_reason, title, model, provider, tier, rigor, delivery FROM v_tasks_v1 ORDER BY created_at",
        )
        .all() as TaskRow[],
    // Undelivered or unacknowledged wakes: acknowledged rows are deleted.
    inboxRows: () =>
      (
        db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE escalated_at IS NULL").get() as {
          n: number;
        }
      ).n,
    close: () => db.close(),
  };
}

export async function runAttempt(options: AttemptOptions): Promise<AttemptRow> {
  const log = options.log ?? (() => {});
  const capMs = options.capMs ?? 3 * 60 * 60 * 1000;
  const quietMs = options.quietMs ?? 30_000;
  const maxDecisions = options.maxDecisions ?? 6;
  const rigor = RIGOR_FOR_CARE[options.care];
  if (options.care === "careful" && !options.mirror) {
    throw new Error("The careful arm lands through a pull request: pass the task's mirror.");
  }
  if (options.care !== "careful" && options.mirror) {
    throw new Error("Only the careful arm lands through a mirror.");
  }

  const outDir = resolve(options.outDir);
  const stateDir = join(outDir, "state");
  assertIsolatedStateDir(stateDir);
  mkdirSync(stateDir, { recursive: true });

  let keychain: HostKeychain = absentKeychain;
  if (options.provider.kind === "mock") {
    isolateForMock(outDir);
    mkdirSync(join(stateDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "auth", "models.json"), options.provider.modelsJson);
  } else {
    assertLiveEnvironment();
    keychain = await liveKeychain();
  }

  // Named after the task: the fleet names a repository by its folder.
  const repoDir = join(outDir, "work", options.taskId);
  const { startCommit, ownsInstructions } = prepareWorkingRepo({
    source: options.repo,
    baseCommit: options.baseCommit,
    dir: repoDir,
    instructions: options.repoInstructions,
    ...(options.mirror ? { mirror: options.mirror } : {}),
  });
  log(`working repo ${repoDir} at start commit ${startCommit}`);

  const startedAt = Date.now();
  const decisions: { card: string; action: string }[] = [];
  let end: { reason: EndReason; detail: string } = { reason: "infra", detail: "not started" };
  let core: Core | undefined;
  let views: Views | undefined;
  let patch = "";
  let graded: AttemptRow["graded"] = null;

  try {
    core = await startCore(headlessHost(stateDir, keychain));
    views = openViews(join(stateDir, "firstmate.db"));
    const available = core.services.availableModels();
    log(
      `models available: ${available.map((model) => `${model.provider}/${model.id}`).join(", ")}`,
    );
    if (available.length === 0) {
      end = { reason: "infra", detail: "no model is available to serve the attempt" };
      throw new AttemptStopped();
    }

    // The repository, registered the way setup_repo does it, then given its
    // posture through the same row configure_repo and Settings write.
    const setup = await core.services.repos.setup({ kind: "adopt", path: repoDir });
    await core.dispatch("inf:repos:configure", [
      setup.repo.id,
      { delivery: options.mirror ? "direct-pr" : "local-only", rigor },
    ]);
    // Auto clears the pin; a pinned attempt writes the one pin route() reads first.
    await core.dispatch("inf:settings:routing:set", [
      { dynamicRouting: true, pins: options.pin ? [options.pin] : [] },
    ]);

    await core.dispatch("inf:converse", [options.instruction]);
    log("ask sent");

    const answered = new Set<string>();
    let quietSince: number | null = null;
    for (;;) {
      await sleep(500);
      const now = Date.now();
      if (now - startedAt > capMs) {
        end = { reason: "timeout", detail: `over the ${Math.round(capMs / 60_000)}-minute cap` };
        break;
      }
      const cards = core.services.supervisor.cards.snapshot();
      let ready: Card | undefined;
      let hostCard: Card | undefined;
      for (const card of cards) {
        const move = captainMove(card);
        if (move.kind === "ready") ready ??= card;
        if (move.kind === "host") hostCard ??= card;
        if (move.kind === "answer" && !answered.has(`${card.id}:${card.createdAt}`)) {
          if (decisions.length >= maxDecisions) {
            end = { reason: "over-asking", detail: `more than ${maxDecisions} decisions` };
            break;
          }
          answered.add(`${card.id}:${card.createdAt}`);
          decisions.push({ card: card.title, action: move.label });
          log(`captain: "${card.title}" -> ${move.label}`);
          await core.dispatch("inf:cards:act", [card.id, move.actionId, "chrome"]);
          quietSince = null;
        }
      }
      if (end.reason === "over-asking") break;
      if (hostCard) {
        end = { reason: "host-card", detail: hostCard.title };
        break;
      }

      const work = core.services.tasks.list().filter((task) => task.kind === "work");
      const moving =
        core.services.firstmate.isBusy() ||
        views.inboxRows() > 0 ||
        work.some(
          (task) =>
            task.activity === "starting" ||
            task.activity === "running" ||
            core?.services.jobs.hasRunningJobs(task.id),
        );
      if (moving) {
        quietSince = null;
        continue;
      }
      quietSince ??= now;
      if (now - quietSince < quietMs) continue;
      if (ready) {
        end = { reason: "ready", detail: ready.title };
      } else if (work.length === 0) {
        end = { reason: "no-work", detail: "the Firstmate started no work" };
      } else if (work.every((task) => task.status === "done" || task.status === "dropped")) {
        end = {
          reason: "closed",
          detail: work.map((task) => `${task.key} ${task.closedReason}`).join(", "),
        };
      } else {
        end = { reason: "idle", detail: "everything went still with no card to answer" };
      }
      break;
    }
    log(`end: ${end.reason} (${end.detail})`);

    // Grade the work that changed the tree. One changed task is the norm;
    // several are graded by the newest and named on the row.
    const changed = core.services.tasks
      .list()
      .filter((task) => task.kind === "work" && task.repoId === setup.repo.id)
      .map((task) => {
        const found = workTree(repoDir, task);
        const diff = found ? diffAgainst(repoDir, startCommit, found.tree, ownsInstructions) : "";
        return { task, found, diff };
      })
      .filter((entry) => entry.found && entry.diff !== "")
      .sort((a, b) => b.task.updatedAt - a.task.updatedAt);
    const chosen = changed[0];
    if (chosen?.found) {
      patch = chosen.diff;
      graded = {
        task_id: chosen.task.id,
        key: chosen.task.key,
        title: chosen.task.title,
        source: chosen.found.source,
        also_changed: changed.slice(1).map((entry) => entry.task.key),
      };
    }
  } catch (error) {
    if (!(error instanceof AttemptStopped)) {
      end = { reason: "infra", detail: error instanceof Error ? error.message : String(error) };
      log(`infra failure: ${end.detail}`);
    }
  }

  const endedAt = Date.now();
  // Read the record after the core stops, so every turn's usage has landed.
  core?.dispose();
  const usage = views?.usage() ?? [];
  const routing = views?.routing() ?? [];
  const tasks = views?.tasks() ?? [];
  views?.close();

  const patchPath = join(outDir, "patch.diff");
  writeFileSync(patchPath, patch);
  let reward: Reward | null = null;
  let verifierError: string | null = null;
  try {
    reward = await options.verifier.verify({
      taskId: options.taskId,
      patchPath,
      outDir: join(outDir, "verifier"),
    });
  } catch (error) {
    verifierError = error instanceof Error ? error.message : String(error);
    log(`verifier failed: ${verifierError}`);
  }

  const sum = (
    field: keyof Pick<UsageRow, "input" | "output" | "cache_read" | "cache_write" | "cost">,
  ) => usage.reduce((total, row) => total + (row[field] ?? 0), 0);
  const gradedTask = graded ? tasks.find((task) => task.task_id === graded?.task_id) : undefined;
  const row: AttemptRow = {
    schema: 1,
    task_id: options.taskId,
    arm: options.pin ? "pinned" : "auto",
    pin: options.pin ?? null,
    care: options.care,
    rigor_asked: rigor,
    rigor_served: gradedTask?.rigor ?? null,
    provider_kind: options.provider.kind,
    infinitary_commit: options.infinitaryCommit ?? null,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    wall_clock_ms: endedAt - startedAt,
    end,
    captain: { decisions },
    graded,
    patch: { path: patchPath, bytes: Buffer.byteLength(patch), files: patchFiles(patch) },
    verifier: { kind: options.verifier.kind, error: verifierError },
    reward,
    usage: {
      rows: usage,
      totals: {
        turns: usage.length,
        input: sum("input"),
        output: sum("output"),
        cache_read: sum("cache_read"),
        cache_write: sum("cache_write"),
        cost: sum("cost"),
      },
    },
    routing,
    tasks,
  };
  writeFileSync(join(outDir, "row.json"), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

/** A deliberate stop before the ask: the row still gets written. */
class AttemptStopped extends Error {}
