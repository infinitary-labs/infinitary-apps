import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import type { FmEvent } from "@shared/events";
import { forgeOf } from "@shared/forge";
import { speaksInfinitaryNames } from "@shared/ipc";
import {
  type BundledRef,
  PLACED_COPY_CHUNK_BYTES,
  type WorkingCopyBase,
  type WorkOrderChannel,
  type WorkOrderResponse,
  workOrders,
} from "@shared/work";
import { type AppPaths, crewmatePlacedDir } from "../paths";
import { TaskService } from "../tasks/taskService";
import { ARTIFACTS_FOLDER, artifactPath, OLDER_ARTIFACTS_FOLDER } from "../workspace/artifacts";
import { bundleRef, commitOf, takeBundle } from "../workspace/bundles";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { git } from "../workspace/git";
import {
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
  /** Every project's id, to find the one a leftover working copy there was cloned from. */
  projects: () => readonly string[];
  /** A paired computer's name, as Devices lists it. */
  deviceName: (deviceId: string) => string;
  /** A project's name, by its id. */
  projectName: (repoId: string) => string | undefined;
  broadcastEvent: (event: FmEvent) => void;
  now: () => number;
  log: (line: string) => void;
};

/** The most commits the home names as ones it has when it asks for a bundle. */
const HAVE_MAX = 64;

export class PreparationUnknown extends Error {}
export class PreparationFailed extends Error {}

