import { join } from "node:path";
import { Type } from "typebox";
import { vi } from "vitest";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { joinHome } from "../../src/core/helper/join";
import { PlacedTasks } from "../../src/core/helper/placedTasks";
import { type HelperRun, startHelper } from "../../src/core/helper/run";
import { SessionHost } from "../../src/core/helper/sessionHost";
import { appPathsFor } from "../../src/core/paths";
import { PlacedSessions } from "../../src/core/placed/placedSessions";
import { WorkDevices } from "../../src/core/placed/workDevices";
import type { SessionFactory, SessionSpec } from "../../src/core/session/session";
import { type CrewmateToolDelegate, crewmateTool } from "../../src/core/session/tools";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  HOME_CAPABILITIES,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  parseInvokeRequest,
} from "../../src/shared/ipc";
import { claimedPort } from "./claimedPort";
import { freshDatabase } from "./database";
import { scratchDir } from "./scratchDirs";
import {
  CONTRACT_TOOL,
  CONTRACT_TOOL_RESULT,
  type ContractWorld,
  CREWMATE_TASK,
} from "./sessionContract";

/**
 * The session contract's world for a crewmate's conversation held on a
 * computer that runs work (src/core/placed/; docs/helper.md, "Holding a
 * conversation"): a backend's own world (`inner`) moved onto another
 * computer. The home is `PlacedSessions` behind the real connection and
 * pairing, with a record that places the contract crewmate's task on that
 * computer; the computer is the helper as the work mode composes it,
 * joined through the real pairing, whose `SessionHost` opens the backend's
 * own factory. Every case opens through the home's factory for that
 * computer, so every order, callback and event crosses the connection.
 *
 * The contract's tool crosses the way a crewmate's tools do: it runs on the
 * computer, and its one callback asks the home, which runs the case's tool
 * there. The working copy is the computer's task folder.
 */

const BUILDER = { name: "builder", uid: 502 };

/** What a world started that outlives its case. */
const started: {
  runs: HelperRun[];
  connections: HomeConnection[];
  pairings: DevicePairing[];
  closes: (() => void)[];
} = { runs: [], connections: [], pairings: [], closes: [] };

/**
 * The contract tool on the computer: it asks the home through a crewmate
 * callback and answers what the contract tool answers.
 */
const lookUpThere = crewmateTool({
  name: CONTRACT_TOOL,
  label: "Look up",
  description: "Look the contract answer up.",
  parameters: Type.Object({}),
  bind: (delegate) => {
    const onProgress = delegate.onProgress;
    if (!onProgress) return undefined;
    return async () => {
      await onProgress("Looked the contract answer up.");
      return { text: CONTRACT_TOOL_RESULT };
    };
  },
});

/** The home's callbacks for a case's spec: the contract tool runs here when the computer asks. */
function callbacksOf(spec: SessionSpec): CrewmateToolDelegate {
  const tool = spec.tools.find((each) => each.name === CONTRACT_TOOL);
  return {
    ...spec.callbacks,
    ...(tool
      ? {
          onProgress: async () => {
            await tool.run({});
            return "Looked up.";
          },
        }
      : {}),
  };
}

/** The home owners a placed case can read without inventing a second ledger. */
type ContractPlacement = {
  db: ReturnType<typeof freshDatabase>;
  tasks: TaskService;
  paths: ReturnType<typeof appPathsFor>;
  devices: WorkDevices;
  deviceId: string;
  placed: PlacedSessions;
};

