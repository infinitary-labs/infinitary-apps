import { userInfo } from "node:os";
import { join } from "node:path";
import { CONNECTION_PORT } from "@shared/connection";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type ComputerReach,
  computerPresenceOf,
  type DeviceChip,
  type DeviceInvite,
  type DeviceInviteRequest,
  type DeviceSystem,
  type DeviceView,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  deviceLabel,
  deviceRunsWork,
  reachFrom,
} from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { overridePasses } from "@shared/holds";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { ComputerResourcesView } from "@shared/resources";
import { interfacesFromAddresses } from "../connection/addresses";
import type { CoreEventSink } from "../events";
import { appLauncher } from "../helper/launcher";
import { bootedAt } from "../helper/lock";
import type { HostCapabilities } from "../host";
import { hostEnv } from "../hostEnv";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { TICK_PERIOD_MS, type Ticker } from "../orchestrator/ticker";
import type { AppPaths } from "../paths";
import { ComputerLoads } from "../placed/computerLoads";
import { ComputerResourceFeed } from "../placed/computerResourceFeed";
import { ComputerResources } from "../placed/computerResources";
import { LoadLine } from "../placed/loadLine";
import type { PlacedSessions } from "../placed/placedSessions";
import { readProcesses } from "../placed/processResources";
import { ResourceSampler } from "../placed/resourceSampler";
import { WorkDevices } from "../placed/workDevices";
import { hostPlatform, thisDeviceSystem } from "../platform";
import {
  AppDataWatch,
  runPrivacyLog,
  SYSTEM_LOG,
  systemProcessReader,
  taskOfProcess,
} from "../privacy/appDataWatch";
import type { StandIns } from "../standIns";
import type { TaskService } from "../tasks/taskService";
import { linuxUpdateCommand, readLinuxInstallation } from "../update/linuxInstall";
import { findOnPath } from "../userBin";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { dnsSdAnnounceArgs, HomeAnnouncement } from "./announce";
import { avahiAnnounceArgs } from "./avahi";
import { ownComputerName, ownNetworkNames } from "./computerName";
import { Computers } from "./computers";
import { DeviceSetup } from "./deviceSetup";
import { DeviceSignIns, type DeviceSignInsOptions } from "./deviceSignIns";
import { DeviceUpdateNudge } from "./deviceUpdateNudge";
import { runDnsSd, runDnsSdHeld, SYSTEM_DNS_SD } from "./dnsSd";
import { type FarBuild, FarBuilds } from "./farBuilds";
import { farSystemNamed } from "./farSystems";
import { firewallKeepsOut } from "./firewall";
import { appBundleOf, joinCommand } from "./joinCommand";
import { NearbyMacs } from "./nearby";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";
import { PublishedBuilds, standInTapFetch } from "./publishedBuilds";
import { RemoteLogin } from "./remoteLogin";
import { systemSsh } from "./ssh";
import { SshConnections } from "./sshConnections";

/**
 * The home's devices wiring (docs/devices.md): pairing, the computers that
 * run work for this home and their load, Remote Login and SSH to a computer
 * added by its address, Macs nearby, the Bonjour announcement and the door a
 * phone asks at, the privacy watch, and each computer's own sign-ins. Your
 * devices, Remove and Update, and each computer's setup and update cards
 * read the crew, so they are made once the supervisor holds the stack
 * (`attachCrew`).
 */
