import { createHash } from "node:crypto";
import { HERE } from "@shared/deviceNames";
import {
  type DownloadArtifactInput,
  type Forge,
  ForgeError,
  type ForgeRepo,
  type ReadWorkflowInput,
  type WorkflowArtifact,
  type WorkflowJobLine,
  type WorkflowJobList,
  type WorkflowRun,
} from "../forge";
import { WORKFLOW_ARTIFACT_MAX_BYTES } from "../forge/workflows";
import { isUnder, packedBytes, type ZipEntry, zipEntries, zipOf } from "../forge/zipParts";
import { TaskService } from "../tasks/taskService";
import { ArtifactFolderError, writeArtifact } from "../workspace/artifacts";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  failedRunJobs,
  RUN_WATCH_LIMIT,
  RUN_WATCH_TICK_MS,
  type RunReading,
  recordRunChecks,
  recordRunFailures,
  runFinished,
} from "./runWatch";

/**
 * Writes an artifact, or a selection of its files (`part`), into the
 * working copy of a task that runs on another computer, there
 * (`PlacedCopies.writeArtifact`, docs/helper.md "Its working copies");
 * throws `EEXIST` when a file is already there. Answers the path there.
 */
export type ArtifactElsewhere = (
  taskId: string,
  deviceId: string,
  artifact: { runId: number; artifactId: number; bytes: Uint8Array; part?: string },
) => Promise<string>;

/** The short read stops naming jobs past this, and says how many it left out. */
const SHORT_READ_MAX_CHARS = 20_000;

/** Task-scoped, read-only host evidence. It never changes CI state or spends a repair. */
export class WorkflowEvidenceService {
  constructor(
    private readonly options: {
      tasks: TaskService;
      repos: RepoRegistry;
      forgeFor: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
      /** A task on a computer that runs work keeps its working copy there. */
      writeElsewhere?: ArtifactElsewhere;
      /** Whether that computer writes a selection of an artifact's files (`artifact-parts`). */
      partsElsewhere?: (deviceId: string) => boolean;
      now?: () => number;
    },
  ) {}

