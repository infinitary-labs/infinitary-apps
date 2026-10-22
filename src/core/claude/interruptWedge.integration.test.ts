import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PlacedEventRecord, PlacedSpec } from "@shared/work";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PlacedTasks } from "../helper/placedTasks";
import { SessionHost } from "../helper/sessionHost";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_MODEL_PROVIDER, createClaudeSessionFactory } from "./session";

/**
 * A crewmate's Claude client that stops answering - INB-9's, on the computer
 * that runs work, sent a model request, never got an answer, and then
 * answered nothing for hours: 0% CPU, a SIGTERM ignored, gone only on a
 * person's SIGKILL. The first mate's interrupt waited on it all that time,
 * and the drop the captain asked for waited behind the interrupt.
 *
 * The real path: the work computer's order handler (`SessionHost`), Claude's
 * rolling session, the SDK and the SDK's own client boxed in a throwaway
 * HOME (`mockClaudeClient` turn mode), against a local stub of the model's
 * API that never answers. SIGSTOP stands in for whatever froze INB-9's
 * client: what is under test is only "the client does not answer".
 *
 * Intent (the captain, 2026-10-19: "looks like interrupting a crewmate can
 * hang forever? this needs a fix by itself"): an interrupt, and a close,
 * end the turn within a tick of the host's clock, whatever the client does.
 */
vi.setConfig({ testTimeout: 30_000 });

/**
 * How long the stopped client takes to exit once the session stops it: the
 * SDK's close sends SIGTERM, which a frozen client holds, and SIGKILL 5 s on.
 */
const STOPPED_MS = 15_000;

const MODEL = "claude-haiku-4-5";
const INSTRUCTION = "You are a crewmate looking for the business project's folder.";
const TASK = "d744e482";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi((body) => JSON.stringify(body.system ?? "").includes(INSTRUCTION));
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];
const hosts: SessionHost[] = [];
/** Processes a case stopped: none outlives it. */
const stopped: number[] = [];

afterEach(async () => {
  for (const pid of stopped.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/**
 * The host's one clock, moved by hand: each tick runs what registered on it.
 * `reads` counts the session's reads of it, each a moment it recorded - an
 * interrupt or a cut it was asked for among them.
 */
function handClock() {
  let now = Date.now();
  let reads = 0;
  const runs: ((now: number) => void)[] = [];
  return {
    clock: {
      now: () => {
        reads += 1;
        return now;
      },
      register: (_name: string, _every: number, run: (now: number) => void) => {
        runs.push(run);
        return () => {
          runs.splice(runs.indexOf(run), 1);
        };
      },
    },
    now: () => now,
    reads: () => reads,
    tick: () => {
      now += TICK_PERIOD_MS;
      for (const run of [...runs]) run(now);
    },
  };
}

/** A throwaway HOME with the boxed client, Claude's factory over it, and the work computer's order handler. */
function workComputer() {
  const home = scratchDir("infinitary-interrupt-wedge-home-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  mkdirSync(join(home, "worktree"), { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const hand = handClock();
  const logs: string[] = [];
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: hand.clock,
    log: (line) => logs.push(line),
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
  });
  const homeEvents: PlacedEventRecord["event"][] = [];
  let through = 0;
  const host = new SessionHost({
    tasks: new PlacedTasks(scratchDir("infinitary-interrupt-wedge-work-")),
    // The home: takes each event once, in order; every other ask is done.
    ask: async (channel, args) => {
      if (channel === "inf:work:events") {
        const [request] = args as [{ events: PlacedEventRecord[] }];
        for (const record of request.events) {
          if (record.seq === through + 1) {
            homeEvents.push(record.event);
            through = record.seq;
          }
        }
        return { through, kept: through };
      }
      return { text: `${channel} done` };
    },
    factories: { claude: factory },
    bind: async () => ({ backend: "claude", accountId: "acct_claude" }),
    now: hand.now,
    log: (line) => logs.push(`host: ${line}`),
  });
  hosts.push(host);
  const spec: PlacedSpec = {
    binding: { backend: "claude" },
    model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    thinking: { level: "off" },
    instructions: INSTRUCTION,
    tools: ["report", "note_progress"],
  };
  const order = (channel: string, request: Record<string, unknown>) =>
    host.answer(channel, [{ task: TASK, ...request }]);
  return { hand, logs, homeEvents, host, spec, order };
}

/**
 * The boxed client this test process started, as `ps` lists it now: the
 * box's launcher execs the SDK's own client, so it is this process's child,
 * as INB-9's client (pid 18902) was the work app's.
 */
function clientProcess(): number {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }]
        : [];
    });
  const client = rows
    .filter((row) => row.ppid === process.pid && row.command.includes("claude-agent-sdk-"))
    .at(-1);
  if (client === undefined) throw new Error("the boxed client is not running");
  return client.pid;
}

