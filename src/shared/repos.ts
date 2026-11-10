import { z } from "zod";
import { costLimitSchema } from "./costLimit";
import { HERE } from "./deviceNames";
import type { ForgeKind } from "./forge";
import { placementRequirementsSchema } from "./placement";
import { rigorSchema } from "./rigor";

/**
 * Managed work repos (decision D-8, fleet-root revision). Every repo is set
 * up by Settings or the Firstmate agent and indexed in the app-owned fleet root
 * (userData/fleet): `clone` and `init` create real directories in the
 * projects folder - the fleet root itself unless the person chose another
 * one (`ProjectsFolderView`), which the fleet root then links; `adopt`
 * keeps an existing folder in place and links it from the fleet root, so
 * `path` is always the repo's real working directory. The default
 * local-only workspace is not listed here - it is the implicit fallback for
 * repo-less tasks.
 */

export const repoSetupKindSchema = z.enum(["clone", "init", "adopt"]);
export type RepoSetupKind = z.infer<typeof repoSetupKindSchema>;

/**
 * The task key a new project's tasks are numbered with (`INF` for `INF-1`),
 * when the person or Firstmate chose one; the app otherwise derives it from
 * the name. The core refuses, in words, a key that is not 2-4 letters or
 * digits or that another project has (`freeProjectKey`).
 */
export const projectKeyChoiceSchema = z.string().trim().min(1).max(16);

export const repoSetupSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clone"),
    origin: z.string().trim().min(1),
    name: z.string().optional(),
    key: projectKeyChoiceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("init"),
    name: z.string().trim().min(1),
    key: projectKeyChoiceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("adopt"),
    path: z.string().trim().min(1),
    name: z.string().optional(),
    key: projectKeyChoiceSchema.optional(),
  }),
]);
export type RepoSetupSpec = z.infer<typeof repoSetupSpecSchema>;

/**
 * What kind of workspace a registered repo is. A `project` is ordinary
 * managed work: a crewmate takes a worktree on a branch and the change
 * leaves through a gate. `personal` is the app's own personal workspace
 * (talk-to-personalize Step 4) and there is exactly one: a crewmate builds
 * in place there, with no worktree, no branch and no pull request, the host
 * commits the workspace at the end of each of its turns, and a completion
 * report closes the task - nothing to merge, land, or discard. The kind is
 * the workspace's nature, never a delivery: delivery says only where a
 * change lands, and a personal task lands nowhere because it is already
 * there.
 */
export const repoKindSchema = z.enum(["project", "personal"]);
export type RepoKind = z.infer<typeof repoKindSchema>;

/**
 * How the agent ships finished work on the repo. `direct-pr` pushes a
 * branch and opens a PR; `queue-pr` does the same, and the captain's merge
 * click waits for the project's own queue to pass that version before it
 * merges (`infinitary/queue`, docs/forge.md "A project's queue"); `local-only`
 * lands on a local branch and never leaves the machine. New postures extend
 * this enum - the registry and display render whatever it carries.
 */
export const repoDeliverySchema = z.enum(["direct-pr", "queue-pr", "local-only"]);

/**
 * The commit status that is the app's contract with a project's own queue
 * (docs/forge.md, "A project's queue"): the app writes it as waiting on the
 * version the captain approved, and the queue answers success or failure on
 * it. The kept merge reads it like any other check, and Settings names it in
 * its how-to for the batched choice.
 */
export const QUEUE_STATUS = "infinitary/queue"; // the shipped queue's rules own it (`QUEUE`, rules.mjs); github.test.ts holds the two equal

/**
 * The project's queue status on a version, as a task's last reading of it
 * saw it (INF-3208): the queue's own words and link, the paused batch's
 * issue a paused reading of this version linked, and when the pull
 * request's own checks started and finished, without the queue status's
 * times. The merge card's Batch check cell says it, and its Checks cell
 * times the pull request's own checks by it (`ProjectQueue.observe`).
 */
