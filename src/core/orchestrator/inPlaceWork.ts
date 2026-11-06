import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type FolderNoticed,
  type FolderRefreshRefusal,
  folderRefreshWords,
} from "@shared/folderRefresh";
import type { RepoView } from "@shared/repos";
import {
  type InPlaceFacts,
  type InPlacePull,
  isFolderRepair,
  isFolderWork,
  isPullRepair,
  type WorkShape,
} from "@shared/routingPolicy";
import { KIND_SOURCE } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import type { TaskRecord } from "../storage/taskStore";
import { TaskService } from "../tasks/taskService";
import { nearestFolderAbove } from "../workspace/workspaceService";
import type { CardService } from "./cardService";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import {
  FOLDER_REPAIR_TITLE,
  PULL_REPAIR_TITLE,
  renderFolderRepairBrief,
  renderPullRepairBrief,
} from "./intentBrief";
import type { SettleOwners } from "./settleOwners";
import { folderMissingText } from "./settleWords";

/** What the in-place work reaches of the supervisor beyond its options. */
export type InPlaceWorkHost = {
  now(): number;
  /** The card stack: a card of the task's still up keeps it open. */
  readonly cards: CardService;
  /** Settling and closing, for the close of an in-place task found done. */
  readonly settling: SettleOwners;
  /** A task's runtime on this computer, while its crewmate is open here. */
  runtime(taskId: string): TaskRuntime | undefined;
  /** Steer a task as the host, answering no message or card. */
  steer(taskId: string, message: string): Promise<unknown>;
  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
  /** Start every queued task whose wait ended (`IdleLadder`'s ready sweep). */
  sweepGates(at: number): Promise<void>;
};

/**
 * The host's own work in a project's folder (docs/task-record.md, INF-549
 * and INF-572): the task it files to bring a folder up to date or back, or
 * to close a pull request an abandoned task left open, where such a task
 * starts, the check of every project's folder at the app's start, and the
 * minute's read that closes such a task once what it was for is done. The
 * crew supervisor composes it and its callers reach it as
 * `CrewSupervisor.inPlaceWork`.
 */
