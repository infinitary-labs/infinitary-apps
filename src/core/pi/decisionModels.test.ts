import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DEFAULT_DECISIONS, type DecisionsSettings } from "@shared/decisions";
import { DECISION_APPROVAL_VERSION } from "@shared/decisionUses";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type DecisionModel, DecisionModels, type DecisionUsage } from "../decisions/decisionModel";
import { OpenRouterDecisionModel } from "../decisions/openRouterDecisionModel";
import { BODY_LIMIT_BYTES } from "../quota/http";
import { openRouterDecisionModels } from "./decisionModels";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";

it("uses the selected account's Pi sign-in, bounds choices, records the served model and reported cost, and falls back without new egress", async () => {
  const dir = scratchDir("infinitary-openrouter-decisions-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ openrouter: { type: "api_key", key: "fake-openrouter-test" } }),
  );
  const seen: {
    bearer?: string;
    body: { state: unknown; questions: Record<string, { criteria: Record<string, string> }> };
  }[] = [];
  let status = 200;
  let confidence = 0.9;
  let choice = "fix";
  let missingConfidence = false;
  // What the reply says about itself; the live service names a dated model
  // and states a cost that is not Pi's catalog price for the same tokens.
  let reply: { model?: string; cost?: number } = {
    model: "typesafe/jev-1.13-20260917",
    cost: 0.0000317,
  };
  const server = createServer((request, response) => {
    // The runtime's background catalog refresh also stays on this disposable
    // server, so this test is hermetic without a caller setting PI_OFFLINE.
    if (request.method === "GET") {
      response.writeHead(503);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      expect(request.url).toBe("/api/v1/systemone");
      seen.push({ bearer: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          status === 200
            ? {
                ...(reply.model ? { model: reply.model } : {}),
                answers: {
                  kind: {
                    type: "choice",
                    choice,
                    probabilities: { fix: confidence },
                    ...(missingConfidence ? {} : { confidence }),
                  },
                },
                usage: {
                  input_tokens: 100,
                  output_tokens: 0,
                  ...(reply.cost === undefined ? {} : { cost: reply.cost }),
                },
              }
            : { error: "test refusal" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = await createModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    catalogBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const models = openRouterDecisionModels(runtime);
  expect(models.map((model) => model.id)).toEqual(
    expect.arrayContaining([
      "typesafe/jev-1.13",
      "~typesafe/jev-latest",
      "jaredpalmer/kev-4b",
      "upstage/solar-decide",
    ]),
  );
  expect(models.some((model) => model.id.startsWith("respan/"))).toBe(false);
  expect(
    runtime.getAvailableSnapshot().some((model) => models.some((entry) => entry.id === model.id)),
  ).toBe(false);
  let settings: DecisionsSettings = DEFAULT_DECISIONS;
  let signedIn = true;
  const picks: string[] = [];
  const renewals: string[] = [];
  const usage: DecisionUsage[] = [];
  const adapter: DecisionModel = {
    id: "adapted",
    native: false,
    decide: async () => ({
      answers: {
        kind: { value: "chore", outcome: "answered", version: "test", source: "mock/chat" },
      },
      usage: [],
    }),
  };
  const service = new DecisionModels({
    settings: {
      getDecisions: () => settings,
      setDecisions: (next) => {
        settings = next;
      },
      getDecisionUses: () => ({}),
      setDecisionUses: () => {},
    },
    adapted: adapter,
    openrouter: {
      signedIn: () => signedIn,
      models: () => models,
      create: (model) =>
        new OpenRouterDecisionModel({
          model,
          selectAccount: (task) => {
            picks.push(task);
            return "acct-selected";
          },
          runtimeFor: async (account) => {
            expect(account).toBe("acct-selected");
            return runtime;
          },
          onUnauthorized: async (account) => {
            renewals.push(account);
          },
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
        }),
    },
    recordUsage: (burn) => usage.push(burn),
  });
  const questions = {
    kind: {
      type: "choice" as const,
      instructions: "What kind?",
      criteria: {
        plan: "plan",
        research: "research",
        reproduce: "reproduce",
        implement: "implement",
        fix: "fix",
        chore: "chore",
        unclear: "unclear",
      },
      abstain: "unclear",
      version: "test1",
    },
  };
  const ask = () =>
    service.decide(
      { purpose: "kind", use: "kind", taskId: "task-test" },
      { facts: { title: "Fix the clock", empty: "" }, adapterText: "must not be sent" },
      questions,
      new AbortController().signal,
    );
  try {
    expect((await ask()).kind?.source).toBe("mock/chat");
    expect(seen).toHaveLength(0);
    service.setSettings({
      version: 1,
      answerer: { kind: "openrouter", model: "typesafe/jev-1.13" },
      egress: {},
    });
    await ask();
    expect(seen).toHaveLength(0);
    service.setSettings({
      ...settings,
      egress: { openrouter: { enabled: true, consentedVersion: DECISION_APPROVAL_VERSION } },
    });
    expect((await ask()).kind).toMatchObject({
      value: "fix",
      outcome: "answered",
      source: "openrouter/typesafe/jev-1.13-20260917",
    });
    expect(seen[0]?.bearer).toBe("Bearer fake-openrouter-test");
    expect(seen[0]?.body.state).toEqual({ title: "Fix the clock" });
    expect(Object.keys(seen[0]?.body.questions.kind?.criteria ?? {})).toHaveLength(6);
    expect(picks).toEqual(["task-test"]);
    // Asked for the pick, served by the model the reply named, at the cost it stated.
    const reported = { input: 100, output: 0, cost: 0.0000317, costSource: "reported" };
    expect(usage[0]).toEqual({
      taskId: "task-test",
      accountId: "acct-selected",
      model: { provider: "openrouter", id: "typesafe/jev-1.13" },
      usage: { ...reported, models: [{ ...reported, model: "typesafe/jev-1.13-20260917" }] },
    });
    // The row's last answer stays with the pick, whichever model served it.
    expect(service.view().openrouter?.last).toMatchObject({ value: "fix", tokens: 100 });
    // A reply that names no model and states no cost: the pick, at Pi's catalog price.
    reply = {};
    expect((await ask()).kind?.source).toBe("openrouter/typesafe/jev-1.13");
    expect(usage.at(-1)).toMatchObject({
      model: { provider: "openrouter", id: "typesafe/jev-1.13" },
      usage: { input: 100, output: 0, costSource: "listed-prices" },
    });
    expect(usage.at(-1)?.usage.models).toBeUndefined();
    expect(usage.at(-1)?.usage.cost).toBeCloseTo(0.0000042);
    reply = { model: "typesafe/jev-1.13-20260917", cost: 0.0000317 };
    confidence = 0.59;
    expect((await ask()).kind).toMatchObject({ value: "unclear", outcome: "abstained" });
    confidence = 0.6;
    expect((await ask()).kind?.outcome).toBe("answered");
    choice = "unknown";
    expect((await ask()).kind?.detail).toContain("schema");
    choice = "fix";
    missingConfidence = true;
    expect((await ask()).kind?.detail).toContain("schema");
    missingConfidence = false;
    for (const [code, reason] of [
      [401, "unauthorized"],
      [402, "no-credit"],
      [429, "rate-limited"],
      [529, "overloaded"],
    ] as const) {
      status = code;
      expect((await ask()).kind).toMatchObject({ value: "chore", outcome: "answered" });
      expect((await ask()).kind?.detail).toContain(reason);
    }
    expect(renewals).toEqual(["acct-selected", "acct-selected"]);
    const count = seen.length;
    signedIn = false;
    expect(service.view().openrouter?.models).toEqual([]);
    await ask();
    expect(seen).toHaveLength(count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await catalogRefreshesSettled();
  }
});

it("refuses a reply past 64 KB before Pi parses it, and the person's own model answers", async () => {
  const dir = scratchDir("infinitary-openrouter-decisions-oversized-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ openrouter: { type: "api_key", key: "fake-openrouter-test" } }),
  );
  // A well-formed answer Pi would take as "fix", padded to `size` bytes.
  const answer = (size: number) => {
    const head = JSON.stringify({
      model: "typesafe/jev-1.13",
      answers: {
        kind: { type: "choice", choice: "fix", probabilities: { fix: 0.9 }, confidence: 0.9 },
      },
      padding: "",
    });
    return `${head.slice(0, -2)}${"x".repeat(size - head.length)}"}`;
  };
  let reply: "padded" | "streamed" | "refused" = "padded";
  let size = 0;
  const streamed = { sent: 0, finished: false, closed: false };
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(503);
      response.end();
      return;
    }
    response.on("error", () => {});
    request.resume();
    request.on("end", () => {
      if (reply === "padded") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(answer(size));
      } else if (reply === "refused") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "x".repeat(size) }));
      } else {
        // No declared length: the answer arrives in chunks until the app
        // hangs up. The cap only stops a runaway, and sits well past what
        // a loopback socket's buffers can hold on any of our machines.
        response.writeHead(200, { "content-type": "application/json" });
        response.on("close", () => {
          streamed.closed = true;
        });
        const chunk = "x".repeat(16 * 1024);
        response.write(answer(1024).slice(0, -2));
        const pump = () => {
          while (!response.destroyed && streamed.sent < 64 * 1024 * 1024) {
            streamed.sent += chunk.length;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          if (!response.destroyed) {
            streamed.finished = true;
            response.end('"}');
          }
        };
        pump();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = await createModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    catalogBaseUrl: base,
  });
  const renewals: string[] = [];
  const service = new DecisionModels({
    settings: {
      getDecisions: () => ({
        version: 1,
        answerer: { kind: "openrouter", model: "typesafe/jev-1.13" },
        egress: { openrouter: { enabled: true, consentedVersion: DECISION_APPROVAL_VERSION } },
      }),
      setDecisions: () => {},
      getDecisionUses: () => ({}),
      setDecisionUses: () => {},
    },
    adapted: {
      id: "adapted",
      native: false,
      decide: async () => ({
        answers: {
          kind: { value: "chore", outcome: "answered", version: "test", source: "mock/chat" },
        },
        usage: [],
      }),
    },
    openrouter: {
      signedIn: () => true,
      models: () => openRouterDecisionModels(runtime),
      create: (model) =>
        new OpenRouterDecisionModel({
          model,
          selectAccount: () => "acct-selected",
          runtimeFor: async () => runtime,
          onUnauthorized: async (account) => {
            renewals.push(account);
          },
          baseUrl: `${base}/api/v1`,
        }),
    },
  });
  const ask = async () =>
    (
      await service.decide(
        { purpose: "kind", use: "kind", taskId: "task-test" },
        { facts: { title: "Fix the clock" } },
        {
          kind: {
            type: "choice",
            instructions: "What kind?",
            criteria: { fix: "fix", chore: "chore", unclear: "unclear" },
            abstain: "unclear",
            version: "test1",
          },
        },
        new AbortController().signal,
      )
    ).kind;
  const fellBack = {
    value: "chore",
    outcome: "answered",
    detail: "decision model openrouter failed: oversized; answered by adapted:mock/chat",
  };
  try {
    size = BODY_LIMIT_BYTES - 1024;
    expect(await ask()).toMatchObject({ value: "fix", source: "openrouter/typesafe/jev-1.13" });
    size = BODY_LIMIT_BYTES + 1;
    expect(await ask()).toMatchObject(fellBack);
    reply = "streamed";
    expect(await ask()).toMatchObject(fellBack);
    await expect.poll(() => streamed.closed).toBe(true);
    expect(streamed.finished).toBe(false);
    reply = "refused";
    size = 70 * 1024;
    expect(await ask()).toMatchObject(fellBack);
    expect(renewals).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await catalogRefreshesSettled();
  }
});
