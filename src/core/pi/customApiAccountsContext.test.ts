import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { SessionEvent } from "../session/session";
import { boundTool } from "../session/tools";
import { fixture, input, vault } from "./customApiAccountsFixture";
import { CustomApiError } from "./customApiPolicy";
import { createPiSessionFactory } from "./session";
import { UNANSWERED_CALL_TEXT } from "./unansweredCalls";

/** English prose, repeated to a byte size. INF-202's paste, not a repeated letter. */
function englishPaste(bytes: number): string {
  const prose = readFileSync(join(__dirname, "../../../docs/architecture.md"), "utf8").replace(
    /[^\x20-\x7e\n]/g,
    " ",
  );
  let text = "";
  while (Buffer.byteLength(text) < bytes) text += prose;
  return text.slice(0, bytes);
}

type SessionOpen = Parameters<ReturnType<typeof createPiSessionFactory>["open"]>[0];
type SessionResume = Extract<SessionOpen["shape"], { turns: "rolling" }>["record"]["resume"];
async function smallWindowSession(
  limits: { context: number; output: number },
  tools: SessionOpen["tools"] = [],
) {
  const api = await fixture();
  const world = vault();
  const draft = world.vault.customPrepare({
    ...input(api.baseUrl, "openai-completions"),
    models: [{ id: "operator-model", ...limits }],
  });
  await world.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const runtime = await world.vault.runtimeFor(account.id);
  const factory = createPiSessionFactory({ agentDir: join(world.paths.userData, "agent") });
  const dir = join(world.paths.userData, "sessions");
  const open = (resume?: SessionResume) =>
    factory.open({
      machine: "local",
      owner: "synthetic-session",
      cwd: world.paths.userData,
      binding: { backend: "pi", accountId: account.id, runtime },
      model: { provider: account.providerId, id: "operator-model" },
      thinking: { level: "off" },
      instructions: { base: "Synthetic session instruction" },
      builtins: "none",
      tools,
      shape: { turns: "rolling", record: { dir, ...(resume ? { resume } : {}) } },
    });
  const session = await open();
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { api, session, events, open };
}

it("sends a paste the old context check refused, and answers it", async () => {
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  try {
    const marker = "Paste marker 55000:";
    await session.prompt(`${marker}\n${englishPaste(55_000)}`);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events.filter((event) => event.type === "turn_closed").at(-1)).toEqual({
      type: "turn_closed",
      text: "Synthetic work answer.",
    });
    expect(api.requests.some((request) => JSON.stringify(request.body).includes(marker))).toBe(
      true,
    );
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("shows a server overflow as the context refusal, not a general server error", async () => {
  // INF-447: exhausted recovery also names the overflow for the session's owner.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.enforce(20_000, 300);
  try {
    await session.prompt(`Overflow marker:\n${englishPaste(90_000)}`);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "synthetic-session",
        error: new CustomApiError("context-limit").message,
        contextOverflow: true,
      },
    ]);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(false);
    expect(
      api.requests.some((request) => JSON.stringify(request.body).includes("Overflow marker:")),
    ).toBe(true);
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("shortens the chat and answers when the server counts more tokens than Pi estimates", async () => {
  // INF-202: the server counts more strictly and reports nothing, so Pi sends
  // on its own estimate, the server refuses, and the shortened retry is answered.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.enforce(20_000, 0, 2.5, false);
  try {
    for (let turn = 1; turn <= 6; turn++) {
      await session.prompt(`Turn ${turn}:\n${englishPaste(8_000)}`);
    }
    expect(api.refused.length).toBeGreaterThan(0);
    // The refused turn's own message, not the summary's quotation of it, is sent again and accepted.
    expect(
      api.refusedText.some((text) => !text.includes("[User]:") && api.answered.includes(text)),
    ).toBe(true);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.type === "tool_end" &&
          event.callId === "synthetic-session:compaction" &&
          event.isError === false,
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_closed")).toEqual(
      Array.from({ length: 6 }, () => ({
        type: "turn_closed",
        text: "Synthetic work answer.",
      })),
    );
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("shows a refusal instead of a trimmed reply when the retry cannot recover", async () => {
  // INF-447: the owner may renew only after Pi's own recovery has failed.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.enforce(20_000, 300);
  try {
    await session.prompt(`Trimmed marker:\n${englishPaste(65_000)}`);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "synthetic-session",
        error: new CustomApiError("context-limit").message,
        contextOverflow: true,
      },
    ]);
    expect(
      events.some(
        (event) =>
          (event.type === "turn_closed" && event.text === "Cut") ||
          (event.type === "assistant_delta" && event.text.includes("Cut")),
      ),
    ).toBe(false);
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("compacts a small custom window instead of filling it on the first turns", async () => {
  // INF-202: a small window compacts from the server's count, not on the first turn.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.count();
  try {
    await session.prompt(`Turn 1:\n${englishPaste(6_000)}`);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(
      events.some(
        (event) => event.type === "tool_end" && event.callId === "synthetic-session:compaction",
      ),
    ).toBe(false);
    for (let turn = 2; turn <= 12; turn++) {
      await session.prompt(`Turn ${turn}:\n${englishPaste(6_000)}`);
    }
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        callId: "synthetic-session:compaction",
        isError: false,
      }),
    );
    expect(events.filter((event) => event.type === "turn_closed")).toHaveLength(12);
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("keeps a full-length reply when the server sends no usage", async () => {
  // INF-202: a full-length reply with no usage count is kept, not run again.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.lengthWithoutUsage();
  try {
    await session.prompt("Write the file.");
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events.filter((event) => event.type === "turn_closed")).toEqual([
      { type: "turn_closed", text: "Finished the file." },
    ]);
    expect(
      events.some(
        (event) => event.type === "tool_end" && event.callId === "synthetic-session:compaction",
      ),
    ).toBe(false);
    const closed = events.filter((event) => event.type === "turn_end");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.type === "turn_end" ? closed[0].usage?.output : undefined).toBeUndefined();
    expect(
      api.requests.some(
        (request) =>
          request.body.max_completion_tokens === 4_000 || request.body.max_tokens === 4_000,
      ),
    ).toBe(true);
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("still compacts after a full-length reply when the server sends no usage", async () => {
  // INF-202: that kept reply does not become the size later turns measure from.
  const { api, session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  api.lengthWithoutUsage();
  try {
    await session.prompt("Write the file.");
    expect(events.filter((event) => event.type === "turn_closed")).toEqual([
      { type: "turn_closed", text: "Finished the file." },
    ]);
    for (let turn = 2; turn <= 12; turn++) {
      await session.prompt(`Turn ${turn}:\n${englishPaste(6_000)}`);
    }
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        callId: "synthetic-session:compaction",
        isError: false,
      }),
    );
  } finally {
    session.dispose();
    await session.closed();
  }
});

it("compacts a small window from the character estimate when the server sends no usage", async () => {
  // INF-202: a server that sends no usage still shortens the chat from the character estimate.
  const { session, events } = await smallWindowSession({ context: 20_000, output: 4_000 });
  try {
    for (let turn = 1; turn <= 12; turn++) {
      await session.prompt(`Turn ${turn}:\n${englishPaste(6_000)}`);
    }
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        callId: "synthetic-session:compaction",
        isError: false,
      }),
    );
  } finally {
    session.dispose();
    await session.closed();
  }
});