export class InPlaceWork {
  /** Folder repairs whose folder is being read now, so one tick reads each once. */
  private readonly closingFolders = new Set<string>();

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: InPlaceWorkHost,
  ) {}

  /**
   * The host's own task for a project folder a merge could not bring up to
   * date (INF-549, the captain's approved plan): filed under the project and
   * started like any queued task whose wait ended, working in place with a
   * brief filled from the facts. One stands per project: a later refusal
   * while it stands updates its facts and files nothing new. Answers the
   * task, and whether it was filed now.
   */
  fileFolderRepair(
    merged: TaskRecord,
    refusal: FolderRefreshRefusal & { reach?: string },
  ): { record: TaskRecord; filed: boolean } | undefined {
    const repo = merged.repoId ? this.options.repos.get(merged.repoId) : undefined;
    if (!repo) return undefined;
    const facts: InPlaceFacts = {
      cause: refusal.cause,
      ...(refusal.branch ? { branch: refusal.branch } : {}),
      ...(refusal.reach ? { reach: refusal.reach } : {}),
      ...(refusal.remote ? { remote: refusal.remote } : {}),
      ...(merged.key ? { after: merged.key } : {}),
    };
    return this.fileRepairFor(
      repo,
      facts,
      `Another merge, ${merged.key || merged.id}, could not bring the folder up to date either: ${folderRefreshWords(facts.cause)}. The folder must now reach ${facts.reach ?? `origin's ${facts.branch ?? "default branch"}`}.`,
    );
  }

  /**
   * Work that needs a project's folder found it missing (INF-572, the
   * captain's approved plan): a task starting on this computer, a branch
   * coming home, or a merge into the folder. The repair that brings it back
   * is filed, or the standing one named, and the words refusing that work
   * return, naming the folder and the repair.
   */
  folderMissing(repoId: string, noticed: FolderNoticed, by?: TaskRecord): string {
    const repo = this.options.repos.get(repoId);
    if (!repo) return "The project's folder is missing.";
    let repair: { record: TaskRecord; filed: boolean } | undefined;
    try {
      repair = this.fileRepairFor(
        repo,
        { cause: "missing", noticed, ...(by?.key ? { after: by.key } : {}) },
        `The folder ${repo.path} is now missing: bring it back instead. Find out why it is missing, and clone it again into the same path only if it was deleted; otherwise ask the captain on a card.`,
      );
    } catch (caught) {
      console.warn("[crew] the folder repair could not be filed:", caught);
    }
    return folderMissingText(
      repo.path,
      noticed,
      repair ? { key: repair.record.key || repair.record.id, filed: repair.filed } : undefined,
    );
  }

  /**
   * The check at each app start, on the computer that keeps the record
   * (INF-572, the captain's answers): every project with an address where it
   * lives is read once, in the background. A missing folder waits until work
   * needs it; a folder on another branch or on none is left alone; one that
   * is behind and clean on its default branch is brought up to date, with
   * one Activity line; one behind with edits or its own commits gets the
   * repair, unless the captain closed one for that same version of where
   * the project lives. A read that fails changes nothing.
   */
  async checkFoldersAtStart(): Promise<void> {
    if (typeof this.options.workspace.refreshAtStart !== "function") return;
    for (const repo of this.options.repos.list()) {
      if (repo.kind !== "project" || !repo.origin) continue;
      try {
        const reading = await this.options.workspace.refreshAtStart(repo.path);
        if (reading.outcome === "refreshed") {
          this.options.broadcastEvent({
            type: "firstmate_note",
            text: `The folder of ${repo.name} was behind where the project lives; Infinitary brought its ${reading.branch} up to date.`,
          });
          continue;
        }
        if (reading.outcome !== "refused") continue;
        const { refusal } = reading;
        if (this.repairClosedAt(repo.id, refusal.remote)) continue;
        this.fileRepairFor(
          repo,
          {
            cause: refusal.cause,
            noticed: "app-start",
            ...(refusal.branch ? { branch: refusal.branch } : {}),
            ...(refusal.remote ? { remote: refusal.remote } : {}),
          },
          `At the app's start the folder was still behind where the project lives: ${folderRefreshWords(refusal.cause)}.`,
        );
      } catch (caught) {
        console.warn(`[crew] reading the folder of ${repo.name} at start:`, caught);
      }
    }
  }

  /**
   * Whether the captain closed this project's latest folder repair while
   * where the project lives stood at `remote` (INF-572, the captain's answer 4): the
   * start check files it again only once that has moved on.
   */
  private repairClosedAt(repoId: string, remote: string | undefined): boolean {
    if (!remote) return false;
    const last = this.options.tasks
      .list()
      .filter((row) => row.repoId === repoId && isFolderRepair(row.shape?.in_place))
      .filter((row) => row.status === "dropped")
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0]?.shape?.in_place;
    return isFolderRepair(last) && (last.remote === remote || last.reach === remote);
  }

  /**
   * Files a project's folder repair, or updates the one standing with the
   * newer facts and tells its crewmate `update`. A folder found missing
   * again while its repair already knows tells nobody anything new.
   */
  private fileRepairFor(
    repo: RepoView,
    facts: InPlaceFacts,
    update: string,
  ): { record: TaskRecord; filed: boolean } | undefined {
    const standing = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()].find(
      (row) => row.repoId === repo.id && isFolderRepair(row.shape?.in_place),
    );
    if (standing) {
      const prior = standing.shape?.in_place;
      if (isFolderRepair(prior) && prior.cause === "missing" && facts.cause === "missing") {
        return { record: standing, filed: false };
      }
      const kept =
        isFolderRepair(prior) && prior.started_in ? { started_in: prior.started_in } : {};
      this.options.tasks.placement.recordShape(
        standing.id,
        { in_place: { ...facts, ...kept } },
        standing.difficulty,
      );
      this.options.tasks.note(standing.id, update, { news: true });
      if (this.host.runtime(standing.id)) {
        void this.host.steer(standing.id, update).catch(() => {});
      }
      const record = this.options.tasks.get(standing.id);
      return record ? { record, filed: false } : undefined;
    }
    const shape: WorkShape = {
      kind: "chore",
      kind_source: `${KIND_SOURCE.skipped}in-place`,
      deliverable: "change",
      in_place: facts,
    };
    const goal =
      facts.cause === "missing"
        ? `Bring back the folder of ${repo.name}, which is missing.`
        : facts.reach
          ? `Bring the folder of ${repo.name} up to date with the merged version.`
          : `Bring the folder of ${repo.name} up to date with where the project lives.`;
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title: FOLDER_REPAIR_TITLE,
      goal,
      prompt: this.folderRepairBrief(repo, facts),
      repoId: repo.id,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      startPolicy: "when-ready",
      status: "open",
      actor: "host",
    });
    this.host.broadcastCrewCounts();
    // It starts on this very sweep, the way a when-ready plan does.
    void this.host.sweepGates(this.host.now());
    return { record, filed: true };
  }

  /** A folder repair's brief, rendered from its facts and its project as they stand now. */
  folderRepairBrief(repo: Pick<RepoView, "name" | "path" | "origin">, facts: InPlaceFacts): string {
    // Rendered just before a start, so it names where that start opens (`inPlaceDir`).
    const workdir = existsSync(repo.path) ? undefined : nearestFolderAbove(repo.path);
    return renderFolderRepairBrief({
      ...facts,
      project: repo.name,
      folder: repo.path,
      origin: repo.origin,
      ...(workdir ? { workdir } : {}),
    });
  }

  /**
   * Where a task that works in place starts: its project's folder, or, for a
   * folder repair that finds it missing, the folder above it that exists,
   * kept on the record so a resume opens there again (INF-572). Each start
   * opens a new conversation, so it reads the project's folder as it stands
   * now: one the captain has since named somewhere else, or one that is back,
   * is where it starts (INF-757).
   */
  inPlaceDir(taskId: string, folder: string): string {
    const record = this.options.tasks.get(taskId);
    const facts = record?.shape?.in_place;
    if (!record || !isFolderRepair(facts)) return folder;
    const { started_in: before, ...rest } = facts;
    const started_in = existsSync(folder) ? undefined : nearestFolderAbove(folder);
    if (started_in !== before) {
      this.options.tasks.placement.recordShape(
        taskId,
        { in_place: started_in ? { ...rest, started_in } : rest },
        record.difficulty,
      );
    }
    return started_in ?? folder;
  }

  /**
   * The host's own task for a pull request an abandoned task could not
   * close (INF-549's sibling, the captain's "close the pull request or
   * report why not"): filed under the project and started like the folder
   * repair, working in place with a brief filled from the facts. One stands
   * per pull request. Answers the task, and whether it was filed now.
   */
  filePullRepair(
    abandoned: TaskRecord,
    problem: string | undefined,
  ): { record: TaskRecord; filed: boolean } | undefined {
    const repo = abandoned.repoId ? this.options.repos.get(abandoned.repoId) : undefined;
    const number = abandoned.delivery?.prNumber;
    if (!repo || number === undefined) return undefined;
    const standing = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()].find(
      (row) => {
        const facts = row.shape?.in_place;
        return row.repoId === repo.id && isPullRepair(facts) && facts.pull.number === number;
      },
    );
    if (standing) return { record: standing, filed: false };
    const label = abandoned.delivery?.changeLabel ?? `#${number}`;
    const facts: InPlacePull = {
      pull: {
        number,
        label,
        ...(abandoned.delivery?.prUrl ? { url: abandoned.delivery.prUrl } : {}),
        ...(abandoned.branch ? { branch: abandoned.branch } : {}),
        ...(problem ? { problem } : {}),
      },
      ...(abandoned.key ? { after: abandoned.key } : {}),
      after_id: abandoned.id,
    };
    const shape: WorkShape = {
      kind: "chore",
      kind_source: `${KIND_SOURCE.skipped}in-place`,
      deliverable: "change",
      in_place: facts,
    };
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title: PULL_REPAIR_TITLE,
      goal: `Close the pull request ${label} of ${repo.name}, which ${abandoned.key || abandoned.id} left open, or report why it cannot be closed.`,
      prompt: renderPullRepairBrief({ ...facts, project: repo.name, folder: repo.path }),
      repoId: repo.id,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      startPolicy: "when-ready",
      status: "open",
      actor: "host",
    });
    this.host.broadcastCrewCounts();
    void this.host.sweepGates(this.host.now());
    return { record, filed: true };
  }

  /**
   * The closing half of a task that works in place (INF-549): it closes as
   * settled, with a feed line, once the host reads what it was for done - a
   * folder clean, on the default branch and at or past the merged version,
   * or a pull request closed where the project lives. A crewmate mid-turn,
   * or a card of the task's still up, keeps it open.
   */
  async closeCurrentFolders(): Promise<void> {
    const live = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()];
    for (const record of live) {
      const facts = record.shape?.in_place;
      const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
      if (!facts || isFolderWork(facts) || !repo || this.closingFolders.has(record.id)) continue;
      if (isPullRepair(facts) && !this.options.readPull) continue;
      const state = this.host.runtime(record.id)?.state;
      if (state !== undefined && state !== "idle") continue;
      if (this.host.cards.snapshot().some((card) => card.taskId === record.id)) continue;
      this.closingFolders.add(record.id);
      try {
        const line = await this.inPlaceDone(facts, repo.path);
        if (!line) continue;
        const now = this.options.tasks.get(record.id);
        if (!now || TaskService.isClosed(now)) continue;
        const after = this.host.runtime(record.id)?.state;
        if (after !== undefined && after !== "idle") continue;
        this.options.tasks.note(record.id, line, {
          news: true,
          feed: true,
          data: { feedLine: true },
        });
        await this.host.settling.closing.closeTask(record.id, {
          status: "done",
          reason: "finished",
          actor: "host",
          text: isPullRepair(facts) ? "the pull request is closed" : "the folder is up to date",
          feed: false,
        });
      } finally {
        this.closingFolders.delete(record.id);
      }
    }
  }

  /**
   * What an in-place task was for, read without changing anything: the
   * Activity line saying it is done, or undefined while it is not, or when
   * it cannot be read.
   */
  private async inPlaceDone(
    facts: InPlaceFacts | InPlacePull,
    folder: string,
  ): Promise<string | undefined> {
    if (isPullRepair(facts)) {
      const pull = await this.options
        .readPull?.(facts.after_id, facts.pull.number)
        .catch(() => undefined);
      if (pull?.state !== "closed") return undefined;
      return `The pull request ${facts.pull.label} is ${pull.merged ? "merged" : "closed"} where the project lives.`;
    }
    // A repair that never read a default branch - the folder was missing,
    // or named none - reads it from the folder as it stands now (INF-572).
    const branch =
      facts.branch ??
      (typeof this.options.workspace.folderDefaultBranch === "function"
        ? await this.options.workspace.folderDefaultBranch(folder).catch(() => "")
        : "");
    if (!branch) return undefined;
    const current = await this.options.workspace
      .folderCurrent(folder, branch, facts.reach)
      .catch(() => false);
    if (!current) return undefined;
    if (facts.cause === "missing") {
      return `The project's folder is back: clean, on ${branch} and level with origin's ${branch}.`;
    }
    return `The project's folder is up to date: clean, on ${branch} and at or past ${facts.reach ? facts.reach.slice(0, 7) : `origin's ${branch}`}.`;
  }
}
