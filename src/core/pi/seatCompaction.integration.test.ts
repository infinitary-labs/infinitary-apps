import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicError,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { PI_CONTRACT_MODEL, piContractModels } from "../../../tests/helpers/piContractWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import type { ModelSession, SessionEvent } from "../session/session";
import { boundTool } from "../session/tools";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";
import { createPiSessionFactory } from "./session";

/** INF-447: exercise real Pi compaction using requests and usage readings from a loopback service.
 * No provider credentials, catalog network, shared files or synthetic injected session events.
 */
let api: StubApi | undefined;
let session: ModelSession | undefined;
afterEach(async () => {
  session?.dispose();
  await session?.closed();
  await catalogRefreshesSettled();
  await api?.close();
  session = undefined;
  api = undefined;
});

it.each([1_000_000, 200_000])(
  "INF-447: real Pi summarizes the seat at its budget on a %i-token model",
  async (window) => {
    api = await startStubApi(() => true);
    const readings: { tokens: number; summary: boolean }[] = [];
    api.answer((request, res) => {
      const tokens = Math.ceil(JSON.stringify(request.body).length / 4);
      const summary = !request.body.tools?.length;
      readings.push({ tokens, summary });
      beginAnthropicStream(res, tokens, request.n);
      writeAnthropicText(
        res,
        0,
        summary
          ? "The captain asked about the crew. Continue from the saved task records."
          : "Aye.",
      );
      finishAnthropicStream(res, "end_turn", 16);
    });
    const modelsPath = piContractModels(api);
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    models.providers[PI_CONTRACT_MODEL.provider].models[0].contextWindow = window;
    writeFileSync(modelsPath, JSON.stringify(models));
    const runtime = await createModelRuntime({
      authPath: join(modelsPath, "..", "auth.json"),
      modelsPath,
      catalogBaseUrl: api.url,
    });
    const root = scratchDir("infinitary-pi-seat-compaction-");
    const cwd = join(root, "home");
    mkdirSync(cwd);
    session = await createPiSessionFactory({ agentDir: join(root, "pi") }).open(
      seatSpec({
        cwd,
        sessionsDir: join(root, "sessions"),
        binding: { backend: "pi", runtime },
        model: PI_CONTRACT_MODEL,
        tools: await firstmateTools(),
        requestTimeoutMs: 0,
        turnTimeoutMs: 0,
      }),
    );
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const row =
      "The composer keeps pasted attachments when the window loses focus. The crew verified the saved draft and completed its task.\n";
    const context = row.repeat(Math.ceil(88_000 / row.length));
    for (let turn = 0; turn < 14; turn += 1)
      await session.prompt(`[fm-op] context (not the user)\n${context}\nturn ${turn}`);
    await session.prompt("hello");
    const summaries = events.filter(
      (event) => event.type === "tool_end" && event.callId === "firstmate:compaction",
    );
    console.info("pi-compaction-evidence", JSON.stringify({ window, readings, summaries }));
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((event) => event.type === "tool_end" && !event.isError)).toBe(true);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(readings.at(-1)?.tokens).toBeLessThan(Math.min(300_000, window));
  },
);

/** A request the stand-in service saw: the summary of a fold carries no tools. */
type Seen = { n: number; summary: boolean; raw: string };

const FOLD_WINDOW = 200_000;
/** A reading over Pi's threshold on that window (its reserve is 16,384). */
const OVER_THRESHOLD = FOLD_WINDOW - 1_000;
const ROW =
  "The composer keeps pasted attachments when the window loses focus. The crew verified the saved draft and completed its task.\n";
const CONTEXT = ROW.repeat(Math.ceil(88_000 / ROW.length));

function tokensOf(request: StubRequest): number {
  return Math.ceil(JSON.stringify(request.body).length / 4);
}

function reply(res: ServerResponse, request: StubRequest, tokens: number, text: string): void {
  beginAnthropicStream(res, tokens, request.n);
  writeAnthropicText(res, 0, text);
  finishAnthropicStream(res, "end_turn", 16);
}

function inOrder(raw: string | undefined, ...marks: string[]): boolean {
  const at = marks.map((mark) => raw?.indexOf(mark) ?? -1);
  return at.every((index, i) => index >= 0 && (i === 0 || index > (at[i - 1] ?? 0)));
}

/**
 * A real Pi seat on a 200k-token model whose service the test scripts, with
 * one tool, `note`. Requests are kept in order; each fold records how many
 * requests came before its end. Three pasted contexts give a fold something
 * to summarize.
 */