export type QueueStatusFact = {
  head: string;
  words?: string;
  link?: string;
  pause?: string;
  checksStartedAt?: number;
  checksFinishedAt?: number;
};

export type RepoDelivery = z.infer<typeof repoDeliverySchema>;

/** The postures that ship through a pull request: everything but a local land. */
export type PullRequestDelivery = Exclude<RepoDelivery, "local-only">;

/** Whether a delivery ships through a pull request (`direct-pr` or `queue-pr`). */
export function opensPullRequest(
  delivery: string | null | undefined,
): delivery is PullRequestDelivery {
  return delivery === "direct-pr" || delivery === "queue-pr";
}

/**
 * The delivery a single task ships at. The captain's ask (in words, as
 * `delivery_ask`) overrides the repository's default for that task alone;
 * omit it and the repo stands. The personal workspace's tasks carry a
 * delivery nobody reads: they build in place, which is its kind's business
 * rather than a posture of its own.
 */
export type DeliveryInput = {
  /** The repository's standing posture; undefined = no repo (local-only). */
  repo?: RepoDelivery | undefined;
  /** The captain asked for a specific posture for this task. */
  ask?: RepoDelivery | undefined;
};

export type DeliveryDecision = {
  delivery: RepoDelivery;
  reason: string;
};

export function deliveryFor(input: DeliveryInput): DeliveryDecision {
  if (input.ask) {
    return {
      delivery: input.ask,
      reason: `the captain asked for ${input.ask}`,
    };
  }
  const repo = input.repo ?? "local-only";
  return {
    delivery: repo,
    reason: input.repo ? `the repository ships ${input.repo}` : "no repository: local-only",
  };
}

/** The posture a stored task ships at: its ask, else the repo, else local-only. */
export function deliveryForRecord(
  record: {
    shape?: { delivery_ask?: RepoDelivery; policies?: { delivery?: RepoDelivery | null } } | null;
  },
  repo?: RepoDelivery,
): RepoDelivery {
  return deliveryFor({
    repo,
    ask:
      record.shape?.policies?.delivery === undefined
        ? record.shape?.delivery_ask
        : (record.shape.policies.delivery ?? undefined),
  }).delivery;
}

/**

 * Whether the fleet may land a task's own green work, or must bring it to
 * the captain (captain ruling, 2026-09-20: "this should actually be the
 * same - repo default, per-task ask allowed"). Autonomy now has the shape
 * delivery and rigor have: a repository default, a per-task ask on the
 * captain's own words, and one effective value every reader takes.
 */
export type AutonomyInput = {
  /** The repository's standing flag; undefined = no repository, so no policy. */
  repo?: boolean | undefined;
  /** The captain said in words, for this task alone. `false` is an ask too. */
  ask?: boolean | undefined;
};

export type AutonomyDecision = {
  autonomy: boolean;
  reason: string;
};

/**
 * The derivation, in the captain's order: the ask, then the repository.
 *
 * A repo-less task - the default workspace - is not held. Autonomy is a
 * REPOSITORY's standing answer to "who merges my green work", and the hold
 * enforces that answer; where there is no repository there is no answer to
 * enforce, and nothing ships out of the app either, so holding it would be
 * the host inventing a policy the captain never set. This is the one case
 * the ruling did not name.
 */
export function autonomyFor(input: AutonomyInput): AutonomyDecision {
  if (input.ask !== undefined) {
    return {
      autonomy: input.ask,
      reason: input.ask
        ? "the captain asked for this task to merge itself"
        : "the captain asked to be asked before this task merges",
    };
  }
  if (input.repo === undefined) {
    return { autonomy: true, reason: "no repository: nothing to hold" };
  }
  return {
    autonomy: input.repo,
    reason: `the repository ${input.repo ? "merges green work itself" : "asks before merging"}`,
  };
}

