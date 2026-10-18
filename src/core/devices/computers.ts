import {
  awayWord,
  type DeviceOtherVersion,
  type DeviceRemovalStage,
  type DeviceRemoveWhen,
  type DeviceSsh,
  type DeviceView,
  deviceConnecting,
  deviceControls,
  deviceLabel,
  deviceRunsWork,
} from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { PROTOCOL_VERSION, takesUpdate } from "@shared/ipc";
import {
  type RemoteLoginPasswordQuestion,
  type RemoteLoginRefusal,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { devicePlace } from "@shared/signIns";
import { updateOrders, WORK_UPDATE_ORDER } from "@shared/work";
import {
  DeviceOutOfReachError,
  type ViewDeviceContact,
  type WorkDeviceContact,
  type WorkDeviceVersion,
} from "../connection/connection";
import type { WorkDevices } from "../placed/workDevices";
import { TaskService } from "../tasks/taskService";
import { compareSemver } from "../update/semver";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { DevicePairing } from "./pairing";
import { RemoteLoginRefusedError } from "./remoteLogin";

/**
 * Your devices as Settings -> Devices lists them, and Remove for a computer
 * that runs work (docs/devices.md, "Your devices" and "Remove"; design
 * skill `components/devices/DevicesTab`).
 *
 * The list is pairing's, with what the home reads of each device right
 * now: whether it is in reach and when it was last; for a Mac that
 * controls this Firstmate, whether it controls it now; and for a computer
 * that runs work, whether this Mac's address changed since or macOS there
 * holds its dial on the local network, the projects
 * whose Runs on names it, how many tasks run there, and where its removal
 * stands. It is pushed whole (`inf:devices`) whenever any of that changes.
 *
 * Removing a computer that runs work never loses work that never merged:
 * in reach, its projects run on this Mac from then on, each task started
 * there stops, every task's unmerged work comes here as its kept work, and
 * only then is it taken off the list, which has it remove what Firstmate
 * set up there. Out of reach, the captain chooses: remove it once it is
 * back, the same way, or now, which leaves its unmerged work there.
 *
 * A computer connected on another version of Firstmate than this Mac's says
 * so on the list, whether or not it still takes work, and Update brings it
 * to this Mac's version (docs/devices.md, "Another version" and
 * "Updating"): over Remote Login for one added by its address, otherwise
 * over the connection, where the computer gets this Mac's Firstmate with
 * its own key, keeps it, and starts again. One too old to take the update
 * order is updated by a new command run there.
 */

/** One step of an update over the connection, as the feed says it. */
export type DeviceUpdateEvent = Extract<FmEvent, { type: "device_update" }>;

export type ComputersOptions = {
  pairing: DevicePairing;
  work: WorkDevices;
  tasks: TaskService;
  repos: RepoRegistry;
  /** Each task started on that computer stops (`CrewSupervisor.stopTasksOn`), resolving once each is closed. */
  stopTasks: (deviceId: string) => Promise<void>;
  /** Every closed task's work there comes here (`PlacedSessions.bringHome`); rejects when some could not. */
  bringHome: (deviceId: string) => Promise<void>;
  /**
   * Removes what Firstmate set up on a computer added by its address, over
   * Remote Login (`RemoteLogin.removeThere`): true once nothing is left there
   * for it to hear. Absent, a computer removed out of reach always hears it
   * the next time it dials.
   */
  removeThere?: (device: DeviceView) => Promise<boolean>;
  /**
   * This Mac's own versions - of Firstmate, when it is known, and of the
   * contract it speaks - which a computer's are measured against.
   */
  home?: { app?: string; contract: string };
  /** Updates Firstmate on a computer added by its address, over Remote Login (`RemoteLogin.update`). */
  updateOverRemoteLogin?: (
    deviceId: string,
    options?: { password?: string },
  ) => Promise<DeviceView | RemoteLoginPasswordQuestion>;
  /**
   * Whether this computer has a Firstmate for that computer's system: its own,
   * or the one published for it (docs/devices.md, "Infinitary for another system").
   */
  canSend?: (device: DeviceView) => boolean;
  /**
   * Gets and checks the Firstmate published for that computer's system before
   * it is asked to update, so its copy starts at once; answers why it could
   * not, or null.
   */
  prepare?: (device: DeviceView) => Promise<RemoteLoginRefusal | null>;
  /** One step of an update over the connection, for the feed. */
  emitUpdate?: (event: DeviceUpdateEvent) => void;
  /**
   * Where this Mac's own SSH connection to a computer stands
   * (`SshConnections.state`), for one it reaches that way; none while no
   * such connection is kept.
   */
  ssh?: (deviceId: string) => DeviceSsh | undefined;
  /** How long an update waits for the computer to come back on this Mac's version. */
  updateWaitMs?: number;
  /** The list, whole, after any change. */
  emit: (devices: DeviceView[]) => void;
  /** A note for the log that a removal waiting for a computer could not finish yet. */
  onProblem: (text: string) => void;
  now: () => number;
  /** When this Mac last started, in milliseconds since the epoch. */
  bootedAt: () => number;
};

type Removing = { stage: DeviceRemovalStage; runs: string[] };

/** How long an update waits for the computer to start again on this Mac's version. */
const UPDATE_WAIT_MS = 3 * 60_000;

export class Computers {
  /** Removals under way, with the projects each computer ran when it began. */
  private readonly removing = new Map<string, Removing>();
  /** Computers being updated over the connection now. */
  private readonly updating = new Set<string>();
  private said = "";

  constructor(private readonly options: ComputersOptions) {
    options.pairing.subscribe(() => this.changed());
    options.work.onWorkDevice((contact) => this.contact(contact));
    options.work.onViewDevice((contact) => this.viewContact(contact));
    // Connected on any version, it is seen; its version is on the list.
    options.work.onVersion((deviceId) => {
      options.pairing.seen(deviceId, options.now());
      this.changed();
    });
    // Where the connection listens moved, so whether this Mac's address
    // changed since a computer last reached it may read differently now.
    options.work.onListening(() => this.changed());
    options.repos.onRunsOn(() => this.changed());
    options.tasks.onChange(() => this.changed());
  }

  /** Every device on the list, oldest first, with what the home reads of each right now. */
  list(): DeviceView[] {
    const { pairing, work, tasks, repos } = this.options;
    const devices = pairing.list();
    if (devices.length === 0) return devices;
    // Tasks and projects are read only when a computer runs work.
    const working = devices.some((device) => deviceRunsWork(device.kind));
    const running = working ? tasks.listActive() : [];
    const projects = working ? repos.list() : [];
    const booted = this.options.bootedAt();
    const listening = work.listening();
    return devices.map((device) => {
      if (!deviceRunsWork(device.kind)) {
        // A Mac that controls this Firstmate is in reach while Firstmate is open on it.
        const controlling = work.controlling(device.id);
        const seenAt = pairing.lastSeen(device.id);
        return {
          ...device,
          inReach: controlling,
          ...(seenAt !== undefined ? { seenAt } : {}),
          controlling,
        };
      }
      const inReach = work.inReach(device.id);
      const version = work.version(device.id);
      const ssh = this.options.ssh?.(device.id);
      const otherVersion = version ? this.otherVersion(device, version) : undefined;
      const seenAt = pairing.lastSeen(device.id);
      const removing = this.removing.get(device.id);
      const removal: DeviceRemovalStage | undefined =
        removing?.stage ?? (pairing.removingWhenBack(device.id) ? "when-back" : undefined);
      const stranded = !inReach && !version && pairing.addressChanged(device.id, listening);
      return {
        ...device,
        inReach,
        ...(otherVersion ? { otherVersion } : {}),
        ...(seenAt !== undefined ? { seenAt } : {}),
        ...(!inReach && !version && device.onThisMac && (seenAt ?? device.pairedAt) < booted
          ? { restartedSince: true }
          : {}),
        // Connected on another version, it found this Mac where it is now.
        ...(stranded ? { addressChanged: true } : {}),
        // A new address strands it first: that is the way back to say.
        ...(!inReach && !version && !stranded && pairing.heldOnLocalNetwork(device.id)
          ? { heldOnLocalNetwork: true }
          : {}),
        tasks: running.filter((record) => record.deviceId === device.id).length,
        runs:
          removing?.runs ??
          projects.filter((repo) => repo.runsOn === device.id).map((repo) => repo.name),
        ...(removal ? { removal } : {}),
        ...(ssh ? { ssh } : {}),
        // A Mac that also controls this Firstmate says so while Firstmate is open there.
        ...(deviceControls(device.kind) ? { controlling: work.controlling(device.id) } : {}),
      };
    });
  }

  /**
   * Remove (docs/devices.md, "Remove"): a Mac that controls this Firstmate
   * is cut off at once. A computer that runs work in reach has its work
   * brought here first; out of reach, `when` is the captain's choice, and
   * with none this refuses, so the question is asked.
   */
  async remove(deviceId: string, when?: DeviceRemoveWhen): Promise<DeviceView> {
    const device = this.options.pairing.list().find((entry) => entry.id === deviceId);
    if (!device) throw new Error("No device with that id is on the list.");
    if (!deviceRunsWork(device.kind)) return this.options.pairing.remove(deviceId);
    const { label } = devicePlace([device], deviceId);
    if (this.removing.has(deviceId)) throw new Error(`${label} is being removed already.`);
    if (this.options.work.inReach(deviceId)) return this.removeWithWork(device);
    if (when === "when-back") {
      this.options.pairing.removeWhenBack(deviceId, true);
      return this.viewOf(deviceId) ?? device;
    }
    if (when === "now") return this.removeNow(device);
    const away = awayWord(deviceConnecting({ inReach: false, ssh: this.options.ssh?.(deviceId) }));
    throw new Error(
      `${label} is ${away}. Choose to remove it when it is back, with its work, or now.`,
    );
  }

  /**
   * Update (docs/devices.md, "Updating"): brings Firstmate on a computer that
   * runs work to this Mac's version - over Remote Login for one added by its
   * address, otherwise over the connection - and answers it on the list
   * once it is back, or rejects with the refusal's two lines, which the feed
   * said too.
   */
  async update(
    deviceId: string,
    options?: { password?: string },
  ): Promise<DeviceView | RemoteLoginPasswordQuestion> {
    const device = this.options.pairing.list().find((entry) => entry.id === deviceId);
    if (!device) throw new Error("No device with that id is on the list.");
    if (!deviceRunsWork(device.kind))
      throw new Error(`${device.name} controls your first mate, and runs no work to update.`);
    if (this.removing.has(deviceId)) throw new Error(`${deviceLabel(device)} is being removed.`);
    if (device.remoteLogin) {
      const update = this.options.updateOverRemoteLogin;
      if (!update) throw new Error(`${deviceLabel(device)} cannot be reached over Remote Login.`);
      const updated = await update(deviceId, options);
      if ("asks" in updated) return updated;
      return this.viewOf(deviceId) ?? updated;
    }
    return this.updateOverConnection(device);
  }

  /** Something the list reads changed outside it, such as an SSH connection's state: pushed when it shows. */
  refresh(): void {
    this.changed();
  }

  /** Keep it: a computer waiting to be removed once it is back stays on the list. */
  keep(deviceId: string): DeviceView {
    this.options.pairing.removeWhenBack(deviceId, false);
    const view = this.viewOf(deviceId);
    if (!view) throw new Error("No device with that id is on the list.");
    return view;
  }

  // ---- inside -------------------------------------------------------------------

  private async removeWithWork(device: DeviceView): Promise<DeviceView> {
    const { label } = devicePlace([device], device.id);
    const runs = this.moveProjectsHome(device.id);
    this.removing.set(device.id, { stage: "bringing-work", runs });
    this.changed();
    try {
      await this.options.stopTasks(device.id);
      await this.options.bringHome(device.id);
      this.removing.set(device.id, { stage: "cleaning-up", runs });
      this.changed();
      // Off the list: cut off at once, it removes what Firstmate set up
      // there; one this Mac reaches over its own SSH is also cleaned up over
      // it, in case it never heard.
      const gone = this.options.pairing.remove(device.id, { cleanUpThere: true });
      return { ...gone, runs };
    } catch (caught) {
      const why = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`Could not bring ${label}'s work here: ${why}. It stays on your list.`);
    } finally {
      this.removing.delete(device.id);
      this.changed();
    }
  }

  /**
   * Remove now, out of reach: its tasks stop here, their working copies
   * stay there with any unmerged work, and it removes what Firstmate set
   * up there once it is back and learns it was removed.
   */
  private async removeNow(device: DeviceView): Promise<DeviceView> {
    const { label } = devicePlace([device], device.id);
    const runs = this.moveProjectsHome(device.id);
    await this.options.stopTasks(device.id);
    for (const record of this.options.tasks.list()) {
      if (record.deviceId !== device.id || record.workspaceState !== "present") continue;
      if (!TaskService.isClosed(record)) continue;
      this.options.tasks.markWorkspaceRemoved(record.id);
      this.options.tasks.note(
        record.id,
        `working copy left on ${label} - it was removed while out of reach, so any unmerged work stays there`,
        { news: true, data: { device: device.id } },
      );
    }
    // Added by its address, what Firstmate set up there is removed over
    // Remote Login now; when that cannot be done yet, this Mac tries again
    // over SSH later (`DevicePairing.sshCleanups`). Otherwise it hears it was
    // removed the next time it dials, and removes that itself.
    const removedThere = device.remoteLogin
      ? await (this.options.removeThere?.(device) ?? Promise.resolve(false)).catch(() => false)
      : false;
    const gone = this.options.pairing.remove(device.id, {
      farewell: !removedThere,
      cleanUpThere: !removedThere,
    });
    return { ...gone, runs };
  }

  /**
   * Updating over the connection (docs/devices.md, "Updating over the
   * connection"): the computer takes the update order whatever its major,
   * gets this Mac's Firstmate with its own key when it keeps a copy, and
   * starts again; this waits for it to come back on this Mac's version.
   */
  private async updateOverConnection(device: DeviceView): Promise<DeviceView> {
    const { work } = this.options;
    const label = deviceLabel(device);
    const say = (stage: DeviceUpdateEvent["stage"], text: string, tone: "info" | "warn" = "info") =>
      this.options.emitUpdate?.({
        type: "device_update",
        deviceId: device.id,
        name: label,
        stage,
        text,
        tone,
      });
    const refuse = (refusal: RemoteLoginRefusal): never => {
      const lines = remoteLoginWords.refused(refusal, {
        address: label,
        name: label,
        doing: "update",
      });
      for (const line of lines) say("refused", line, "warn");
      throw new RemoteLoginRefusedError(refusal, lines, lines.join(" "));
    };
    if (this.updating.has(device.id)) throw new Error(`${label} is being updated already.`);
    const version = work.version(device.id);
    if (!version) return refuse("out-of-reach");
    if (!this.otherVersion(device, version)) return refuse("current");
    if (!takesUpdate(version.contract)) return refuse("not-updatable");
    // Another user on this Mac runs this Mac's own app; another Mac gets it from here.
    const runsThisApp = device.onThisMac === true && device.user !== undefined;
    if (!runsThisApp && !(this.options.canSend?.(device) ?? false)) return refuse("cannot-send");

    this.updating.add(device.id);
    try {
      say("updating", remoteLoginWords.updating(device));
      if (!runsThisApp) {
        const unready = await this.options.prepare?.(device);
        if (unready) return refuse(unready);
      }
      // Listening before it is asked, so its return is never missed.
      const back = this.backOnThisVersion(device);
      let answer: { restarts: boolean };
      try {
        answer = updateOrders[WORK_UPDATE_ORDER].response.parse(
          await work.ask(device.id, WORK_UPDATE_ORDER, [], { anyVersion: true }),
        );
      } catch (caught) {
        back.cancel();
        console.warn(`[devices] could not update ${label}:`, caught);
        return refuse(caught instanceof DeviceOutOfReachError ? "out-of-reach" : "failed");
      }
      if (!answer.restarts) {
        back.cancel();
        say("done", remoteLoginWords.updatedByHand(device));
      } else if (await back.came) say("done", remoteLoginWords.updated(device, "running"));
      else for (const line of remoteLoginWords.notBack(device)) say("done", line, "warn");
      return this.viewOf(device.id) ?? device;
    } finally {
      this.updating.delete(device.id);
    }
  }

  /** Resolves true once the computer is connected on this Mac's version, false after the wait. */
  private backOnThisVersion(device: DeviceView): { came: Promise<boolean>; cancel: () => void } {
    let settle: (came: boolean) => void = () => {};
    const came = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const stop = this.options.work.onVersion((deviceId, version) => {
      if (deviceId === device.id && version && !this.otherVersion(device, version)) done(true);
    });
    const timer = setTimeout(() => done(false), this.options.updateWaitMs ?? UPDATE_WAIT_MS);
    timer.unref?.();
    const done = (value: boolean) => {
      clearTimeout(timer);
      stop();
      settle(value);
    };
    return { came, cancel: () => done(false) };
  }

  /**
   * Whether the computer is connected on an older Firstmate than this Mac's
   * and takes no new work because of it: a task for it waits for an update,
   * which is not being out of reach.
   */
  takesNoWorkUntilUpdated(deviceId: string): boolean {
    const version = this.options.work.version(deviceId);
    if (!version || version.takesWork) return false;
    const device = this.options.pairing.list().find((entry) => entry.id === deviceId);
    return !!device && this.otherVersion(device, version)?.than === "older";
  }

  /**
   * What the list says of a computer connected on another version of
   * Firstmate than this Mac's: undefined when it runs this Mac's. Two
   * versions of Firstmate are compared when both are known, else the
   * contracts they speak.
   */
  private otherVersion(
    device: DeviceView,
    version: WorkDeviceVersion,
  ): DeviceOtherVersion | undefined {
    const home = this.options.home ?? { contract: PROTOCOL_VERSION };
    const apps = version.app !== undefined && home.app !== undefined;
    if (apps ? version.app === home.app : version.contract === home.contract) return undefined;
    const order = apps
      ? compareSemver(version.app as string, home.app as string)
      : compareSemver(version.contract, home.contract);
    return {
      ...(version.app !== undefined ? { app: version.app } : {}),
      ...(order ? { than: order < 0 ? ("older" as const) : ("newer" as const) } : {}),
      takesWork: version.takesWork,
      updateBy: device.remoteLogin
        ? "remote-login"
        : takesUpdate(version.contract)
          ? "connection"
          : "command",
    };
  }

  /** Every project that runs on the computer runs on this Mac from now; answers their names. */
  private moveProjectsHome(deviceId: string): string[] {
    const moved: string[] = [];
    for (const repo of this.options.repos.list()) {
      if (repo.runsOn !== deviceId) continue;
      this.options.repos.setRunsOn(repo.id, null);
      moved.push(repo.name);
    }
    return moved;
  }

  private contact(contact: WorkDeviceContact): void {
    const { pairing } = this.options;
    pairing.seen(contact.deviceId, this.options.now());
    if (
      contact.contact === "in-reach" &&
      pairing.removingWhenBack(contact.deviceId) &&
      !this.removing.has(contact.deviceId)
    ) {
      const device = pairing.list().find((entry) => entry.id === contact.deviceId);
      if (device)
        void this.removeWithWork(device).catch((caught: unknown) =>
          this.options.onProblem(caught instanceof Error ? caught.message : String(caught)),
        );
    }
    this.changed();
  }

  /** A Mac that controls this Firstmate connected or went: when it was last seen is kept. */
  private viewContact(contact: ViewDeviceContact): void {
    this.options.pairing.seen(contact.deviceId, this.options.now());
    this.changed();
  }

  private viewOf(deviceId: string): DeviceView | undefined {
    return this.list().find((device) => device.id === deviceId);
  }

  /** Pushes the list when what it says changed. */
  private changed(): void {
    const devices = this.list();
    const said = JSON.stringify(devices);
    if (said === this.said) return;
    this.said = said;
    this.options.emit(devices);
  }
}
