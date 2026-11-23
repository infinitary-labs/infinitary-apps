import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DELIVERY_CHANGES, DELIVERY_COMPLETE } from "../../src/core/orchestrator/contextDelivery";
import { FIRSTMATE_FAILURE_CARD_ID } from "../../src/core/orchestrator/hostCards";
import { chatFrame, customChatText } from "../helpers/customApiDialect";
import { fillCustomApi, saveCustomApi } from "./customApi";
import { chooseWhereFirstMateLives } from "./firstLaunch";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { regionShot } from "./pictures";
import { servedContext } from "./providerRequest";
import { pager, showCard, shownCard } from "./stack";

const CTX = 49152;
const OUT = 8192;
const USAGE = true;
const MODEL = "nvidia/Qwen3.8-27B-NVFP4";

type Logged = {
  n: number;
  at: string;
  kind: string;
  bytes: number;
  approxTokens: number;
  checkTokens: number;
  maxTokens: unknown;
  lastRole: unknown;
  messages: number;
  status: number;
  summaryInputChars?: number;
  /** The newest context a first mate request carries, and whether it holds the fold's recovery. */
  context?: "complete" | "changes";
  recovery?: boolean;
};

function filler(turn: number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const line = `2026-10-11T23:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")} worker-${turn}-${i % 13} INFO processed batch ${i} of shard ${(i * 31) % 97} in ${(i * 17) % 900}ms, queue depth ${(i * 3) % 40}`;
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

test("Firstmate compacts and keeps answering on a 48k custom model", async () => {
  const out = test.info().outputPath("wire");
  mkdirSync(out, { recursive: true });
  const log: Logged[] = [];
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: MODEL, context_length: CTX, max_output_tokens: OUT }],
        }),
      );
      return;
    }
    const body = JSON.parse(raw) as {
      messages: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
      max_tokens?: number;
      stream_options?: { include_usage?: boolean };
    };
    const transcript = JSON.stringify(body);
    const promptChars =
      JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length;
    const approx = Math.ceil(promptChars / 4);
    const system = String((body.messages[0] as { content?: unknown })?.content ?? "");
    const kind = transcript.includes("synthetic API connection check")
      ? "check"
      : system.includes("context summarization assistant")
        ? "summary"
        : body.tools?.some((tool) => tool.function.name === "emit_card")
          ? "firstmate"
          : "other";
    const entry: Logged = {
      n: log.length + 1,
      at: new Date().toISOString(),
      kind,
      bytes: raw.length,
      approxTokens: approx,
      checkTokens: Math.ceil(
        Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools ?? [] })) / 3,
      ),
      maxTokens: body.max_tokens,
      lastRole: body.messages.at(-1)?.role,
      messages: body.messages.length,
      status: 200,
    };
    if (kind === "summary") entry.summaryInputChars = transcript.length;
    if (kind === "firstmate" && body.messages.at(-1)?.role === "user") {
      const context = servedContext(raw);
      if (context?.delivery === DELIVERY_COMPLETE) entry.context = "complete";
      if (context?.delivery === DELIVERY_CHANGES) entry.context = "changes";
      entry.recovery = context?.recovery !== undefined;
    }
    log.push(entry);
    writeFileSync(join(out, "stub-requests.json"), JSON.stringify(log, null, 2));
    // A real server enforces its own window on its own count (chars/4 here).
    if (kind !== "check" && approx + Number(body.max_tokens ?? 0) > CTX) {
      entry.status = 400;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `This model's maximum context length is ${CTX} tokens. However, you requested ${approx + Number(body.max_tokens ?? 0)} tokens. Please reduce the length of the messages or completion.`,
          },
        }),
      );
      return;
    }
    const usage =
      USAGE && body.stream_options?.include_usage ? { input: approx, output: 40 } : undefined;
    const usageFrame = usage
      ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })}\n\n`
      : "";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (kind === "check") {
      if (transcript.includes("data:image/png;base64,")) {
        res.end(customChatText("unknown"));
        return;
      }
      const result = transcript.includes('"role":"tool"');
      if (result) res.end(customChatText("FIRSTMATE_CUSTOM_API_OK"));
      else {
        const args = '{"text":"FIRSTMATE_CUSTOM_API_OK"}';
        res.end(
          chatFrame({
            tool_calls: [
              {
                index: 0,
                id: "check_call",
                type: "function",
                function: { name: "firstmate_echo", arguments: args },
              },
            ],
          }) +
            chatFrame({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
      }
      return;
    }
    if (kind === "summary") {
      // A real model writes as much checkpoint as it is allowed: fill the cap
      // Pi asked for (about 4 characters a token), so a summary the app leaves
      // unsized shows up as a retry that overflows again.
      const allowed = Number(body.max_tokens ?? 0) * 4;
      const head =
        "## Goal\nThe captain pasted server logs for review.\n\n## Progress\n- Firstmate acknowledged each part.\n\n## Critical Context\n";
      res.end(
        customChatText(
          `${head}${filler(0, Math.max(0, allowed - head.length))}`.slice(0, allowed || undefined),
          usage,
        ),
      );
      return;
    }
    // A fold inside a turn steers its recovery in after the tool result
    // (INF-1712): that user message is the app's own, not a captain message,
    // so it is answered like the tool result it follows.
    const recoverySteer = entry.recovery === true && body.messages.at(-2)?.role === "tool";
    if (kind === "firstmate" && body.messages.at(-1)?.role === "user" && !recoverySteer) {
      calls += 1;
      const args = JSON.stringify({
        title: `Noted part ${calls}`,
        body: "I read the log part you pasted.",
      });
      res.end(
        chatFrame({
          tool_calls: [
            {
              index: 0,
              id: `call_${calls}`,
              type: "function",
              function: { name: "emit_card", arguments: args },
            },
          ],
        }) +
          chatFrame({}, "tool_calls") +
          usageFrame +
          "data: [DONE]\n\n",
      );
      return;
    }
    res.end(customChatText("Shown on a card.", usage));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchApp({ modelsJson: () => JSON.stringify({ providers: {} }) });
    const page = launched.page;
    await chooseWhereFirstMateLives(page, "here");
    await page.locator("[data-first-run-gate] [data-connect-custom-api]").click();
    await fillCustomApi(page, {
      name: "Small context model",
      address: baseUrl,
      network: "local",
      pick: [MODEL],
    });
    expect(await saveCustomApi(page)).toBe("saved");
    await page.getByRole("button", { name: `Use ${MODEL}`, exact: true }).click();
    for (let turn = 1; turn <= 10; turn++) {
      await askFirstmate(
        page,
        `Here is log part ${turn}, just acknowledge it:\n${filler(turn, 12000)}`,
      );
      const cards = await page.evaluate(() => window.infinitary.cards.list());
      const failure = cards.find((card) => card.id === FIRSTMATE_FAILURE_CARD_ID);
      if (failure) {
        await expect(pager(page, cards.length)).toBeVisible();
        await showCard(page, failure.title);
        await regionShot(
          shownCard(page, failure.title),
          test.info().outputPath("failure-card.png"),
        );
      }
      expect(failure, `turn ${turn} recovers instead of showing a context failure`).toBeUndefined();
      expect(calls).toBe(turn);
    }
    // Short messages after the compactions: the saved summary and the kept
    // turns leave room for them, so none is refused.
    for (const text of ["try again", "hello", "hello again", "hello"]) {
      await askFirstmate(page, text);
      const after = await page.evaluate(() => window.infinitary.cards.list());
      expect(
        after.find((card) => card.id === FIRSTMATE_FAILURE_CARD_ID),
        `"${text}" after compaction recovers instead of showing a context failure`,
      ).toBeUndefined();
    }
    expect(log.filter((entry) => entry.kind === "summary").length).toBeGreaterThan(0);
    expect(log.every((entry) => entry.status === 200)).toBe(true);
    // INF-1712 over the real wire: the conversation's first context is
    // complete, later ones carry only what changed, and the first request
    // after each summary is complete again with the fold's recovery.
    const served = log.filter((entry) => entry.context !== undefined);
    expect(served[0]).toMatchObject({ context: "complete", recovery: false });
    expect(served.some((entry) => entry.context === "changes")).toBe(true);
    for (const summary of log.filter((entry) => entry.kind === "summary")) {
      expect(served.find((entry) => entry.n > summary.n)).toMatchObject({
        context: "complete",
        recovery: true,
      });
    }
    expect(
      served.slice(1).every((entry) => entry.context === "changes" || entry.recovery),
      "a complete context after the first one follows a fold",
    ).toBe(true);
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    await expect(pager(page, cards.length)).toBeVisible();
    await showCard(page, `Noted part ${calls}`);
    await regionShot(
      shownCard(page, `Noted part ${calls}`),
      test.info().outputPath("recovered-card.png"),
    );
  } finally {
    writeFileSync(join(out, "stub-requests.json"), JSON.stringify(log, null, 2));
    await launched?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