/**
 * The autonomy a stored task ships at: its ask, else the repo. Derived
 * live, exactly like `deliveryForRecord` - the shape's stamped `autonomy`
 * is what the task was commissioned under, not what a merge attempt reads,
 * so flipping a repository's default reaches work already in flight.
 */
export function autonomyForRecord(
  record: { shape?: { autonomy_ask?: boolean; policies?: { autonomy?: boolean | null } } | null },
  repo?: boolean,
): boolean {
  return autonomyFor({
    ...(repo !== undefined ? { repo } : {}),
    ask:
      record.shape?.policies?.autonomy === undefined
        ? record.shape?.autonomy_ask
        : (record.shape.policies.autonomy ?? undefined),
  }).autonomy;
}

/**
 * Policy fields Settings and `app_change project-settings` may write. The personal
 * workspace takes none of them (its registry refuses the whole patch): it
 * builds in place, so there is nothing to deliver, land, or review.
 */
/**
 * Where a registered project lives (git integration PR 1.1, migration 40):
 * the host kind read from its origin (`forgeOf` in `./forge.ts`) and the
 * host's name. Null for a project kept only on this Mac. GitLab and
 * Bitbucket are recognised so a surface can name them; until their own
 * forge files exist they behave as a plain Git host. A remote on this Mac's
 * own disk is a plain host with no name.
 */
export const repoHostSchema = z
  .object({
    kind: z.enum(["github", "gitlab", "bitbucket", "git"]),
    name: z.string().nullable(),
  })
  .nullable();
export type RepoHost = z.infer<typeof repoHostSchema>;

/**
 * The hosts with a part of the shipped queue (docs/forge.md, "One queue for
 * every host"): where the queue runs in the project's own CI, marks each
 * change with a status, holds a pause in an issue and starts again by hand.
 * A host with no part, such as a plain Git host with no CI, cannot hold a
 * shared queue, so batched pull requests is not offered there.
 */
const QUEUE_PART_HOSTS: ReadonlySet<NonNullable<RepoHost>["kind"]> = new Set(["github", "gitlab"]);

/** Why a project whose host has no part of the shipped queue cannot choose batched pull requests. */
export const QUEUE_HOST_REFUSAL =
  "Batched pull requests need a host whose CI runs Infinitary's queue, and this project's host has none it can use yet. Choose pull requests or a local merge.";

/** Whether a project's host has a part of the shipped queue, so it may choose batched pull requests. */
export function hostRunsQueue(host: RepoHost | undefined): boolean {
  return host ? QUEUE_PART_HOSTS.has(host.kind) : false;
}

/**
 * The deliveries a project may choose where it lives: a project kept only on
 * this Mac lands locally; one with a host also opens pull requests; and one
 * whose host has a part of the shipped queue can merge through it. Settings
 * lists them in this order, from the lightest choice to the most involved.
 */
export function deliveryChoices(host: RepoHost | undefined): RepoDelivery[] {
  if (!host) return ["local-only"];
  return hostRunsQueue(host)
    ? ["local-only", "direct-pr", "queue-pr"]
    : ["local-only", "direct-pr"];
}

/** A parsed origin (`forgeOf`) as a project's host, or null when it lives only on this Mac. */
export function repoHostFrom(where: { kind: ForgeKind; host: string | null }): RepoHost {
  return where.kind === "none" ? null : { kind: where.kind, name: where.host };
}

export const repoPolicyPatchSchema = z
  .object({
    placementRequirements: placementRequirementsSchema.nullable().optional(),
    delivery: repoDeliverySchema.optional(),
    autonomy: z.boolean().optional(),
    rigor: rigorSchema.nullable().optional(),
    costLimit: costLimitSchema.nullable().optional(),
    scope: z.string().nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    path: z.string().trim().min(1).max(4096).optional(),
    origin: z.string().trim().min(1).max(4096).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "pass delivery, autonomy, rigor, costLimit, scope, name, path, origin, or several",
  });
export type RepoPolicyPatch = z.infer<typeof repoPolicyPatchSchema>;

