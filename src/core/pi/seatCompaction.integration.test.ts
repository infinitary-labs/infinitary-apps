import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  startStubApi,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { PI_CONTRACT_MODEL, piContractModels } from "../../../tests/helpers/piContractWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import type { ModelSession, SessionEvent } from "../session/session";
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