  /**
   * A run's short read when no job is named, otherwise one job's log lines.
   * github_read still lists runs by version; this read lists that run's jobs.
   */
  async read(taskId: string, input: ReadWorkflowInput): Promise<string> {
    return this.answer(async () => {
      const { workflows } = this.context(taskId);
      const runId = integer(input.runId, "runId");
      if (input.jobId === undefined) {
        const run = await workflows.run(runId);
        const list = await workflows.jobs(runId);
        return `${formatShortRunRead(run, list)}\n${this.observe(taskId, { run, list })}`;
      }
      const jobId = integer(input.jobId, "jobId");
      const offset = integer(input.offset ?? 1, "offset");
      const limit = integer(input.limit ?? 200, "limit", 1, 500);
      const run = await workflows.run(runId);
      const { job, text } = await workflows.jobLog(runId, jobId);
      const lines = text.split(/\r?\n/);
      const selected: string[] = [];
      let chars = 0;
      let clipped = false;
      for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
        const bounded = line.slice(0, 2000);
        if (chars + bounded.length > 20_000) break;
        selected.push(bounded);
        chars += bounded.length;
        clipped ||= bounded.length !== line.length;
      }
      const nextOffset =
        offset - 1 + selected.length < lines.length ? offset + selected.length : null;
      return JSON.stringify(
        {
          run,
          job,
          offset,
          nextOffset,
          totalLines: lines.length,
          longLinesClipped: clipped,
          lines: selected,
        },
        null,
        2,
      );
    });
  }

  /** The supervisor reads through the same project/sign-in context, without gateway calls or CI facts. */
  async readWatched(taskId: string, runId: number): Promise<RunReading> {
    const { workflows } = this.context(taskId);
    return { run: await workflows.run(runId), list: await workflows.jobs(runId) };
  }

  /** An accepted start has an exact run number; arm before the host queues its new attempt. */
  watchStarted(taskId: string, runId: number): string {
    integer(runId, "runId");
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return "The task is closed; no watch was started.";
    const watches = task.delivery?.runWatches ?? [];
    const existing = watches.find((w) => w.runId === runId);
    if (!existing && watches.length >= RUN_WATCH_LIMIT)
      return "The task already watches 5 runs; this run is not watched. No wake will come for it. Read it with read_workflow once a slot is free.";
    const now = (this.options.now ?? Date.now)();
    const watch = existing ?? {
      runId,
      name: `Run ${runId}`,
      attempt: 1,
      since: now,
      nextAt: now + RUN_WATCH_TICK_MS,
      failureSeen: false,
    };
    if (!existing) {
      this.options.tasks.recordChangeEvidence(taskId, { runWatches: [...watches, watch] });
      this.options.tasks.note(taskId, `Started watching ${watch.name} (run ${runId}).`, {
        news: false,
      });
    }
    return `The app watches run ${runId} every minute for up to 3 hours, and wakes you once on its first failed job and once when it ends. End your turn and wait; never sleep or loop on reads.`;
  }

  private observe(taskId: string, { run, list }: RunReading): string {
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return "The task is closed; no watch was started.";
    recordRunFailures(this.options.tasks, taskId, { run, list });
    const watches = task.delivery?.runWatches ?? [];
    const existing = watches.find((w) => w.runId === run.id);
    const now = (this.options.now ?? Date.now)();
    if (runFinished(run)) {
      if (existing) {
        recordRunChecks(this.options.tasks, taskId, run, now);
        this.options.tasks.recordChangeEvidence(taskId, {
          runWatches: watches.filter((w) => w.runId !== run.id),
        });
        this.options.tasks.note(
          taskId,
          `Stopped watching ${run.name} (run ${run.id}): the crewmate read its outcome.`,
          { news: false },
        );
      }
      return "The run has ended; no wake will come for this reading.";
    }
    if (!existing && watches.length >= RUN_WATCH_LIMIT) {
      return "The task already watches 5 runs; this run is not watched. No wake will come for it until a slot is free and you read it again.";
    }
    recordRunChecks(this.options.tasks, taskId, run, now);
    const watch = {
      ...(existing ?? { since: now }),
      runId: run.id,
      name: run.name,
      attempt: run.attempt,
      nextAt: now + RUN_WATCH_TICK_MS,
      // A crewmate reading the failure itself already knows: suppress that early wake only.
      failureSeen: existing?.failureSeen === true || failedRunJobs(list).length > 0,
    };
    this.options.tasks.recordChangeEvidence(taskId, {
      runWatches: [...watches.filter((w) => w.runId !== run.id), watch],
    });
    if (!existing)
      this.options.tasks.note(taskId, `Started watching ${run.name} (run ${run.id}).`, {
        news: false,
      });
    return "The app watches this run every minute for up to 3 hours, and wakes you once on its first failed job and once when it ends. A failure you already read sends no early wake. End your turn and wait; never sleep or loop on reads.";
  }

  async download(taskId: string, input: DownloadArtifactInput): Promise<string> {
    return this.answer(async () => {
      const { workflows, cwd, deviceId } = this.context(taskId);
      const runId = integer(input.runId, "runId");
      const artifactId = integer(input.artifactId, "artifactId");
      const paths = input.files === undefined ? undefined : selection(input.files);
      if (input.list || paths) {
        if (!input.list && deviceId && !this.options.partsElsewhere?.(deviceId))
          throw new ForgeError(
            "unsupported",
            "The computer this task runs on needs an update before it can save selected files. Nothing was downloaded.",
          );
        if (!workflows.archive)
          throw new ForgeError(
            "unsupported",
            "This project's host cannot list an artifact's files or save selected ones.",
          );
        const run = await workflows.run(runId);
        const { artifact, archive } = await workflows.archive(runId, artifactId);
        const entries = await zipEntries(archive, WORKFLOW_ARTIFACT_MAX_BYTES);
        if (input.list) {
          const offset = integer(input.offset ?? 1, "offset");
          return formatListing(run, artifact, archive.size, entries, paths, offset);
        }
        const chosen = entries.filter((entry) => paths?.some((path) => isUnder(entry.name, path)));
        if (chosen.length === 0)
          throw new ForgeError(
            "not-found",
            "None of the named files is in the artifact; list it with list true to see its paths.",
          );
        const bytes = await zipOf(archive, chosen, WORKFLOW_ARTIFACT_MAX_BYTES);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const part = sha256.slice(0, 12);
        const path = await this.write(taskId, cwd, deviceId, { runId, artifactId, bytes, part });
        return JSON.stringify(
          {
            run,
            artifact,
            path,
            bytes: bytes.byteLength,
            sha256,
            extracted: false,
            selected: {
              files: chosen.filter((entry) => !entry.name.endsWith("/")).length,
              size: chosen.reduce((sum, entry) => sum + entry.size, 0),
              paths: (paths ?? []).map((path) => ({
                path,
                files: chosen.filter(
                  (entry) => !entry.name.endsWith("/") && isUnder(entry.name, path),
                ).length,
              })),
            },
          },
          null,
          2,
        );
      }
      const run = await workflows.run(runId);
      const { artifact, bytes } = await workflows.download(runId, artifactId);
      const relativePath = await this.write(taskId, cwd, deviceId, { runId, artifactId, bytes });
      return JSON.stringify(
        {
          run,
          artifact,
          path: relativePath,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          extracted: false,
        },
        null,
        2,
      );
    });
  }

  /** Writes the archive, or a selection of it, into the task's working copy, wherever that is. */
  private async write(
    taskId: string,
    cwd: string | null | undefined,
    deviceId: string | undefined,
    artifact: { runId: number; artifactId: number; bytes: Uint8Array; part?: string },
  ): Promise<string> {
    try {
      if (deviceId) return await this.elsewhere(taskId, deviceId, artifact);
      return await writeArtifact(
        cwd as string,
        artifact.runId,
        artifact.artifactId,
        artifact.bytes,
        artifact.part,
      );
    } catch (caught) {
      if (caught instanceof ArtifactFolderError) throw new ForgeError("refused", caught.message);
      throw caught;
    }
  }

  /**
   * The task's forge and where its working copy is: this Mac's folder, or
   * the computer that runs work holding it there, when its record names one
   * (docs/helper.md, "Its working copies"); the forge is the project's
   * either way.
   */
  private context(taskId: string) {
    const task = this.options.tasks.get(taskId);
    if (!task) throw new ForgeError("not-found", "The task is no longer available.");
    const repo = task.repoId ? this.options.repos.get(task.repoId) : undefined;
    if (!repo) throw new ForgeError("not-found", "The task's project is no longer registered.");
    const deviceId = task.deviceId ?? undefined;
    if (!task.worktreeDir && !deviceId)
      throw new ForgeError("refused", "The task has no working copy for workflow evidence.");
    const forge = this.options.forgeFor(repo, task.worktreeDir || repo.path);
    if (!forge.workflows)
      throw new ForgeError(
        "unsupported",
        "This project's host has no workflow log or artifact reader.",
      );
    return { workflows: forge.workflows, cwd: task.worktreeDir, deviceId };
  }

  private elsewhere(
    taskId: string,
    deviceId: string,
    artifact: { runId: number; artifactId: number; bytes: Uint8Array; part?: string },
  ): Promise<string> {
    const write = this.options.writeElsewhere;
    if (!write)
      throw new ForgeError(
        "unsupported",
        `${HERE.This} cannot reach the computer this task runs on.`,
      );
    return write(taskId, deviceId, artifact);
  }

  private async answer(run: () => Promise<string>): Promise<string> {
    try {
      return await run();
    } catch (caught) {
      if (caught instanceof ForgeError)
        return `Cannot read workflow evidence (${caught.failure}): ${caught.message}`;
      if ((caught as NodeJS.ErrnoException).code === "EEXIST")
        return "Cannot download artifact: the destination already exists; it was not overwritten.";
      // File/fetch errors are not a channel for sign-in material or signed URLs.
      return "Cannot read workflow evidence: the working copy or download is unavailable.";
    }
  }
}