/**
 * A workflow file on a project's default branch that mentions the app's
 * queue status (`infinitary/queue`, docs/forge.md "A project's queue"), as
 * last read where the project lives, and whether it is turned on there.
 */
export const queueWorkflowSchema = z.object({
  path: z.string(),
  active: z.boolean(),
  /** The shipped queue's version this file's stamp names; absent for a queue the project wrote itself. */
  shipped: z.number().int().positive().optional(),
});
export type QueueWorkflow = z.infer<typeof queueWorkflowSchema>;

/**
 * A project's paused batch as this app last read it where the project
 * lives (docs/forge.md, "A paused batch"): the failed batch run, the one
 * issue that holds the pause, when the app first saw it, the paused
 * changes' numbers, and who took the issue to repair it. `unread` marks a
 * pause kept from a task's paused status alone, because the issue could not
 * be read (Issues turned off): `url` is then that status's link and
 * `changes` only the changes this app saw paused.
 */
export const queuePauseSchema = z.object({
  run: z.number(),
  url: z.string(),
  since: z.number(),
  changes: z.array(z.number()),
  claimedBy: z.string().optional(),
  unread: z.literal(true).optional(),
});
export type QueuePause = z.infer<typeof queuePauseSchema>;

/**
 * A by-hand answer to a paused batch, from Settings or the first mate:
 * resume, or send one change back. `run` names the paused batch run it
 * answers, so an answer to a pause that already ended is refused.
 */
export const queueAnswerSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resume"),
    run: z.number().int().positive(),
    reason: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("send-back"),
    run: z.number().int().positive(),
    number: z.number().int().positive(),
    reason: z.string().trim().min(1).max(120),
  }),
]);
export type QueueAnswer = z.infer<typeof queueAnswerSchema>;

/**
 * The token a project's shipped queue writes with, where its host keeps one
 * in the project's CI settings rather than handing the queue's jobs a
 * credential of their own (GitLab; docs/forge.md, "The shipped queue on
 * GitLab"): `missing` until someone creates it, `ready` with the day it
 * ends, and `unreadable` when this sign-in cannot read the project's
 * tokens, such as without the Maintainer role. The token itself never
 * leaves the host.
 */
export const queueCredentialSchema = z.object({
  state: z.enum(["missing", "ready", "unreadable"]),
  /** The day the token ends, as the host writes it (YYYY-MM-DD). */
  expiresAt: z.string().optional(),
});
export type QueueCredential = z.infer<typeof queueCredentialSchema>;

export const repoViewSchema = z.object({
  id: z.string(),
  /** The fleet name (unique; names the fleet-root entry), shown in surfaces. */
  name: z.string(),
  /** What work belongs here, in the captain's words; personal takes no scope. */
  scope: z.string().nullable().optional(),
  /** The repo's real working directory (external for adopted repos). */
  path: z.string(),
  setupKind: repoSetupKindSchema,
  /**
   * The workspace's nature (`project` or `personal`), migration 37. There
   * is exactly one `personal` row - the app's own personal workspace - and
   * it takes no delivery, autonomy or rigor.
   */
  kind: repoKindSchema,
  /** Remote URL when known: the clone source, or a detected origin on adopt. */
  origin: z.string().nullable(),
  /** Where the project lives, read from `origin`; null = kept on this Mac. */
  host: repoHostSchema,
  delivery: repoDeliverySchema,
  /** On = the agent may land green finished work on this repo by itself. */
  autonomy: z.boolean(),
  /**
   * The repository's standing delivery rigor (delivery rigor phase 3), set
   * by talking or Settings → Projects; null = the host derives it per task
   * from the posture and the intelligence tier (`rigorFor` in `./rigor.ts`).
   */
  rigor: rigorSchema.nullable(),
  /** Null follows Settings → Intelligence; absent on older homes. */
  costLimit: costLimitSchema.nullable().optional(),
  /**
   * Where the project's next task starts (multi-machine piece 11,
   * docs/helper.md "Runs on"): the id of a paired computer that runs work,
   * or null for this Mac.
   */
  runsOn: z.string().nullable(),
  placementRequirements: placementRequirementsSchema.optional(),
  /**
   * The workflow files that mention the queue status, read when the batched
   * delivery is chosen and at each merge click that waits on it; absent
   * until a read succeeded (docs/forge.md, "A project's queue").
   */
  queueWorkflows: z.array(queueWorkflowSchema).optional(),
  /**
   * When anything other than the app last wrote the queue status on one of
   * this project's versions (epoch ms); absent while nothing has answered.
   */
  queueAnsweredAt: z.number().optional(),
  /**
   * When the batched delivery was chosen while nothing in the project
   * answered its queue status (epoch ms): the choice waits, the project
   * keeps `delivery`, and the app switches it once a workflow that is on
   * mentions the status (docs/forge.md, "Choosing batched pull requests
   * before a queue exists"); absent when nothing waits.
   */
  queuePendingAt: z.number().optional(),
  /** The project's paused batch, while this app reads one (docs/forge.md, "A paused batch"). */
  queuePause: queuePauseSchema.optional(),
});
export type RepoView = z.infer<typeof repoViewSchema>;

