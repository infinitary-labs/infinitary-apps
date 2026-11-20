import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { speaksInfinitaryNames } from "@shared/contractFeatures";
import { preparedPublicationRemote } from "@shared/contributions";
import { HERE } from "@shared/deviceNames";
import { computerForgeName } from "@shared/deviceSetup";
import type { FmEvent } from "@shared/events";
import { forgeOf } from "@shared/forge";
import type { AwayCopy } from "@shared/placement";
import {
  type BundledRef,
  PLACED_COPY_CHUNK_BYTES,
  type ReadableRef,
  SOURCE_REF_FROM,
  type WorkingCopyBase,
  type WorkOrderChannel,
  type WorkOrderResponse,
  workOrders,
} from "@shared/work";
import { DeviceOutOfReachError } from "../connection/connection";
import { ComputerBehindError, contractChange, listsChange } from "../connection/contractChanges";
import { type AppPaths, crewmatePlacedDir } from "../paths";
import { TaskService } from "../tasks/taskService";
import { ARTIFACTS_FOLDER, artifactPath, OLDER_ARTIFACTS_FOLDER } from "../workspace/artifacts";
import { bundleRef, commitOf, sha256Of, takeBundle } from "../workspace/bundles";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { git } from "../workspace/git";
import { defaultTaskBranch } from "../workspace/taskBranches";
import {
  awayCopyRefFor,
  checkedOutRefFor,
  type DependencyInstall,
  KEPT_REF_PREFIX,
  type KeptWork,
  keptRefFor,
  keptRefsFor,
  keptWorkWords,
  OLDER_KEPT_REF_PREFIX,
  sourceRefFor,
  type WorktreeAcquisition,
} from "../workspace/workspaceService";
import { sendSourceFile } from "./sourceFiles";
import type { WorkDevices } from "./workDevices";

/**
 * The home's side of a task's working copy on a computer that runs work
 * (docs/helper.md, "Its working copies"): it asks that computer to make
 * one, install it and say what it holds, brings the task's branch here
 * before this Mac's own git reads it, writes a downloaded artifact into it
 * there, and, once the task closes, takes its kept work here before that
 * computer deletes it; a working copy there whose task this Mac no longer
 * records goes by the rule this Mac's own leftover working copies follow
 * (`retireLeftover`). Everything that crosses goes over the connection
 * (`WorkDevices`), and the work itself as a git bundle, never through where
 * the project lives.
 */

/** A task's working copy on that computer, as the supervisor starts it. */
export type PlacedCopy = {
  /** Its folder there, which the crewmate runs in. */
  cwd: string;
  branch: string;
  /** How that computer got it, absent when it was already there. */
  acquired?: WorktreeAcquisition;
};

export type PlacedCopiesOptions = {
  tasks: TaskService;
  devices: WorkDevices;
  paths: AppPaths;
  /** The home's repository for a task: its project's, or this Mac's own local workspace. */
  homeRepo: (repoId: string | null) => Promise<string | undefined>;
  /**
   * Fetches the repository's default branch from where the project lives,
   * bounded and never prompting (`WorkspaceService.dispatchBase`); absent,
   * nothing is fetched.
   */
  refreshDefaultBranch?: (repoDir: string) => Promise<unknown>;
  /**
   * The project's folder here is missing as a task's branch would come into
   * it: the words refusing it, naming the folder and its repair (INF-572).
   */
  folderMissing?: (repoId: string, taskId: string) => string;
  /** A project's saved address where it lives, cloned from while its folder here is missing. */
  projectOrigin?: (repoId: string) => string | null | undefined;
  /** Every project's id, to find the one a leftover working copy there was cloned from. */
  projects: () => readonly string[];
  /** A paired computer's name, as Devices lists it. */
  deviceName: (deviceId: string) => string;
  /** A project's name, by its id. */
  projectName: (repoId: string) => string | undefined;
  broadcastEvent: (event: FmEvent) => void;
  now: () => number;
  log: (line: string) => void;
  /**
   * Closes the task's conversation there for good, with what the home knows
   * of it and its report noted on the task's timeline
   * (`PlacedSessions.closeThere`); a move names its own order.
   */
  closeThere: (deviceId: string, taskId: string, orderId?: string) => Promise<unknown>;
  /** A copy a task left on a computer it moved off while out of reach is kept now (`keepAwayCopy`). */
  awayCopyKept?: (taskId: string) => void;
  /**
   * Brings home what the task's conversation record there holds past this
   * Mac's copy (`PlacedSessions.copyRecordThere`), before its folder there goes.
   */
  copyRecordThere: (deviceId: string, taskId: string) => Promise<void>;
};

/** The most commits the home names as ones it has when it asks for a bundle. */
const HAVE_MAX = 64;

const FOLLOWS_PROJECT_ADDRESS = contractChange("placed-project-address");

export class PreparationUnknown extends Error {}
export class PreparationFailed extends Error {}

export class PlacedCopies {
  /** One bring-home or retirement per task at a time, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private stopping = false;
  /** Tasks whose working copy there is retired, so a second retirement says nothing twice. */
  private readonly retiredThere = new Set<string>();
  /** Leftover working copies the feed said stay there, by computer and task: said once. */
  private readonly saidLeftover = new Set<string>();

  constructor(private readonly options: PlacedCopiesOptions) {}

