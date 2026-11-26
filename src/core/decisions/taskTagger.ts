import type { DecisionAnswer } from "@shared/decisions";
import type { FmEvent } from "@shared/events";
import { type Said, said, saidLine } from "@shared/i18n/said";
import type { TagCheckChange, TagCheckReach, TagCheckRead, TagCheckView } from "@shared/tagCheck";
import type { TagSuggestionRefusal } from "@shared/tagSuggestion";
import type { TagSuggestionFacts } from "../orchestrator/tagSuggestionNote";
import { TICK_PERIOD_MS, type Ticker } from "../orchestrator/ticker";
import type { AppDatabase } from "../storage/db";
import type { SavedTagCheck, SettingsStore } from "../storage/settingsStore";
import { type TagCheckScope, TagWork, type TagWorkItem } from "../storage/tagWork";
import type { TaskService } from "../tasks/taskService";
import type { TagJudgment } from "../tasks/taskTags";
import type { TaskChange } from "../tasks/taskWriter";
import type { DecisionModels } from "./decisionModel";
import { tagQuestions, tagState } from "./tagQuestion";

/**
 * Automatic tagging and Check existing tasks (docs/task-tags.md): one
 * background worker asks the decision model about one task at a time, all
 * of the task's owed tags in one request, and records every answer through
 * `TaskService`. New tasks always go first; a check takes the turns left.
 *
 * Nothing here holds a list of work: what is owed is read from the record
 * each turn (`TagWork`), so a restart resumes where the record stands, and
 * a project with no tags owes nothing and is never asked about.
 */

/** A task whose request failed is asked again after this long, or at the next start. */
export const TAG_RETRY_MS = 60 * 60 * 1000;

/** A refused start, in words Settings and the first mate both show. */
export class TagCheckRefusal extends Error {}

const ANSWERS = new Set(["yes", "no"]);

export type TaskTaggerOptions = {
  tasks: Pick<TaskService, "get" | "judgeTags" | "projects">;
  work: TagWork;
  models: Pick<DecisionModels, "decide" | "allowsUse" | "answererName">;
  settings: Pick<
    SettingsStore,
    "getTagCheck" | "setTagCheck" | "getTagAutoSince" | "setTagAutoSince"
  >;
  now: () => number;
  /** One Activity line, as the feed shows a host notice. */
  activity: (line: Said) => void;
};

export class TaskTagger {
  private busy = false;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private controller: { abort: AbortController; check: boolean } | undefined;
  /** Tasks whose last request failed, by when they may be asked again. */
  private readonly failedAuto = new Map<string, number>();
  /** Tasks the check under way could not ask; it ends without them. */
  private readonly failedCheck = new Set<string>();
  private allowed: boolean;

  constructor(private readonly options: TaskTaggerOptions) {
    this.allowed = options.models.allowsUse("tags");
    if (this.allowed && options.settings.getTagAutoSince() === null)
      options.settings.setTagAutoSince(options.now());
  }

  /**
   * A committed task change: a task filed, moved to another project or
   * given new words may owe a request. Every other change owes nothing new.
   */
  heard(change: TaskChange): void {
    if (
      change.reset ||
      change.events.some(
        (event) =>
          event.kind === "created" ||
          event.kind === "moved" ||
          (event.kind === "note" &&
            typeof event.data?.changes === "object" &&
            event.data.changes !== null &&
            ("title" in event.data.changes || "goal" in event.data.changes)),
      )
    )
      this.wake();
  }

  /**
   * The use's switch or the answering model moved. Turned off, the request
   * in flight is let go and the check under way stops, keeping what it did;
   * turned on, only tasks filed from now on are asked about.
   */
  useChanged(): void {
    const allowed = this.options.models.allowsUse("tags");
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    if (!allowed) {
      this.controller?.abort.abort();
      this.failedAuto.clear();
      this.endCheck(false);
      return;
    }
    this.options.settings.setTagAutoSince(this.options.now());
    this.wake();
  }

