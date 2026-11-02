import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { StubApi } from "../../../tests/helpers/anthropicDialect";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { piContractModels, piContractWorld } from "../../../tests/helpers/piContractWorld";
import {
  CONTRACT_TOOL,
  CONTRACT_TOOL_RESULT,
  describeSessionContract,
  startContractApi,
} from "../../../tests/helpers/sessionContract";
import { boundTool } from "../session/tools";
import { readSession } from "../storage/sessionReader";

/**
 * Pi's harness for the session contract (`tests/helpers/sessionContract.ts`):
 * real Pi, in process, with its own runtime on its own store, served by a
 * local stub API in the Anthropic dialect (`piContractWorld`). Nothing is
 * mocked inside Pi, and nothing reaches the network.
 */

let api: StubApi;

beforeAll(async () => {
  api = await startContractApi();
});

afterAll(async () => {
  await api.close();
});

async function world() {
  const modelsPath = piContractModels(api);
  const runtime = await ModelRuntime.create({
    authPath: join(modelsPath, "..", "auth.json"),
    modelsPath,
    allowModelNetwork: false,
  });
  return piContractWorld(api, runtime);
}

describeSessionContract({
  name: "Pi, real, against a stub API",
  backend: "pi",
  world,
});

// INF-2223's approved lifecycle: retain actual late outcomes before releasing
// the session, so a reopen reads the result instead of repeating the callback.
it("keeps a callback's late result in the saved conversation after close", async () => {
  const fixture = await world();
  fixture.answer({ tool: CONTRACT_TOOL, answer: "left" });
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const tool = boundTool({
    name: CONTRACT_TOOL,
    label: "Look up",
    description: "Look the contract answer up.",
    parameters: Type.Object({}),
    run: async () => {
      calls += 1;
      entered();
      await gate;
      return { text: CONTRACT_TOOL_RESULT };
    },
  });
  const input = {
    binding: fixture.binding,
    cwd: fixture.homeDir,
    owner: "late-result",
    instructions: "Look up the record, then answer the question.",
    recordDir: fixture.paths.firstmateSessionsDir,
    model: fixture.model,
    tools: [tool],
  };
  const session = await fixture.factory.open(codingSpec(input));
  const turn = session.prompt("Which way?");
  await ready;
  let closed = false;
  session.dispose();
  const closure = session.closed().then(() => {
    closed = true;
  });
  try {
    // Flush continuations, not a wall-clock grace period: Pi must not have
    // reported closure while the callback is still held at the gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
  } finally {
    finish();
  }
  await turn;
  await closure;
  expect(closed).toBe(true);
  const saved = readSession(session.recordPath() ?? "");
  const results = saved.entries.flatMap((entry) => {
    const message = entry.message as { role?: string } | undefined;
    return message?.role === "toolResult" ? [message] : [];
  });
  expect(results).toMatchObject([
    { isError: false, content: [{ type: "text", text: CONTRACT_TOOL_RESULT }] },
  ]);
  await expect(session.prompt("Do not admit this after close.")).rejects.toThrow();
  await expect(session.steer("Do not queue this after close.")).rejects.toThrow();
  fixture.answer({ text: "right" });
  const reopened = await fixture.factory.open(codingSpec({ ...input, resume: session.resume() }));
  try {
    await reopened.prompt("Continue from the lookup result.");
    expect(fixture.served().at(-1)?.said).toContain(CONTRACT_TOOL_RESULT);
    expect(calls).toBe(1);
  } finally {
    reopened.dispose();
    await reopened.closed();
  }
});
