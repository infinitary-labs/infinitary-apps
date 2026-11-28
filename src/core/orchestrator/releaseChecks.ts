import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as m from "@shared/i18n/messages.generated";
import type { RepoView } from "@shared/repos";
import { type InPlaceRelease, isReleaseCheck, type WorkShape } from "@shared/routingPolicy";
import { KIND_SOURCE } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraph } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { IN_PLACE_OPENING } from "./intentBrief";

/** How often the host looks, in the design's one-minute periods: a tag read at most this often. */
export const RELEASE_LOOK_MS = 5 * 60 * 1000;
/** A tag never starts a check sooner than this after the project's last one. */
export const RELEASE_CHECK_GAP_MS = 3 * 60 * 60 * 1000;
/** With no new tag, a check starts this long after the last one, or after the oldest listed merge. */
export const RELEASE_CHECK_FLOOR_MS = 24 * 60 * 60 * 1000;

/**
 * What a release check's report declared that only someone else can move:
 * a wait on the captain, the first mate's help, a work wait, recovery ways
 * or a job it looks at again. Such a report sorts as any task's would and
 * keeps the check open; any other report sorts `host-check` and closes it
 * (docs/report-sort.md, row 2c).
 */
export type ReleaseCheckReport = {
  wait?: unknown;
  needsFirstmate?: string;
  workWait?: unknown;
  recoveryWays?: readonly unknown[];
  checkBack?: unknown;
};

/** True when a release check's report hands nothing on, so the host may close the check. */
export function releaseCheckReported(declared: ReleaseCheckReport | undefined): boolean {
  return (
    declared?.wait === undefined &&
    declared?.needsFirstmate === undefined &&
    declared?.workWait === undefined &&
    !declared?.recoveryWays?.length &&
    declared?.checkBack === undefined
  );
}

/** What the release checks reach of the supervisor beyond its options. */
export type ReleaseChecksHost = {
  now(): number;
  broadcastCrewCounts(): void;
  /** Start every queued task whose wait ended (`IdleLadder`'s ready sweep). */
  sweepGates(at: number): Promise<void>;
};

/** One merged task a check looks for, as its brief names it. */
export type ReleaseCheckTask = {
  key: string;
  title: string;
  mergeCommit?: string;
  mergedAt?: number;
};

/**
 * The host's release check (docs/task-record.md, "A release check"; INF-7198's
 * plan, Part 2): while a release-moment side-effect task waits on merged work
 * with no recorded first release, the host files one short read-only check in
 * that work's project, whose crewmate finds the earliest published release
 * the way the project ships and declares it through `report.first_release`.
 * The host knows nothing of how a project releases; a tag at origin is only a
 * hint to look sooner, never a release. The minute's read in `InPlaceWork`
 * closes a check once its crewmate's report handed nothing on.
 */