/**
 * The shipped queue's version the project runs on its default branch, read
 * from the stamp of a workflow that is on; undefined when it runs none.
 * Every teammate's Infinitary treats such a project as batched, whatever
 * that person chose (docs/forge.md, "The shipped queue").
 */
export function queueShipped(repo: Pick<RepoView, "queueWorkflows">): number | undefined {
  const versions = (repo.queueWorkflows ?? [])
    .filter((workflow) => workflow.active && workflow.shipped !== undefined)
    .map((workflow) => workflow.shipped as number);
  return versions.length ? Math.max(...versions) : undefined;
}

/**
 * Whether the app's reads find nothing to answer a project's queue: the
 * workflows were read, none that is on mentions its status, and the status
 * was never answered. A read that never succeeded is unknown, never
 * "nothing answers", so it is not missing.
 */
export function queueMissing(repo: Pick<RepoView, "queueWorkflows" | "queueAnsweredAt">): boolean {
  if (repo.queueAnsweredAt !== undefined) return false;
  const workflows = repo.queueWorkflows;
  return workflows !== undefined && !workflows.some((workflow) => workflow.active);
}

/**
 * Settings' warning under "Where changes go" for a project on the batched
 * delivery whose queue the app's reads find nothing to answer (docs/forge.md,
 * "A project's queue"); null when the queue answered before, a workflow that
 * is on mentions its status, or the workflows were never read. It says only
 * what was read: a mention is not proof a workflow answers.
 */
export function queueSettingsWarning(
  repo: Pick<RepoView, "delivery" | "queueWorkflows" | "queueAnsweredAt">,
): string | null {
  if (repo.delivery !== "queue-pr" || !queueMissing(repo)) return null;
  return (repo.queueWorkflows ?? []).length > 0
    ? "The workflow in this project that mentions its batch check is turned off, so approved merges would wait for one."
    : "No workflow in this project mentions its batch check yet, so approved merges would wait for one.";
}

/**
 * Why a project's tasks can run only on this Mac, or null when its Runs on
 * may name another computer: the personal workspace builds in place here,
 * and a project with no origin has nowhere another computer could clone it
 * from (docs/helper.md, "Its working copies").
 */
export function runsHereOnly(repo: Pick<RepoView, "kind" | "origin">): string | null {
  if (repo.kind === "personal") return `The personal workspace stays on ${HERE.this}.`;
  if (!repo.origin) return `Kept on ${HERE.this} only, so its tasks run there.`;
  return null;
}

/**
 * A task's own Runs on that names this Mac (`WorkShape.runs_on_ask`,
 * docs/helper.md "A task's own Runs on"); any other value is a device id.
 */
export const RUNS_ON_THIS_MAC = "this-mac";

