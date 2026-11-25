import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  startStubApi,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { fakeBinding } from "../../../tests/helpers/fakeSession";
import {
  catalogLimits,
  piStubRuntime,
  type StubLimits,
} from "../../../tests/helpers/piStubRuntime";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  appPathsFor,
  crewmateCardBodiesDir,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateTempDir,
} from "../paths";
import { CODEX_INSTRUCTIONS } from "../pi/codexInstructions";
import { catalogRefreshesSettled, createModelRuntime } from "../pi/modelRuntime";
import { createPiSessionFactory } from "../pi/sessionFactory";
import { languageCompletionHeadings } from "../prompts/captainLanguage";
import { localTimeZoneName, timeZoneFact } from "../prompts/timeZone";
import {
  CREWMATE_SECRETS_CATALOG_LINE,
  CREWMATE_SECRETS_LINE,
  CREWMATE_SECRETS_THERE_LINE,
} from "../secrets/commandWords";
import { answersDir, savedAnswerText } from "../session/answerFiles";
import { LOCAL_MACHINE_ID, type SessionEvent } from "../session/session";
import { crewmateContractStamp, crewmateRestartText, crewmateSessionSpec } from "./crewSession";

it.each(["pi", "claude"] as const)(
  "a %s session carries the editable body folder to its instructions and tools",
  async (backend) => {
    const root = scratchDir("crew-card-file-");
    const paths = appPathsFor(root);
    const dir = scratchDir("crew-card-bodies-");
    const body = "<p>A file snapshot from this session.</p>";
    await writeFile(join(dir, "answer.html"), body);
    const shown: string[] = [];
    const session = crewmateSessionSpec(
      paths,
      {
        machineId: LOCAL_MACHINE_ID,
        taskId: "task-1",
        cwd: root,
        evidenceDir: crewmateEvidenceDir(paths, "task-1"),
        cardBodiesDir: dir,
        onCard: (card) => {
          shown.push(card.body);
          return "card-task-1-answer";
        },
      },
      backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
    );
    expect(session.instructions.base).toContain(`Your card body folder is ${dir}`);
    const emit = session.tools.find((t) => t.name === "emit_card");
    expect(emit).toBeDefined();
    await emit?.run({ title: "Answer", body_file: "answer.html" });
    expect(shown).toEqual([body]);
    expect(crewmateCardBodiesDir(paths, "task-1")).toBe(
      join(paths.crewmatesDir, "task-1", "card-bodies"),
    );
    expect(crewmateCardBodiesDir(paths, "task-1")).not.toBe(
      crewmateCardPicturesDir(paths, "task-1"),
    );
  },
);

it.each(["pi", "claude"] as const)(
  "a %s session advertises Secrets requests only with the local command grant, and the catalog alone on another computer",
  (backend) => {
    // INF-1109: expose references and requests, never claim an unmigrated or remote owner is protected.
    // Its revision spec: "Treat all crewmates consistently" - a placed task lists the catalog, with no use.
    const root = scratchDir("crew-secrets-command-");
    const catalog = { list: async () => [] };
    const open = (
      secrets?: true,
      shell?: { path: string[]; env: Record<string, string> },
      machineId = LOCAL_MACHINE_ID,
      secretsCatalog?: typeof catalog,
    ) =>
      crewmateSessionSpec(
        appPathsFor(root),
        { machineId, taskId: "secrets-task", cwd: root, secrets, shell, secretsCatalog },
        backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
      ).instructions.base;
    const shell = { path: [root], env: {} };
    expect(open(true, shell)).toContain(CREWMATE_SECRETS_LINE);
    expect(open(true, shell)).not.toContain(CREWMATE_SECRETS_CATALOG_LINE);
    expect(open(undefined, shell)).not.toContain(CREWMATE_SECRETS_LINE);
    expect(open(true)).not.toContain(CREWMATE_SECRETS_LINE);
    expect(open(true, shell, "another-computer")).not.toContain(CREWMATE_SECRETS_LINE);
    // On another computer the command lists the home's catalog and says a use is not reachable.
    const placed = open(undefined, undefined, "another-computer", catalog);
    expect(placed).toContain(CREWMATE_SECRETS_CATALOG_LINE);
    expect(placed).not.toContain(CREWMATE_SECRETS_LINE);
    expect(open(undefined, undefined, "another-computer")).not.toContain(
      CREWMATE_SECRETS_CATALOG_LINE,
    );
    // A local task never reads the catalog line: its shell carries the whole command.
    expect(open(true, shell, LOCAL_MACHINE_ID, catalog)).not.toContain(
      CREWMATE_SECRETS_CATALOG_LINE,
    );
  },
);

