import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { CARD_MEDIA_PIECE_BYTES } from "@shared/cardPictures";
import type { CardPicture } from "@shared/cards";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import {
  type PlacedEventRecord,
  type PlacedSpec,
  placedTaskFolders,
  type WorkOrderChannel,
  type WorkOrderResponse,
} from "@shared/work";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { freePort } from "../../../tests/helpers/connectionClient";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { gif } from "../../../tests/helpers/gifFixture";
import { box, mp4 } from "../../../tests/helpers/mp4Fixture";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import type { ContractWorld } from "../../../tests/helpers/sessionContract";
import { moveWorkFolder, olderWorkFolder } from "../../../tests/helpers/workFolderMove";
import { type HomeConnection, startConnection } from "../connection/connection";
import { DevicePairing } from "../devices/pairing";
import type { CoreActor, CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { crewmateMovedText } from "../orchestrator/crewSession";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { createPiSessionFactory } from "../pi/sessionFactory";
import type { ModelRuntime } from "../pi/types";
import { type CrewmateTool, crewmateTool } from "../session/tools";
import { joinHome } from "./join";
import { PlacedTasks } from "./placedTasks";
import { type HelperRun, startHelper } from "./run";
import { SessionHost } from "./sessionHost";
import { PLACED_REQUEST_WAIT_MS } from "./toolWait";
import type { WorkingCopies } from "./workingCopies";

/**
 * A crewmate's conversation held on a computer that runs work
 * (docs/helper.md, "Holding a conversation"), end to end on this side: the
 * helper as the app's work mode composes it, joined through the real
 * pairing, over the real connection, holding a real Pi conversation against
 * a local stub of the model's API. The home is a stand-in that answers the
 * work requests the way the home keeps them (src/shared/work.ts): every
 * answer under the id it was asked by, every event once, in order. Nothing
 * reaches the network, and no sign-in is read.
 */

const PROVIDER = "fm-placed";
const MODEL = "stub-1";
const TASK = "task-placed";
const BUILDER = { name: "builder", uid: 502 };

let api: StubApi;
let runtime: ModelRuntime;

beforeAll(async () => {
  api = await startStubApi(() => true);
  runtime = await piStubRuntime(api.url, { provider: PROVIDER, id: MODEL });
});

afterAll(async () => {
  await api.close();
});

/** A real grayscale PNG, 4x3 by default; distinct widths produce distinct picture ids. */
function png(width = 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(3, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * 3))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** What the model does on one request: call tools, or answer and end the turn. */
type Step = { tools: { name: string; args: Record<string, unknown> }[] } | { text: string };

/** The model, one step per request from now on; past the last step it answers "Done." */
function model(steps: Step[]): void {
  const first = api.requests.length;
  api.answer((request: StubRequest, res: ServerResponse) => {
    const step = steps[request.n - first - 1] ?? { text: "Done." };
    beginAnthropicStream(res, 100, request.n);
    if ("text" in step) {
      writeAnthropicText(res, 0, step.text);
      finishAnthropicStream(res, "end_turn", 3);
      return;
    }
    for (const [index, tool] of step.tools.entries())
      writeAnthropicToolUse(res, index, {
        id: `toolu_${request.n}_${index}`,
        name: tool.name,
        args: tool.args,
      });
    finishAnthropicStream(res, "tool_use", 5);
  });
}

/** One first-time effect of a work request at the home, and how many events it had taken in by then. */
type Effect = { channel: string; callId: string; request: Record<string, unknown>; after: number };

/**
 * The home's side as a stand-in: what the real home keeps (src/shared/work.ts)
 * - an answer per call id, kept before it is returned and answered again
 * from there; each event once, in order; `kept` at each turn's end - and a
 * gate a test can hold one kind of request at.
 */
function standInHome() {
  const ledger = new Map<string, unknown>();
  const effects: Effect[] = [];
  const asked: { channel: string; callId: string }[] = [];
  const events: PlacedEventRecord[] = [];
  const actors: CoreActor[] = [];
  const pictures = new Map<string, Buffer>();
  const recordings = new Map<string, Buffer>();
  const typefaces = new Map<string, Buffer>();
  let through = 0;
  let kept = 0;
  const gates = new Map<string, { reached: () => void; open: Promise<void> }>();
  let cards = 0;

  const answerFor = (channel: string, request: Record<string, unknown>): unknown => {
    switch (channel) {
      case "inf:work:card":
        cards += 1;
        return { shown: true, cardId: `card-${cards}` };
      case "inf:work:picture":
        pictures.set(String(request.id), Buffer.from(String(request.data), "base64"));
        return { ok: true };
      case "inf:work:typeface":
        typefaces.set(String(request.id), Buffer.from(String(request.data), "base64"));
        return { ok: true };
      case "inf:work:media": {
        const id = String(request.id);
        const piece = Buffer.from(String(request.data), "base64");
        recordings.set(id, Buffer.concat([recordings.get(id) ?? Buffer.alloc(0), piece]));
        return { ok: true };
      }
      case "inf:work:tasks":
        return { rows: [{ key: "FI3-1", title: "A task" }], total: 1 };
      case "inf:work:card-refused":
      case "inf:work:job-exit":
        return { ok: true };
      default:
        return { text: `${channel} done` };
    }
  };

  const dispatch = (async (channel: string, rawArgs: unknown, actor?: CoreActor) => {
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (actor) actors.push(actor);
    const [request] = rawArgs as [Record<string, unknown>];
    if (channel === "inf:work:events") {
      const gate = gates.get(channel);
      if (gate) {
        gate.reached();
        await gate.open;
      }
      for (const record of request.events as PlacedEventRecord[]) {
        if (record.seq <= through) continue;
        if (record.seq !== through + 1) break;
        events.push(record);
        through = record.seq;
        if (record.event.type === "turn_end" || record.event.type === "turn_ended") kept = through;
      }
      return { through, kept };
    }
    const callId = String(request.callId);
    asked.push({ channel, callId });
    if (ledger.has(callId)) return ledger.get(callId);
    const gate = gates.get(channel);
    if (gate) {
      gate.reached();
      await gate.open;
    }
    // Asked again while the first one waited: one effect, one answer.
    if (ledger.has(callId)) return ledger.get(callId);
    effects.push({ channel, callId, request, after: through });
    const answer = answerFor(channel, request);
    ledger.set(callId, answer);
    return answer;
  }) as CoreDispatch;

  return {
    dispatch,
    effects,
    asked,
    events,
    actors,
    pictures,
    recordings,
    typefaces,
    /** The event types the home took in, in order. */
    types: () => events.map((record) => record.event.type),
    /** Holds every request of one kind until `open()`; `reached` resolves when the first arrives. */
    hold(channel: string) {
      let reached!: () => void;
      let open!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      gates.set(channel, {
        reached,
        open: new Promise<void>((resolve) => {
          open = resolve;
        }),
      });
      return {
        reached: arrived,
        open: () => {
          gates.delete(channel);
          open();
        },
      };
    },
  };
}

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const runs: HelperRun[] = [];

afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await scriptedClaudeCleanup();
});