export async function placedContractWorld<T extends Pick<ContractWorld, "factory" | "binding">>(
  inner: T,
  options: {
    protocolVersion?: string;
    /** A historical minor-boundary case runs against a matching-major home. */
    homeProtocolVersion?: string;
    now?: () => number;
    schedule?: (ms: number, run: () => void) => () => void;
    /** A native work-side case uses the production conversation composition. */
    conversations?: Parameters<typeof startHelper>[0]["conversations"];
  } = {},
) {
  // The home.
  const db = freshDatabase();
  started.closes.push(() => db.close());
  const now = options.now ?? (() => Date.now());
  const tasks = new TaskService({ db, now });
  const homeRoot = scratchDir("infinitary-placed-contract-home-");
  const pairing = new DevicePairing({
    dir: join(homeRoot, "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ownUid: 501,
  });
  started.pairings.push(pairing);
  const devices = new WorkDevices();
  const placed = new PlacedSessions({
    tasks,
    paths: appPathsFor(homeRoot),
    devices,
    profiles: { pi: inner.factory.controlProfile, claude: inner.factory.controlProfile },
    deviceName: () => "Mac mini",
    projectName: () => undefined,
    broadcastEvent: () => {},
    now,
    schedule: options.schedule,
    log: () => {},
  });
  placed.serve({
    adopt: async () => {
      throw new Error("Every case opens its own session.");
    },
    caughtUp: () => {},
    jobExit: () => {},
    reopened: () => {},
  });
  const dispatch = (async (channel, rawArgs, actor) => {
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: options.homeProtocolVersion ?? PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (actor?.kind !== "device" || !isWorkInvokeChannel(channel))
      throw new Error(`Rejected ${channel}`);
    const [request] = parseInvokeRequest(channel, rawArgs);
    return placed.answer(actor.deviceId, channel, request);
  }) as CoreDispatch;
  const port = await claimedPort();
  const connection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    protocolVersion: options.homeProtocolVersion ?? PROTOCOL_VERSION,
  });
  started.connections.push(connection);
  devices.attach(connection);
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await connection.settled();

  // The computer, joined as another user, whose working copy for the task is its own folder.
  const dataDir = scratchDir("infinitary-placed-contract-computer-");
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;
  const folders = new PlacedTasks(dataDir).ensure(CREWMATE_TASK);
  seedTask(tasks, {
    id: CREWMATE_TASK,
    title: "The contract crewmate",
    status: "running",
    deviceId,
    sessionFile: "placed",
  });
  const run = startHelper({
    dataDir,
    protocolVersion: options.protocolVersion,
    say: () => {},
    retryMs: [20],
    conversations:
      options.conversations ??
      (async ({ dataDir: dir, ask, homeChanges, homeVersion }) => {
        const host = new SessionHost({
          tasks: new PlacedTasks(dir),
          ask,
          // What the home's welcome listed, as the work mode hands it on.
          ...(homeChanges ? { homeChanges } : {}),
          // The real welcome owns work compatibility; a missing version grants no new events.
          ...(homeVersion ? { homeVersion } : {}),
          factories: { [inner.factory.backend]: inner.factory },
          bind: async () => inner.binding,
          tools: [lookUpThere],
          log: () => {},
        });
        return { host, close: () => host.close() };
      }),
  });
  if (!run.ok) throw new Error(run.reason);
  started.runs.push(run.run);
  // In reach, and its roster read: the home knows where the task's folders are.
  // Its window holds only on a graded run (`waitWindow.ts`).
  await vi.waitFor(
    () => {
      if (!placed.ready(deviceId, CREWMATE_TASK))
        throw new Error("The computer never came into reach.");
    },
    { timeout: 5_000, interval: 10 },
  );
  const there = placed.factories(deviceId)?.[inner.factory.backend];
  if (!there) throw new Error(`The home has no ${inner.factory.backend} factory for it.`);
  const factory: SessionFactory = {
    backend: there.backend,
    controlProfile: there.controlProfile,
    open: (spec) => there.open({ ...spec, callbacks: callbacksOf(spec) }),
  };
  return {
    ...inner,
    factory,
    machine: deviceId,
    homeDir: folders.work,
    /** The computer's own data folder, whose files only the computer reads. */
    computerDir: dataDir,
    placement: {
      db,
      tasks,
      paths: appPathsFor(homeRoot),
      devices,
      deviceId,
      placed,
    } as ContractPlacement,
  };
}

/** Lets go of everything every world started. */
export async function placedContractCleanup(): Promise<void> {
  await Promise.all(started.runs.splice(0).map((run) => run.stop()));
  await Promise.all(started.connections.splice(0).map((connection) => connection.close()));
  for (const pairing of started.pairings.splice(0)) pairing.dispose();
  for (const close of started.closes.splice(0)) close();
}