async function foldSeat(
  respond: (request: StubRequest, res: ServerResponse, summary: boolean) => void,
  onNote: () => void = () => {},
) {
  api = await startStubApi(() => true);
  const seen: Seen[] = [];
  api.answer((request, res) => {
    const summary = !request.body.tools?.length;
    seen.push({ n: request.n, summary, raw: request.raw });
    if (summary)
      reply(
        res,
        request,
        tokensOf(request),
        "The captain pasted logs. Continue from the saved records.",
      );
    else respond(request, res, summary);
  });
  const modelsPath = piContractModels(api);
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  models.providers[PI_CONTRACT_MODEL.provider].models[0].contextWindow = FOLD_WINDOW;
  writeFileSync(modelsPath, JSON.stringify(models));
  const runtime = await createModelRuntime({
    authPath: join(modelsPath, "..", "auth.json"),
    modelsPath,
    catalogBaseUrl: api.url,
  });
  const root = scratchDir("infinitary-pi-seat-fold-recovery-");
  const cwd = join(root, "home");
  mkdirSync(cwd);
  const note = boundTool({
    name: "note",
    label: "Note",
    description: "Notes a line.",
    parameters: Type.Object({}),
    run: () => {
      onNote();
      return { text: "Noted." };
    },
  });
  const opened = await createPiSessionFactory({ agentDir: join(root, "pi") }).open(
    seatSpec({
      cwd,
      sessionsDir: join(root, "sessions"),
      binding: { backend: "pi", runtime },
      model: PI_CONTRACT_MODEL,
      tools: [note],
      requestTimeoutMs: 0,
      turnTimeoutMs: 0,
    }),
  );
  session = opened;
  const folds: { turn?: string; afterRequest: number }[] = [];
  const events: SessionEvent[] = [];
  opened.subscribe((event) => {
    events.push(event);
    if (event.type === "context_compacted")
      folds.push({ ...(event.turn ? { turn: event.turn } : {}), afterRequest: seen.length });
  });
  for (let turn = 0; turn < 3; turn += 1)
    await opened.prompt(`[fm-op] context (not the user)\n${CONTEXT}\nturn ${turn}`);
  return { opened, seen, folds, events };
}

/**
 * The first mate's own rule (`afterFold`, INF-1712): a fold whose turn goes
 * on, or with an input not yet read, sends the recovery as its first steer.
 */
function recoverOnFold(opened: ModelSession, when: (turn: string | undefined) => boolean): void {
  opened.subscribe((event) => {
    if (event.type === "context_compacted" && when(event.turn))
      void (opened.steerFirst ?? opened.steer).call(opened, "RECOVERY-R43: read open_work first.");
  });
}

function afterFold(seen: Seen[], fold: { afterRequest: number } | undefined): Seen[] {
  expect(seen[(fold?.afterRequest ?? 0) - 1]?.summary).toBe(true);
  return seen.slice(fold?.afterRequest ?? 0);
}

it("INF-1746 R43/R44: a fold before a step's next response takes the recovery into it, the captain's words keep their order, and a fold after the turn asks nothing more", async () => {
  // Pi folds at its threshold before a tool round's next response. The
  // captain's first words arrive while the tool runs, so Pi already holds
  // them when it folds; their next words arrive during the fold. The
  // recovery must reach that next response, and the captain's words must
  // reach the model oldest first.
  let toolRound = false;
  let closeOver = false;
  const { opened, seen, folds, events } = await foldSeat(
    (request, res) => {
      if (toolRound) {
        toolRound = false;
        beginAnthropicStream(res, OVER_THRESHOLD, request.n);
        writeAnthropicToolUse(res, 0, { id: "toolu_r43", name: "note", args: {} });
        finishAnthropicStream(res, "tool_use", 16);
      } else reply(res, request, closeOver ? OVER_THRESHOLD : tokensOf(request), "Aye.");
    },
    () => {
      void session?.steer("CAPTAIN-1: the deploy window is Friday.");
      void session?.steer("CAPTAIN-2: and the release is Larkspur.");
    },
  );
  recoverOnFold(opened, (turn) => turn === "goes-on");
  let duringFold = true;
  opened.subscribe((event) => {
    if (event.type !== "tool_start" || !event.callId.endsWith(":compaction") || !duringFold) return;
    duringFold = false;
    void opened.steer("CAPTAIN-3: one more thing.");
  });
  toolRound = true;
  await opened.prompt("Note this, then acknowledge.");
  const inRun = folds.length;
  for (let turn = 3; turn < 5; turn += 1)
    await opened.prompt(`[fm-op] context (not the user)\n${CONTEXT}\nturn ${turn}`);
  closeOver = true;
  await opened.prompt("Acknowledge again.");
  console.info(
    "pi-fold-recovery-evidence",
    JSON.stringify({ seen: seen.map(({ raw: _, ...request }) => request), folds }),
  );
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);

  expect(folds[inRun - 1]?.turn).toBe("goes-on");
  const next = afterFold(seen, folds[inRun - 1]);
  expect(
    seen.slice(0, folds[inRun - 1]?.afterRequest ?? 0).some((r) => r.raw.includes("RECOVERY-R43")),
  ).toBe(false);
  expect(inOrder(next[0]?.raw, "RECOVERY-R43", "CAPTAIN-1")).toBe(true);
  const lastOfTurn = next.filter((request) => request.raw.includes("CAPTAIN-3"))[0];
  expect(inOrder(lastOfTurn?.raw, "CAPTAIN-1", "CAPTAIN-2", "CAPTAIN-3")).toBe(true);
  const after = folds.slice(inRun);
  expect(after).toHaveLength(1);
  expect(after[0]).not.toHaveProperty("turn");
  expect(seen.length).toBe(after[0]?.afterRequest);
  expect(seen.at(-1)?.summary).toBe(true);
});