export type HomeDevices = {
  /**
   * The computers that run work for this home (docs/helper.md, "Holding a
   * conversation"): the connection reaches them once the shell attaches it,
   * and a task whose record names one opens its conversation there.
   */
  work: WorkDevices;
  loadLine: LoadLine;
  computerResources: ComputerResources;
  computerLoads: ComputerLoads;
  /** Pairing: the one writer over userData/devices, and the connection's pairing seam. */
  pairing: DevicePairing;
  computerResourceFeed: ComputerResourceFeed;
  /** The app a command on another Mac gets from this one, or null when this copy cannot send itself. */
  appBundle: string | null;
  /**
   * The Firstmate for a computer of `system` on `chip`, or the Ubuntu package
   * a command asks for to install there, or null when there is none to send.
   */
  farBuild: (
    system: DeviceSystem | undefined,
    chip: DeviceChip | undefined,
    kind?: "deb",
  ) => Promise<FarBuild | null>;
  /** Makes a link for a device, wrapped in the command for one when asked (docs/devices.md, "Joining by a command"). */
  inviteDevice: (request: DeviceInviteRequest) => Promise<DeviceInvite>;
  sshConnections: SshConnections;
  /** One reach value, worked out once and handed to every reader. */
  reachOf: (deviceId: string) => ComputerReach;
  remoteLogin: RemoteLogin;
  nearbyMacs: NearbyMacs;
  homeAnnouncement: HomeAnnouncement;
  phoneDoor?: PhoneDoor;
  privacyWatch: AppDataWatch | null;
  /** Each computer that runs work signing in to its own subscriptions. */
  signIns: DeviceSignIns;
  /** A computer connected on an older Firstmate takes no new work: answered by Your devices. */
  takesNoWorkUntilUpdated: (deviceId: string) => boolean;
  /** A task began waiting for an update: its card comes back, even after Not now. */
  recallUpdateCard: (deviceId: string) => void;
  /** Each computer's resources reach the pressure watch from here on. */
  attachPressure: (observe: (view: ComputerResourcesView) => void) => void;
  /** A computer's word on its sign-ins reaches the crew from here on. */
  attachSignIns: (changed: (deviceId: string) => void) => void;
  /** Your devices and each computer's setup and update cards, once the supervisor holds the stack. */
  attachCrew: (crew: DevicesCrew) => { computers: Computers; setup: DeviceSetup };
};

/** What Your devices and the devices' cards read of the crew. */
export type DevicesCrew = {
  supervisor: Pick<
    CrewSupervisor,
    | "stopTasksOn"
    | "pauseForUpdate"
    | "resumeAfterUpdate"
    | "raiseHostCard"
    | "withdrawHostCard"
    | "hasCard"
    | "cardStored"
    | "cardChosenAction"
    | "projectForgeSignInNeeded"
    | "resumeDeviceForgeSignInTasks"
    | "observeRequiredActionDevice"
  >;
  placed: Pick<PlacedSessions, "bringHome">;
  repos: RepoRegistry;
  ticker: Ticker;
};