it.each(["pi", "claude"] as const)(
  "a %s session on a computer that runs work is never told to ask for a secret its command cannot ask",
  (backend) => {
    // INF-4248's review: that computer's command takes uses but offers no ask, so its crewmate names
    // the secret in its report instead of hearing a false "Secrets is not offered".
    const root = scratchDir("crew-secrets-there-");
    const unused = async () => {
      throw new Error("No use is asked while the prompt is built.");
    };
    const base = crewmateSessionSpec(
      appPathsFor(root),
      {
        machineId: "work-computer",
        taskId: "secrets-there",
        cwd: root,
        secretUses: { use: unused, take: unused, gone: () => undefined },
      },
      backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
    ).instructions.base;
    expect(base).toContain(CREWMATE_SECRETS_THERE_LINE);
    expect(base).not.toContain(CREWMATE_SECRETS_LINE);
    expect(base).not.toContain("run `ask`");
  },
);

it.each(["pi", "claude"] as const)(
  "a %s session names the captain's local time zone for its time rule (FI3-1006)",
  (backend) => {
    const root = scratchDir("crew-time-zone-");
    const session = crewmateSessionSpec(
      appPathsFor(root),
      { machineId: LOCAL_MACHINE_ID, taskId: "task-1", cwd: root },
      backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
    );
    const named = /The captain's local time zone is (\S+) \((UTC[+-]\d{2}:\d{2})\)\./.exec(
      session.instructions.base,
    );
    expect(named?.[1]).toBe(localTimeZoneName());
    expect(`${named?.[1]} (${named?.[2]})`).toBe(timeZoneFact(Date.now()));
  },
);

// INF-3674's approved plan: anything written to the captain is in the
// captain's language, the language the app speaks on this Mac.
it.each(["pi", "claude"] as const)(
  "a %s session names the captain's language for its language rule",
  (backend) => {
    const root = scratchDir("crew-language-");
    const open = () =>
      crewmateSessionSpec(
        appPathsFor(root),
        { machineId: LOCAL_MACHINE_ID, taskId: "task-1", cwd: root },
        backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
      ).instructions.base;
    expect(open()).toContain("The captain's language is English (en).");
    setCurrentLanguage("ja");
    try {
      // The catalog has Japanese, so the merge card's headings are offered in it, in order.
      const prompt = open();
      expect(prompt).toContain("The captain's language is Japanese (ja).");
      expect(languageCompletionHeadings()).not.toContain("Why");
      expect(prompt).toContain(languageCompletionHeadings().join(", "));
      // A pseudo-language is a test's window, so the crew still writes English.
      setCurrentLanguage("en-XA");
      expect(open()).toContain("The captain's language is English (en).");
    } finally {
      setCurrentLanguage(SOURCE_LANGUAGE);
    }
  },
);

// INF-2589, the captain: "any too big answer gets stored in a file and we
// return the path to the file instead of the full answer".
it("serves a crewmate on this Mac an answer too long to read whole as a file in its task's temporary folder", async () => {
  const root = scratchDir("crew-answer-files-");
  const paths = appPathsFor(root);
  const tempDir = crewmateTempDir(paths, "task-1");
  // A real answer past the band: the captured INF-91 record as one read serves it whole.
  const answer = JSON.stringify(
    JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8")),
    null,
    2,
  );
  const session = crewmateSessionSpec(
    paths,
    {
      ...crewmateToolDelegate(),
      onGithubRead: async () => answer,
      machineId: LOCAL_MACHINE_ID,
      taskId: "task-1",
      cwd: root,
      tempDir,
    },
    { backend: "claude", accountId: "acct_claude" },
  );
  const read = session.tools.find((tool) => tool.name === "github_read");
  const output = await read?.run({ path: "/repos/acme/shop/actions/runs?per_page=100" });
  const [saved] = readdirSync(answersDir(tempDir));
  const path = join(answersDir(tempDir), saved ?? "");
  expect(output?.text).toBe(savedAnswerText(path, answer));
  expect(readFileSync(path, "utf8")).toBe(answer);
});