  /** Ask once more about tasks whose request failed long enough ago. */
  retry(): void {
    if (this.failedAuto.size > 0) this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    this.again = true;
    if (this.busy) return;
    this.busy = true;
    // A pass that throws, such as a record read failing, waits for the next
    // wake instead of leaving a rejection nobody hears.
    this.running = this.drain().catch((error: unknown) => {
      console.warn("[tags] a tagging pass failed", error);
    });
  }

  /** Resolves once the worker rests with nothing owed it can ask now. */
  idle(): Promise<void> {
    return this.busy && this.running ? this.running : Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.again && !this.stopped) {
        this.again = false;
        for (;;) {
          if (this.stopped || !this.options.models.allowsUse("tags")) break;
          const auto = this.nextAuto();
          if (auto) {
            await this.ask(auto, false);
            continue;
          }
          const check = this.nextCheck();
          if (!check) break;
          await this.ask(check, true);
        }
      }
    } finally {
      // Cleared in the same step that last read `again`, so a wake after
      // it starts a new pass instead of being lost to one that has ended.
      this.busy = false;
    }
  }

  private nextAuto(): TagWorkItem | undefined {
    const now = this.options.now();
    for (const [taskId, at] of this.failedAuto) if (at <= now) this.failedAuto.delete(taskId);
    const since = this.options.settings.getTagAutoSince() ?? now;
    const next = this.options.work.nextAuto(since, [...this.failedAuto.keys()]);
    // With nothing owed and no task waiting out a retry, every task filed
    // so far is judged, so the next read seeks only tasks filed from here
    // and its cost stays with the newest tasks, not the whole record. One
    // millisecond short of the newest task: a task filed later in that same
    // millisecond is still read.
    if (!next && this.failedAuto.size === 0) {
      const newest = this.options.work.newestFiled();
      if (newest !== null && newest - 1 > since) this.options.settings.setTagAutoSince(newest - 1);
    }
    return next;
  }

  private nextCheck(): TagWorkItem | undefined {
    const saved = this.options.settings.getTagCheck();
    if (!saved) return undefined;
    const next = this.options.work.nextCheck(scopeOf(saved), [...this.failedCheck]);
    if (!next) this.endCheck(true);
    return next;
  }

  /** One request about one task, and its answers recorded. */
  private async ask(item: TagWorkItem, check: boolean): Promise<void> {
    const failed = () =>
      check
        ? this.failedCheck.add(item.taskId)
        : this.failedAuto.set(item.taskId, this.options.now() + TAG_RETRY_MS);
    const task = this.options.tasks.get(item.taskId);
    const tags = item.tagIds.flatMap((id) => {
      const tag = this.options.tasks.projects.tags.get(id);
      return tag && tag.projectId === task?.projectId ? [tag] : [];
    });
    if (!task || tags.length === 0) {
      failed();
      return;
    }
    const { questions, ids } = tagQuestions(tags);
    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    const parent = task.parentId ? this.options.tasks.get(task.parentId) : undefined;
    const state = tagState({
      project: this.options.tasks.projects.get(task.projectId)?.name,
      title: task.title,
      goal: goalOf(task),
      userWords: task.intent?.userWords,
      parentTitle: parent?.title,
    });
    const asked = wordsOf(task);
    const abort = new AbortController();
    this.controller = { abort, check };
    let answers: Record<string, DecisionAnswer>;
    try {
      answers = await this.options.models.decide(
        { purpose: "task-tags", use: "tags", taskId: task.id, together: true },
        state,
        questions,
        abort.signal,
      );
    } finally {
      this.controller = undefined;
    }
    if (abort.signal.aborted || this.stopped) return;
    // Answers about words or a project the task no longer has are dropped
    // unrecorded and not counted as a failure: the record still owes the
    // task, so the next read asks about what it holds now.
    const current = this.options.tasks.get(task.id);
    if (!current || wordsOf(current) !== asked) return;
    const judgments: TagJudgment[] = [];
    let missed = false;
    for (const [key, name] of Object.entries(ids)) {
      const tag = byName.get(name);
      const answer = answers[key];
      if (!tag) continue;
      if (!answer || answer.outcome === "failed") {
        missed = true;
        continue;
      }
      const value =
        answer.outcome === "answered" && ANSWERS.has(answer.value)
          ? (answer.value as "yes" | "no")
          : "unsure";
      judgments.push({ tagId: tag.id, revision: tag.revision, answer: value });
    }
    const kept = judgments.length > 0 ? this.options.tasks.judgeTags(task.id, judgments).kept : 0;
    // A tag left owed - no answer, or an answer dropped because its tag's
    // description changed meanwhile - waits out the retry, so the worker
    // never asks the same task again at once and loops.
    if (missed || kept < judgments.length) failed();
  }

  /** Each project with tags, or the one asked for, as its Tags group draws it. */
  views(read?: TagCheckRead): TagCheckView[] {
    const projects = read
      ? [this.options.tasks.projects.get(read.projectId)].filter((project) => project !== undefined)
      : this.options.tasks.projects
          .list()
          .filter(
            (project) =>
              project.archivedAt === null &&
              this.options.tasks.projects.tags.of(project.id).length > 0,
          );
    return projects.map((project) => this.view(project.id, read?.tagIds ?? null));
  }

  private view(projectId: string, tagIds: readonly string[] | null): TagCheckView {
    const at = this.options.now();
    const saved = this.options.settings.getTagCheck();
    const count = (reach: SavedTagCheck["reach"]) =>
      this.options.work.remaining({ projectId, reach, tagIds, at });
    const elsewhere =
      saved && saved.projectId !== projectId
        ? this.options.tasks.projects.get(saved.projectId)?.name
        : undefined;
    return {
      projectId,
      auto: this.options.models.allowsUse("tags"),
      answerer: this.options.models.answererName(),
      reaches: { open: count("open"), week: count("week"), all: count("all") },
      ...(saved?.projectId === projectId
        ? {
            running: {
              reach: saved.reach,
              ...(saved.tagIds ? { tagIds: saved.tagIds } : {}),
              total: saved.total,
              done: Math.max(0, saved.total - this.options.work.remaining(scopeOf(saved))),
            },
          }
        : {}),
      ...(elsewhere ? { elsewhere } : {}),
    };
  }

  /**
   * What a Suggest tags press tells the first mate about a project
   * (docs/task-tags.md, "Suggesting tags"), or why the press sends nothing:
   * no such project, a removed one, or one that has a tag already.
   */
  suggestion(projectId: string): TagSuggestionFacts | TagSuggestionRefusal {
    const project = this.options.tasks.projects.get(projectId);
    if (!project) return "unknown";
    if (project.archivedAt !== null) return "removed";
    if (this.options.tasks.projects.tags.of(project.id).length > 0) return "tagged";
    const at = this.options.now();
    const count = (reach: TagCheckReach) => this.options.work.tasksIn(project.id, reach, at);
    return {
      projectId: project.id,
      key: project.key,
      name: project.name,
      reaches: { open: count("open"), week: count("week"), all: count("all") },
      auto: this.options.models.allowsUse("tags"),
      answerer: this.options.models.answererName(),
    };
  }

  /** Start or stop a project's check (`inf:projects:tag-check`). */
  change(change: TagCheckChange): TagCheckView {
    const project = this.options.tasks.projects.get(change.projectId);
    // i18n-exempt: a refusal served to the first mate; Settings offers only what it can start
    if (!project) throw new TagCheckRefusal(`There is no project ${change.projectId}.`);
    const saved = this.options.settings.getTagCheck();
    if (change.op === "stop") {
      if (saved?.projectId === project.id) this.endCheck(false);
      return this.view(project.id, null);
    }
    const tags = this.options.tasks.projects.tags.of(project.id);
    if (tags.length === 0)
      // i18n-exempt: a refusal served to the first mate; Settings offers no check without tags
      throw new TagCheckRefusal(`${project.name} has no tags to check.`);
    const unknown = (change.tagIds ?? []).filter((id) => !tags.some((tag) => tag.id === id));
    if (unknown.length > 0)
      // i18n-exempt: a refusal served to the first mate; Settings offers only the project's tags
      throw new TagCheckRefusal(`${project.name} has no tag ${unknown.join(", ")}.`);
    if (!this.options.models.allowsUse("tags"))
      throw new TagCheckRefusal(
        // i18n-exempt: a refusal served to the first mate; Settings offers no Start while the use is off
        "Tag tasks automatically is off in Settings → Intelligence, so nothing can be checked.",
      );
    if (saved && saved.projectId !== project.id) {
      const other = this.options.tasks.projects.get(saved.projectId)?.name ?? saved.projectId;
      // i18n-exempt: a refusal served to the first mate; Settings shows the other check instead of Start
      throw new TagCheckRefusal(`A check of ${other}'s tasks is under way; stop it first.`);
    }
    const scope: TagCheckScope = {
      projectId: project.id,
      reach: change.reach,
      tagIds: change.tagIds ?? null,
      at: this.options.now(),
    };
    this.failedCheck.clear();
    this.options.settings.setTagCheck({
      projectId: scope.projectId,
      reach: scope.reach,
      tagIds: change.tagIds ?? null,
      at: scope.at,
      total: this.options.work.remaining(scope),
    });
    this.wake();
    return this.view(project.id, null);
  }

  /**
   * The check is over: finished, with one Activity line saying how many
   * tasks it asked about, or stopped, keeping every answer it recorded.
   */
  private endCheck(finished: boolean): void {
    const saved = this.options.settings.getTagCheck();
    if (!saved) return;
    if (this.controller?.check) this.controller.abort.abort();
    this.options.settings.setTagCheck(null);
    const missed = this.failedCheck.size;
    this.failedCheck.clear();
    if (!finished) return;
    const project = this.options.tasks.projects.get(saved.projectId)?.name ?? saved.projectId;
    const asked = Math.max(0, saved.total - missed);
    this.options.activity(
      missed === 0
        ? said("feedTagCheckFinished", { project, count: asked })
        : said("feedTagCheckFinishedMissed", { project, count: asked, missed: String(missed) }),
    );
  }

  dispose(): void {
    this.stopped = true;
    this.controller?.abort.abort();
  }
}