it("INF-1746 R43: a fold before a prompt takes the recovery into the prompt's first request, ahead of words queued during the fold", async () => {
  // Pi folds before sending a prompt when the last reply was cut off over
  // its threshold. The captain's words arrive while it folds.
  let cut: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    cut = resolve;
  });
  let hang = false;
  const { opened, seen, folds, events } = await foldSeat((request, res) => {
    if (hang) {
      hang = false;
      beginAnthropicStream(res, OVER_THRESHOLD, request.n);
      writeAnthropicText(res, 0, "Reading the");
      return;
    }
    reply(res, request, tokensOf(request), "Aye.");
  });
  // Cut once Pi has read the reply's start, with its usage reading.
  const stopWatching = opened.subscribe((event) => {
    if (event.type === "assistant_delta") cut?.();
  });
  hang = true;
  const cutTurn = opened.prompt("Summarize everything.").catch(() => {});
  await arrived;
  await opened.abort();
  await cutTurn;
  stopWatching();
  // The prompt is not read yet, so the first mate sends the recovery.
  recoverOnFold(opened, () => true);
  opened.subscribe((event) => {
    if (event.type === "tool_start" && event.callId.endsWith(":compaction"))
      void opened.steer("CAPTAIN-1: the deploy window is Friday.");
  });
  const foldsBefore = folds.length;
  await opened.prompt("What is open?");
  console.info(
    "pi-fold-recovery-evidence",
    JSON.stringify({ seen: seen.map(({ raw: _, ...request }) => request), folds }),
  );
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  expect(folds).toHaveLength(foldsBefore + 1);
  const next = afterFold(seen, folds.at(-1));
  expect(inOrder(next[0]?.raw, "What is open?", "RECOVERY-R43")).toBe(true);
  expect(next[0]?.raw).not.toContain("CAPTAIN-1");
  expect(next.some((request) => request.raw.includes("CAPTAIN-1"))).toBe(true);
});

it("INF-1746 R43: the retry after an overflow fold takes the recovery, ahead of words queued during the fold", async () => {
  let overflow = false;
  const { opened, seen, folds, events } = await foldSeat((request, res) => {
    if (overflow) {
      overflow = false;
      writeAnthropicError(res, 400, {
        type: "invalid_request_error",
        message: "prompt is too long: 213462 tokens > 200000 maximum",
      });
      return;
    }
    reply(res, request, tokensOf(request), "Aye.");
  });
  recoverOnFold(opened, (turn) => turn === "goes-on");
  opened.subscribe((event) => {
    if (event.type === "tool_start" && event.callId.endsWith(":compaction"))
      void opened.steer("CAPTAIN-1: the deploy window is Friday.");
  });
  overflow = true;
  await opened.prompt("What is open?");
  console.info(
    "pi-fold-recovery-evidence",
    JSON.stringify({ seen: seen.map(({ raw: _, ...request }) => request), folds }),
  );
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  expect(folds.at(-1)?.turn).toBe("goes-on");
  const next = afterFold(seen, folds.at(-1));
  expect(next[0]?.raw).toContain("RECOVERY-R43");
  expect(next[0]?.raw).not.toContain("CAPTAIN-1");
  expect(next.some((request) => request.raw.includes("CAPTAIN-1"))).toBe(true);
});

it("INF-1746 R43: a fold after the turn's last reply, with words still unread, takes the recovery into the run that delivers them", async () => {
  // Pi continues once after a fold that leaves steers queued; its first
  // request takes the queue's head without polling again
  // (`skipInitialSteeringPoll`).
  let closeOver = false;
  const { opened, seen, folds, events } = await foldSeat((request, res) => {
    reply(res, request, closeOver ? OVER_THRESHOLD : tokensOf(request), "Aye.");
  });
  // The captain's words arrive during the fold, so they are unread when it
  // ends, and the first mate sends the recovery.
  opened.subscribe((event) => {
    if (event.type === "tool_start" && event.callId.endsWith(":compaction"))
      void opened.steer("CAPTAIN-1: the deploy window is Friday.");
  });
  recoverOnFold(opened, () => true);
  closeOver = true;
  await opened.prompt("Acknowledge.");
  closeOver = false;
  console.info(
    "pi-fold-recovery-evidence",
    JSON.stringify({ seen: seen.map(({ raw: _, ...request }) => request), folds }),
  );
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  expect(folds.at(-1)).not.toHaveProperty("turn");
  const next = afterFold(seen, folds.at(-1));
  expect(next[0]?.raw).toContain("RECOVERY-R43");
  expect(next[0]?.raw).not.toContain("CAPTAIN-1");
  expect(next.some((request) => request.raw.includes("CAPTAIN-1"))).toBe(true);
});
