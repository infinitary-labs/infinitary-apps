import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import { questionSessionSpec } from "../decisions/questionSession";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID, type SessionSpec } from "../session/session";
import { resolveClaudeExecutable } from "./claudeCli";
import { MessageQueue, userMessage } from "./claudeQueryCore";
import { claudeSessionOptions } from "./claudeSessionOptions";
import { locateClaudeTranscript } from "./claudeTranscript";

/**
 * INF-1627's accepted workaround for Claude Code issue 97074: identify
 * Infinitary truthfully, even when the host inherited another entrypoint.
 * Real client requests and persisted messages, not just SDK options, own
 * the transport fact. Dummy credentials and a local API keep this check
 * independent of Anthropic's accounting and the person's sign-in.
 */
// Linux integration shard: the resumed two-launch case took 1.984 s.
// Five times that measured work, rounded up to a whole 5 s.
vi.setConfig({ testTimeout: 10_000 });

const MODEL = "claude-haiku-4-5";
let api: StubApi;
beforeAll(async () => {
  api = await startStubApi(() => true);
});
afterAll(async () => {
  await api.close();
});

type Shape = "crewmate" | "seat" | "question";
function boxed(shape: Shape) {
  const home = scratchDir("infinitary-claude-entrypoint-");
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  const client = resolveClaudeExecutable();
  const executable = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, maxRetries: 0, ...(client ? { client } : {}) },
  });
  const binding = { backend: "claude" as const, accountId: "acct_claude_entrypoint" };
  const spec: SessionSpec =
    shape === "crewmate"
      ? crewmateSessionSpec(
          appPathsFor(scratchDir("infinitary-entrypoint-app-")),
          { ...crewmateToolDelegate(), machineId: LOCAL_MACHINE_ID, cwd },
          binding,
        )
      : shape === "seat"
        ? seatSpec({
            cwd,
            sessionsDir: join(home, "sessions"),
            binding,
            model: { provider: "anthropic-claude", id: MODEL },
            tools: [],
          })
        : questionSessionSpec({
            homeDir: cwd,
            binding,
            model: { provider: "anthropic-claude", id: MODEL },
            instruction: "Answer with exactly one of: left, right.",
          });
  const sessionId = randomUUID();
  const options = (resume = false): Options =>
    claudeSessionOptions({
      spec,
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
      executable,
      stderr: () => {},
      ...(spec.shape.turns === "rolling"
        ? { attachment: { model: MODEL, session: resume ? { resume: sessionId } : { sessionId } } }
        : {}),
    });
  const transcript = () => {
    const path = locateClaudeTranscript({ configDir: join(home, ".claude"), cwd, sessionId });
    return path
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  };
  const transcriptFiles = () => {
    const projects = join(home, ".claude", "projects");
    return existsSync(projects)
      ? readdirSync(projects, { recursive: true }).filter((file) => String(file).endsWith(".jsonl"))
      : [];
  };
  return { options, transcript, transcriptFiles };
}

async function turn(options: Options, prompt: string) {
  const from = api.requests.length;
  const input = new MessageQueue();
  const session = query({ prompt: input, options });
  let answered = false;
  try {
    input.push(userMessage(prompt));
    for await (const message of session) {
      if (message.type === "result") {
        expect(message.is_error).toBe(false);
        answered = true;
        input.close();
      }
    }
  } finally {
    input.close();
    session.close();
  }
  expect(answered).toBe(true);
  const requests = api.requests.slice(from).filter((request) => request.raw.includes(prompt));
  expect(requests.length).toBeGreaterThan(0);
  return requests;
}

function expectIdentity(requests: Awaited<ReturnType<typeof turn>>, entrypoint: string) {
  for (const request of requests) {
    const billing = request.body.system?.find((block) =>
      block.text?.startsWith("x-anthropic-billing-header:"),
    )?.text;
    expect(billing).toContain(`cc_entrypoint=${entrypoint};`);
    console.info(JSON.stringify({ billing, model: request.body.model }));
  }
}

function expectTranscript(box: ReturnType<typeof boxed>, entrypoint: string, turns: number) {
  const messages = box
    .transcript()
    .filter((row) => row.type === "user" || row.type === "assistant");
  expect(messages.filter((row) => row.type === "user")).toHaveLength(turns);
  expect(messages.length).toBeGreaterThan(turns);
  for (const row of messages) expect(row.entrypoint).toBe(entrypoint);
  console.info(
    JSON.stringify({ transcriptEntrypoints: messages.map((row) => row.entrypoint), turns }),
  );
}

describe("Infinitary's Claude launch identity on the real client", () => {
  for (const shape of ["crewmate", "seat", "question"] as const) {
    it(`identifies the ${shape}'s requests and persisted messages as infinitary`, async () => {
      const box = boxed(shape);
      expectIdentity(await turn(box.options(), "Say left."), "infinitary");
      if (shape !== "question") expectTranscript(box, "infinitary", 1);
      else expect(box.transcriptFiles()).toEqual([]);
    });
  }
  it("keeps the identity when a rolling conversation resumes with its earlier messages", async () => {
    const box = boxed("seat");
    expectIdentity(await turn(box.options(), "Remember the word lighthouse."), "infinitary");
    const resumed = await turn(box.options(true), "What word did I ask you to remember?");
    expectIdentity(resumed, "infinitary");
    expect(resumed[0]?.raw).toContain("Remember the word lighthouse.");
    expectTranscript(box, "infinitary", 2);
  });
  it("observes the SDK default in a control with the app identity removed", async () => {
    const box = boxed("seat");
    const options = box.options();
    const env = { ...options.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    expectIdentity(await turn({ ...options, env }, "Say right."), "sdk-ts");
    expectTranscript(box, "sdk-ts", 1);
  });
});