  /**
   * Asks the computer for the task's working copy: the project cloned there
   * once from where it lives, then a working copy on the task's branch. The
   * feed says when it cloned the project.
   */
  async prepare(
    deviceId: string,
    taskId: string,
    repoId: string | null,
    base?: WorkingCopyBase,
    named?: string,
  ): Promise<PlacedCopy> {
    const name = this.options.deviceName(deviceId);
    const committed = this.options.tasks.get(taskId)?.placement?.snapshot;
    const delivery = this.options.tasks.get(taskId)?.delivery;
    const project: { origin: string; name: string; pushOrigin?: string } | undefined =
      delivery?.publicationOrigin && !base
        ? {
            origin: delivery.publicationOrigin,
            pushOrigin: delivery.publicationPushOrigin,
            name: this.options.projectName(repoId ?? "") ?? "the project",
          }
        : repoId && !base
          ? await this.originOf(repoId)
          : undefined;
    const moved = committed?.origin && project && committed.origin !== project.origin;
    const orderId = committed?.orderId ?? `prepare:${taskId}:${this.options.now()}`;
    // A preparation receipt for the former address must not answer this request.
    const routeOrder = moved
      ? `${orderId}:origin:${createHash("sha256").update(project.origin).digest("hex")}`
      : orderId;
    if (moved && !this.followsProjectAddress(deviceId))
      throw new PreparationFailed(
        `${name} must be updated before this task can follow the project's new address.`,
      );
    // A separate push address goes only to a computer on this home's major.
    if (project?.pushOrigin && !this.options.devices.takesCurrentWork(deviceId))
      throw new PreparationFailed(
        `${name} must be updated before it can push contributions through your fork.`,
      );
    // A projectless builder starts from the home's workspace. Its reviewer
    // already has the builder's repository there, so sends no seed.
    const seed = repoId || base ? undefined : await this.seed(deviceId, taskId);
    // The name the task's record holds, else the one this start chose; a
    // computer from before names were sent makes `fm/task-<id>`, and the
    // answer's branch is saved (docs/architecture.md, "A task's branch").
    const branch = this.options.tasks.get(taskId)?.branch || named || undefined;
    let answer: WorkOrderResponse<"inf:working-copy:prepare">;
    try {
      answer = await this.ask(deviceId, "inf:working-copy:prepare", [
        {
          orderId: routeOrder,
          task: taskId,
          ...(project
            ? {
                project: {
                  origin: project.origin,
                  ...(project.pushOrigin ? { pushOrigin: project.pushOrigin } : {}),
                },
              }
            : {}),
          ...(base ? { base } : {}),
          ...(seed ? { seed } : {}),
          ...(branch ? { branch } : {}),
        },
      ]);
    } catch (caught) {
      throw new PreparationUnknown(
        `${name} could not confirm this task's working copy: ${messageOf(caught)}`,
        { cause: caught },
      );
    }
    // The host where the project lives wants that computer's own sign-in:
    // the refusal stays typed, so the task waits for the sign-in there and
    // starts by itself once the computer reports it (docs/forge.md, "A
    // computer's own sign-in").
    if ("refused" in answer && answer.refused === "preparation-unknown")
      throw new PreparationUnknown();
    if ("refused" in answer && answer.refused === "preparation-failed") {
      if (committed)
        this.options.tasks.placement.releasePlacement(taskId, committed.orderId, "ended");
      throw new PreparationFailed(answer.message);
    }
    if ("refused" in answer) {
      if (committed)
        this.options.tasks.placement.releasePlacement(taskId, committed.orderId, "ended");
      // The host the computer named, so the task waits behind that host's
      // own gate and card, and its sign-in there releases it.
      throw new ForgeAuthRequiredError(
        `${answer.name} requires ${name}'s own sign-in to fetch this project.`,
        answer.host,
        computerForgeName(answer.host),
      );
    }
    if (base && answer.headSha !== base.headSha)
      throw new Error(
        `${name} did not prepare the assigned commit. Update Infinitary there before reviewing.`,
      );
    if (answer.cloned && project) {
      const signIn = answer.signedIn
        ? forgeOf(project.origin).kind === "github"
          ? " with its own GitHub sign-in"
          : " with its own sign-in"
        : "";
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${name} cloned ${project.name}${signIn}.`,
      });
    }
    return {
      cwd: answer.dir,
      branch: answer.branch,
      ...(answer.acquired ? { acquired: answer.acquired } : {}),
    };
  }

  /** Refresh an existing ordinary copy before a new turn, not a turn already running. */
  async followProject(
    deviceId: string,
    taskId: string,
    lastOrigin?: string,
  ): Promise<string | undefined> {
    const record = this.options.tasks.get(taskId);
    if (
      !record?.repoId ||
      record.deviceId !== deviceId ||
      !record.branch ||
      record.shape?.kind === "review" ||
      record.delivery?.publicationOrigin
    )
      return undefined;
    const origin = this.options.projectOrigin?.(record.repoId);
    if (!origin || origin === lastOrigin) return origin ?? undefined;
    // Not connected says nothing of its version: the order waits for it to
    // be back, as any order does (`DeviceOutOfReachError`). Connected without
    // the change, it must be updated first.
    if (!this.options.devices.version(deviceId)) throw new DeviceOutOfReachError();
    if (!this.followsProjectAddress(deviceId))
      throw new ComputerBehindError(
        `${this.options.deviceName(deviceId)} must be updated before it can verify this working copy's project address.`,
        deviceId,
        FOLLOWS_PROJECT_ADDRESS,
      );
    const answer = await this.ask(deviceId, "inf:working-copy:prepare", [
      {
        task: taskId,
        orderId: `follow-project:${randomUUID()}`,
        project: { origin: withoutSignIn(origin) },
        branch: record.branch,
      },
    ]);
    if ("refused" in answer)
      throw new Error("The working copy could not follow the project's approved address.");
    return origin;
  }

  private followsProjectAddress(deviceId: string): boolean {
    return listsChange(this.options.devices.version(deviceId)?.changes, FOLLOWS_PROJECT_ADDRESS);
  }

  /** Reads on the selected computer; never falls back to a stale branch at home. */
  async revision(
    deviceId: string,
    taskId: string,
    headSha?: string,
    builtOn?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">> {
    return this.ask(deviceId, "inf:working-copy:revision", [
      { task: taskId, ...(headSha ? { headSha } : {}), ...(builtOn ? { builtOn } : {}) },
    ]);
  }

  /**
   * Sends this Mac's default workspace to that computer, as a bundle of only
   * the commits it lacks, in pieces, and answers the commit it now holds
   * for the task to start from (`inf:working-copy:seed`). Throws when it
   * does not arrive whole.
   */
  private async seed(deviceId: string, taskId: string): Promise<string> {
    const name = this.options.deviceName(deviceId);
    try {
      const repoDir = await this.options.homeRepo(null);
      const sha = repoDir ? await commitOf(repoDir, "HEAD") : null;
      if (!repoDir || !sha) throw new Error(`${HERE.This} has no workspace to send.`);
      const asked = await this.ask(deviceId, "inf:working-copy:seed", [{ task: taskId, sha }]);
      if (asked.outcome === "have") return sha;
      const dir = crewmatePlacedDir(this.options.paths, taskId);
      const file = join(dir, "seed.bundle");
      try {
        const made = await bundleRef(repoDir, "HEAD", asked.have ?? [], file);
        if (!made.bundle || made.sha !== sha)
          throw new Error("The workspace could not be bundled.");
        const bytes = Buffer.alloc(PLACED_COPY_CHUNK_BYTES);
        const fd = openSync(file, "r");
        try {
          let offset = 0;
          while (offset < made.bundle.size) {
            const read = readSync(fd, bytes, 0, bytes.length, offset);
            if (read === 0) throw new Error("The bundle changed while it was being sent.");
            const sent = await this.ask(deviceId, "inf:working-copy:seed", [
              {
                task: taskId,
                sha,
                piece: {
                  size: made.bundle.size,
                  sha256: made.bundle.sha256,
                  offset,
                  data: bytes.subarray(0, read).toString("base64"),
                },
              },
            ]);
            offset += read;
            if (sent.outcome === "ready") return sha;
          }
        } finally {
          closeSync(fd);
        }
        throw new Error("The workspace did not arrive whole.");
      } finally {
        await rm(file, { force: true });
      }
    } catch (caught) {
      throw new Error(`${name} could not take ${HERE.this}'s workspace: ${messageOf(caught)}`, {
        cause: caught,
      });
    }
  }