/**
 * One minute of the host's clock, once the session has recorded what it was
 * asked since `before` - an order's arrival, not a second of the real clock,
 * which a busy Mac can outlast (INF-857).
 */
async function minuteOnceAsked(hand: ReturnType<typeof handClock>, before: number): Promise<void> {
  await expect.poll(() => hand.reads()).toBeGreaterThan(before);
  hand.tick();
}

/** INB-9's turn up to the wedge: open, prompt, the model's request left unanswered, a steer delivered. */
async function inb9UpToTheWedge(at: ReturnType<typeof workComputer>) {
  await at.order("inf:session:open", { orderId: `open:${TASK}:1`, spec: at.spec });
  // The model never answers: INB-9's last request, at 1:35 PM, got no byte back.
  api.answer(() => {});
  const asked = api.nextRequest();
  expect(
    await at.order("inf:session:prompt", { orderId: "rows:20929", text: "Find the folder." }),
  ).toEqual({ turn: 1 });
  await asked;
  expect(
    await at.order("inf:session:steer", {
      orderId: "rows:20945",
      text: "This is upkeep: skip the pull request and report.",
    }),
  ).toEqual({ delivered: true });
}

describe("an interrupt, on the computer that runs the crewmate, when its client stops answering", () => {
  it("answers the interrupt and ends the turn within a tick, so the close behind it is not held", async () => {
    const at = workComputer();
    await inb9UpToTheWedge(at);
    const client = clientProcess();
    stopped.push(client);
    process.kill(client, "SIGSTOP");
    const before = at.hand.reads();

    const answered: string[] = [];
    void at
      .order("inf:session:abort", { orderId: "abort:e3219553" })
      .then((answer) => answered.push(`abort ${JSON.stringify(answer)}`));
    void at
      .order("inf:session:close", { orderId: `close:${TASK}` })
      .then((answer) => answered.push(`close ${JSON.stringify(answer)}`));
    await minuteOnceAsked(at.hand, before);

    // The client is stopped outright, and both orders are answered in turn.
    await expect
      .poll(() => answered, { timeout: STOPPED_MS })
      .toEqual(['abort {"ok":true}', 'close {"ok":true}']);
    // The home takes the turn's end as the work computer sends it, after the answers.
    await expect
      .poll(() => at.homeEvents)
      .toContainEqual(expect.objectContaining({ type: "turn_ended", turn: 1, outcome: "done" }));
    const roster = (await at.host.answer("inf:session:roster", [])) as {
      tasks: { task: string; running?: unknown; closed: boolean }[];
    };
    expect(roster.tasks.find((entry) => entry.task === TASK)).toMatchObject({ closed: true });
    expect(roster.tasks.find((entry) => entry.task === TASK)?.running).toBeUndefined();
  });

  it("closes the conversation for good within a tick, with no interrupt ahead of the close", async () => {
    const at = workComputer();
    await inb9UpToTheWedge(at);
    const client = clientProcess();
    stopped.push(client);
    process.kill(client, "SIGSTOP");
    const before = at.hand.reads();

    let answered = false;
    void at.order("inf:session:close", { orderId: `close:${TASK}` }).then(() => {
      answered = true;
    });
    await minuteOnceAsked(at.hand, before);

    await expect.poll(() => answered, { timeout: STOPPED_MS }).toBe(true);
    await expect
      .poll(() => at.homeEvents)
      .toContainEqual(
        expect.objectContaining({ type: "turn_ended", turn: 1, outcome: "interrupted" }),
      );
  });

  it("fails the turn a bound's cut ends, with the bound's failure", async () => {
    const at = workComputer();
    await inb9UpToTheWedge(at);
    const client = clientProcess();
    stopped.push(client);
    process.kill(client, "SIGSTOP");
    const before = at.hand.reads();

    let answer: unknown;
    void at
      .order("inf:session:abort", {
        orderId: "abort:bound",
        failure: "Request timed out after 300 seconds",
      })
      .then((answered) => {
        answer = answered;
      });
    await minuteOnceAsked(at.hand, before);

    await expect.poll(() => answer, { timeout: STOPPED_MS }).toEqual({ ok: true });
    await expect.poll(() => at.homeEvents.some((event) => event.type === "turn_ended")).toBe(true);
    expect(at.homeEvents).toContainEqual(
      expect.objectContaining({
        type: "turn_failed",
        error: "Request timed out after 300 seconds",
      }),
    );
  });
});