it("stamps a crewmate's conversation with the prompt and tools it serves, the same at every open of the same build", () => {
  const root = scratchDir("crew-contract-");
  const paths = appPathsFor(root);
  const { calls: _calls, ...every } = crewmateToolDelegate();
  const open = (delegate: Partial<typeof every> = every) =>
    crewmateSessionSpec(
      paths,
      {
        ...delegate,
        machineId: LOCAL_MACHINE_ID,
        taskId: "task-1",
        cwd: root,
        evidenceDir: crewmateEvidenceDir(paths, "task-1"),
      },
      { backend: "claude", accountId: "acct_claude" },
    );
  const stampOf = (spec: ReturnType<typeof open>) =>
    spec.shape.turns === "rolling" ? spec.shape.record.stamp : undefined;
  const first = open();
  const stamp = stampOf(first);
  expect(stamp).toEqual(crewmateContractStamp(first.instructions.base, first.tools));
  expect(Object.keys(stamp?.tools ?? {})).toEqual(first.tools.map((tool) => tool.name));
  expect(stampOf(open())).toEqual(stamp);
  const { onOpenChange: _openChange, ...fewer } = every;
  const shrunk = stampOf(open(fewer));
  expect(shrunk?.tools?.open_change).toBeUndefined();
  expect(stamp?.tools?.open_change).toBeDefined();
  for (const [name, sha] of Object.entries(shrunk?.tools ?? {})) {
    expect(stamp?.tools?.[name]).toBe(sha);
  }
  const reworded = first.tools.map((tool) =>
    tool.name === "emit_card" ? { ...tool, description: `${tool.description} Reworded.` } : tool,
  );
  const changed = crewmateContractStamp(`${first.instructions.base} Reworded.`, reworded);
  expect(changed.promptSha).not.toBe(stamp?.promptSha);
  expect(changed.tools?.emit_card).not.toBe(stamp?.tools?.emit_card);
  expect(changed.tools?.report).toBe(stamp?.tools?.report);
});

it("tells a crewmate in a new conversation why, where its record is, and its brief", () => {
  const renewed = crewmateRestartText({
    restart: { from: "old-conversation", changed: ["prompt"] },
    taskKey: "FI3-7",
    brief: "Goal: count the rivets.",
    earlier: "/records/old-conversation.jsonl",
  });
  const [why, record, brief, next] = renewed.split("\n\n");
  expect(why).toContain("the app was updated");
  expect(record).toContain("tasks (key FI3-7)");
  expect(record).toContain("/records/old-conversation.jsonl");
  expect(brief).toBe("Your task's brief, as you first received it:");
  expect(renewed).toContain("Goal: count the rivets.");
  expect(next).toBe("Goal: count the rivets.");
  expect(renewed.endsWith("The message that brought you back follows.")).toBe(true);
  const personal = crewmateRestartText({
    restart: { from: "old", changed: ["instructions"] },
    taskKey: "FI3-7",
  });
  expect(personal).toContain("this computer's own instructions and skills changed");
  expect(personal).not.toContain("brief, as you first received it");
  expect(personal).not.toContain("transcript of your earlier conversation");
  const unopenable = crewmateRestartText({
    restart: { from: "old", changed: "unopenable" },
    taskKey: "FI3-7",
  });
  expect(unopenable).toContain("could not be reopened");
});

// A user's report: GPT-6.x Sol crew sessions summarized near 483,600 tokens,
// so a long build sent requests past the 272,000-token price step, where every
// input token costs twice as much. INF-6693: every crewmate summarizes at
// 300,000 tokens too, or below its step when that comes sooner. Here a
// crewmate reads a long build log in one turn, about 345,700 tokens in all,
// and the service reads each request's real size. The step rule leaves alone
// a first step below what a summary keeps (Qwen3.7 Flash's 32,000), where Pi
// would summarize before every request, and Copilot, whose plan counts
// requests rather than tokens, so Copilot stops at 300,000.
const sol = catalogLimits("openai-codex", "gpt-6.1-sol");
const qwen = catalogLimits("openrouter", "qwen/qwen3.7-flash");
const copilotSol = catalogLimits("github-copilot", "gpt-6.1-sol");
const kimi = catalogLimits("amazon-bedrock", "global.moonshotai.kimi-k3");
const step = (limits: StubLimits, index: number) =>
  limits.cost.tiers?.[index]?.inputTokensAbove ?? 0;