export class ReleaseChecks {
  /**
   * Origin's tags per project as the host last filed a check on them, or as
   * first read when no check names any: what a later tag is new against when
   * the record's last day holds no check of that project. Lost on a restart,
   * after which the first read is the baseline again, and the daily look
   * still covers a tag that came meanwhile.
   */
  private readonly seenTags = new Map<string, string>();
  private looking = false;

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: ReleaseChecksHost,
  ) {}

  /**
   * Each project's merged tasks that an open release-moment side-effect task
   * waits on with no recorded first release (`TaskGraph.awaitingRelease`),
   * keyed by that work's own project, since a first release is declared by a
   * task of the same project. Work with no project is left out.
   */
  unreleasedByProject(): Map<string, TaskRecord[]> {
    const byProject = new Map<string, Map<string, TaskRecord>>();
    for (const waiting of this.options.tasks.listOpen()) {
      for (const wait of this.options.tasks.graph.awaitingRelease(waiting)) {
        if (!wait.repoId) continue;
        const listed = byProject.get(wait.repoId) ?? new Map<string, TaskRecord>();
        listed.set(wait.id, wait);
        byProject.set(wait.repoId, listed);
      }
    }
    return new Map([...byProject].map(([repoId, listed]) => [repoId, [...listed.values()]]));
  }

  /**
   * One look over every project, on the host's tick: a project with listed
   * work and no check open or running gets one when origin shows a tag its
   * last check did not see and that check started at least
   * `RELEASE_CHECK_GAP_MS` ago, or when `RELEASE_CHECK_FLOOR_MS` passed since
   * its last check, or, with none in that time, since its oldest listed
   * merge. A project with nothing listed is never read.
   */
  async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      for (const [repoId, listed] of this.unreleasedByProject()) {
        const repo = this.options.repos.get(repoId);
        if (!repo) continue;
        await this.lookAt(repo, listed).catch((caught) => {
          console.warn(`[crew] the release check of ${repo.name} could not be filed:`, caught);
        });
      }
    } finally {
      this.looking = false;
    }
  }

  private async lookAt(repo: RepoView, listed: TaskRecord[]): Promise<void> {
    const now = this.host.now();
    const checks = this.options.tasks
      .listLiveOrClosedSince(now - RELEASE_CHECK_FLOOR_MS)
      .filter((row) => row.repoId === repo.id && isReleaseCheck(row.shape?.in_place));
    if (checks.some((row) => !TaskService.isClosed(row))) return;
    // A folder that is gone gets its repair from the work that next needs it;
    // a check started into it would only be refused.
    if (!existsSync(repo.path)) return;
    const last = checks.reduce<TaskRecord | undefined>(
      (newest, row) => (newest && newest.createdAt >= row.createdAt ? newest : row),
      undefined,
    );
    const since = last?.createdAt ?? Math.min(...listed.map((wait) => wait.closedAt ?? now));
    const daily = now - since >= RELEASE_CHECK_FLOOR_MS;
    if (!daily && last && now - last.createdAt < RELEASE_CHECK_GAP_MS) return;
    const tags = await Promise.resolve()
      .then(() => this.options.workspace.originTags(repo.path))
      .catch(() => undefined);
    const lastFacts = last?.shape?.in_place;
    const baseline =
      (isReleaseCheck(lastFacts) ? lastFacts.release.tags : undefined) ??
      this.seenTags.get(repo.id);
    if (tags !== undefined && baseline === undefined) this.seenTags.set(repo.id, tags);
    const newTag = tags !== undefined && baseline !== undefined && tags !== baseline;
    if (!daily && !newTag) return;
    this.file(repo, listed, tags);
  }

  /** Files the project's check, started the way a when-ready task starts. */
  private file(repo: RepoView, listed: TaskRecord[], tags: string | undefined): TaskRecord {
    if (tags !== undefined) this.seenTags.set(repo.id, tags);
    const facts: InPlaceRelease = {
      release: { tasks: listed.map((wait) => wait.id), ...(tags ? { tags } : {}) },
    };
    // Deliverable "change", as the folder and pull request repairs take: an
    // answer's brief would ask for a card and free edits in the folder, which
    // here is the person's own project folder.
    const shape: WorkShape = {
      kind: "chore",
      kind_source: `${KIND_SOURCE.skipped}in-place`,
      deliverable: "change",
      in_place: facts,
    };
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title: m.taskReleaseCheckTitle(),
      // i18n-exempt: served to the check's crewmate as its goal, stays English
      goal: `Find the earliest published release of ${repo.name} holding ${listed.map((wait) => wait.key || wait.id).join(", ")}, and declare it through report.first_release.`,
      prompt: this.brief(repo, facts),
      repoId: repo.id,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      startPolicy: "when-ready",
      status: "open",
      actor: "host",
    });
    this.host.broadcastCrewCounts();
    void this.host.sweepGates(this.host.now());
    return record;
  }

  /**
   * The check's brief at its start, from the record as it stands: the listed
   * tasks still merged with no first release, as a release report since may
   * have named some.
   */
  brief(repo: Pick<RepoView, "name" | "path">, facts: InPlaceRelease): string {
    const tasks = facts.release.tasks.flatMap((id): ReleaseCheckTask[] => {
      const task = this.options.tasks.get(id);
      if (!task || task.delivery?.firstRelease || !TaskGraph.workMerged(task)) return [];
      return [
        {
          key: task.key || task.id,
          title: task.title,
          ...(task.delivery?.mergedSha ? { mergeCommit: task.delivery.mergedSha } : {}),
          ...(task.closedAt != null ? { mergedAt: task.closedAt } : {}),
        },
      ];
    });
    return renderReleaseCheckBrief({ project: repo.name, folder: repo.path, tasks });
  }
}