/**
 * The working copies a computer keeps, as far as a conversation reads them:
 * a task's is its folder under `worktrees/`, made and deleted by the test as
 * `WorkingCopies` makes and retires one, with no git.
 */
function folderCopies(dataDir: string): WorkingCopies {
  const worktreesDir = join(dataDir, "worktrees");
  return {
    worktreesDir,
    has: (task: string) => existsSync(join(worktreesDir, task)),
    list: () => (existsSync(join(worktreesDir, TASK)) ? [TASK] : []),
  } as Partial<WorkingCopies> as WorkingCopies;
}

/** A home with the stand-in core, a computer joined to it as another user, and the helper running there. */
async function placed(
  options: {
    copies?: boolean;
    probeMedia?: MediaProbe;
    probeTypeface?: TypefaceProbe;
    /** The contract the home's welcome says, in place of the one the link heard. */
    homeVersion?: string;
    /** Claude's factory on the scripted client, for a conversation the home binds to Claude. */
    claude?: ContractWorld;
    /** Its work starts in Firstmate 3000's folder, before its first update to Infinitary (`moveComputer`). */
    inOlderFolder?: boolean;
    retryMs?: readonly number[];
    /** A filtered Claude give-up signal, injected at the bound-tool seam independently of the test model. */
    toolSignal?: AbortSignal;
    /** Tools of the test's own, in place of the crewmate's; the spec names them too. */
    tools?: readonly CrewmateTool[];
  } = {},
) {
  const home = standInHome();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-placed-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ownUid: 501,
  });
  pairings.push(pairing);
  const port = await freePort();
  const listen = () => {
    const connection = startConnection({
      dispatch: home.dispatch,
      events: new CoreEventBus(),
      devices: pairing,
      port,
      name: () => "MacBook Pro",
    });
    connections.push(connection);
    return connection;
  };
  let connection = listen();
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await connection.settled();
  const appData = options.inOlderFolder ? scratchDir("infinitary-placed-app-data-") : undefined;
  let dataDir = appData ? olderWorkFolder(appData) : scratchDir("infinitary-placed-");
  if (appData) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;

  let host: SessionHost | undefined;
  let belowUi: boolean | undefined;
  const start = () => {
    const started = startHelper({
      dataDir,
      say: () => {},
      retryMs: options.retryMs ?? [20],
      conversations: async ({ dataDir: dir, ask, homeVersion, belowUi: below }) => {
        belowUi = below;
        const copies = options.copies ? folderCopies(dir) : undefined;
        const pi = createPiSessionFactory({ agentDir: join(dir, "pi-agent") });
        host = new SessionHost({
          tasks: new PlacedTasks(dir, copies?.worktreesDir),
          ...(copies ? { copies } : {}),
          ask,
          factories: {
            pi: options.toolSignal
              ? {
                  ...pi,
                  open: (spec) =>
                    pi.open({
                      ...spec,
                      tools: spec.tools?.map((tool) => ({
                        ...tool,
                        run: (params) => tool.run(params, options.toolSignal),
                      })),
                    }),
                }
              : pi,
            ...(options.claude ? { claude: options.claude.factory } : {}),
          },
          bind: async (binding) =>
            binding.backend === "claude" && options.claude
              ? options.claude.binding
              : { backend: "pi", runtime },
          ...(options.probeMedia ? { probeMedia: options.probeMedia } : {}),
          ...(options.probeTypeface ? { probeTypeface: options.probeTypeface } : {}),
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.homeVersion
            ? { homeVersion: () => options.homeVersion as string }
            : homeVersion
              ? { homeVersion }
              : {}),
          log: () => {},
        });
        const held = host;
        return { host: held, close: () => held.close() };
      },
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return started.run;
  };
  let run = start();
  const inReach = async () => {
    await expect
      .poll(() =>
        connection.ask(deviceId, "inf:session:roster", []).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
  };
  await inReach();

  /** The home asks the computer one order. */
  const order = <C extends WorkOrderChannel>(channel: C, args: unknown) =>
    connection.ask(deviceId, channel, args) as Promise<WorkOrderResponse<C>>;
  const spec: PlacedSpec = {
    binding: { backend: "pi", provider: PROVIDER },
    model: { provider: PROVIDER, id: MODEL },
    thinking: { level: "off" },
    instructions: "You are a crewmate on another Mac.",
    tools: options.tools?.map((tool) => tool.name) ?? [
      "emit_card",
      "report",
      "note_progress",
      "file_followup",
      "tasks",
      "github_write",
    ],
  };
  return {
    home,
    deviceId,
    /** The computer's work folder now: Infinitary's once `moveComputer` moved it. */
    get dataDir() {
      return dataDir;
    },
    order,
    spec,
    host: () => {
      if (!host) throw new Error("No conversation was opened.");
      return host;
    },
    /** Whether the run had its conversations keep a crewmate's builds and tests below the UI. */
    belowUi: () => belowUi,
    open: () => order("inf:session:open", [{ orderId: `open:${TASK}:1`, task: TASK, spec }]),
    /** The home's turn ends: the computer said `turn_ended` for this turn. */
    ended: (turn: number) =>
      expect
        .poll(() =>
          home.events.some(
            (record) => record.event.type === "turn_ended" && record.event.turn === turn,
          ),
        )
        .toBe(true),
    stopHome: async () => {
      await connection.close();
      await expect.poll(() => run.state().contact).not.toBe("in-reach");
    },
    startHome: async () => {
      connection = listen();
      await connection.settled();
    },
    inReach,
    /** Firstmate quits on the home and opens again: the connection drops and comes back. */
    dropAndReturn: async () => {
      await connection.close();
      connection = listen();
      await connection.settled();
      await inReach();
    },
    /** The computer's own process quits, and starts again from the same folder. */
    restartComputer: async () => {
      await run.stop();
      host = undefined;
      run = start();
      await inReach();
    },
    /** Its first update to Infinitary: its work stops, the one-time move runs, and its work starts from the new folder. */
    moveComputer: async () => {
      if (!appData) throw new Error("This computer's work is in no older folder.");
      await run.stop();
      host = undefined;
      dataDir = await moveWorkFolder(appData, "linux");
      run = start();
      await inReach();
    },
  };
}

describe("a conversation held on a computer that runs work", () => {
  it("runs the home's prompt there, does each callback once at the home, and tells the home every event once, in order", async () => {
    const at = await placed();
    const opened = await at.open();
    expect(opened.state).toMatchObject({
      backend: "pi",
      streaming: false,
      model: { provider: PROVIDER, id: MODEL },
      controlProfile: { backgroundWork: "host" },
    });
    model([
      { tools: [{ name: "note_progress", args: { text: "Started." } }] },
      { tools: [{ name: "report", args: { text: "All done.", summary: "It is done." } }] },
      { text: "Reported." },
    ]);
    expect(
      await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Do it." }]),
    ).toEqual({ turn: 1 });
    await at.ended(1);

    // The model's request carried the home's instructions and the forwarded tools.
    const served = api.requests.at(-1)?.body;
    expect(JSON.stringify(served?.system)).toContain("You are a crewmate on another Mac.");
    expect(served?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["emit_card", "report", "note_progress", "file_followup", "tasks"]),
    );

    // Each callback once, as the computer itself, after every event before it.
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:progress",
      "inf:work:report",
    ]);
    expect(at.home.effects[1]?.request).toMatchObject({
      task: TASK,
      text: "All done.",
      summary: "It is done.",
    });
    expect(at.home.actors.length).toBeGreaterThan(0);
    for (const actor of at.home.actors)
      expect(actor).toEqual({ kind: "device", deviceId: at.deviceId });
    const reportStart = at.home.events.find(
      (record) => record.event.type === "tool_start" && record.event.toolName === "report",
    );
    expect(at.home.effects[1]?.after).toBeGreaterThanOrEqual(reportStart?.seq ?? Number.NaN);

    // Every event once, numbered from 1 with no gap, the turn's start first and its end last.
    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    const types = at.home.types();
    expect(types[0]).toBe("turn_started");
    expect(types.at(-1)).toBe("turn_ended");
    expect(types).toEqual(expect.arrayContaining(["tool_start", "tool_end", "turn_end"]));
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "done",
      undelivered: [],
      state: { streaming: false, resume: expect.stringMatching(/\.jsonl$/) },
    });
    // What the home keeps, the computer forgets: its outbox holds nothing kept.
    const outbox = join(placedTaskFolders(join(at.dataDir, "tasks"), TASK).root, "outbox.jsonl");
    await expect.poll(() => readFileSync(outbox, "utf8")).toBe("");
  });

  it("answers an order it already applied as it did, without doing it again", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Once." }]);
    const prompt = [{ orderId: "rows:7", task: TASK, text: "Say it once." }];
    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    await at.ended(1);
    const requests = api.requests.length;

    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    expect((await at.open()).state.sessionId).toBe(opened.state.sessionId);
    expect(api.requests.length).toBe(requests);
    expect(at.home.types().filter((type) => type === "turn_started")).toHaveLength(1);

    // A steer after the turn ended reached nothing, so the home puts its words back.
    expect(
      await at.order("inf:session:steer", [{ orderId: "rows:8", task: TASK, text: "Late." }]),
    ).toEqual({ delivered: false });
  });

  it("rebinds an idle conversation when a later open names a tool it lacked (INF-398)", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Started." }, { text: "Has the tool." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).not.toContain(
      "prepare_change",
    );
    const held = await at.open();
    expect(held.state.sessionId).toBe(opened.state.sessionId);
    expect(held.state.resume).toBeTruthy();

    const again = await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:2`,
        task: TASK,
        spec: {
          ...at.spec,
          tools: [...at.spec.tools, "prepare_change"],
          resume: held.state.resume,
        },
      },
    ]);
    expect(again.state.resume).toBe(held.state.resume);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Continue." }]);
    await at.ended(2);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).toContain("prepare_change");
  });

  // Intent: INF-311's accepted whole-call deadline includes waiting for prior events.
  it.each(["inf:work:report", "inf:work:events"])(
    "ends the whole tool call after 24 days while waiting on %s (INF-312)",
    async (channel) => {
      const at = await placed();
      await at.open();
      const held = at.home.hold(channel);
      model([
        { tools: [{ name: "report", args: { text: "Across the deadline." } }] },
        { text: "Checked the timeout." },
      ]);
      const first = api.requests.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await at.order("inf:session:prompt", [{ orderId: "deadline", task: TASK, text: "Report." }]);
      await held.reached;
      // Wait for the model's tool-start event before moving only the deadline clock.
      await expect
        .poll(() => {
          const outbox = new PlacedTasks(at.dataDir).outbox(TASK, 0);
          return outbox.some((record) => record.event.type === "tool_start");
        })
        .toBe(true);
      try {
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
      } finally {
        vi.useRealTimers();
      }
      held.open();
      await at.ended(1);
      const transcript = JSON.stringify(
        api.requests.slice(first).map((request) => request.body.messages),
      );
      expect(transcript).toContain(
        channel === "inf:work:report" ? "may already be done" : "was not sent",
      );
      if (channel === "inf:work:events")
        expect(
          at.home.effects.filter((effect) => effect.channel === "inf:work:report"),
        ).toHaveLength(0);
      console.info("Whole-call deadline:", channel, transcript.slice(-1200));
    },
  );

  // Intent: the captain's F2 backstop withdraws a Claude give-up callback even before our deadline.
  it("withdraws a tool when Claude gives up, and never resends it on return (INF-312 F2)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Wait for this report." } }] },
      { text: "Checking what happened before asking again." },
    ]);
    const from = api.requests.length;
    try {
      await at.order("inf:session:prompt", [
        { orderId: "provider-abort", task: TASK, text: "Report." },
      ]);
      await report.reached;
      await at.stopHome();
      controller.abort(new Error("The provider stopped waiting"));
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("conversation stopped waiting");
      await at.startHome();
      await at.inReach();
      report.open();
      await at.ended(1);
      expect(at.home.asked.filter((request) => request.channel === "inf:work:report")).toHaveLength(
        1,
      );
      console.info(
        "Claude give-up: callback withdrawn without advancing the 24-day timer; no resend on return.",
      );
    } finally {
      report.open();
    }
  });

  /** A saved-story completion card, the shape a crewmate's merge decision takes. */
  const completionCard: Step = {
    tools: [
      {
        name: "emit_card",
        args: {
          title: "Review this change",
          presentation: 1,
          actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
        },
      },
    ],
  };

  // Intent: review d0c421b2 F2: a completion refusal is an independent fact, not part of the cancelled tool.
  it("records a refused completion outside its cancelled invocation (INF-312 review)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.open();
    // The card asks after the events before it, so held here it never goes out.
    const events = at.home.hold("inf:work:events");
    model([completionCard, { text: "The completion was refused." }]);
    try {
      await at.order("inf:session:prompt", [
        { orderId: "refusal-cancel", task: TASK, text: "Show the review." },
      ]);
      await events.reached;
      await expect
        .poll(() =>
          new PlacedTasks(at.dataDir)
            .outbox(TASK, 0)
            .some((record) => record.event.type === "tool_start"),
        )
        .toBe(true);
      controller.abort(new Error("Claude stopped waiting"));
      events.open();
      await expect
        .poll(
          () =>
            at.home.effects.filter((effect) => effect.channel === "inf:work:card-refused").length,
        )
        .toBe(1);
      await at.ended(1);
      expect(at.home.asked.filter((request) => request.channel === "inf:work:card")).toEqual([]);
      expect(
        at.home.effects.find((effect) => effect.channel === "inf:work:card-refused")?.request
          .refusal,
      ).toMatchObject({ title: "Review this change", why: expect.stringContaining("not sent") });
    } finally {
      events.open();
    }
  });

  // Intent: INF-370 R1 - a completion card whose request went out may already be up, so it is not recorded as refused.
  it.each(["Claude gives up", "the 24 days pass"])(
    "records no refusal for a completion card the home may already show when %s (INF-370 R1)",
    async (cause) => {
      const controller = new AbortController();
      const at = await placed({ toolSignal: controller.signal });
      await at.open();
      const card = at.home.hold("inf:work:card");
      model([completionCard, { text: "Checking whether the card is up." }]);
      const from = api.requests.length;
      try {
        if (cause === "Claude gives up") {
          await at.order("inf:session:prompt", [
            { orderId: "unknown-card", task: TASK, text: "Show the review." },
          ]);
          await card.reached;
          controller.abort(new Error("Claude stopped waiting"));
        } else {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
          try {
            await at.order("inf:session:prompt", [
              { orderId: "unknown-card", task: TASK, text: "Show the review." },
            ]);
            await card.reached;
            await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
          } finally {
            vi.useRealTimers();
          }
        }
        await expect
          .poll(() =>
            JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
          )
          .toContain("may already be done");
        // The home shows it after the conversation stopped waiting.
        card.open();
        await at.ended(1);
        expect(at.home.effects.filter((effect) => effect.channel === "inf:work:card")).toHaveLength(
          1,
        );
        expect(
          at.home.asked.filter((request) => request.channel === "inf:work:card-refused"),
        ).toEqual([]);
      } finally {
        card.open();
      }
    },
  );

  // Intent: review d0c421b2 F1/F5: name a reachable check for changes and call a read a request.
  it.each([
    {
      channel: "inf:work:github-write",
      name: "github_write",
      args: { method: "POST", path: "/repos/fixture/site/issues", body: "{}" },
      words: "Read the affected item where your project lives",
    },
    {
      channel: "inf:work:tasks",
      name: "tasks",
      args: {},
      words: "the request was sent, but its answer did not arrive",
    },
    { channel: "inf:work:events", name: "tasks", args: {}, words: "the request was not sent" },
  ])(
    "explains an unanswered $channel accurately (INF-312 review)",
    async ({ channel, name, args, words }) => {
      const at = await placed();
      await at.open();
      const held = at.home.hold(channel);
      model([{ tools: [{ name, args }] }, { text: "Checking before asking again." }]);
      const from = api.requests.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await at.order("inf:session:prompt", [
          { orderId: `words:${name}`, task: TASK, text: "Check it." },
        ]);
        await held.reached;
        await expect
          .poll(() =>
            new PlacedTasks(at.dataDir)
              .outbox(TASK, 0)
              .some((record) => record.event.type === "tool_start"),
          )
          .toBe(true);
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
      } finally {
        vi.useRealTimers();
        held.open();
      }
      await at.ended(1);
      const transcript = JSON.stringify(
        api.requests.slice(from).map((request) => request.body.messages),
      );
      expect(transcript).toContain(words);
      if (name === "tasks") expect(transcript).not.toContain("the change was not sent");
    },
  );

  // Intent: INF-339 F1, the accepted limit covers a whole card callback, not each transfer.
  it("does not reset a card's deadline when one picture arrives between two absences (INF-312)", async () => {
    const day = PLACED_REQUEST_WAIT_MS / 24;
    const at = await placed({ retryMs: [day] });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    writeFileSync(join(folders.evidence, "first.png"), png());
    writeFileSync(join(folders.evidence, "second.png"), png(5));
    const first = at.home.hold("inf:work:picture");
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "Two pictures",
              body: ["first.png", "second.png"]
                .map((name) => `<img src="${join(folders.evidence, name)}" alt="${name}">`)
                .join(""),
            },
          },
        ],
      },
      { text: "Checked before showing the card again." },
    ]);
    const from = api.requests.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      await at.order("inf:session:prompt", [
        { orderId: "multipart-deadline", task: TASK, text: "Show it." },
      ]);
      await first.reached;
      const start = Date.now();
      const advanceToDay = (number: number) =>
        vi.advanceTimersByTimeAsync(Math.max(0, start + number * day - Date.now()));
      await at.stopHome();
      await advanceToDay(9);
      await at.startHome();
      await vi.advanceTimersToNextTimerAsync();
      await at.inReach();
      await advanceToDay(10);
      first.open();
      const second = at.home.hold("inf:work:picture");
      await second.reached;
      expect(
        at.home.effects.filter((effect) => effect.channel === "inf:work:picture"),
      ).toHaveLength(1);
      await at.stopHome();
      await advanceToDay(24);
      // The model hears the refusal at the original deadline, not 24 days after the first answer.
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("was not sent");
      expect(
        JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
      ).not.toContain("may already be done");
      await advanceToDay(29);
      await at.startHome();
      await vi.advanceTimersToNextTimerAsync();
      await at.inReach();
      await advanceToDay(30);
      second.open();
      await at.ended(1);
      expect(at.home.effects.filter((effect) => effect.channel === "inf:work:card")).toHaveLength(
        0,
      );
      console.info(
        "Multipart recovery: one picture answered on day 10; callback expired at day 24; no card on return at day 30.",
      );
    } finally {
      vi.useRealTimers();
      first.open();
    }
  });

  it("keeps the turn running through a drop: a waiting callback is asked again under its id, done once, and the home catches up exactly", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Across the drop." } }] },
      { text: "Carried on." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Report." }]);
    await report.reached;

    await at.dropAndReturn();
    // The same call, asked again on the new connection, while the first still waits.
    await expect
      .poll(() => at.home.asked.filter((ask) => ask.channel === "inf:work:report").length)
      .toBe(2);
    const [first, second] = at.home.asked.filter((ask) => ask.channel === "inf:work:report");
    expect(second?.callId).toBe(first?.callId);
    report.open();
    await at.ended(1);

    expect(at.home.effects.filter((effect) => effect.channel === "inf:work:report")).toHaveLength(
      1,
    );
    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    expect(at.home.types().filter((type) => type === "turn_ended")).toHaveLength(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "done" });
  });

  it("holds several callbacks waiting at once, and answers each once after a drop", async () => {
    const at = await placed();
    await at.open();
    const progress = at.home.hold("inf:work:progress");
    const followup = at.home.hold("inf:work:followup");
    model([
      {
        tools: [
          { name: "note_progress", args: { text: "Two at once." } },
          {
            name: "file_followup",
            args: { title: "A gap", goal: "Close it.", why: "Found it." },
          },
        ],
      },
      { text: "Both answered." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:3", task: TASK, text: "Both." }]);
    await Promise.all([progress.reached, followup.reached]);

    await at.dropAndReturn();
    await expect.poll(() => at.home.asked.length).toBe(4);
    progress.open();
    followup.open();
    await at.ended(1);
    expect(at.home.effects.map((effect) => effect.channel).sort()).toEqual([
      "inf:work:followup",
      "inf:work:progress",
    ]);
  });

  it("sends a card's picture before the card, from the folder the crewmate wrote it in", async () => {
    const at = await placed();
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const picture_ = png();
    writeFileSync(join(folders.evidence, "after.png"), picture_);
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "Done on another Mac",
              body: `<p>It works.</p><img src="${join(folders.evidence, "after.png")}" alt="It works">`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:4", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:card",
    ]);
    const [picture, card] = at.home.effects;
    expect(at.home.pictures.get(String(picture?.request.id))).toEqual(picture_);
    expect(card?.request.card).toMatchObject({
      title: "Done on another Mac",
      pictures: [{ id: picture?.request.id, alt: "It works" }],
    });
    expect(String((card?.request.card as { body?: string } | undefined)?.body)).toContain(
      `${picture?.request.id}.png`,
    );
    const toolEnd = at.home.events.find(
      (record) => record.event.type === "tool_end" && record.event.toolName === "emit_card",
    );
    expect(toolEnd?.event).toMatchObject({ isError: false });
  });

  it("sends a demo's recording in pieces after its poster and before the card, checked by this computer's decoder", async () => {
    const decoded: number[] = [];
    const at = await placed({
      probeMedia: async ({ bytes }) => {
        decoded.push(bytes.length);
        return { ok: true, width: 400, height: 300, durationMs: 2000 };
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    // Past one piece, so it crosses in two.
    const recording = Buffer.concat([
      mp4({ width: 400, height: 300 }),
      box("free", Buffer.alloc(CARD_MEDIA_PIECE_BYTES)),
    ]);
    writeFileSync(join(folders.evidence, "demo.mp4"), recording);
    writeFileSync(join(folders.evidence, "demo.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A demo from another Mac",
              body: `<p>It moves.</p><figure data-inf-demo="${join(folders.evidence, "demo.mp4")}"><img src="${join(folders.evidence, "demo.png")}" alt="It moves"></figure>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:demo", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(decoded).toEqual([recording.length]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:media",
      "inf:work:media",
      "inf:work:card",
    ]);
    const card = at.home.effects.at(-1)?.request.card as { pictures?: CardPicture[] };
    const demo = card.pictures?.[0]?.demo;
    expect(demo).toMatchObject({ kind: "mp4", bytes: recording.length });
    const received = at.home.recordings.get(String(demo?.id));
    expect(received).toBeDefined();
    expectBytesEqual(received as Buffer, recording);
    expect(at.home.effects[1]?.request).toMatchObject({ offset: 0, size: recording.length });
    expect(at.home.effects[2]?.request).toMatchObject({
      offset: CARD_MEDIA_PIECE_BYTES,
      size: recording.length,
    });
  });

  it("sends a GIF demo as a GIF after its poster, by its own walk with no decoder asked", async () => {
    const decoded: number[] = [];
    const at = await placed({
      probeMedia: async ({ bytes }) => {
        decoded.push(bytes.length);
        return { ok: false, reason: "a GIF is never probed" };
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const recording = gif({ width: 400, height: 300, frames: 4 });
    writeFileSync(join(folders.evidence, "demo.gif"), recording);
    writeFileSync(join(folders.evidence, "demo.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A GIF demo from another Mac",
              body: `<p>It moves.</p><figure data-inf-demo="${join(folders.evidence, "demo.gif")}"><img src="${join(folders.evidence, "demo.png")}" alt="It moves"></figure>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:gif", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(decoded).toEqual([]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:media",
      "inf:work:card",
    ]);
    expect(at.home.effects[1]?.request).toMatchObject({ extension: "gif", offset: 0 });
    const card = at.home.effects.at(-1)?.request.card as { pictures?: CardPicture[] };
    const demo = card.pictures?.[0]?.demo;
    expect(demo).toMatchObject({ kind: "gif", bytes: recording.length, durationMs: 400 });
    const received = at.home.recordings.get(String(demo?.id));
    expect(received).toBeDefined();
    expectBytesEqual(received as Buffer, recording);
  });

  // INF-128's plan, with the captain's "In this build" for other computers:
  // a preview's project font, checked where the crewmate runs, goes home
  // before the card that names it.
  it("sends a preview's project font before the card, checked by this computer's font loader", async () => {
    const loaded: string[] = [];
    const at = await placed({
      probeTypeface: async (typefaces) => {
        loaded.push(...typefaces.map(({ contentType }) => contentType));
        return typefaces.map(() => ({ ok: true }));
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const font = projectFontBytes();
    writeFileSync(join(folders.evidence, "face.woff2"), font);
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A preview from another Mac",
              body: `<p>The balance screen.</p><style>@font-face{font-family:"Wallet";src:url("${join(folders.evidence, "face.woff2")}")}.b{font-family:"Wallet"}</style><p class="b">$42.50</p>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:font", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(loaded).toEqual(["font/woff2"]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:typeface",
      "inf:work:card",
    ]);
    const [typeface, card] = at.home.effects;
    expect(typeface?.request).toMatchObject({ extension: "woff2" });
    expectBytesEqual(at.home.typefaces.get(String(typeface?.request.id)) as Buffer, font);
    expect(String((card?.request.card as { body?: string } | undefined)?.body)).toContain(
      `url("app-frame://typefaces/${typeface?.request.id}.woff2")`,
    );
  });

  it("refuses a card naming a project font to a home too old to keep one, sending none of it", async () => {
    const at = await placed({
      probeTypeface: async (typefaces) => typefaces.map(() => ({ ok: true })),
      // A minor before the one that keeps project fonts (`CARD_TYPEFACES_SINCE`).
      homeVersion: "8.8.0",
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    writeFileSync(join(folders.evidence, "face.woff2"), projectFontBytes());
    writeFileSync(join(folders.evidence, "after.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A preview for an older home",
              // A picture beside the font: refused first, it never crosses either.
              body: `<style>@font-face{font-family:"Wallet";src:url("${join(folders.evidence, "face.woff2")}")}</style><p>$42.50</p><img src="${join(folders.evidence, "after.png")}" alt="The screen">`,
            },
          },
        ],
      },
      { text: "Refused." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:old", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual([]);
    const toolEnd = at.home.events.find(
      (record) => record.event.type === "tool_end" && record.event.toolName === "emit_card",
    );
    expect(toolEnd?.event).toMatchObject({ isError: true });
    // The crewmate reads why, and what to do instead, in the tool's answer.
    expect(JSON.stringify(api.requests.at(-1)?.body?.messages)).toContain(
      "runs an older Infinitary that cannot show a project's fonts",
    );
  });

  it("ends a turn the computer quit in the middle of as interrupted, and tells the home once it is back", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([{ tools: [{ name: "report", args: { text: "Never answered." } }] }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:5", task: TASK, text: "Go." }]);
    await report.reached;

    await at.restartComputer();
    await at.ended(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "interrupted",
    });
    // The roster says what it holds now: nothing open, nothing running.
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks).toEqual([
      expect.objectContaining({ task: TASK, open: false, closed: false }),
    ]);
    expect(roster.tasks[0]?.running).toBeUndefined();
    // The prompt asked again after the quit is the one that started that turn.
    expect(
      await at.order("inf:session:prompt", [{ orderId: "rows:5", task: TASK, text: "Go." }]),
    ).toEqual({ turn: 1 });
    report.open();
  });

  // Captain's INF-352 W1: helper shutdown/recovery must terminate its own continuation.
  it.each(["stop", "crash", "older-crash", "closed"] as const)(
    "records terminal Claude endings only for open work after %s",
    async (ending) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => held });
      const at = await placed({ claude });
      const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
      claude.answer({ text: "The background check started." });
      try {
        await at.order("inf:session:open", [{ orderId: "open:continuation", task: TASK, spec }]);
        await at.order("inf:session:prompt", [
          { orderId: "rows:continuation", task: TASK, text: "Start the background check." },
        ]);
        await at.ended(1);
        claude.answer({ tool: "note_progress", answer: "Not reached while held." });
        claude.continueTurn();
        await expect
          .poll(() => at.home.events.some(({ event }) => event.type === "tool_start"))
          .toBe(true);
        let root = at.dataDir;
        if (ending === "crash" || ending === "older-crash") {
          // The bytes already on disk before graceful shutdown model a process lost mid-call.
          root = scratchDir("infinitary-continuation-crash-");
          cpSync(join(at.dataDir, "tasks"), join(root, "tasks"), { recursive: true });
        }
        if (ending === "closed")
          await at.order("inf:session:close", [{ orderId: "close:continuation", task: TASK }]);
        await at.host().close();
        const tasks = new PlacedTasks(root);
        if (ending === "older-crash") {
          // c645fe4's helper kept the outbox boundaries without a state flag.
          tasks.writeState(TASK, { ...tasks.state(TASK), continuing: undefined });
        }
        const restart = () =>
          new SessionHost({
            tasks,
            factories: { claude: claude.factory },
            bind: async () => claude.binding,
            ask: async () => {
              throw new Error("The recovered helper has not reconnected.");
            },
            log: () => {},
          });
        const recovered = restart();
        await recovered.close();
        const events = tasks.outbox(TASK, 0);
        const terminal = events.filter(({ event }) => event.type === "continuation_ended");
        if (ending === "closed") expect(tasks.state(TASK).closed).toBe(true);
        expect(terminal).toEqual(
          ending === "closed"
            ? []
            : [
                expect.objectContaining({
                  event: {
                    type: "continuation_ended",
                    interrupted: true,
                    error: expect.any(String),
                  },
                }),
              ],
        );
        if (ending !== "closed") expect(events.at(-1)?.event).toEqual(terminal[0]?.event);
        expect(events.some(({ event }) => event.type === "tool_end")).toBe(false);
        const again = restart();
        await again.close();
        expect(
          tasks.outbox(TASK, 0).filter(({ event }) => event.type === "continuation_ended"),
        ).toHaveLength(ending === "closed" ? 0 : 1);
      } finally {
        claude.endClient();
        release();
      }
    },
  );

  // INF-284, review F4: a Claude conversation's token names no folder, and a
  // home that restarted after this computer's one-time move names the new
  // one, so nothing an open carries names the older folder; its crewmate is
  // still told once where its folders moved.
  it("tells a Claude crewmate once where its folders moved when its conversation opens after this computer's one-time move, though nothing the home sends names the older folder (INF-284)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude, inOlderFolder: true });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    let opens = 0;
    const open = (resume?: string) => {
      opens += 1;
      return at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:${opens}`,
          task: TASK,
          spec: { ...spec, ...(resume ? { resume } : {}) },
        },
      ]);
    };
    const prompt = async (turn: number, text: string) => {
      await at.order("inf:session:prompt", [{ orderId: `rows:${turn}`, task: TASK, text }]);
      await at.ended(turn);
    };
    /** The conversation's own id, as its last turn's end named it to the home. */
    const resumeToken = () => {
      const ended = at.home.events.filter((record) => record.event.type === "turn_ended").at(-1);
      return ended?.event.type === "turn_ended" ? ended.event.state?.resume : undefined;
    };
    claude.answer({ text: "On it." });
    expect((await open()).state.backend).toBe("claude");
    await prompt(1, "Fix the footer.");
    const olderDir = at.dataDir;
    const older = placedTaskFolders(join(olderDir, "tasks"), TASK);
    expect(resumeToken()).toBeTruthy();

    await at.moveComputer();
    const moved = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    // As a home that restarted opens it: its instructions name no older
    // path, and its token is the conversation's id.
    await open(resumeToken());
    await prompt(2, "Fix the header too.");
    const notice = crewmateMovedText({
      work: { from: older.work, to: moved.work },
      root: { from: older.root, to: moved.root },
    });
    const told = claude.served().at(-1)?.said ?? "";
    expect(told).toContain(notice);
    expect(told.indexOf(notice)).toBeLessThan(told.indexOf("Fix the header too."));

    // That computer restarts: the conversation opens again, and its crewmate is not told twice.
    await at.restartComputer();
    await open(resumeToken());
    await prompt(3, "Check the footer again.");
    const later = claude.served().at(-1)?.said ?? "";
    expect(later).toContain("Check the footer again.");
    expect(later.split(notice)).toHaveLength(2);

    // A task that began after the move has nothing that moved, and is told nothing.
    const fresh = "task-after-the-move";
    await at.order("inf:session:open", [{ orderId: `open:${fresh}:1`, task: fresh, spec }]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:fresh", task: fresh, text: "Start the sidebar." },
    ]);
    await expect.poll(() => claude.served().at(-1)?.said).toContain("Start the sidebar.");
    const freshOlder = placedTaskFolders(join(olderDir, "tasks"), fresh);
    const freshNow = placedTaskFolders(join(at.dataDir, "tasks"), fresh);
    expect(claude.served().at(-1)?.said).not.toContain(
      crewmateMovedText({
        work: { from: freshOlder.work, to: freshNow.work },
        root: { from: freshOlder.root, to: freshNow.root },
      }),
    );
  });

  it("copies the conversation's record to the home, from where its copy ends", async () => {
    const at = await placed();
    await at.open();
    model([{ text: "Recorded." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:6", task: TASK, text: "Note it." }]);
    await at.ended(1);

    const first = await at.order("inf:session:copy", [{ task: TASK, from: [] }]);
    expect(first.more).toBe(false);
    expect(first.files).toHaveLength(1);
    const [file] = first.files;
    const text = Buffer.from(file?.data ?? "", "base64").toString("utf8");
    expect(text).toContain("Note it.");
    expect(file?.size).toBe(Buffer.byteLength(text));

    const again = await at.order("inf:session:copy", [
      { task: TASK, from: [{ name: file?.name ?? "", offset: file?.size ?? 0 }] },
    ]);
    expect(again).toEqual({ files: [], more: false });
  });

  it("closes a conversation for good when the home closes the record", async () => {
    const at = await placed();
    await at.open();
    expect(await at.order("inf:session:close", [{ orderId: "close:1", task: TASK }])).toEqual({
      ok: true,
    });
    await expect(at.open()).rejects.toThrow("opens no more");
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks).toEqual([expect.objectContaining({ task: TASK, closed: true })]);
  });

  it("removes a closed conversation's folder for the home only once its working copy is gone, and answers the same when asked again", async () => {
    const at = await placed({ copies: true });
    const work = join(at.dataDir, "worktrees", TASK);
    mkdirSync(work, { recursive: true });
    await at.open();
    const folder = join(at.dataDir, "tasks", TASK);
    const remove = (orderId: string) => at.order("inf:session:remove", [{ orderId, task: TASK }]);
    await expect(remove("remove:1")).rejects.toThrow("still open here");
    await at.order("inf:session:close", [{ orderId: "close:1", task: TASK }]);
    await expect(remove("remove:2")).rejects.toThrow("working copy is still here");
    expect(existsSync(folder)).toBe(true);

    // The working copy retired, the folder goes, and nothing writes it again.
    rmSync(work, { recursive: true });
    expect(await remove("remove:3")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
    expect((await at.order("inf:session:roster", [])).tasks).toEqual([]);
    expect(await remove("remove:3")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
  });

  it("tells the home when a job the crewmate's shell started there ends", async () => {
    const at = await placed();
    await at.open();
    at.host().jobExit({
      jobId: "job1",
      ownerId: TASK,
      command: "pnpm test",
      exitCode: 0,
      durationMs: 1200,
      tail: "passed",
    });
    await expect
      .poll(() => at.home.effects.map((effect) => effect.channel))
      .toEqual(["inf:work:job-exit"]);
    expect(at.home.effects[0]).toMatchObject({
      callId: "job:job1",
      request: { task: TASK, exit: { jobId: "job1", exitCode: 0, tail: "passed" } },
    });
  });

  // Intent: INF-416 piece A (audit R6): a cut-off knowledge write is safe to
  // ask again on the work computer, as the home already treats it, instead of
  // reading as though the change may already be done.
  it("calls a cut-off knowledge write safe to ask again (INF-416 A)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "record_knowledge"] },
      },
    ]);
    const knowledge = at.home.hold("inf:work:record-knowledge");
    model([
      {
        tools: [
          {
            name: "record_knowledge",
            args: {
              action: "publish",
              request_id: "cut-off-1",
              kind: "concept",
              title: "Idle ladder",
              text: "How an idle crewmate is nudged.",
            },
          },
        ],
      },
      { text: "Asked again." },
    ]);
    const from = api.requests.length;
    try {
      await at.order("inf:session:prompt", [
        { orderId: "knowledge-cut", task: TASK, text: "Save it." },
      ]);
      await knowledge.reached;
      controller.abort(new Error("Claude stopped waiting"));
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("You can ask again");
      const transcript = JSON.stringify(
        api.requests.slice(from).map((request) => request.body.messages),
      );
      expect(transcript).not.toContain("may already be done");
      console.info("Cut-off knowledge write:", transcript.slice(-500));
      knowledge.open();
      await at.ended(1);
    } finally {
      knowledge.open();
    }
  });

  // Intent: INF-389, review INF-381's I1 on PR #66: a job's end is its own
  // fact, not part of the tool it ran under, so a cancelled tool never
  // withdraws the end its crewmate waits for.
  it("tells the home a job's end that arrives in a cancelled tool's scope, and forgets its row only once the home answers (INF-389)", async () => {
    const controller = new AbortController();
    let exits!: () => void;
    const exited = new Promise<void>((resolve) => {
      exits = resolve;
    });
    let host: () => SessionHost = () => {
      throw new Error("No conversation was opened.");
    };
    // A tool that starts a job here and then asks the home: the job's end
    // arrives on a callback registered inside the tool, as a spawned
    // child's close does.
    const startJob = crewmateTool({
      name: "start_job",
      label: "Start a job",
      description: "Start a background job and note it.",
      parameters: Type.Object({}),
      bind: (delegate) => {
        const onProgress = delegate.onProgress;
        if (!onProgress) return undefined;
        return async (_params, signal) => {
          void exited.then(() =>
            host().jobExit({
              jobId: "9b2e4f61",
              ownerId: TASK,
              command: "pnpm test:ios",
              exitCode: 0,
              durationMs: 95_000,
              tail: "Test Suites: 12 passed",
            }),
          );
          await (signal
            ? onProgress("Started pnpm test:ios in the background.", undefined, signal)
            : onProgress("Started pnpm test:ios in the background."));
          return { text: "Started." };
        };
      },
    });
    const at = await placed({ toolSignal: controller.signal, tools: [startJob] });
    host = at.host;
    await at.open();
    const progress = at.home.hold("inf:work:progress");
    const told = at.home.hold("inf:work:job-exit");
    const tasks = new PlacedTasks(at.dataDir);
    model([{ tools: [{ name: "start_job", args: {} }] }, { text: "Waiting for the job." }]);
    try {
      await at.order("inf:session:prompt", [
        { orderId: "job-in-tool", task: TASK, text: "Run the iOS tests." },
      ]);
      await progress.reached;
      controller.abort(new Error("Claude stopped waiting"));
      await at.ended(1);
      exits();
      await expect
        .poll(() => at.home.asked.some((ask) => ask.callId === "job:9b2e4f61"))
        .toBe(true);
      expect(tasks.jobs(TASK).map((job) => job.id)).toEqual(["9b2e4f61"]);
      told.open();
      await expect.poll(() => tasks.jobs(TASK)).toEqual([]);
      expect(
        at.home.effects
          .filter((effect) => effect.channel === "inf:work:job-exit")
          .map((effect) => effect.request.exit),
      ).toEqual([
        {
          jobId: "9b2e4f61",
          command: "pnpm test:ios",
          exitCode: 0,
          durationMs: 95_000,
          tail: "Test Suites: 12 passed",
        },
      ]);
    } finally {
      progress.open();
      told.open();
    }
  });

  // INF-367: a restart here tells the home of each background job's end it
  // had not told, once, so the crewmate never waits for an exit that cannot
  // arrive.
  it("tells the home once of each job end its last run left untold - a job its stop killed, one its end left unmarked, and an exit the home had not answered - asking again under the job's id when it stops again before the home answers (INF-367)", async () => {
    const at = await placed();
    await at.open();
    const told = at.home.hold("inf:work:job-exit");
    const asks = (id: string) => at.home.asked.filter((ask) => ask.callId === `job:${id}`).length;
    // The rows a run keeps while its jobs run (`JobManager`): its stop marks
    // the one it kills, and an end without its stop leaves the other as is.
    const tasks = new PlacedTasks(at.dataDir);
    const startedAt = Date.now() - 20 * 60_000;
    tasks.jobRows.add({ id: "45d291d9", ownerId: TASK, command: "pnpm test:ios", startedAt });
    tasks.jobRows.add({ id: "5e1f0c2a", ownerId: TASK, command: "pnpm build", startedAt });
    tasks.jobRows.markStoppedByQuit("45d291d9", TASK, startedAt + 12 * 60_000);
    // A third job exits now, and the home is slow to answer.
    at.host().jobExit({
      jobId: "7c3a9e10",
      ownerId: TASK,
      command: "pnpm lint",
      exitCode: 0,
      durationMs: 4_000,
      tail: "clean",
    });
    await expect.poll(() => asks("7c3a9e10")).toBe(1);

    await at.restartComputer();
    await expect
      .poll(() => [asks("45d291d9"), asks("5e1f0c2a"), asks("7c3a9e10")])
      .toEqual([1, 1, 2]);
    // Stopped again before the home answered: every row stays for the next start.
    await at.restartComputer();
    expect(tasks.jobs(TASK).map((job) => job.id)).toEqual(["45d291d9", "5e1f0c2a", "7c3a9e10"]);
    told.open();
    await expect.poll(() => tasks.jobs(TASK)).toEqual([]);
    expect(asks("45d291d9")).toBeGreaterThan(1);
    expect(asks("5e1f0c2a")).toBeGreaterThan(1);
    const heard = at.home.effects
      .filter((effect) => effect.channel === "inf:work:job-exit")
      .map((effect) => effect.request.exit as { jobId: string })
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
    expect(heard).toEqual([
      {
        jobId: "45d291d9",
        command: "pnpm test:ios",
        exitCode: null,
        durationMs: 12 * 60_000,
        tail: "",
        interrupted: "quit",
      },
      {
        jobId: "5e1f0c2a",
        command: "pnpm build",
        exitCode: null,
        durationMs: 0,
        tail: "",
        interrupted: "crash",
      },
      { jobId: "7c3a9e10", command: "pnpm lint", exitCode: 0, durationMs: 4_000, tail: "clean" },
    ]);
  });

  // INF-379: a Claude conversation's background work runs inside its
  // client, which this computer's stop ends with it; only what the client
  // still ran then is told, once, at the next start.
  it("keeps a row for each background task a Claude client runs, none for one it finished or once its client ended, and tells the home once at the next start that the stop ended the rest (INF-379)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    const tasks = new PlacedTasks(at.dataDir);
    const rows = () => tasks.jobs(TASK).map(({ id, command }) => ({ id, command }));
    const told = () => at.home.effects.filter((effect) => effect.channel === "inf:work:job-exit");
    const suite = { id: "bybac1mss", description: "Run the long suite" };
    const lint = { id: "b7rk2q0zt", description: "Lint the project" };
    try {
      claude.answer({ text: "Both run in the background." });
      await at.order("inf:session:open", [{ orderId: "open:tasks", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        {
          orderId: "rows:tasks",
          task: TASK,
          text: "Run the suite and the lint in the background.",
        },
      ]);
      await at.ended(1);
      claude.listBackgroundTasks([suite, lint]);
      await expect.poll(rows).toEqual([
        { id: suite.id, command: suite.description },
        { id: lint.id, command: lint.description },
      ]);
      // The lint finished: the client tells its own model, and its row goes.
      claude.listBackgroundTasks([suite]);
      await expect.poll(rows).toEqual([{ id: suite.id, command: suite.description }]);
      // The home hears how many, as before, and nothing of the tasks themselves
      // (the client's attach says it runs none it knows of yet).
      await expect
        .poll(() =>
          at.home.events.flatMap(({ event: { type, ...said } }) =>
            type === "background_work_changed" ? [said] : [],
          ),
        )
        .toEqual([{}, { count: 2 }, { count: 1 }]);
      expect(told()).toEqual([]);

      await at.restartComputer();
      await expect.poll(rows).toEqual([]);
      expect(told().map((effect) => effect.request.exit)).toEqual([
        {
          jobId: suite.id,
          command: suite.description,
          exitCode: null,
          durationMs: expect.any(Number),
          tail: "",
          interrupted: "quit",
        },
      ]);

      // A client that ends while this computer runs on takes its tasks with
      // it, and leaves no row for a later start to tell as cut off.
      claude.answer({ text: "The suite runs again." });
      await at.order("inf:session:open", [{ orderId: "open:tasks:2", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:tasks:2", task: TASK, text: "Run the suite again." },
      ]);
      await at.ended(2);
      claude.listBackgroundTasks([{ id: "bq4w8n1xe", description: "Run the long suite" }]);
      await expect.poll(rows).toEqual([{ id: "bq4w8n1xe", command: "Run the long suite" }]);
      claude.endClient();
      await expect.poll(rows).toEqual([]);
      await at.restartComputer();
      await at.inReach();
      expect(told()).toHaveLength(1);
    } finally {
      claude.endClient();
    }
  });

  it("keeps a crewmate's builds and tests below the UI as another user on the home's own Mac", async () => {
    // Captain on INF-255. This world joins by a link for another user here (`work`).
    const at = await placed();
    await at.open();
    expect(at.belowUi()).toBe(true);
  });

  it("refuses an order it does not know, a malformed one, and one for a task it never opened", async () => {
    const at = await placed();
    await expect(at.order("inf:session:launch" as WorkOrderChannel, [])).rejects.toThrow(
      "not a request this computer answers",
    );
    await expect(at.order("inf:session:prompt", [{ task: TASK }])).rejects.toThrow("malformed");
    await expect(
      at.order("inf:session:prompt", [{ orderId: "rows:9", task: TASK, text: "Hi." }]),
    ).rejects.toThrow("No conversation is open");
    // Nothing open to stop: nothing done, and nothing kept for a task it never held.
    expect(await at.order("inf:session:abort", [{ orderId: "stop:1", task: TASK }])).toEqual({
      ok: true,
    });
    expect((await at.order("inf:session:roster", [])).tasks).toEqual([]);
    // A computer that keeps no working copies holds a task's work in its
    // folder, so it never removes one.
    await expect(
      at.order("inf:session:remove", [{ orderId: "remove:1", task: TASK }]),
    ).rejects.toThrow("keeps a task's work in its folder");
    await expect(
      at.order("inf:session:open", [{ orderId: "open:x", task: "../escape", spec: at.spec }]),
    ).rejects.toThrow("malformed");
    expect(existsSync(join(at.dataDir, "escape"))).toBe(false);
  });
});