  /**
   * The commit the task's working copy there has checked out, which the
   * bundle of its starting work leaves out with everything before it, so
   * only the commits that computer lacks cross (INF-5142: a closed task's
   * two commits went with the project's whole history, 91 MB where under
   * 1 MB would do). That computer's new working copy starts from the
   * default branch it just fetched, so when this home lacks the commit, its
   * own default branch is fetched first. Nothing when that computer cannot
   * say, as one on an older contract cannot, or this home still lacks the
   * commit, as when the fetch failed: the whole history crosses as before.
   */
  private async heldThere(deviceId: string, taskId: string, repoDir: string): Promise<string[]> {
    const head = (await this.checkoutAt(deviceId, taskId).catch(() => null))?.head;
    if (!head) return [];
    if (!(await commitOf(repoDir, head)))
      await this.options.refreshDefaultBranch?.(repoDir).catch(() => undefined);
    return (await commitOf(repoDir, head)) ? [head] : [];
  }

  /** What the task's working copy there has checked out; null when none is there. */
  private async checkoutAt(
    deviceId: string,
    taskId: string,
  ): Promise<{ branch: string | null; head: string } | null> {
    const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
    return status.present ? (status.checkedOut ?? null) : null;
  }

  /** Transfer starting work over the paired connection, not through the project's host. */
  async sourceRef(
    deviceId: string,
    taskId: string,
    repoId: string | null,
    sourceId: string,
    ref: string,
  ): Promise<string> {
    const repoDir = await this.options.homeRepo(repoId);
    if (!repoDir) throw new Error("The source work has no repository here.");
    const named = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const infinitary = speaksInfinitaryNames(
      this.options.devices.version(deviceId)?.contract ?? "",
    );
    // A computer from before the rename takes kept work only under Firstmate
    // 3000's name, and any computer takes only a ref named in the order's
    // letters, so the bundle carries other work under a stand-in kept ref,
    // made here only for the bundle; any kept ref already there is left alone.
    const kept = infinitary ? KEPT_REF_PREFIX : OLDER_KEPT_REF_PREFIX;
    const standIn =
      !infinitary && named.startsWith(KEPT_REF_PREFIX)
        ? `${OLDER_KEPT_REF_PREFIX}for-older/${taskId}-${sourceId}`
        : SOURCE_REF_FROM.test(named)
          ? null
          : `${kept}for-transfer/${taskId}-${sourceId}`;
    const from = standIn ?? named;
    const name = `${sourceId}.bundle`;
    const file = join(crewmatePlacedDir(this.options.paths, taskId), name);
    try {
      if (standIn) await git(repoDir, ["update-ref", standIn, `${named}^{commit}`]);
      let made = await bundleRef(
        repoDir,
        from,
        await this.heldThere(deviceId, taskId, repoDir),
        file,
      );
      // That computer holds the commit already, but not the ref: the bundle
      // carries the one commit, leaving out its parents, so the ref is named.
      if (made.sha && !made.bundle) {
        const parents = await git(repoDir, ["rev-parse", `${made.sha}^@`]);
        made = await bundleRef(repoDir, from, parents.split("\n").filter(Boolean), file);
      }
      if (!made.sha || !made.bundle) throw new Error("The starting ref could not be bundled.");
      await sendSourceFile(this.options.devices, deviceId, taskId, name, file);
      const to = sourceRefFor(taskId, sourceId, infinitary);
      const answer = await this.ask(deviceId, "inf:working-copy:source-ref", [
        {
          task: taskId,
          name,
          from,
          to,
          sha: made.sha,
          ...made.bundle,
        },
      ]);
      if (answer.ref !== to) throw new Error("The starting ref was not acknowledged.");
      return to;
    } finally {
      await rm(file, { force: true });
      if (standIn) await git(repoDir, ["update-ref", "-d", standIn]).catch(() => {});
    }
  }

  /** The working copy's dependencies, installed there; a failure is an outcome, never thrown. */
  async install(deviceId: string, taskId: string): Promise<DependencyInstall> {
    try {
      return await this.ask(deviceId, "inf:working-copy:install", [
        { orderId: `install:${taskId}:${this.options.now()}`, task: taskId },
      ]);
    } catch (caught) {
      return { outcome: "failed", ms: 0, error: messageOf(caught) };
    }
  }

  /**
   * Whether the task's working copy there holds edits or commits that never
   * merged; null when its computer is out of reach, so nobody can tell.
   */
  async status(taskId: string): Promise<{ dirty: boolean; unlandedCommits: number } | null> {
    const deviceId = this.options.tasks.get(taskId)?.deviceId;
    if (!deviceId || !this.options.devices.inReach(deviceId)) return null;
    try {
      const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
      if (!status.present) return null;
      return { dirty: status.dirty, unlandedCommits: status.unlandedCommits };
    } catch {
      return null;
    }
  }

