import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { startStubApi } from "../../../tests/helpers/anthropicDialect";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SessionEvent } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { hasActiveSession } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

/**
 * Intent: the startup-stop fix must work across the SDK's real input and
 * control queues, then preserve the next prompt in the client's transcript.
 * The scripted unit check owns stop retention; this integration owns that
 * SDK compatibility and persisted recovery. The co-released client runs in
 * a scratch HOME with dummy credentials and a Keychain shim, against a
 * local API. No real sign-in, network service or account is used.
 */
it("delivers a startup stop through the real client and records the next answer", async () => {
  const instruction = "You are checking startup stop delivery.";
  const api = await startStubApi((body) => JSON.stringify(body.system).includes(instruction));
  const home = scratchDir("infinitary-startup-stop-");
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const executable = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  const configDir = join(home, ".claude");
  const recordDir = join(home, "record");
  const store = new SessionRecordStore(recordDir);
  const actions: string[] = [];
  const events: SessionEvent[] = [];
  const session = await createClaudeSessionFactory({
    configDir,
    env: () => ({ PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: executable }),
    clock: manualClock(),
    records: () => store,
    query: (params) => {
      actions.push("client attached");
      const client = query(params);
      const interrupt = client.interrupt.bind(client);
      client.interrupt = () => {
        actions.push("interrupt sent");
        return interrupt();
      };
      return client;
    },
  }).open(
    codingSpec({
      binding: { backend: "claude", accountId: "claude" },
      cwd,
      instructions: instruction,
      recordDir,
      model: { provider: "anthropic-claude", id: "claude-haiku-4-5" },
    }),
  );
  session.subscribe((event) => events.push(event));
  try {
    actions.push("prompt called");
    const first = session.prompt("Start work, then stop.");
    actions.push("stop asked before attachment");
    await session.abort();
    await first;
    expect(actions).toEqual([
      "prompt called",
      "stop asked before attachment",
      "client attached",
      "interrupt sent",
    ]);
    expect(session.isStreaming()).toBe(false);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    await session.prompt("Continue after the stop.");
    expect(events).toContainEqual({ type: "turn_closed", text: "Aye." });
    // The client writes on its own schedule; exit is the persisted-record
    // boundary, not the arrival of its answer.
    await session.detach();
    const record = await session.recordPath({ refresh: true });
    expect(readFileSync(record as string, "utf8")).toContain("Continue after the stop.");
    // Product-level trace retained in the run log, not just a pass count.
    console.info(
      JSON.stringify({
        actions,
        streaming: session.isStreaming(),
        turnEvents: events.filter((event) => ["turn_closed", "turn_failed"].includes(event.type)),
        nextPromptRecorded: true,
      }),
    );
  } finally {
    session.dispose();
    await session.closed();
    await store.flushed();
    await api.close();
  }
  expect(hasActiveSession(configDir)).toBe(false);
}, 15_000);