function scopeOf(saved: SavedTagCheck): TagCheckScope {
  return { projectId: saved.projectId, reach: saved.reach, tagIds: saved.tagIds, at: saved.at };
}

type TaskRecord = NonNullable<ReturnType<TaskService["get"]>>;

function goalOf(task: TaskRecord): string {
  return task.goal ?? task.intent?.goal ?? "";
}

/** What a task's answers were about: its project and its words. */
function wordsOf(task: TaskRecord): string {
  return JSON.stringify([task.projectId, task.title, goalOf(task)]);
}

/**
 * The app's one tagger: it hears every committed task change, every move
 * of the use's switch, and the ticker's minute for failed requests' retry.
 */
export function startTaskTagger(input: {
  db: AppDatabase;
  tasks: TaskService;
  models: DecisionModels;
  settings: SettingsStore;
  ticker: Ticker;
  broadcastEvent: (event: FmEvent) => void;
}): { tagger: TaskTagger; stop: () => void } {
  const tagger = new TaskTagger({
    tasks: input.tasks,
    work: new TagWork(input.db),
    models: input.models,
    settings: input.settings,
    now: input.ticker.now,
    activity: (line) => input.broadcastEvent({ type: "firstmate_note", ...saidLine(line) }),
  });
  const stops = [
    input.tasks.onChange((change) => tagger.heard(change)),
    input.settings.onDecisionsChanged(() => tagger.useChanged()),
  ];
  input.ticker.register("task-tags", TICK_PERIOD_MS, () => tagger.retry());
  tagger.wake();
  return {
    tagger,
    stop: () => {
      for (const stop of stops) stop();
      tagger.dispose();
    },
  };
}