  /**
   * Brings the task's branch here from the computer it runs on, before this
   * Mac's own git reads it - to open, check or merge its change: only the
   * commits this Mac lacks cross, as a bundle, into `refs/heads/<branch>`
   * of the task's repository here. Answers that repository, where this
   * Mac's git reads the branch: the project's folder now, or this Mac's
   * default workspace for a task with no project. The record names that
   * folder too, including after this Mac's folder moved; the read uses the
   * project's folder as it stands, which can have moved again since the
   * task started. Out of reach, this Mac reads what it brought last.
   * Ordinary reads log failures; a source handoff passes `strict` to refuse
   * a stale or missing branch before briefing its successor.
   */
  bringBranchHome(taskId: string, strict = false, branch?: string): Promise<string | undefined> {
    return this.serial(taskId, async () => {
      const record = this.options.tasks.get(taskId);
      const deviceId = record?.deviceId;
      if (!record || !deviceId || !record.branch) {
        if (strict) throw new Error("The source task has no live branch.");
        return undefined;
      }
      if (!this.options.devices.inReach(deviceId)) {
        if (strict)
          throw new DeviceOutOfReachError("The source computer is out of reach.", { deviceId });
        return this.options.homeRepo(record.repoId ?? null).catch(() => undefined);
      }
      let repoDir: string | undefined;
      try {
        repoDir = await this.options.homeRepo(record.repoId ?? null);
        if (!repoDir) throw new Error("The source task has no repository here.");
        if (record.repoId && !existsSync(repoDir)) {
          throw new Error(
            this.options.folderMissing?.(record.repoId, taskId) ??
              `The project's folder ${repoDir} is missing.`,
          );
        }
        // Another branch the crewmate checked out there comes to the task's
        // own ref for it (INF-2490); the task's branch to its own name.
        const other = branch !== undefined && branch !== record.branch;
        if (other && !this.sendsCheckedOut(deviceId))
          throw new Error("That computer needs an update to send another branch.");
        const ref = other ? checkedOutRefFor(taskId) : `refs/heads/${record.branch}`;
        const sha = await this.take(
          deviceId,
          taskId,
          repoDir,
          "branch",
          ref,
          other ? branch : undefined,
        );
        if (strict && (!sha || (await commitOf(repoDir, ref)) !== sha))
          throw new Error("The source branch did not arrive at its current commit.");
        // What a move continues from if that computer is out of reach later
        // (docs/helper.md, "Moving a task off a computer that is out of reach").
        if (!other && sha && this.options.tasks.get(taskId)?.deviceId === deviceId)
          this.options.tasks.placement.recordHomeCopy(taskId, { sha, at: this.options.now() });
      } catch (caught) {
        if (strict) throw caught;
        this.options.log(`could not bring ${taskId}'s branch home: ${messageOf(caught)}`);
      }
      return repoDir;
    });
  }

  /**
   * What this Mac holds of a task's branch, read without its computer
   * (docs/helper.md, "Moving a task off a computer that is out of reach"):
   * the commit `refs/heads/<branch>` of the task's repository here points
   * at, and when it was brought here when the record says so. Undefined
   * when this Mac holds none of the task's commits.
   */
  async homeCopy(
    taskId: string,
  ): Promise<{ head: string; at?: number; branch: string; repoDir: string } | undefined> {
    const record = this.options.tasks.get(taskId);
    if (!record?.branch) return undefined;
    const repoDir = await this.options.homeRepo(record.repoId ?? null).catch(() => undefined);
    if (!repoDir || !existsSync(repoDir)) return undefined;
    const head = await commitOf(repoDir, `refs/heads/${record.branch}`);
    if (!head) return undefined;
    const known = record.shape?.home_copy;
    return {
      head,
      ...(known?.sha === head ? { at: known.at } : {}),
      branch: record.branch,
      repoDir,
    };
  }

  /**
   * The branch the task's working copy there has checked out, null when
   * detached, and the commit it points at (INF-2490): what a story is
   * prepared for, as this Mac's own working copy reads its checkout. Null
   * when that computer is out of reach or cannot say.
   */
  async checkoutThere(taskId: string): Promise<{ branch: string | null; head: string } | null> {
    const deviceId = this.options.tasks.get(taskId)?.deviceId;
    if (!deviceId || !this.options.devices.inReach(deviceId) || !this.sendsCheckedOut(deviceId))
      return null;
    return this.checkoutAt(deviceId, taskId);
  }

  private sendsCheckedOut(deviceId: string): boolean {
    return this.options.devices.takesCurrentWork(deviceId);
  }

  /**
   * A closed task's working copy there goes, once its work is here: that
   * computer saves what never merged as one commit on the task's kept ref,
   * the commit crosses as a bundle and is fetched here, and only then is
   * the working copy deleted there. Out of reach, it waits for the next
   * time that computer is back; a step that fails is tried again then.
   */
  retire(taskId: string): Promise<void> {
    return this.serial(taskId, async () => {
      const record = this.options.tasks.get(taskId);
      const deviceId = record?.deviceId;
      // A closed record, whatever it says of the working copy: a start that
      // failed after that computer made one leaves it there all the same.
      if (!record || !deviceId || !TaskService.isClosed(record)) return;
      if (this.retiredThere.has(taskId) || !this.options.devices.inReach(deviceId)) return;
      try {
        const { kept } = await this.ask(deviceId, "inf:working-copy:keep", [
          { orderId: `keep:${taskId}`, task: taskId },
        ]);
        const repoDir = await this.options.homeRepo(record.repoId ?? null);
        if (kept) {
          if (!repoDir) throw new Error(`${HERE.This} has no repository to keep its work in.`);
          const sha = await this.take(deviceId, taskId, repoDir, "kept", keptRefFor(taskId));
          if (sha !== kept.sha) throw new Error("The kept work that arrived is not what was kept.");
        }
        await this.ask(deviceId, "inf:working-copy:retire", [
          { orderId: `retire:${taskId}`, task: taskId, kept: kept?.sha ?? null },
        ]);
        // This Mac's copy of the branch goes with it, as a local task's does.
        if (repoDir && record.branch) await this.forgetBranch(repoDir, record.branch);
        if (repoDir)
          await git(repoDir, ["update-ref", "-d", checkedOutRefFor(taskId)]).catch(() => {});
        this.retired(taskId, deviceId, kept);
      } catch (caught) {
        this.options.log(
          `could not retire ${taskId}'s working copy there yet: ${messageOf(caught)}`,
        );
      }
    });
  }

