import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import {
  HOME_ABANDON_ORDER,
  HOME_ARRIVE_ORDER,
  HOME_MOVE_CHANGE,
  HOME_MOVE_MANIFEST,
  HOME_READY_ORDER,
  HOME_RECEIVE_ORDER,
  type HomeMoved,
  type HomeMoveFacts,
  type HomeMoveGap,
  type HomeMoveManifest,
  type HomeMoveProgress,
  type HomeMoveReady,
  homeMoveFactsSchema,
  type MovedProject,
  type RecordFile,
} from "@shared/homeMove";
import { PLACED_COPY_CHUNK_BYTES } from "@shared/work";
import Database from "better-sqlite3";
import { z } from "zod";
import { DeviceOutOfReachError } from "../connection/connection";
import { writePrivate } from "../devices/identity";
import { git } from "../workspace/git";
import { hashFile, listRecord, type RecordEntry } from "./record";
import { HOME_MOVE_WORDS } from "./words";

/** A started task on this computer, as the move reads it. */
export type LocalTask = {
  id: string;
  /** Its key and title, as a line names it. */
  handle: string;
  /** Whether it moves to the move's destination now; otherwise `refusal` says why, naming it. */
  movable: boolean;
  refusal?: string;
  /** Its own move, while one stands: where to, and why it waits when it cannot go on, naming it. */
  moving?: { to: string; problem?: string };
};

/** What the destination answers once the first mate is in place there. */
type Arrived = { addresses: string[] };

/** The move's mark, written before the commit and kept until the destination answered it. */
const PENDING_FILE = "pending.json";

const pendingMoveSchema = z.object({
  version: z.literal(1),
  move: z.string(),
  to: z.string(),
  name: z.string(),
  homeNumber: z.number().int().min(2),
  manifestSha256: z.string(),
  movedHome: z.object({ deviceId: z.string(), key: z.string(), cert: z.string() }),
});
type PendingMove = z.infer<typeof pendingMoveSchema>;

function writePendingMove(stagingDir: string, pending: PendingMove): void {
  writePrivate(join(stagingDir, PENDING_FILE), `${JSON.stringify(pending)}\n`);
}

/**
 * The move a home stopped for and sent, whose destination has not answered
 * yet, or null. A mark that cannot be read is still a mark: the home keeps
 * its first mate stopped rather than risk running beside the new one.
 */