const priceSteps: [
  string,
  { provider: string; limits: StubLimits; below: number; past?: number },
][] = [
  [
    "keeps every request below its model's price step",
    {
      provider: "fm-crew",
      limits: sol,
      below: step(sol, 0),
    },
  ],
  [
    "summarizes at 300,000 on a flat-priced 1M-token model",
    {
      provider: "fm-crew",
      limits: kimi,
      below: 300_000,
    },
  ],
  [
    "keeps below the next step when the first sits under what a summary keeps",
    {
      provider: "fm-crew",
      limits: qwen,
      below: Math.min(step(qwen, 1), 300_000),
      past: step(qwen, 0),
    },
  ],
  [
    "runs past the step on Copilot, whose plan counts requests, and summarizes at 300,000",
    {
      provider: "github-copilot",
      limits: copilotSol,
      below: 300_000,
      past: step(copilotSol, 0),
    },
  ],
];
it.each(priceSteps)(
  "a crewmate's real Pi session %s",
  async (_name, { provider, limits, below, past }) => {
    const root = scratchDir("crew-price-step-");
    const reads = 30;
    const linesPerRead = 600;
    const line = "vitest ran src/core/pi/session.test.ts: 41 passed, 0 failed, in 2.3s\n";
    writeFileSync(join(root, "build.log"), line.repeat(reads * linesPerRead));
    const api = await startStubApi(() => true);
    const readings: { tokens: number; summary: boolean }[] = [];
    api.answer((request, res) => {
      const tokens = Math.ceil(JSON.stringify(request.body).length / 4);
      const summary = !request.body.tools?.length;
      const read = readings.filter((reading) => !reading.summary).length;
      readings.push({ tokens, summary });
      beginAnthropicStream(res, tokens, request.n);
      if (summary)
        writeAnthropicText(res, 0, "The crewmate is reading build.log for the failing test.");
      else if (read < reads)
        writeAnthropicToolUse(res, 0, {
          id: `read-${read}`,
          name: "read",
          args: { path: "build.log", offset: read * linesPerRead + 1, limit: linesPerRead },
        });
      else writeAnthropicText(res, 0, "No test failed.");
      finishAnthropicStream(res, !summary && read < reads ? "tool_use" : "end_turn", 16);
    });
    const runtime = await piStubRuntime(api.url, { provider, id: "sol", limits });
    const paths = appPathsFor(root);
    const session = await createPiSessionFactory({ agentDir: join(root, "pi") }).open(
      crewmateSessionSpec(
        paths,
        {
          ...crewmateToolDelegate(),
          machineId: LOCAL_MACHINE_ID,
          taskId: "task-1",
          cwd: root,
          evidenceDir: crewmateEvidenceDir(paths, "task-1"),
          model: { provider, id: "sol" },
        },
        { backend: "pi", runtime },
      ),
    );
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.prompt("Find the failing test in build.log.");
      const largest = Math.max(...readings.map((reading) => reading.tokens));
      expect(largest).toBeLessThan(below);
      if (past !== undefined) expect(largest).toBeGreaterThan(past);
      // The whole build reaches about 345,700 tokens, so one summary brings it
      // under the limit for good.
      expect(readings.filter((reading) => reading.summary)).toHaveLength(1);
      expect(readings.filter((reading) => !reading.summary)).toHaveLength(reads + 1);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    } finally {
      session.dispose();
      await session.closed();
      await catalogRefreshesSettled();
      await api.close();
    }
  },
);

// A user's report: GPT-6.2 never reuses a request's `instructions` from its
// prompt cache, so every request of a crewmate's conversation paid for its
// whole instructions again, while the input's leading items are reused.
it("a crewmate's real Pi session on Codex sends its instructions first in the conversation", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      requests.push(JSON.parse(String(data)));
      const id = `resp_${requests.length}`;
      const item = {
        type: "message",
        id: `msg_${requests.length}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done." }],
      };
      for (const event of [
        { type: "response.created", response: { id, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          delta: "Done.",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 30_000, output_tokens: 3 },
          },
        },
      ])
        socket.send(JSON.stringify(event));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = scratchDir("crew-codex-instructions-");
  const store = join(root, "store");
  mkdirSync(store);
  // The service reads the account from the sign-in's claims; this one is made up.
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } };
  const signIn = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmVk`;
  writeFileSync(
    join(store, "models.json"),
    JSON.stringify({ providers: { "openai-codex": { baseUrl: url, apiKey: signIn } } }),
  );
  const runtime = await createModelRuntime({
    authPath: join(store, "auth.json"),
    modelsPath: join(store, "models.json"),
    catalogBaseUrl: url,
  });
  const paths = appPathsFor(root);
  const spec = crewmateSessionSpec(
    paths,
    {
      ...crewmateToolDelegate(),
      machineId: LOCAL_MACHINE_ID,
      taskId: "task-1",
      cwd: root,
      evidenceDir: crewmateEvidenceDir(paths, "task-1"),
      model: { provider: "openai-codex", id: "gpt-6.1-sol" },
    },
    { backend: "pi", runtime },
  );
  const session = await createPiSessionFactory({ agentDir: join(root, "pi") }).open(spec);
  try {
    await session.prompt("Build the parser.");
    await session.prompt("Now the tests.");
    const [first, second] = requests;
    expect(requests.map((request) => request.instructions)).toEqual([
      CODEX_INSTRUCTIONS,
      CODEX_INSTRUCTIONS,
    ]);
    const opening = (first?.input as { role: string; content: string }[] | undefined)?.[0];
    expect(opening?.role).toBe("developer");
    expect(opening?.content).toContain(spec.instructions.base);
    // The second request continues the first on the same socket: it sends
    // only the new message, so the instructions stay in the reused prefix.
    expect(second?.previous_response_id).toBe("resp_1");
    expect(second?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Now the tests." }] },
    ]);
  } finally {
    session.dispose();
    await session.closed();
    await catalogRefreshesSettled();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