  /**
   * What a computer holds for a task this Mac no longer records there - a
   * start that failed after that computer made its working copy, a purge,
   * a task placed elsewhere before it ran there - goes by the rule this
   * Mac's own leftover working copies follow (docs/helper.md, "Leftovers"):
   * its conversation there is closed for good, what its working copy holds
   * that never merged comes here first, onto the task's kept ref in the
   * project it was cloned from, and only then are the working copy and the
   * task's folder removed there. One with nothing unmerged goes at once.
   * One whose work has nowhere to go here - no project here cloned from
   * where it came from, a task this Mac records elsewhere, a kept ref here
   * that holds other work - stays there, and the feed says so once. Out of
   * reach, it waits for the next time that computer is back; a step that
   * fails is tried again then.
   */
  retireLeftover(deviceId: string, taskId: string, folder?: string): Promise<void> {
    return this.serial(taskId, async () => {
      if (!this.options.devices.inReach(deviceId)) return;
      const record = this.options.tasks.get(taskId);
      // Placed there again since: the record's own rule applies.
      if (record?.deviceId === deviceId) return;
      // A move to or from that computer removes what it left there itself
      // (`retireMoved`): its work is the work that moved, never a leftover.
      // A move made while it was out of reach left its copy there instead.
      const move = record?.shape?.computer_move;
      if (move && (move.to === deviceId || (move.from === deviceId && !move.away))) return;
      const left = record?.shape?.away_copies?.findLast((entry) => entry.from === deviceId);
      if (left) {
        // Removed already: nothing of it is left there to keep.
        if (left.kept?.removed !== undefined) return;
        await this.keepAwayCopy(deviceId, taskId, left, folder).catch((caught: unknown) =>
          this.options.log(`could not save what ${taskId} left there yet: ${messageOf(caught)}`),
        );
        // A closed task's copy there goes, its work saved here first.
        if (record && TaskService.isClosed(record))
          await this.dropAwayCopy(deviceId, taskId, folder).catch((caught: unknown) =>
            this.options.log(
              `could not remove what ${taskId} left there yet: ${messageOf(caught)}`,
            ),
          );
        return;
      }
      try {
        await this.options.closeThere(deviceId, taskId);
        const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
        if (
          status.present &&
          !(await this.retireLeftoverCopy(
            deviceId,
            taskId,
            status.origin,
            status.checkedOut?.branch,
          ))
        )
          return;
        await this.ask(deviceId, "inf:session:remove", [
          { orderId: `remove:${taskId}`, task: taskId },
        ]);
      } catch (caught) {
        this.options.log(`could not remove what ${taskId} left there yet: ${messageOf(caught)}`);
      }
    });
  }

  /**
   * The copy a task left on a computer it moved off while that computer was
   * out of reach, now that it is back (docs/helper.md, "Moving a task off a
   * computer that is out of reach"): its conversation there is closed for
   * good, so that computer stops running the task; what its working copy
   * holds that never merged is saved there as one commit and brought here,
   * onto a ref of its own in the task's project (`awayCopyRefFor`); and
   * the record notes the commit, the ref and the folder there, once. The
   * working copy and the task's folder there stay as they are.
   */
  private async keepAwayCopy(
    deviceId: string,
    taskId: string,
    left: AwayCopy,
    folder: string | undefined,
  ): Promise<void> {
    if (left.kept) return;
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    await this.options.closeThere(deviceId, taskId, `left-close:${taskId}:${left.at}`);
    const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
    const kept: NonNullable<AwayCopy["kept"]> = { at: this.options.now() };
    if (status.present) {
      if (folder) kept.folder = folder;
      const saved = (
        await this.ask(deviceId, "inf:working-copy:keep", [
          { orderId: `left-keep:${taskId}:${left.at}`, task: taskId },
        ])
      ).kept;
      const repoDir = saved ? await this.options.homeRepo(record.repoId ?? null) : undefined;
      // Work it saved that has nowhere to land here is not kept yet: the next contact tries again.
      if (saved && !repoDir)
        throw new Error(`${HERE.this} has no repository for its project to save it in`);
      if (saved && repoDir) {
        const ref = awayCopyRefFor(taskId, left.at);
        const sha = await this.take(deviceId, taskId, repoDir, "kept", ref);
        if (sha !== saved.sha) throw new Error("The kept work that arrived is not what was kept.");
        kept.sha = sha;
        kept.ref = ref;
      }
    }
    const now = this.options.tasks.get(taskId);
    const entries = now?.shape?.away_copies ?? [];
    if (!now || !entries.some((entry) => entry.from === deviceId && entry.at === left.at)) return;
    const name = this.options.deviceName(deviceId);
    this.options.tasks.placement.setAwayCopies(
      taskId,
      entries.map((entry) =>
        entry.from === deviceId && entry.at === left.at ? { ...entry, kept } : entry,
      ),
      {
        text: kept.sha
          ? `${name} is back: it stopped running this task, and the working copy it left there stays there; what it held that never merged is saved here at ${kept.ref}`
          : status.present
            ? `${name} is back: it stopped running this task, and the working copy it left there stays there; it held nothing that never merged`
            : `${name} is back and stopped running this task; it holds no working copy of it`,
      },
    );
    this.options.awayCopyKept?.(taskId);
  }

  /**
   * Removes the copy a task left on a computer it moved off while that
   * computer was out of reach (docs/helper.md, "Moving a task off a computer
   * that is out of reach"), before the task moves back there: its closed
   * conversation there takes no moved work. Throws while that computer is
   * out of reach or a step fails.
   */
  removeAwayCopy(deviceId: string, taskId: string, folder?: string): Promise<void> {
    return this.serial(taskId, async () => {
      if (!this.options.devices.inReach(deviceId))
        throw new Error(`${this.options.deviceName(deviceId)} is out of reach.`);
      await this.dropAwayCopy(deviceId, taskId, folder);
    });
  }

  /**
   * The copy goes once its work is saved here (`keepAwayCopy`, first if it
   * was not yet) and its conversation's record is brought home, since this
   * Mac copied it last at a turn's end there and sessions are never pruned:
   * the working copy is retired there against what was kept, then the
   * task's folder there is removed, and the record notes when.
   */
  private async dropAwayCopy(deviceId: string, taskId: string, folder?: string): Promise<void> {
    const leftNow = () =>
      this.options.tasks
        .get(taskId)
        ?.shape?.away_copies?.findLast((entry) => entry.from === deviceId);
    const left = leftNow();
    if (!left || left.kept?.removed !== undefined) return;
    if (!left.kept) await this.keepAwayCopy(deviceId, taskId, left, folder);
    const kept = leftNow()?.kept;
    if (!kept) throw new Error("what it left there is not saved here yet");
    await this.options.copyRecordThere(deviceId, taskId);
    const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
    if (status.present)
      await this.ask(deviceId, "inf:working-copy:retire", [
        { orderId: `left-retire:${taskId}:${left.at}`, task: taskId, kept: kept.sha ?? null },
      ]);
    await this.ask(deviceId, "inf:session:remove", [
      { orderId: `left-remove:${taskId}:${left.at}`, task: taskId },
    ]);
    const entries = this.options.tasks.get(taskId)?.shape?.away_copies ?? [];
    const name = this.options.deviceName(deviceId);
    this.options.tasks.placement.setAwayCopies(
      taskId,
      entries.map((entry) =>
        entry.from === deviceId && entry.at === left.at && entry.kept
          ? { ...entry, kept: { ...entry.kept, removed: this.options.now() } }
          : entry,
      ),
      {
        text: kept.sha
          ? `The working copy this task left on ${name} is removed there; what it held that never merged stays saved here at ${kept.ref}`
          : `The working copy this task left on ${name} is removed there; it held nothing that never merged`,
      },
    );
  }