/** The line of the check's brief over the tasks it looks for. */
// i18n-exempt: served to the check's crewmate in its brief, stays English
export const RELEASE_CHECK_LISTED = "Merged tasks with no recorded first release:";

/**
 * The release check's brief (INF-7198's plan, Part 2, the captain's pick "a
 * short crewmate check, only while a task waits, reading however the project
 * ships"). It speaks for every project: it names no place releases live, and
 * the crewmate finds that from the project itself. Like the folder's repair,
 * the task ships nothing: no delivery line and no completion decision.
 */
export function renderReleaseCheckBrief(facts: {
  project: string;
  folder: string;
  tasks: readonly ReleaseCheckTask[];
}): string {
  const listed = facts.tasks.length
    ? facts.tasks.map(
        (task) =>
          // i18n-exempt: served to the check's crewmate in its brief, stays English
          `- ${task.key} "${task.title}": merged${task.mergedAt !== undefined ? ` ${new Date(task.mergedAt).toISOString()}` : ""}, merge commit ${task.mergeCommit ?? "not recorded"}`,
      )
    : // i18n-exempt: served to the check's crewmate in its brief, stays English
      [
        "- none: a release was already recorded for each, so report that there was nothing to look for.",
      ];
  // i18n-exempt: served to the check's crewmate in its brief, stays English
  return [
    `Goal: find the earliest published release of ${facts.project} that holds each merged task below, and declare each one you verify through report's first_release.`,
    "",
    "Infinitary filed this task itself. Work that acts at a release, such as a reply to the person who asked for a fix, waits on these merged tasks, and the task record holds no first release for them yet. Infinitary knows nothing about how this project releases, so finding that out is yours.",
    "",
    RELEASE_CHECK_LISTED,
    ...listed,
    "",
    `${IN_PLACE_OPENING}: your working directory is the project's folder, ${facts.folder}, not a working copy of your own. Leave it as it is: never check out, commit, stash, reset, push or change a file. You may fetch from origin, tags included, since a fetch changes no file. This task has no branch, no pull request and no merge card, and it ships nothing.`,
    "Find how this project publishes its releases from the project itself: its docs, its changelog and its history. Its releases may live on release pages where the project lives, in tags, in a package registry, in a store listing or in a changelog.",
    "A tag alone is not a published release. Count a release only once it is published where the project's users get it; a draft, or a release still being made, is not published.",
    "For each task, find the earliest published release whose source holds its merge commit (`git merge-base --is-ancestor <merge commit> <the release's commit>`), or, where no merge commit is recorded, that holds its change by other evidence you can name.",
    "Declare each group of tasks that share an earliest release in one report's first_release: the version, its page, the task keys, and your evidence that each is in it and when it was first published. Send one report for each group.",
    "A task in no published release yet stays without one: never guess from the merge time, release names or version order. Say it is not released yet; Infinitary looks again later.",
    "Once you have declared every release you verified, report what you found in a few sentences. Infinitary closes this task itself; show a card only when you must ask the captain.",
  ].join("\n");
}