export function readPendingMove(stagingDir: string): PendingMove | null {
  const file = join(stagingDir, PENDING_FILE);
  if (!existsSync(file)) return null;
  return pendingMoveSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Whether a move's mark stands in this data folder's staging folder. */
export function movePending(stagingDir: string): boolean {
  return existsSync(join(stagingDir, PENDING_FILE));
}

/** How long the old home waits before asking a destination out of reach again, after the stop. */
const ASK_AGAIN_MS = 2_000;

/**
 * How long the destination stays out of reach during the commit before the
 * captain is offered to start the first mate here again: long enough for
 * that computer to restart and answer, as an update or a crash would.
 */
export const START_HERE_OFFER_MS = 3 * 60_000;

/** What the old home's side of a move needs from the core. */
export type OutgoingHost = {
  userData: string;
  homeDir: string;
  claudeDir: string | null;
  appVersion: string | null;
  ownName: () => Promise<string>;
  /** A computer on the list that runs work, by id: its name, or undefined when none. */
  computer: (deviceId: string) => { name: string; runsWork: boolean } | undefined;
  ask: (deviceId: string, channel: string, args: unknown) => Promise<unknown>;
  /** The computer is connected and its version lists the move's contract change. */
  speaksMove: (deviceId: string) => boolean;
  /** Whether that computer is in reach now. */
  inReach: (deviceId: string) => boolean;
  homeNumber: () => number;
  /** Takes a higher home number, which every device follows and every lower home is refused by. */
  raiseHomeNumber: (homeNumber: number) => void;
  now?: () => number;
  /** How long the destination stays out of reach before Start here is offered; `START_HERE_OFFER_MS` unless a development run stands in a shorter wait. */
  offerMs?: number;
  homeKey: () => string;
  addMovedHome: (name: string) => { deviceId: string; key: string; cert: string };
  removeMovedHome: (deviceId: string) => void;
  /** The started tasks on this computer, each read against moving to `to`. */
  localTasks: (to: string) => Promise<LocalTask[]>;
  moveTask: (taskId: string, to: string) => Promise<{ ok: boolean; text: string }>;
  cancelTask: (taskId: string) => void;
  /** The project folders the first mate keeps, but the personal workspace, which is in the record. */
  projects: () => { id: string; path: string }[];
  /** This home's subscriptions, by provider, and the hosts where projects live it is signed in to. */
  providers: () => { id: string; name: string }[];
  forges: () => { host: string; name: string }[];
  /** The computers that reach this home only through its own SSH connection. */
  sshComputers: () => { id: string; name: string }[];
  secretsKept: () => boolean;
  integrationsSignedIn: () => string[];
  dictationOn: () => boolean;
  /** Stops everything the first mate does but its connection to its devices. */
  quiesce: () => Promise<void>;
  /** Refuses each change a device asks, with these words, or takes them again with null. */
  hold: (why: string | null) => void;
  tellMoved: (moved: HomeMoved) => Promise<void>;
  /** The move is done: this computer becomes a Mac of the new home, controlling it and running its work. */
  onMoved: (handOver: HomeHandOver) => void;
  /** The move failed after the first mate stopped: it starts again whole, here. */
  onStopped: () => void;
  emit: (progress: HomeMoveProgress) => void;
  /** Where to stage a database's consistent copy before it crosses. */
  stagingDir: string;
};

/** What this computer keeps to start again as a Mac of the new home. */
export type HomeHandOver = { move: string; grant: DeviceGrant; homeNumber: number; name: string };

/** One move this home runs, from the captain's click to the hand-over. */
type Running = {
  move: string;
  to: string;
  name: string;
  cancelled: boolean;
  frozen: boolean;
  /** The move's mark, once the commit asks the destination. */
  pending?: PendingMove;
  /** Since when the destination has been out of reach during the commit. */
  outSince?: number;
  /** The captain started the first mate here again: no answer counts from then. */
  startedHere?: boolean;
  /** An order of the commit is on its way to the destination, unanswered yet. */
  asking?: boolean;
  /** The last step offered Start my first mate here again. */
  offered?: boolean;
};

const PIECE = PLACED_COPY_CHUNK_BYTES;

/**
 * The old home's side of moving the first mate (docs/devices.md, "Moving the
 * first mate"): the Ready list before the click, then the move - started
 * tasks first, then the record copied while the first mate still works, then
 * a short stop in which only what changed crosses, then the new home starts
 * and every device follows it. Nothing moves the home by itself: only
 * `start`, from the captain's click, begins one.
 */
export class OutgoingHomeMove {
  private running: Running | null = null;
  /** A click whose Ready list is being read: a second click waits for nothing and is refused. */
  private starting = false;

  constructor(private readonly host: OutgoingHost) {}

  /** Whether a move runs now. */
  moving(): boolean {
    return this.running !== null;
  }

  /** The Ready list for `deviceId`: each gap the captain should know before moving there. */
  async ready(deviceId: string): Promise<HomeMoveReady> {
    const computer = this.host.computer(deviceId);
    const name = computer?.name ?? deviceId;
    const gaps: HomeMoveGap[] = [];
    const words = HOME_MOVE_WORDS;
    if (!computer?.runsWork) {
      gaps.push({ id: "not-work", level: "blocks", text: words.notWork(name) });
      return { deviceId, name: name.slice(0, 160), gaps };
    }
    if (!this.host.speaksMove(deviceId)) {
      gaps.push({ id: "out-of-reach", level: "blocks", text: words.outOfReach(name) });
      return { deviceId, name, gaps };
    }
    let facts: HomeMoveFacts;
    try {
      facts = homeMoveFactsSchema.parse(await this.host.ask(deviceId, HOME_READY_ORDER, []));
    } catch {
      gaps.push({ id: "out-of-reach", level: "blocks", text: words.outOfReach(name) });
      return { deviceId, name, gaps };
    }
    if (this.running) gaps.push({ id: "moving", level: "blocks", text: words.alreadyMoving });
    if (facts.appVersion !== this.host.appVersion)
      gaps.push({
        id: "version",
        level: "blocks",
        text: words.version(name, facts.appVersion, this.host.appVersion),
      });
    if (facts.firstMateRunning)
      gaps.push({ id: "first-mate-there", level: "blocks", text: words.firstMateThere(name) });
    if (!facts.background)
      gaps.push({ id: "background", level: "blocks", text: words.noBackground(name) });
    if (facts.addresses.length === 0)
      gaps.push({ id: "addresses", level: "blocks", text: words.noAddresses(name) });
    const size = listRecord(this.host.userData, this.host.claudeDir, { kinds: false }).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    if (facts.freeBytes !== null && facts.freeBytes < size * 2)
      gaps.push({ id: "space", level: "blocks", text: words.space(name, size, facts.freeBytes) });
    const tasks = await this.host.localTasks(deviceId);
    for (const task of tasks)
      if (!task.movable)
        gaps.push({
          id: `task-${task.id}`.slice(0, 64),
          level: "blocks",
          text: words.taskStays(task.refusal ?? task.id),
        });
    const moving = tasks.filter((task) => task.movable);
    if (moving.length)
      gaps.push({ id: "tasks", level: "notes", text: words.tasksMoveFirst(moving.length, name) });
    if (facts.ownRecord)
      gaps.push({ id: "own-record", level: "notes", text: words.ownRecord(name) });
    // Nothing signed in here is copied: the new home asks for each sign-in.
    const signIns = [
      ...this.host.providers().map((provider) => provider.name),
      ...this.host.forges().map((forge) => forge.name),
    ];
    if (signIns.length)
      gaps.push({ id: "sign-ins", level: "notes", text: words.signInAgain(name, signIns) });
    for (const computer of this.host.sshComputers())
      if (computer.id !== deviceId)
        gaps.push({
          id: `ssh-${computer.id}`.slice(0, 64),
          level: "notes",
          text: words.overSsh(computer.name, name),
        });
    if (this.host.secretsKept())
      gaps.push({ id: "secrets", level: "notes", text: words.secrets(name) });
    const integrations = this.host.integrationsSignedIn();
    if (integrations.length)
      gaps.push({
        id: "integrations",
        level: "notes",
        text: words.integrations(name, integrations),
      });
    for (const project of await this.uncommitted())
      gaps.push({
        id: `uncommitted-${project.id}`.slice(0, 64),
        level: "notes",
        text: words.uncommitted(project.path),
      });
    if (this.host.dictationOn())
      gaps.push({ id: "dictation", level: "notes", text: words.dictation(name) });
    return { deviceId, name, gaps: gaps.slice(0, 64) };
  }

  /**
   * The captain's click: starts the move to `deviceId` when nothing on its
   * Ready list blocks it, and answers at once; the move says where it stands
   * in progress pushes.
   */
  async start(deviceId: string): Promise<{ ok: boolean; text: string }> {
    if (this.running || this.starting) return { ok: false, text: HOME_MOVE_WORDS.alreadyMoving };
    this.starting = true;
    let ready: HomeMoveReady;
    try {
      ready = await this.ready(deviceId);
    } finally {
      this.starting = false;
    }
    const blocking = ready.gaps.find((gap) => gap.level === "blocks");
    if (blocking) return { ok: false, text: blocking.text };
    const running: Running = {
      move: randomUUID(),
      to: deviceId,
      name: ready.name,
      cancelled: false,
      frozen: false,
    };
    this.running = running;
    void this.run(running).finally(() => {
      if (this.running === running) this.running = null;
    });
    return { ok: true, text: HOME_MOVE_WORDS.started(ready.name) };
  }

  /**
   * The captain's confirmed Start my first mate here again, offered once the
   * destination stayed out of reach through `START_HERE_OFFER_MS` of the
   * commit (docs/devices.md, "A destination that never answers"). The mark
   * goes, and this home takes the number above the one the destination
   * would have, so every device follows this computer and refuses the
   * destination should it come back running the first mate too.
   */
  startHere(): { ok: boolean; text: string } {
    const running = this.running;
    const pending = running?.pending;
    if (!running || !pending || running.startedHere)
      return { ok: false, text: HOME_MOVE_WORDS.notMoving };
    const now = this.host.now?.() ?? Date.now();
    // Back in reach, or with an order on its way, the destination may be starting the first mate.
    if (
      running.asking ||
      this.host.inReach(running.to) ||
      running.outSince === undefined ||
      now - running.outSince < (this.host.offerMs ?? START_HERE_OFFER_MS)
    )
      return { ok: false, text: HOME_MOVE_WORDS.stillAsking(running.name) };
    running.startedHere = true;
    this.host.raiseHomeNumber(pending.homeNumber + 1);
    this.host.removeMovedHome(pending.movedHome.deviceId);
    rmSync(this.host.stagingDir, { recursive: true, force: true });
    this.say(running, "failed", HOME_MOVE_WORDS.startedHere(running.name));
    this.host.onStopped();
    return { ok: true, text: HOME_MOVE_WORDS.startedHere(running.name) };
  }

  /** The captain's Cancel: stops a move that has not stopped the first mate yet. */
  cancel(): { ok: boolean; text: string } {
    const running = this.running;
    if (!running) return { ok: false, text: HOME_MOVE_WORDS.notMoving };
    if (running.frozen) return { ok: false, text: HOME_MOVE_WORDS.tooLate(running.name) };
    running.cancelled = true;
    return { ok: true, text: HOME_MOVE_WORDS.cancelling };
  }

  private say(
    running: Running,
    stage: HomeMoveProgress["stage"],
    text: string,
    done?: number,
    total?: number,
    startHere?: true,
  ) {
    this.host.emit({
      deviceId: running.to,
      name: running.name,
      stage,
      text,
      ...(startHere ? { startHere } : {}),
      ...(done !== undefined ? { done } : {}),
      ...(total !== undefined ? { total } : {}),
    });
  }

  private async run(running: Running): Promise<void> {
    const words = HOME_MOVE_WORDS;
    let movedHome: { deviceId: string; key: string; cert: string } | null = null;
    let pending: PendingMove;
    try {
      await this.moveTasks(running);
      const sent = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
      const projects = await this.sendProjects(running);
      await this.sendRecord(running, sent, false);
      if (running.cancelled) throw new Cancelled();
      // The stop: nothing the first mate does changes the record from here.
      running.frozen = true;
      this.say(running, "stopping", words.stopping);
      this.host.hold(words.holding(running.name));
      await this.host.quiesce();
      movedHome = this.host.addMovedHome(await this.host.ownName());
      const files = await this.sendRecord(running, sent, true);
      const manifest: HomeMoveManifest = {
        version: 1,
        files,
        projects,
        from: { userData: this.host.userData, homeDir: this.host.homeDir },
        name: (await this.host.ownName()).slice(0, 160),
        signIns: {
          providers: this.host.providers().slice(0, 64),
          forges: this.host.forges().slice(0, 64),
        },
      };
      const manifestSha256 = await this.sendBytes(
        running,
        HOME_MOVE_MANIFEST,
        Buffer.from(`${JSON.stringify(manifest)}\n`),
      );
      // From here the destination may put the first mate in place: the mark
      // keeps this home stopped across a quit, a crash or a restart until the
      // destination answers (docs/devices.md, "The stop").
      pending = {
        version: 1,
        move: running.move,
        to: running.to,
        name: running.name,
        homeNumber: this.host.homeNumber() + 1,
        manifestSha256,
        movedHome,
      };
      writePendingMove(this.host.stagingDir, pending);
    } catch (caught) {
      const cancelled = caught instanceof Cancelled;
      void this.host.ask(running.to, HOME_ABANDON_ORDER, [{ move: running.move }]).catch(() => {});
      if (movedHome) this.host.removeMovedHome(movedHome.deviceId);
      rmSync(join(this.host.stagingDir, running.move), { recursive: true, force: true });
      if (running.frozen) {
        // The first mate stopped: it starts again whole, here.
        this.say(running, "failed", words.failedAfterStop(running.name, reason(caught)));
        this.host.onStopped();
        return;
      }
      this.say(
        running,
        cancelled ? "cancelled" : "failed",
        cancelled ? words.cancelled : words.failed(running.name, reason(caught)),
      );
      return;
    }
    await this.commit(running, pending);
  }

  /**
   * A launch that finds a move's mark: the old home stopped and sent its
   * record, and no answer came before it quit. It keeps its first mate
   * stopped and asks the destination again, as the move would have.
   * Answers whether it found one.
   */
  async resume(): Promise<boolean> {
    const pending = readPendingMove(this.host.stagingDir);
    if (!pending || this.running) return false;
    const running: Running = {
      move: pending.move,
      to: pending.to,
      name: pending.name,
      cancelled: false,
      frozen: true,
    };
    this.running = running;
    this.host.hold(HOME_MOVE_WORDS.holding(running.name));
    await this.host.quiesce();
    void this.commit(running, pending).finally(() => {
      if (this.running === running) this.running = null;
    });
    return true;
  }

  /**
   * The move's commit: only the destination's answer decides. It put the
   * first mate in place, and every device follows it; or it refused and,
   * asked until it says so, dropped everything of the move, and only then
   * the first mate starts again here.
   */
  private async commit(running: Running, pending: PendingMove): Promise<void> {
    const words = HOME_MOVE_WORDS;
    running.pending = pending;
    this.say(running, "arriving", words.arriving(running.name));
    const arrive = () =>
      this.untilAnswered(running, () =>
        this.host.ask(running.to, HOME_ARRIVE_ORDER, [
          {
            move: running.move,
            homeNumber: pending.homeNumber,
            manifestSha256: pending.manifestSha256,
          },
        ]),
      ) as Promise<Arrived>;
    const abandon = () =>
      this.untilAnswered(running, () =>
        this.host.ask(running.to, HOME_ABANDON_ORDER, [{ move: running.move }]),
      ) as Promise<{ dropped: boolean }>;
    let arrived: Arrived | null = null;
    let refusal: unknown = null;
    // Each refusal is followed by the abandon; one that did not drop the move
    // asks the arrive again, which answers the arrival once it is there.
    while (!arrived) {
      try {
        const answer = await arrive();
        if (!answer.addresses[0]) throw new Error(words.notStarted(running.name));
        arrived = answer;
        break;
      } catch (caught) {
        if (caught instanceof StartedHere) return;
        refusal = caught;
      }
      try {
        if ((await abandon()).dropped) break;
        this.say(running, "arriving", words.waitingFor(running.name));
      } catch (refused) {
        if (refused instanceof StartedHere) return;
        this.say(running, "arriving", words.notDropped(running.name, reason(refused)));
      }
      await new Promise((resolve) => setTimeout(resolve, ASK_AGAIN_MS));
    }
    if (!arrived) {
      this.host.removeMovedHome(pending.movedHome.deviceId);
      rmSync(this.host.stagingDir, { recursive: true, force: true });
      // The first mate stopped: it starts again whole, here.
      this.say(running, "failed", words.failedAfterStop(running.name, reason(refusal)));
      this.host.onStopped();
      return;
    }
    // The first mate runs on the destination now: nothing here starts it
    // again, and the mark stays until this computer starts again as a Mac of it.
    rmSync(join(this.host.stagingDir, running.move), { recursive: true, force: true });
    const [at, ...also] = arrived.addresses as [string, ...string[]];
    try {
      await this.host.tellMoved({
        homeNumber: pending.homeNumber,
        addresses: arrived.addresses,
        to: running.to,
        name: running.name,
      });
    } catch {
      // A device not told finds the new home by its announcement, since it shows the same key.
    }
    this.say(running, "moved", words.moved(running.name));
    this.host.onMoved({
      move: running.move,
      homeNumber: pending.homeNumber,
      name: running.name,
      grant: {
        at,
        ...(also.length ? { also } : {}),
        homeKey: this.host.homeKey(),
        deviceId: pending.movedHome.deviceId,
        kind: "mac",
        key: pending.movedHome.key,
        cert: pending.movedHome.cert,
      },
    });
  }

  /**
   * An order of the move's commit, asked until the destination answers it:
   * out of reach, nothing says whether it acted, so it is asked again under
   * the same move once it is back, and it answers the same. Its refusal is
   * an answer and throws.
   */
  private async untilAnswered(running: Running, ask: () => Promise<unknown>): Promise<unknown> {
    for (;;) {
      if (running.startedHere) throw new StartedHere();
      if (this.host.inReach(running.to)) {
        // Back in reach: the wait starts over, and the offer goes until it is out again.
        running.outSince = undefined;
        if (running.offered) {
          running.offered = false;
          this.say(running, "arriving", HOME_MOVE_WORDS.waitingFor(running.name));
        }
      }
      running.asking = true;
      try {
        const answer = await ask();
        if (running.startedHere) throw new StartedHere();
        running.outSince = undefined;
        return answer;
      } catch (caught) {
        if (!(caught instanceof DeviceOutOfReachError)) throw caught;
        running.asking = false;
        const now = this.host.now?.() ?? Date.now();
        running.outSince ??= now;
        // A destination out of reach this long may never answer: the captain may start the first mate here again.
        const offer =
          running.pending !== undefined &&
          now - running.outSince >= (this.host.offerMs ?? START_HERE_OFFER_MS);
        this.say(
          running,
          "arriving",
          HOME_MOVE_WORDS.waitingFor(running.name),
          undefined,
          undefined,
          offer ? true : undefined,
        );
        running.offered = offer;
        await new Promise((resolve) => setTimeout(resolve, ASK_AGAIN_MS));
      } finally {
        running.asking = false;
      }
    }
  }

  /** Every started task here moves to the destination first, keeping its key, branch and files. */
  private async moveTasks(running: Running): Promise<void> {
    const words = HOME_MOVE_WORDS;
    const asked = new Set<string>();
    for (;;) {
      const local = await this.host.localTasks(running.to);
      const stays = local.find((task) => !task.movable && !asked.has(task.id));
      if (stays) throw new Error(words.taskStays(stays.refusal ?? stays.id));
      // A task asked to move that stays here, its move waiting on a problem or gone, stops the move.
      for (const task of local) {
        if (!asked.has(task.id)) continue;
        if (task.moving?.to === running.to && task.moving.problem)
          throw new Error(words.taskStays(task.moving.problem));
        if (task.moving?.to !== running.to) throw new Error(words.taskStopped(task.handle));
      }
      const left = local.filter((task) => task.movable || asked.has(task.id));
      if (!left.length) return;
      if (running.cancelled) {
        for (const id of asked) this.host.cancelTask(id);
        throw new Cancelled();
      }
      for (const task of left) {
        if (asked.has(task.id)) continue;
        asked.add(task.id);
        const done = await this.host.moveTask(task.id, running.to);
        if (!done.ok) throw new Error(done.text);
      }
      this.say(
        running,
        "tasks",
        words.tasks(left.length, running.name),
        asked.size - left.length,
        asked.size,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /** Each project folder crosses as a bundle of every branch, with its remotes. */
  private async sendProjects(running: Running): Promise<MovedProject[]> {
    const projects: MovedProject[] = [];
    const dir = join(this.host.stagingDir, running.move, "projects");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [index, project] of this.host.projects().entries()) {
      if (running.cancelled) throw new Cancelled();
      const remotes = await readRemotes(project.path);
      if (remotes === null) {
        projects.push({ id: project.id, path: project.path, remotes: [] });
        continue;
      }
      const file = join(dir, `${index}.bundle`);
      const path = `projects/${index}.bundle`;
      // A repository with no branch or tag yet has nothing to bundle: it is
      // made empty there. Any other failure stops the move before the stop.
      const refs = await git(project.path, ["for-each-ref", "--count=1", "--format=%(refname)"], {
        timeoutMs: 10_000,
      });
      const bundled = refs.trim() !== "";
      if (bundled)
        await git(project.path, ["bundle", "create", file, "--all"], { timeoutMs: 30 * 60_000 });
      if (bundled) await this.sendFile(running, path, file);
      projects.push({
        id: project.id,
        path: project.path,
        ...(bundled ? { bundle: path } : {}),
        remotes,
      });
    }
    return projects;
  }

  /**
   * The record as it stands, each file that changed since it last crossed;
   * answers every file the record holds now. A database crosses as its own
   * consistent copy.
   */
  private async sendRecord(
    running: Running,
    sent: Map<string, { size: number; mtimeMs: number; sha256: string }>,
    final: boolean,
  ): Promise<RecordFile[]> {
    const entries = listRecord(this.host.userData, this.host.claudeDir);
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let done = 0;
    const files: RecordFile[] = [];
    for (const entry of entries) {
      if (!final && running.cancelled) throw new Cancelled();
      const before = sent.get(entry.path);
      let sha256: string;
      if (
        !entry.database &&
        before &&
        before.size === entry.size &&
        before.mtimeMs === entry.mtimeMs
      )
        sha256 = before.sha256;
      else if (final) sha256 = await this.sendEntry(running, entry);
      else {
        // A file written while it crossed, such as a conversation the first
        // mate is adding to, does not arrive whole: it crosses at the stop.
        try {
          sha256 = await this.sendEntry(running, entry);
        } catch (caught) {
          // A computer gone out of reach fails the move before the stop.
          if (caught instanceof DeviceOutOfReachError) throw caught;
          sent.delete(entry.path);
          continue;
        }
      }
      sent.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, sha256 });
      const size = entry.database ? statSync(this.copyOf(running, entry)).size : entry.size;
      files.push({ path: entry.path, size, sha256 });
      done += entry.size;
      this.say(
        running,
        final ? "stopping" : "copying",
        HOME_MOVE_WORDS.copying(running.name),
        done,
        total,
      );
    }
    return files;
  }

  private copyOf(running: Running, entry: RecordEntry): string {
    return join(this.host.stagingDir, running.move, "db", entry.path);
  }

  private async sendEntry(running: Running, entry: RecordEntry): Promise<string> {
    if (!entry.database) return this.sendFile(running, entry.path, entry.abs);
    const copy = this.copyOf(running, entry);
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    rmSync(copy, { force: true });
    const db = new Database(entry.abs, { readonly: true, fileMustExist: true });
    try {
      await db.backup(copy);
    } finally {
      db.close();
    }
    return this.sendFile(running, entry.path, copy);
  }

  private async sendBytes(running: Running, path: string, bytes: Buffer): Promise<string> {
    const file = join(this.host.stagingDir, running.move, "manifest");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
    return this.sendFile(running, path, file);
  }

  /** One file in pieces; a piece the destination refused is asked again once. Answers its hash. */
  private async sendFile(running: Running, path: string, abs: string): Promise<string> {
    const sha256 = await hashFile(abs);
    const size = statSync(abs).size;
    const handle = await open(abs, "r");
    try {
      let offset = 0;
      do {
        const buffer = Buffer.alloc(Math.min(PIECE, size - offset));
        const { bytesRead } = buffer.length
          ? await handle.read(buffer, 0, buffer.length, offset)
          : { bytesRead: 0 };
        const order = {
          move: running.move,
          path,
          size,
          sha256,
          offset,
          data: buffer.subarray(0, bytesRead).toString("base64"),
        };
        try {
          await this.host.ask(running.to, HOME_RECEIVE_ORDER, [order]);
        } catch {
          await this.host.ask(running.to, HOME_RECEIVE_ORDER, [order]);
        }
        offset += bytesRead;
        if (bytesRead === 0) break;
      } while (offset < size);
    } finally {
      await handle.close();
    }
    return sha256;
  }

  private async uncommitted(): Promise<{ id: string; path: string }[]> {
    const found: { id: string; path: string }[] = [];
    for (const project of this.host.projects()) {
      try {
        const status = await git(project.path, ["status", "--porcelain"], { timeoutMs: 10_000 });
        if (status.trim()) found.push(project);
      } catch {
        // Not a repository, or out of reach: nothing to say of it.
      }
    }
    return found;
  }
}

class Cancelled extends Error {}

/** The captain started the first mate here again: the commit stops asking. */
class StartedHere extends Error {}

function reason(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A repository's remotes, or null for a folder that is not one. */
async function readRemotes(path: string): Promise<MovedProject["remotes"] | null> {
  try {
    await git(path, ["rev-parse", "--git-dir"], { timeoutMs: 10_000 });
  } catch {
    return null;
  }
  const names = (await git(path, ["remote"], { timeoutMs: 10_000 }).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const remotes: MovedProject["remotes"] = [];
  for (const name of names.slice(0, 32)) {
    const url = (
      await git(path, ["remote", "get-url", name], { timeoutMs: 10_000 }).catch(() => "")
    ).trim();
    if (url) remotes.push({ name, url });
  }
  return remotes;
}

export { HOME_MOVE_CHANGE };