  /**
   * Packs a task's work on the computer it runs on to move it elsewhere
   * (docs/helper.md, "Moving a started task"): its conversation there is let
   * go, its branch comes home as a bundle into `refs/heads/<branch>` of the
   * task's repository here, and its pack is read into `pack` here, checked
   * against the digest that computer gave. Answers the commit the checkout
   * is at and the repository here.
   */
  moveOut(
    deviceId: string,
    taskId: string,
    attempt: string,
    pack: string,
    keep: readonly string[] = [],
  ): Promise<{ head: string; branch: string; repoDir: string }> {
    return this.serial(taskId, async () => {
      const record = this.options.tasks.get(taskId);
      if (!record) throw new Error("The task has no record here.");
      const repoDir = await this.options.homeRepo(record.repoId ?? null);
      if (!repoDir) throw new Error(`${HERE.This} has no repository for this task's work.`);
      const out = await this.ask(deviceId, "inf:working-copy:move-out", [
        {
          orderId: `move-out:${taskId}:${attempt}`,
          task: taskId,
          ...(keep.length ? { keep: [...keep] } : {}),
        },
      ]);
      const ref = `refs/heads/${out.branch}`;
      const sha = await this.take(deviceId, taskId, repoDir, "branch", ref);
      if (!sha || !(await commitOf(repoDir, out.head)))
        throw new Error("The task's commits did not arrive here.");
      mkdirSync(join(pack, ".."), { recursive: true, mode: 0o700 });
      await this.download(deviceId, taskId, "move", out.pack.size, join(pack, ".."), pack);
      if ((await sha256Of(pack)) !== out.pack.sha256)
        throw new Error("The moved work that arrived is not what was packed.");
      return { head: out.head, branch: out.branch, repoDir };
    });
  }

  /**
   * Makes the working copy of a task that moves to that computer from the
   * work packed here: a task with no project sends this Mac's workspace
   * first, as its start does; the branch's commits that computer lacks
   * cross as a bundle, the pack as a source file, and that computer makes
   * the working copy at `head` and unpacks the work, checked against what
   * left. Answers the working copy there.
   */
  moveIn(
    deviceId: string,
    taskId: string,
    attempt: string,
    input: { repoId: string | null; head: string; branch: string; pack: string },
  ): Promise<PlacedCopy> {
    return this.serial(taskId, async () => {
      const repoDir = await this.options.homeRepo(input.repoId);
      if (!repoDir) throw new Error(`${HERE.This} has no repository for this task's work.`);
      // A project kept here only, or cloned from a folder of this Mac, has
      // no origin that computer can clone: its commits all cross in the
      // bundle, and its repository there starts on this one's branch at the
      // commit the task's branch left it at.
      const prepared = preparedPublicationRemote(this.options.tasks.get(taskId));
      const origin =
        prepared?.origin ??
        (input.repoId
          ? await this.originOf(input.repoId).then(
              (found) => (forgeOf(found.origin).host ? found.origin : undefined),
              () => undefined,
            )
          : undefined);
      if (prepared?.pushOrigin && !this.options.devices.takesCurrentWork(deviceId))
        throw new PreparationFailed(
          `${this.options.deviceName(deviceId)} must be updated before it can push contributions through your fork.`,
        );
      const seed = input.repoId ? undefined : await this.seed(deviceId, taskId);
      const base = {
        task: taskId,
        ...(origin
          ? {
              project: {
                origin,
                ...(prepared?.pushOrigin ? { pushOrigin: prepared.pushOrigin } : {}),
              },
            }
          : input.repoId
            ? { project: { local: input.repoId, base: await integrationBase(repoDir, input.head) } }
            : {}),
        ...(seed ? { seed } : {}),
        head: input.head,
        branch: input.branch,
      };
      const asked = await this.ask(deviceId, "inf:working-copy:move-in", [
        { orderId: `move-in:${taskId}:${attempt}:ask`, ...base },
      ]);
      if (asked.outcome !== "need") throw new Error("The moved work was not asked for.");
      const dir = join(this.options.paths.crewmatesDir, taskId, "move");
      const bundleFile = join(dir, `move-${attempt}.bundle`);
      try {
        const made = await bundleRef(repoDir, `refs/heads/${input.branch}`, asked.have, bundleFile);
        if (made.sha !== input.head)
          throw new Error("The task's branch here is not at the moved work's commit.");
        let bundle: { name: string; size: number; sha256: string } | undefined;
        if (made.bundle) {
          const name = `move-${attempt}.bundle`;
          await sendSourceFile(this.options.devices, deviceId, taskId, name, bundleFile);
          bundle = { name, ...made.bundle };
        }
        const packName = `move-${attempt}.pack`;
        await sendSourceFile(this.options.devices, deviceId, taskId, packName, input.pack);
        const ready = await this.ask(deviceId, "inf:working-copy:move-in", [
          {
            orderId: `move-in:${taskId}:${attempt}`,
            ...base,
            ...(bundle ? { bundle } : {}),
            pack: { name: packName, ...(await digestOf(input.pack)) },
          },
        ]);
        if (ready.outcome !== "ready") throw new Error("The moved work was not taken there.");
        return { cwd: ready.dir, branch: ready.branch };
      } finally {
        await rm(bundleFile, { force: true });
      }
    });
  }

  /**
   * The working copy a task left on a computer it moved off, or a moved
   * copy a move that did not finish made there: once the task's work is
   * on the computer it runs on now, this one goes - its conversation there
   * closed for good, what it holds kept there as one commit only so the
   * copy can be removed, the copy removed, then the task's folder there.
   * Nothing of it comes here: the work it holds is the work that moved.
   * Throws while that computer is out of reach or a step fails.
   */
  retireMoved(deviceId: string, taskId: string): Promise<void> {
    return this.serial(taskId, async () => {
      if (!this.options.devices.inReach(deviceId))
        throw new Error(`${this.options.deviceName(deviceId)} is out of reach.`);
      await this.options.closeThere(deviceId, taskId, `move-close:${taskId}:${this.options.now()}`);
      const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
      if (status.present) {
        const stamp = this.options.now();
        const { kept } = await this.ask(deviceId, "inf:working-copy:keep", [
          { orderId: `move-keep:${taskId}:${stamp}`, task: taskId },
        ]);
        await this.ask(deviceId, "inf:working-copy:retire", [
          { orderId: `move-retire:${taskId}:${stamp}`, task: taskId, kept: kept?.sha ?? null },
        ]);
      }
      await this.ask(deviceId, "inf:session:remove", [
        { orderId: `move-remove:${taskId}:${this.options.now()}`, task: taskId },
      ]);
    });
  }