export async function startHomeDevices(options: {
  host: Pick<HostCapabilities, "app" | "resourceMemory">;
  paths: Pick<AppPaths, "userData" | "devicesDir" | "phoneDoorDir">;
  standIns: StandIns;
  tasks: TaskService;
  emit: CoreEventSink;
  broadcastEvent: (event: FmEvent) => void;
  /** The ids this Mac's rail protects for a provider: a computer's Codex and Grok lists are judged by it. */
  protectedIds: DeviceSignInsOptions["protectedIds"];
  /** The board's presentation refresh, set up with the crew. */
  scheduleWorkPresentation: () => void;
}): Promise<HomeDevices> {
  const { host, paths, standIns, tasks, emit, broadcastEvent } = options;
  const packaged = host.app.packaged;
  const workDevices = new WorkDevices();
  const loadOverridden = (taskId: string): boolean => {
    const delivery = tasks.get(taskId)?.delivery;
    return overridePasses(delivery, "load-line", delivery?.headSha);
  };
  const loadLine = new LoadLine({
    stateFile: join(paths.userData, "load", "holds.json"),
    overridden: loadOverridden,
    changed: () => tasks.invalidatePresentation(),
  });
  const computerResources = new ComputerResources({
    work: workDevices,
    local: new ResourceSampler({
      memory: host.resourceMemory,
      processes: readProcesses,
      observed: (observation, processes, started, window, cpuWindow) =>
        loadLine.observe(observation, processes, started, window, cpuWindow),
    }),
  });
  const computerLoads = new ComputerLoads({
    local: loadLine,
    work: workDevices,
    changed: () => tasks.invalidatePresentation(),
    overrides: (computerId) => tasks.passingOverridesForComputer(computerId, "load-line"),
  });
  // Made once the supervisor holds the stack (`attachCrew`).
  let computers: Computers | undefined;
  let deviceSetup: DeviceSetup | undefined;
  let updateNudge: DeviceUpdateNudge | undefined;
  // Leave from a Mac that runs work is Remove's, which brings its work here
  // first; bound once Your devices exists (docs/devices.md, "Leave").
  let leaveWithWork: (device: DeviceView) => boolean = () => false;
  // Devices reads each connection's state; the list is made further on.
  let devicesChanged = () => {};
  let observePressure: (view: ComputerResourcesView) => void = () => {};
  // A computer's word on its sign-ins reaches the crew once it exists: a
  // cut-off it names holds its tasks there, and its end lets them go on.
  let onDeviceSignIns: (deviceId: string) => void = () => {};
  // A development picture's addresses.
  const standInAddresses = standIns.addresses;
  const interfaces = () => (standInAddresses ? interfacesFromAddresses(standInAddresses) : {});
  const devices = new DevicePairing({
    dir: paths.devicesDir,
    // Dev/e2e may keep the connection to loopback at a port of its own
    // (tests/e2e/launch.ts): with no private address in view, a link names
    // 127.0.0.1 at that port, so a test never listens on this Mac's network,
    // where a firewall can drop the dial, or on the port a real app holds.
    ...(standIns.loopbackPort !== undefined
      ? { port: standIns.loopbackPort, interfaces }
      : standInAddresses
        ? { interfaces }
        : {}),
    // Dev/e2e may stand in another Mac for every device that joins, so two
    // apps on one Mac read as two Macs; an installed app never does.
    ...(standIns.joinsFromAnotherMac ? { joinsFromAnotherMac: true } : {}),
    leaveWithWork: (device) => leaveWithWork(device),
    // A Linux home says when its own firewall may keep devices out
    // (docs/devices.md, "A Linux home's firewall"); a Mac's asks its person.
    ...(hostPlatform() === "linux"
      ? { firewall: () => firewallKeepsOut({ port: CONNECTION_PORT }) }
      : {}),
    // One feed line when a device joins, or finds this Mac again; it names
    // the device, never the link. A computer that runs work then gets its
    // setup card (docs/devices.md, "Finishing its setup").
    onJoined: (device, found, again) => {
      broadcastEvent({
        type: "device_joined",
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        ...(device.user ? { user: device.user } : {}),
        ...(device.onThisMac !== undefined ? { onThisMac: device.onThisMac } : {}),
        ...(found ? { found } : {}),
        ...(again ? { again } : {}),
        ...(device.reachedOn ? { reachedOn: device.reachedOn } : {}),
      });
      deviceSetup?.joined(device, found, again);
    },
    onLeft: (device) =>
      broadcastEvent({
        type: "device_left",
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
      }),
  });
  const computerResourceFeed = new ComputerResourceFeed({
    resources: computerResources,
    computers: () => [
      { computerId: null, label: HERE.This },
      ...devices
        .list()
        .filter((device) => deviceRunsWork(device.kind))
        .map((device) => ({
          computerId: device.id,
          label: deviceLabel(device),
        })),
    ],
    onComputers: (listener) => devices.subscribe(listener),
    onWork: (listener) => tasks.onChange(() => listener()),
    // Asked on every resource tick and task change, so it never composes the
    // whole task history to learn whether one task is active.
    working: () => loadLine.active || tasks.hasStatus("active"),
    load: (computerId) => computerLoads.read(computerId),
    refreshLoad: (computerId) => computerLoads.refresh(computerId),
    onContact: (listener) => workDevices.onWorkDevice(listener),
    emit: (view) => {
      emit("inf:computers:resources", view);
      observePressure(view);
    },
  });
  if (standIns.networkName) {
    devices.noteNetworkName(standIns.networkName);
  } else {
    void ownNetworkNames().then((names) => {
      const local = names.filter((name) => name.endsWith(".local"));
      devices.noteNetworkName(local.at(-1) ?? null);
    });
  }
  // The app a command on another Mac gets from this one, and how another
  // user on this Mac starts this one (docs/devices.md, "Joining by a command").
  const appBundle = appBundleOf({
    packaged,
    executable: process.execPath,
    env: process.env,
    // An installed Linux app sends itself whole only as the AppImage it runs from.
    appImage:
      packaged && hostPlatform() === "linux"
        ? (readLinuxInstallation({
            chip: process.arch,
            resourcesDir: host.app.resourcesDir,
            execPath: process.execPath,
            env: process.env,
          }).appImage ?? null)
        : null,
  });
  const flavor = host.app.flavor ?? (packaged ? "release" : "dev");
  // The Firstmate a computer of another system gets from this one
  // (docs/devices.md, "Infinitary for another system"): this app's own when it
  // suits, else the one published for that system at this version. Only an
  // installed release reads the public tap; a development run reads a
  // stand-in tap a test names, or none, and so keeps link pairing.
  const tapStandIn = standIns.publishedTap;
  const farBuilds = new FarBuilds({
    own: () => appBundle,
    published:
      (packaged && flavor === "release") || tapStandIn
        ? new PublishedBuilds({
            version: host.app.version,
            dir: join(paths.devicesDir, "builds"),
            ...(tapStandIn ? { fetchImpl: standInTapFetch(tapStandIn) } : {}),
          })
        : null,
    chip: thisDeviceSystem().chip ?? null,
  });
  const farBuild: HomeDevices["farBuild"] = async (system, chip, kind) => {
    const far = farSystemNamed(system);
    const on = far ? (chip ?? Object.values(far.chips)[0]) : undefined;
    if (!far || !on || !Object.values(far.chips).includes(on)) return null;
    if (kind && far.system !== "linux") return null;
    const build = await farBuilds.for(far, on, kind);
    return "refusal" in build ? null : build;
  };
  const launcher = appLauncher({
    packaged,
    platform: hostPlatform(),
    execPath: process.execPath,
    appDir: host.app.appDir,
    resourcesDir: host.app.resourcesDir,
    env: process.env,
  });
  const inviteDevice = async (request: DeviceInviteRequest): Promise<DeviceInvite> => {
    // Every Mac added now can both control and run work, so no new link
    // makes one that only controls (docs/devices.md, "The link").
    if (request.kind === "view")
      throw new Error(
        `A new link adds a ${COMPUTER.one} that can control your first mate and run work.`,
      );
    // A command for another Mac adds a Mac; one for another user here a
    // computer that only runs work.
    if (request.command && (request.command === "another-user") !== (request.kind === "work"))
      throw new Error(
        `Only the command for another user on ${HERE.this} adds one that only runs work.`,
      );
    // A Linux home that cannot send itself still makes it: a Linux computer
    // with Infinitary installed joins with that copy, and any other says
    // this computer has nothing to send it (docs/devices.md, "Joining by a command").
    if (
      request.command === "another-mac" &&
      !farBuilds.canSendAny() &&
      !(packaged && host.app.platform !== "darwin")
    )
      throw new Error(
        `This copy of Infinitary cannot send itself to another ${COMPUTER.one}; only an installed one can.`,
      );
    // A command for another Mac downloads this computer's published version
    // there first, looked up without downloading it here, and its link lasts
    // long enough for that download and the copy from here it falls back to
    // (docs/devices.md, "Joining by a command"); a development or
    // unpublished one gets it from here, with a link of the usual lifetime.
    const mac = farSystemNamed("macos");
    const [download, ubuntuPackage] =
      request.command === "another-mac" && mac
        ? await Promise.all([
            farBuilds.downloadFor(mac, Object.values(mac.chips)[0] ?? "arm64"),
            farBuilds.ubuntuPackageDownload(),
          ])
        : [null, null];
    const invite = devices.invite(
      request,
      download ? { lastsMs: DOWNLOAD_COMMAND_LINK_TTL_MS } : {},
    );
    if (!request.command) return invite;
    return {
      ...invite,
      command: {
        for: request.command,
        text: joinCommand({
          for: request.command,
          link: invite.link,
          homeName: await ownComputerName({ packaged, env: process.env }),
          launcher,
          ...(download ? { download: { ...download, expiresAt: invite.expiresAt } } : {}),
          version: host.app.version,
          // The one line that updates an older Ubuntu package there (captain's pick on INF-1181).
          ...(ubuntuPackage
            ? {
                update:
                  linuxUpdateCommand({ chip: "x64", package: "deb" }, ubuntuPackage) ?? undefined,
              }
            : {}),
        }),
      },
    };
  };
  // The captain's own SSH, or a development run's stand-in for it, so a test
  // never reaches a real Mac (docs/devices.md, "Adding a computer by its address").
  const ssh = standIns.ssh ? { program: standIns.ssh, args: [] } : systemSsh();
  // Nothing here starts it: the shell does, once it attached the paired
  // connection.
  const sshConnections: SshConnections = new SshConnections({
    pairing: devices,
    ssh,
    flavor,
    listening: () => workDevices.listening(),
    settled: () => workDevices.settled(),
    // Welcomed on any version: connected, though it may take no new work.
    welcomed: (deviceId) =>
      workDevices.inReach(deviceId) || workDevices.version(deviceId) !== undefined,
    onWorkDevice: (listener) => workDevices.onWorkDevice(listener),
    cleanUpThere: (cleanup) => remoteLogin.cleanUpThere(cleanup),
    emit: (event) => broadcastEvent(event),
    changed: () => devicesChanged(),
  });
  const reachOf = (deviceId: string) =>
    reachFrom({
      inReach: workDevices.inReach(deviceId),
      ssh: sshConnections.state(deviceId),
    });
  const remoteLogin: RemoteLogin = new RemoteLogin({
    pairing: devices,
    ssh,
    flavor,
    appBundle: () => appBundle,
    builds: farBuilds,
    version: host.app.version,
    listening: () => workDevices.settled(),
    inReach: (deviceId) => workDevices.inReach(deviceId),
    connections: sshConnections,
    emit: (event) => broadcastEvent(event),
  });
  const thisUser = () => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  };
  // Macs nearby: macOS's own dns-sd, or a development run's stand-in for
  // it, so a test never listens on the Mac's own network (docs/devices.md,
  // "Macs nearby"). Linux looks with Avahi's avahi-browse where it has one.
  const dnsSd = standIns.dnsSd || (hostPlatform() === "darwin" ? SYSTEM_DNS_SD : undefined);
  const avahiBrowse =
    !dnsSd && hostPlatform() === "linux" ? findOnPath("avahi-browse", hostEnv()) : undefined;
  const nearbyMacs = new NearbyMacs({
    run: dnsSd ? runDnsSd(dnsSd) : null,
    avahi: avahiBrowse ? runDnsSd(avahiBrowse) : null,
    ownNames: () => ownNetworkNames(),
    user: thisUser(),
    changed: (view) => emit("inf:devices:nearby", view),
  });
  // While a phone is on the list this computer announces itself over Bonjour
  // so the phone can find it again (docs/devices.md, "Announcing to a
  // phone"): with dns-sd, or on Linux with Avahi's avahi-publish where it has one.
  const avahiPublish =
    !dnsSd && hostPlatform() === "linux" ? findOnPath("avahi-publish", hostEnv()) : undefined;
  const announcer = dnsSd || avahiPublish;
  const homeAnnouncement = new HomeAnnouncement({
    run: announcer ? runDnsSdHeld(announcer) : null,
    args: dnsSd ? dnsSdAnnounceArgs : avahiAnnounceArgs,
    name: () => ownComputerName({ packaged, env: process.env }),
    port: devices.port,
  });
  homeAnnouncement.devicesChanged(devices.list(), devices.phoneMayJoin());
  devices.subscribe(() => homeAnnouncement.devicesChanged(devices.list(), devices.phoneMayJoin()));
  // A phone signed in to this computer over SSH asks the open app for a
  // one-use phone link at its door (docs/devices.md, "A phone that joins by
  // its address"); with no door, the phone says so and nothing joins. This
  // account's own `infinitary link` asks the same door for a computer's link
  // or a phone's (docs/run.md, "A link by command"). Each is answered once
  // the connection listens for it, as a computer added by its address is.
  const phoneDoor = await PhoneDoor.open({
    dir: paths.phoneDoorDir,
    invite: (phone) => devices.invite({ kind: "mac", ...(phone ? { phone } : {}) }),
    listening: () => workDevices.settled(),
  }).catch((error: unknown) => {
    console.warn(
      `[devices] no phone door, so a phone cannot join by its address: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  // The privacy watch: macOS's own log reader, or a development run's
  // stand-in for it, so a test never reads this Mac's own privacy log
  // (docs/macos-privacy.md). It finds a task by the working copy its
  // process works in, among the live tasks this Mac runs.
  const privacyLog = standIns.privacyLog || (hostPlatform() === "darwin" ? SYSTEM_LOG : undefined);
  const privacyWatch = privacyLog
    ? new AppDataWatch({
        run: runPrivacyLog(privacyLog),
        self: process.pid,
        findTask: (pid) =>
          taskOfProcess(pid, {
            reader: systemProcessReader,
            self: process.pid,
            places: tasks
              .list()
              .filter(
                (record) =>
                  record.status === "active" &&
                  !record.deviceId &&
                  record.workspaceState === "present" &&
                  Boolean(record.worktreeDir),
              )
              .map((record) => ({ taskId: record.id, dir: record.worktreeDir })),
          }),
        note: (taskId, text, facts) => tasks.noteProgress(taskId, text, "host", undefined, facts),
      })
    : null;
  privacyWatch?.start();
  // Each computer that runs work signing in to its own subscriptions: what
  // Settings -> Intelligence draws, and what a task there is routed among.
  const deviceSignIns = new DeviceSignIns({
    devices: () => devices.list(),
    work: workDevices,
    emit,
    broadcastEvent,
    changed: (deviceId) => onDeviceSignIns(deviceId),
    protectedIds: options.protectedIds,
    reachOf,
  });
  return {
    work: workDevices,
    loadLine,
    computerResources,
    computerLoads,
    pairing: devices,
    computerResourceFeed,
    appBundle,
    farBuild,
    inviteDevice,
    sshConnections,
    reachOf,
    remoteLogin,
    nearbyMacs,
    homeAnnouncement,
    ...(phoneDoor ? { phoneDoor } : {}),
    privacyWatch,
    signIns: deviceSignIns,
    takesNoWorkUntilUpdated: (deviceId) => computers?.takesNoWorkUntilUpdated(deviceId) === true,
    recallUpdateCard: (deviceId) => updateNudge?.refresh(deviceId, true),
    attachPressure: (observe) => {
      observePressure = observe;
    },
    attachSignIns: (changed) => {
      onDeviceSignIns = changed;
    },
    attachCrew: ({ supervisor, placed, repos, ticker }) => {
      // Your devices, and Remove for a computer that runs work (docs/devices.md).
      const list = new Computers({
        pairing: devices,
        work: workDevices,
        tasks,
        repos,
        stopTasks: (deviceId) => supervisor.stopTasksOn(deviceId),
        bringHome: (deviceId) => placed.bringHome(deviceId),
        // Its crew pauses for its update and carries on after (docs/helper.md, "Updated by its home").
        pauseTasks: (deviceId) => supervisor.pauseForUpdate(deviceId),
        resumeTasks: (deviceId) => supervisor.resumeAfterUpdate(deviceId),
        removeThere: (device) => remoteLogin.removeThere(device),
        // Update: a computer's version against this Mac's, over Remote Login or
        // the connection (docs/devices.md, "Updating").
        home: { app: host.app.version, contract: PROTOCOL_VERSION },
        updateOverRemoteLogin: (deviceId, update) => remoteLogin.update(deviceId, update),
        // Whether this computer has a Firstmate for that computer's system, and
        // that one got and checked before it is asked to update.
        canSend: (device) => {
          const far = farSystemNamed(device.system);
          const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
          return far !== null && chip !== undefined && farBuilds.canSend(far, chip);
        },
        prepare: async (device) => {
          const far = farSystemNamed(device.system);
          const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
          if (!far || !chip || !farBuilds.fetches(far, chip)) return null;
          const build = await farBuilds.for(far, chip);
          return "refusal" in build ? build.refusal : null;
        },
        // Where a Mac updated over the connection downloads this computer's
        // version itself, looked up without downloading it here
        // (docs/devices.md, "Downloading over the connection").
        download: async (device) => {
          const far = farSystemNamed(device.system);
          const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
          return far && chip ? farBuilds.downloadFor(far, chip) : null;
        },
        emitUpdate: (event) => {
          broadcastEvent(event);
          updateNudge?.updateSaid(event);
        },
        ssh: (deviceId) => sshConnections.state(deviceId),
        reachOf,
        emit: (view) => {
          emit("inf:devices", view);
          emit("inf:computers:presence", computerPresenceOf(view));
        },
        onProblem: (text) => broadcastEvent({ type: "firstmate_note", text }),
        now: ticker.now,
        bootedAt,
      });
      computers = list;
      devicesChanged = () => {
        // Task rows say connecting by the same reach: they follow it at once.
        options.scheduleWorkPresentation();
        list.refresh();
        deviceSignIns.pushView();
      };
      // The connecting limit is read when reach is read. The host clock asks
      // whether that read moved, and pushes only then.
      ticker.register("device-reach", TICK_PERIOD_MS, () => {
        if (sshConnections.due()) devicesChanged();
      });
      // Its work comes here first, or once it is back, as Remove's would.
      leaveWithWork = (device) => {
        list.remove(device.id, "when-back").catch((error: unknown) =>
          broadcastEvent({
            type: "firstmate_note",
            text: `${device.name} left, and its removal could not finish: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
        return true;
      };
      // Finishing a computer's setup (docs/devices.md, "Finishing its setup"):
      // the host's own card at join, from typed facts, and the GitHub card a
      // project raises when it runs on a computer with no GitHub sign-in.
      const setup = new DeviceSetup({
        devices: () => devices.list(),
        repos,
        signIns: {
          lastSaid: (deviceId) => deviceSignIns.lastSaid(deviceId),
          signInsOf: (deviceId) => deviceSignIns.signInsOf(deviceId),
        },
        cards: {
          raise: (card) => supervisor.raiseHostCard(card),
          withdraw: (id, reason) => supervisor.withdrawHostCard(id, reason),
          has: (id) => supervisor.hasCard(id),
          stored: (id) => supervisor.cardStored(id),
          chosenAction: (id) => supervisor.cardChosenAction(id),
        },
        broadcastEvent,
        forgeNeeded: (deviceId, forgeHost, repo) =>
          supervisor.projectForgeSignInNeeded(deviceId, forgeHost, repo),
        forgeReady: (deviceId, forgeHost) =>
          void supervisor.resumeDeviceForgeSignInTasks(deviceId, forgeHost),
      });
      deviceSetup = setup;
      repos.onRunsOn((repo) => setup.runsOnChanged(repo));
      workDevices.onWorkDevice((contact) => setup.contact(contact));
      // The card that nudges the captain to update a computer on an older
      // Firstmate (docs/devices.md, "Another version, and updating").
      const nudge = new DeviceUpdateNudge({
        devices: () => list.list(),
        homeApp: () => host.app.version,
        cards: {
          raise: (card) => supervisor.raiseHostCard(card),
          withdraw: (id, reason) => supervisor.withdrawHostCard(id, reason),
          has: (id) => supervisor.hasCard(id),
          chosenAction: (id) => supervisor.cardChosenAction(id),
        },
        broadcastEvent,
      });
      updateNudge = nudge;
      workDevices.onVersion((deviceId, version) => {
        if (version) supervisor.observeRequiredActionDevice(deviceId, version);
        nudge.refresh(deviceId);
      });
      devices.subscribe(() => {
        setup.devicesChanged();
        nudge.devicesChanged();
      });
      // Where devices find this Mac, whole, whenever it reads differently - the
      // captain's choice, or this Mac's network while pairing follows it - so
      // Settings -> Devices says where this Mac is now with the tab open.
      let addressesSaid = JSON.stringify(devices.addresses());
      devices.subscribe(() => {
        const addresses = devices.addresses();
        const said = JSON.stringify(addresses);
        if (said === addressesSaid) return;
        addressesSaid = said;
        emit("inf:devices:addresses", addresses);
      });
      return { computers: list, setup };
    },
  };
}