// INF-3089: a quit while a tool runs saves the call with no result, and a
// custom connection refused every later turn of that record.
it.each([0, 3])(
  "answers a call a quit left unanswered as unknown, and sends the next turn after %i refused",
  async (refusedTurns) => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => {};
    const echo = boundTool({
      name: "session_echo",
      label: "Synthetic echo",
      description: "Echo a synthetic value in memory",
      parameters: Type.Object({ text: Type.String() }),
      run: ({ text }) => {
        started();
        return new Promise<{ text: string }>((resolve) => {
          finish = () => resolve({ text });
        });
      },
    });
    const limits = { context: 65_536, output: 1_024 };
    const { api, session, events, open } = await smallWindowSession(limits, [echo]);
    api.tools();
    void session.prompt("Synthetic tool work");
    await running;
    // The app's quit disposes the session, and the process ends before the tool returns.
    const resume = session.resume();
    session.dispose();
    const file = resume?.backend === "pi" ? resume.sessionFile : "";
    const record = SessionManager.open(file, dirname(file));
    const call = record.getLeafEntry();
    if (call?.type !== "message" || call.message.role !== "assistant") throw new Error("No call");
    // Each turn the old check refused saved its message and a failed reply.
    for (let turn = 0; turn < refusedTurns; turn++) {
      record.appendMessage({ role: "user", content: `Refused ${turn}`, timestamp: turn });
      record.appendMessage({ ...call.message, content: [], stopReason: "error", timestamp: turn });
    }
    const reopened = await open(resume);
    reopened.subscribe((event) => events.push(event));
    try {
      const before = api.requests.length;
      await reopened.prompt("Synthetic continuation after the quit");
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(api.requests).toHaveLength(before + 1);
      const sent = (api.requests.at(-1)?.body.messages ?? []) as Record<string, unknown>[];
      expect(sent.filter((message) => message.role === "tool")).toEqual([
        { role: "tool", tool_call_id: "work_call", content: UNANSWERED_CALL_TEXT },
      ]);
      const answer = sent.findIndex((message) => message.role === "tool");
      // The refused messages stay after the answer; their failed replies never reach the model.
      expect(JSON.stringify(sent.slice(answer + 1).map((message) => message.content))).toBe(
        JSON.stringify([
          ...Array.from({ length: refusedTurns }, (_, turn) => `Refused ${turn}`),
          [{ type: "text", text: "Synthetic continuation after the quit" }],
        ]),
      );
      expect(readFileSync(reopened.recordPath() ?? "", "utf8")).toContain(UNANSWERED_CALL_TEXT);
    } finally {
      reopened.dispose();
      finish();
      await Promise.all([reopened.closed(), session.closed()]);
    }
  },
);