  /**
   * The computer holds nothing for a closed task whose working copy this
   * Mac still counts as there: nothing is left to bring home.
   */
  forget(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (record?.workspaceState === "present" && TaskService.isClosed(record))
      this.options.tasks.placement.markWorkspaceRemoved(taskId);
  }

  writesEvidenceFiles(deviceId: string): boolean {
    return this.options.devices.takesCurrentWork(deviceId);
  }

  async writeEvidenceFile(
    taskId: string,
    deviceId: string,
    name: string,
    file: string,
  ): Promise<string> {
    if (!this.writesEvidenceFiles(deviceId))
      throw new Error("That computer needs an update to receive evidence files.");
    return sendSourceFile(this.options.devices, deviceId, taskId, name, file, undefined, true);
  }

  /** Whether that computer writes a selection of an artifact's files beside the whole one. */
  writesArtifactParts(deviceId: string): boolean {
    return this.options.devices.takesCurrentWork(deviceId);
  }

  /**
   * Writes an artifact this Mac downloaded, or a selection of its files
   * (`part`, only to a computer that `writesArtifactParts`), into the
   * task's working copy there, in pieces, as this Mac writes one into its
   * own; a file already there throws `EEXIST`, never written over. Answers
   * where it is there, in the folder that computer's version writes it in.
   */
  async writeArtifact(
    taskId: string,
    deviceId: string,
    artifact: { runId: number; artifactId: number; bytes: Uint8Array; part?: string },
  ): Promise<string> {
    if (artifact.part !== undefined && !this.writesArtifactParts(deviceId))
      throw new Error("That computer cannot write a selection of an artifact's files yet.");
    const folder = speaksInfinitaryNames(this.options.devices.version(deviceId)?.contract ?? "")
      ? ARTIFACTS_FOLDER
      : OLDER_ARTIFACTS_FOLDER;
    const path = artifactPath(artifact.runId, artifact.artifactId, folder, artifact.part);
    const bytes = Buffer.from(artifact.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let offset = 0;
    do {
      const piece = bytes.subarray(offset, offset + PLACED_COPY_CHUNK_BYTES);
      const { outcome } = await this.ask(deviceId, "inf:working-copy:artifact", [
        {
          task: taskId,
          runId: artifact.runId,
          artifactId: artifact.artifactId,
          ...(artifact.part !== undefined ? { part: artifact.part } : {}),
          size: bytes.length,
          sha256,
          offset,
          data: piece.toString("base64"),
        },
      ]);
      offset += piece.length;
      if (outcome === "exists")
        throw Object.assign(new Error("The artifact is already in the working copy."), {
          code: "EEXIST",
        });
      if (outcome === "written") return path;
    } while (offset < bytes.length);
    throw new Error("The artifact did not arrive whole.");
  }

  // ---- inside -------------------------------------------------------------------

  /**
   * Fetches one of the task's refs there into `to` here, as a bundle of
   * only what this Mac lacks; answers the commit it points at.
   */
  private async take(
    deviceId: string,
    taskId: string,
    repoDir: string,
    ref: BundledRef,
    to: string,
    branch?: string,
  ): Promise<string | null> {
    const have = await this.haves(repoDir, taskId);
    const made = await this.ask(deviceId, "inf:working-copy:bundle", [
      { task: taskId, ref, have, ...(branch === undefined ? {} : { branch }) },
    ]);
    if (!made.sha) return null;
    if (!made.bundle) {
      // This Mac has the commit already: only the ref moves.
      if ((await commitOf(repoDir, to)) !== made.sha && !(await this.checkedOut(repoDir, to)))
        await git(repoDir, ["update-ref", to, made.sha]);
      return made.sha;
    }
    const dir = crewmatePlacedDir(this.options.paths, taskId);
    const file = join(dir, `${ref}.bundle`);
    try {
      await this.download(deviceId, taskId, ref, made.bundle.size, dir, file);
      const from =
        branch === undefined
          ? await bundledName(repoDir, file, taskId, ref, to)
          : `refs/heads/${branch}`;
      await takeBundle(repoDir, file, made.bundle, from, to, made.sha);
    } finally {
      await rm(file, { force: true });
    }
    return made.sha;
  }

  /** The bundle's bytes, read there in pieces into `file` here. */
  private async download(
    deviceId: string,
    taskId: string,
    ref: ReadableRef,
    size: number,
    dir: string,
    file: string,
  ): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const handle = openSync(file, "w", 0o600);
    try {
      let offset = 0;
      while (offset < size) {
        const piece = await this.ask(deviceId, "inf:working-copy:read", [
          { task: taskId, ref, offset },
        ]);
        const bytes = Buffer.from(piece.data, "base64");
        if (piece.size !== size || piece.offset !== offset || bytes.length === 0)
          throw new Error("The bundle changed there while it was being read.");
        let written = 0;
        while (written < bytes.length)
          written += writeSync(handle, bytes, written, bytes.length - written, offset + written);
        offset += bytes.length;
      }
    } finally {
      closeSync(handle);
    }
  }

  /**
   * The commits this Mac has that the task's work builds on: its copy of
   * the branch, the kept ref, the default branch it last fetched, and the
   * commit the working copy started from there.
   */
  private async haves(repoDir: string, taskId: string): Promise<string[]> {
    const record = this.options.tasks.get(taskId);
    const refs = [
      ...(record?.branch ? [`refs/heads/${record.branch}`] : []),
      ...keptRefsFor(taskId),
      "refs/remotes/origin/HEAD",
      "HEAD",
      ...this.startedFrom(taskId),
    ];
    const have = new Set<string>();
    for (const ref of refs) {
      const sha = await commitOf(repoDir, ref);
      if (sha) have.add(sha);
    }
    return [...have].slice(0, HAVE_MAX);
  }

  /** The commit the task's working copy started from, as its timeline says. */
  private startedFrom(taskId: string): string[] {
    for (const event of [...this.options.tasks.timeline(taskId)].reverse()) {
      const base = (event.data as { base?: { sha?: unknown } } | null)?.base;
      if (typeof base?.sha === "string" && /^[0-9a-f]{40}$/.test(base.sha)) return [base.sha];
    }
    return [];
  }