export class PlacedCopies {
  /** One bring-home or retirement per task at a time, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
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
  ): Promise<PlacedCopy> {
    const name = this.options.deviceName(deviceId);
    const committed = this.options.tasks.get(taskId)?.placement?.snapshot;
    const project =
      committed?.origin && !base
        ? {
            origin: committed.origin,
            name: this.options.projectName(repoId ?? "") ?? "the project",
          }
        : repoId && !base
          ? await this.originOf(repoId)
          : undefined;
    // A projectless builder starts from the home's workspace. Its reviewer
    // already has the builder's repository there, so sends no seed.
    const seed = repoId || base ? undefined : await this.seed(deviceId, taskId);
    let answer: WorkOrderResponse<"inf:working-copy:prepare">;
    try {
      answer = await this.ask(deviceId, "inf:working-copy:prepare", [
        {
          orderId: committed?.orderId ?? `prepare:${taskId}:${this.options.now()}`,
          task: taskId,
          ...(project ? { project: { origin: project.origin } } : {}),
          ...(base ? { base } : {}),
          ...(seed ? { seed } : {}),
        },
      ]);
    } catch (caught) {
      throw new PreparationUnknown(
        `${name} could not confirm this task's working copy: ${messageOf(caught)}`,
      );
    }
    // The host where the project lives wants that computer's own sign-in:
    // the refusal stays typed, so the task waits for the sign-in there and
    // starts by itself once the computer reports it (docs/forge.md, "A
    // computer's own sign-in").
    if ("refused" in answer && answer.refused === "preparation-unknown")
      throw new PreparationUnknown();
    if ("refused" in answer && answer.refused === "preparation-failed") {
      if (committed) this.options.tasks.releasePlacement(taskId, committed.orderId, "ended");
      throw new PreparationFailed(answer.message);
    }
    if ("refused" in answer) {
      if (committed) this.options.tasks.releasePlacement(taskId, committed.orderId, "ended");
      throw new ForgeAuthRequiredError(
        `${answer.name} requires ${name}'s own sign-in to fetch this project.`,
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

  /** Reads on the selected computer; never falls back to a stale branch at home. */
  async revision(
    deviceId: string,
    taskId: string,
    headSha?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">> {
    return this.ask(deviceId, "inf:working-copy:revision", [
      { task: taskId, ...(headSha ? { headSha } : {}) },
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
      throw new Error(`${name} could not take ${HERE.this}'s workspace: ${messageOf(caught)}`);
    }
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
    // 3000's name, so the bundle carries it under a stand-in of that name,
    // made here only for the bundle; any kept ref already there is left alone.
    const standIn =
      !infinitary && named.startsWith(KEPT_REF_PREFIX)
        ? `${OLDER_KEPT_REF_PREFIX}for-older/${taskId}-${sourceId}`
        : null;
    const from = standIn ?? named;
    const name = `${sourceId}.bundle`;
    const file = join(crewmatePlacedDir(this.options.paths, taskId), name);
    try {
      if (standIn) await git(repoDir, ["update-ref", standIn, `${named}^{commit}`]);
      const made = await bundleRef(repoDir, from, [], file);
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
   * of the task's repository here. Out of reach, this Mac reads what it
   * brought last. Ordinary reads log failures; a source handoff passes
   * `strict` to refuse a stale or missing branch before briefing its successor.
   */
  bringBranchHome(taskId: string, strict = false): Promise<void> {
    return this.serial(taskId, async () => {
      const record = this.options.tasks.get(taskId);
      const deviceId = record?.deviceId;
      if (!record || !deviceId || !record.branch) {
        if (strict) throw new Error("The source task has no live branch.");
        return;
      }
      if (!this.options.devices.inReach(deviceId)) {
        if (strict) throw new Error("The source computer is out of reach.");
        return;
      }
      try {
        const repoDir = await this.options.homeRepo(record.repoId ?? null);
        if (!repoDir) throw new Error("The source task has no repository here.");
        const ref = `refs/heads/${record.branch}`;
        const sha = await this.take(deviceId, taskId, repoDir, "branch", ref);
        if (strict && (!sha || (await commitOf(repoDir, ref)) !== sha))
          throw new Error("The source branch did not arrive at its current commit.");
      } catch (caught) {
        if (strict) throw caught;
        this.options.log(`could not bring ${taskId}'s branch home: ${messageOf(caught)}`);
      }
    });
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
  retireLeftover(deviceId: string, taskId: string): Promise<void> {
    return this.serial(taskId, async () => {
      if (!this.options.devices.inReach(deviceId)) return;
      // Placed there again since: the record's own rule applies.
      if (this.options.tasks.get(taskId)?.deviceId === deviceId) return;
      try {
        await this.ask(deviceId, "inf:session:close", [
          { orderId: `close:${taskId}`, task: taskId },
        ]);
        const status = await this.ask(deviceId, "inf:working-copy:status", [{ task: taskId }]);
        if (status.present && !(await this.retireLeftoverCopy(deviceId, taskId, status.origin)))
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
   * The computer holds nothing for a closed task whose working copy this
   * Mac still counts as there: nothing is left to bring home.
   */
  forget(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (record?.workspaceState === "present" && TaskService.isClosed(record))
      this.options.tasks.markWorkspaceRemoved(taskId);
  }

  /**
   * Writes an artifact this Mac downloaded into the task's working copy
   * there, in pieces, as this Mac writes one into its own; a file already
   * there throws `EEXIST`, never written over. Answers where it is there,
   * in the folder that computer's version writes it in.
   */
  async writeArtifact(
    taskId: string,
    deviceId: string,
    artifact: { runId: number; artifactId: number; bytes: Uint8Array },
  ): Promise<string> {
    const folder = speaksInfinitaryNames(this.options.devices.version(deviceId)?.contract ?? "")
      ? ARTIFACTS_FOLDER
      : OLDER_ARTIFACTS_FOLDER;
    const path = artifactPath(artifact.runId, artifact.artifactId, folder);
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
  ): Promise<string | null> {
    const have = await this.haves(repoDir, taskId);
    const made = await this.ask(deviceId, "inf:working-copy:bundle", [{ task: taskId, ref, have }]);
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
      const from = await bundledName(repoDir, file, taskId, ref, to);
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
    ref: BundledRef,
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
      this.options.tasks.releasePlacement(taskId, record.placement.snapshot.orderId, "ended");
    if (record?.workspaceState === "present") this.options.tasks.markWorkspaceRemoved(taskId);
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
        this.sayLeftover(deviceId, taskId);
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
    if (placement) this.options.tasks.releasePlacement(taskId, placement.snapshot.orderId, "ended");
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

  private sayLeftover(deviceId: string, taskId: string): void {
    const key = `${deviceId}:${taskId}`;
    if (this.saidLeftover.has(key)) return;
    this.saidLeftover.add(key);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `${this.options.deviceName(deviceId)} keeps a leftover working copy, because its work could not be saved on ${HERE.this} first: fm/task-${taskId}.`,
      taskId,
    });
  }

  /** The project's origin, as that computer clones it: never a sign-in written into the address. */
  private async originOf(repoId: string): Promise<{ origin: string; name: string }> {
    const name = this.options.projectName(repoId) ?? "the project";
    const repoDir = await this.options.homeRepo(repoId);
    const origin = repoDir
      ? await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "")
      : "";
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

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
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