/**
 * The feed line when a project's Runs on changes (design skill
 * `components/devices/RunsOn`). `where` places the computer after a verb,
 * as `signInPlace` does ("on Mac mini", "as Builder"); null is this Mac.
 * `fromHere` says the project ran on this Mac before.
 */
export function runsOnLine(
  name: string,
  where: string | null,
  fromHere: boolean,
  automatic = false,
): string {
  if (automatic)
    return `Infinitary chooses a computer for each new task in ${name}. Started tasks stay where they started.`;
  if (where === null) return `${name} runs on ${HERE.this} now. Its next task starts here.`;
  return fromHere
    ? `${name} runs ${where} now. Its next task starts there; the one running here finishes here.`
    : `${name} runs ${where} now. Its next task starts there; one already running finishes where it started.`;
}

export const repoSetupResultSchema = z.object({
  repo: repoViewSchema,
  created: z.boolean(),
  initializedGit: z.boolean().optional(),
  createdInitialCommit: z.boolean().optional(),
});
export type RepoSetupResult = z.infer<typeof repoSetupResultSchema>;

/**
 * What a setup would do, read without doing any of it (the setup card,
 * `./projectSetup.ts`): the project already on the list, or the name it
 * would get, where it lives, whether adding a plain folder starts a git
 * repository in it, and the task key it was asked to take, normalized.
 */
export type RepoSetupCheck =
  | { existing: RepoView }
  | { name: string; origin: string | null; host: RepoHost; startsGit: boolean; key?: string };

/** Tasks still on a project. Any open or active task blocks its removal. */
export const repoRemovalSchema = z.object({
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      status: z.enum(["planned", "working"]),
    }),
  ),
});
export type RepoRemoval = z.infer<typeof repoRemovalSchema>;

/** Settings and Firstmate say the same thing when tasks are in the way. */
export function repoRemovalRefusal(name: string, tasks: RepoRemoval["tasks"]): string {
  const named = tasks.map((task) => `${task.key} "${task.title}" (${task.status})`);
  const list =
    named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : (named[0] ?? "");
  return `${name} still has ${tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}: ${list}. Finish or drop ${tasks.length === 1 ? "it" : "them"}, then remove it.`;
}

/** What Remove does to a project, said on its row before anything is asked. */
export const REPO_REMOVAL_LINE = "Takes it off this list. Its folder and finished tasks stay.";

export function repoRemovalQuestion(name: string, path: string): string {
  return `Remove ${name}? Its folder stays at ${path}, and its finished tasks stay readable.`;
}

/**
 * Where new projects go: the folder `clone` and `init` create their real
 * directories in. `custom` is false while it is the app's own fleet root,
 * the default; a folder the person chose in Settings -> Projects is
 * `custom`. Projects already set up never move when it changes.
 */
export const projectsFolderViewSchema = z.object({
  path: z.string(),
  custom: z.boolean(),
});
export type ProjectsFolderView = z.infer<typeof projectsFolderViewSchema>;

/** The one `repo_configured` payload Settings and `app_change project-settings` broadcast. */
export function repoConfiguredEvent(repo: RepoView): {
  type: "repo_configured";
  repoId: string;
  name: string;
  delivery: RepoDelivery;
  autonomy: boolean;
  rigor: z.infer<typeof rigorSchema> | null;
} {
  return {
    type: "repo_configured",
    repoId: repo.id,
    name: repo.name,
    delivery: repo.delivery,
    autonomy: repo.autonomy,
    rigor: repo.rigor,
  };
}

/** The one outcome line Settings and `app_change project-settings` write. */
export function repoPolicyOutcome(repo: RepoView): string {
  return `${repo.name} now ships ${repo.delivery} with autonomy ${
    repo.autonomy ? "on" : "off"
  }, rigor ${repo.rigor ?? "standard"}.`;
}

/** The picker's sentinel for the app-managed default workspace. */
export const DEFAULT_WORKSPACE_ID = "default";