  private async checkedOut(repoDir: string, ref: string): Promise<boolean> {
    const head = await git(repoDir, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "");
    return head === ref;
  }

  /** This Mac's copy of a retired task's branch; the kept ref holds what never merged. */
  private async forgetBranch(repoDir: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    if (!(await commitOf(repoDir, ref)) || (await this.checkedOut(repoDir, ref))) return;
    await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
  }

  private retired(taskId: string, deviceId: string, kept: KeptWork | null): void {
    this.retiredThere.add(taskId);
    const record = this.options.tasks.get(taskId);
    if (record?.placement)
      this.options.tasks.placement.releasePlacement(
        taskId,
        record.placement.snapshot.orderId,
        "ended",
      );
    if (record?.workspaceState === "present")
      this.options.tasks.placement.markWorkspaceRemoved(taskId);
    if (kept)
      this.options.tasks.note(
        taskId,
        `working copy on ${this.options.deviceName(deviceId)} removed - ${keptWorkWords(kept)} saved here first`,
        { news: false, data: { saved: kept, device: deviceId } },
      );
  }

  /**
   * A leftover working copy there: its unmerged work kept there, brought
   * here and verified, then the copy deleted there. Answers whether it is
   * gone; false when its work has nowhere to go here, which the feed says.
   */
  private async retireLeftoverCopy(
    deviceId: string,
    taskId: string,
    origin: string | null | undefined,
    branch: string | null | undefined,
  ): Promise<boolean> {
    const { kept } = await this.ask(deviceId, "inf:working-copy:keep", [
      { orderId: `keep:${taskId}`, task: taskId },
    ]);
    if (kept) {
      const repoDir = await this.leftoverHome(taskId, origin);
      const ref = keptRefFor(taskId);
      const here = repoDir ? await commitOf(repoDir, ref) : null;
      // A kept ref here that holds other work is never written over.
      if (!repoDir || (here !== null && here !== kept.sha)) {
        this.sayLeftover(deviceId, taskId, branch);
        return false;
      }
      const sha = await this.take(deviceId, taskId, repoDir, "kept", ref);
      if (sha !== kept.sha) throw new Error("The kept work that arrived is not what was kept.");
      this.options.log(`${taskId}'s leftover work there is saved here at ${ref}`);
    }
    await this.ask(deviceId, "inf:working-copy:retire", [
      { orderId: `retire:${taskId}`, task: taskId, kept: kept?.sha ?? null },
    ]);
    const placement = this.options.tasks.get(taskId)?.placement;
    if (placement)
      this.options.tasks.placement.releasePlacement(taskId, placement.snapshot.orderId, "ended");
    return true;
  }

  /**
   * Where a leftover working copy's work is kept here: the project cloned
   * from where it came from, or this Mac's own local workspace for one of
   * that computer's. None for a task this Mac records elsewhere, whose own
   * work owns its kept ref here, or from a computer that does not say.
   */
  private async leftoverHome(
    taskId: string,
    origin: string | null | undefined,
  ): Promise<string | undefined> {
    if (this.options.tasks.get(taskId) || origin === undefined) return undefined;
    if (origin === null) return this.options.homeRepo(null);
    for (const repoId of this.options.projects()) {
      const repoDir = await this.options.homeRepo(repoId);
      if (!repoDir) continue;
      const here = await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "");
      if (here && withoutSignIn(here) === origin) return repoDir;
    }
    return undefined;
  }

  /**
   * Names the copy by its task's saved branch, else the branch it has
   * checked out there, as one with no record here has (`branch`).
   */
  private sayLeftover(deviceId: string, taskId: string, branch: string | null | undefined): void {
    const key = `${deviceId}:${taskId}`;
    if (this.saidLeftover.has(key)) return;
    this.saidLeftover.add(key);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `${this.options.deviceName(deviceId)} keeps a leftover working copy, because its work could not be saved on ${HERE.this} first: ${this.options.tasks.get(taskId)?.branch || branch || defaultTaskBranch(taskId)}.`,
      taskId,
    });
  }

  /** The project's origin, as that computer clones it: never a sign-in written into the address. */
  private async originOf(repoId: string): Promise<{ origin: string; name: string }> {
    const name = this.options.projectName(repoId) ?? "the project";
    const repoDir = await this.options.homeRepo(repoId);
    // An approved address wins over the checkout's unapproved configuration.
    const approved = this.options.projectOrigin?.(repoId);
    const origin =
      approved !== undefined
        ? approved
        : repoDir && existsSync(repoDir)
          ? await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "")
          : undefined;
    if (!origin)
      throw new Error(`${name} has no origin to clone it from, so it runs on ${HERE.this} only.`);
    return { origin: withoutSignIn(origin), name };
  }

  private async ask<C extends WorkOrderChannel>(
    deviceId: string,
    channel: C,
    args: unknown,
  ): Promise<WorkOrderResponse<C>> {
    const raw = await this.options.devices.ask(deviceId, channel, args);
    return workOrders[channel].response.parse(raw) as WorkOrderResponse<C>;
  }

  /** Seal the queues and wait for every admitted operation before SQLite closes. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.chains.values());
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("This computer is stopping."));
    const next = (this.chains.get(key) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

/**
 * The ref a bundle of that kind carries, as the computer names it: a kept
 * one under Infinitary's name or, from a computer not yet updated, under
 * Firstmate 3000's, read off the bundle's own heads.
 */
async function bundledName(
  repoDir: string,
  file: string,
  taskId: string,
  ref: BundledRef,
  branchRef: string,
): Promise<string> {
  if (ref !== "kept") return branchRef;
  const heads = (await git(repoDir, ["bundle", "list-heads", file]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1] ?? "");
  return keptRefsFor(taskId).find((name) => heads.includes(name)) ?? keptRefFor(taskId);
}

/**
 * Where a project's repository on another computer starts when it has no
 * origin there to clone: this repository's own branch, at the commit the
 * task's branch left it at, or the task's commit when they share none.
 */
async function integrationBase(
  repoDir: string,
  head: string,
): Promise<{ branch: string; sha: string }> {
  const branch = await git(repoDir, ["symbolic-ref", "--short", "HEAD"]).catch(() => "main");
  const sha = await git(repoDir, ["merge-base", "HEAD", head]).catch(() => head);
  return { branch, sha };
}

/** An https address with any name or password taken out; any other address as it is. */
export function withoutSignIn(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return origin;
    if (!url.username && !url.password) return origin;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return origin;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function digestOf(file: string): Promise<{ size: number; sha256: string }> {
  return {
    size: statSync(file).size,
    sha256: await sha256Of(file),
  };
}