/** The paths a selection names, each a path inside the archive. */
function selection(files: unknown): string[] {
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => typeof file !== "string" || file.length === 0)
  )
    throw new ForgeError("refused", "files must name at least one path inside the archive.");
  return [...new Set(files as string[])];
}

/**
 * The archive's files by path, from `offset`, as many as the answer holds:
 * a header naming the artifact and how many files there are, one line per
 * file with what saving it reads and its unpacked size, then where the next
 * page starts. Folders' own entries are left out; a selection takes them
 * with their files.
 */
function formatListing(
  run: WorkflowRun,
  artifact: WorkflowArtifact,
  archiveBytes: number,
  entries: ZipEntry[],
  paths: string[] | undefined,
  offset: number,
): string {
  const files = entries
    .filter((entry) => !entry.name.endsWith("/"))
    .filter((entry) => !paths || paths.some((path) => isUnder(entry.name, path)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const header = [
    `${artifact.name} (artifact ${artifact.id}) from ${run.name} run ${run.id}, version ${run.headSha}`,
    `archive: ${archiveBytes} bytes; files${paths ? " under the named paths" : ""}: ${files.length}, ${packedBytes(files)} bytes packed`,
    "each line: packed bytes (what saving it reads), unpacked bytes, path",
  ];
  const room = SHORT_READ_MAX_CHARS - header.join("\n").length - 40;
  const lines: string[] = [];
  let used = 0;
  for (const entry of files.slice(offset - 1)) {
    const line = `${entry.end - entry.start} ${entry.size} ${oneLine(entry.name)}`;
    if (lines.length > 0 && used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  const next = offset - 1 + lines.length;
  const shown =
    lines.length === 0 ? `no files from ${offset}` : `files ${offset}-${next} of ${files.length}`;
  return [
    ...header,
    shown,
    ...lines,
    ...(next < files.length ? [`nextOffset: ${next + 1}`] : []),
  ].join("\n");
}

/** The run's name, state, version, link and attempt, then one line per job. */
function formatShortRunRead(run: WorkflowRun, list: WorkflowJobList): string {
  const header = [
    run.name,
    `state: ${stateOf(run.status, run.conclusion)}`,
    `version: ${run.headSha}`,
    `attempt: ${run.attempt}`,
    `link: ${run.url}`,
  ];
  const room = SHORT_READ_MAX_CHARS - header.join("\n").length - 1;
  const lines: string[] = [];
  let used = 0;
  for (const job of list.jobs) {
    const line = jobLine(job);
    if (lines.length > 0 && used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [...header, jobsHeader(list, lines.length), ...lines].join("\n");
}

function jobsHeader(list: WorkflowJobList, shown: number): string {
  const known = list.total ?? list.jobs.length;
  const leftOut = known - shown;
  const unknownMore = list.total === null && !list.complete;
  if (leftOut > 0 && unknownMore) return `jobs: ${shown} shown, at least ${leftOut} left out`;
  if (leftOut > 0) return `jobs: ${shown} shown, ${leftOut} left out`;
  if (unknownMore) return `jobs: ${shown} shown, more left out`;
  return `jobs: ${list.jobs.length}`;
}

function jobLine(job: WorkflowJobLine): string {
  const where = job.failedAt ? ` — failed at "${quoted(job.failedAt)}"` : "";
  return `${job.id} ${oneLine(job.name)} — ${stateOf(job.status, job.conclusion)}${where}`;
}

function stateOf(status: string, conclusion: string | null): string {
  if (!conclusion || conclusion === status) return status;
  return `${status}, ${conclusion}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoted(value: string): string {
  return oneLine(value).replace(/"/g, "'").slice(0, 120);
}

function integer(
  value: number | undefined,
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ForgeError("refused", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
