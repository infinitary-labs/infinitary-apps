import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DECISION_MODEL_CATALOG, type DecisionQuestion } from "@shared/decisions";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT_BYTES, type QuotaHttp, QuotaTransportError } from "../../quota/http";
import { JevDecisionModel } from "./jevClient";

/**
 * The native path against a local stub of the vendor endpoint (S7b gate):
 * every way the call can go wrong - 401, 422, 429, 529, a timeout, a body
 * we do not recognise - and the two rules that make it safe to turn on at
 * all: no key means no request, and certainty never crosses the interface.
 *
 * No real key is ever used here, and nothing reaches the network: the
 * transport is the one seam this class takes.
 */

const ROW = DECISION_MODEL_CATALOG[0];

const QUESTION: DecisionQuestion = {
  type: "choice",
  instructions: "Which kind of work is this?",
  criteria: { fix: "correcting something wrong", chore: "small mechanical work" },
  abstain: "unclear",
  version: "kc1",
};

type Call = { url: string; init: Parameters<QuotaHttp>[1] };

function modelWith(
  answer: { status: number; json?: unknown } | (() => never),
  options: { key?: string | undefined; endpoint?: string } = {},
): { model: JevDecisionModel; calls: Call[] } {
  const calls: Call[] = [];
  const http: QuotaHttp = async (url, init) => {
    calls.push({ url, init });
    if (typeof answer === "function") return answer();
    return { status: answer.status, json: answer.json };
  };
  return {
    model: new JevDecisionModel({
      row: ROW,
      key: () => ("key" in options ? options.key : "ts-live-1234567890"),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      http,
    }),
    calls,
  };
}

const STATE = { facts: { title: "Fix the flaky auth test", basis: null }, adapterText: "[work]" };

function ask(model: JevDecisionModel) {
  return model.decide(
    { purpose: "kind", taskId: "task-1" },
    STATE,
    { kind: QUESTION },
    new AbortController().signal,
  );
}

describe("JevDecisionModel: what it sends", () => {
  it("posts the named facts and the options, withholding the abstention", async () => {
    const { model, calls } = modelWith({
      status: 200,
      json: {
        model: "jev-1.13.0",
        answers: {
          kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
        },
      },
    });
    await ask(model);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ROW.endpoint);
    const body = JSON.parse(new TextDecoder().decode(calls[0]?.init.body)) as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    expect(body.model).toBe("jev-latest");
    // A fact with nothing to say is not sent; the adapter's rendering of
    // the same facts is not sent either.
    expect(body.state).toEqual({ title: "Fix the flaky auth test" });
    expect(Object.keys(body.questions.kind?.criteria ?? {})).toEqual(["fix", "chore"]);
    expect(JSON.stringify(body)).not.toContain("unclear");
  });

  it("sends the user's key as a bearer and nothing that claims to be a browser", async () => {
    const { model, calls } = modelWith({
      status: 200,
      json: {
        answers: {
          kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
        },
      },
    });
    await ask(model);
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer ts-live-1234567890",
      "Content-Type": "application/json",
    });
  });

  it("honors a dev endpoint override", async () => {
    const { model, calls } = modelWith(
      {
        status: 200,
        json: {
          answers: {
            kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
          },
        },
      },
      { endpoint: "http://127.0.0.1:9/systemone" },
    );
    await ask(model);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/systemone");
  });

  it("makes no request at all when no key is stored", async () => {
    const { model, calls } = modelWith(
      {
        status: 200,
        json: {
          answers: {
            kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
          },
        },
      },
      { key: undefined },
    );
    const answers = await ask(model);
    expect(calls).toEqual([]);
    expect(answers.answers.kind).toMatchObject({ outcome: "failed", reason: "no-key" });
  });
});

describe("JevDecisionModel: what it reads back", () => {
  it("returns the option and keeps the certainty off the interface", async () => {
    const { model } = modelWith({
      status: 200,
      json: {
        model: "jev-1.13.0",
        answers: {
          kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
        },
        usage: { input_tokens: 412, output_tokens: 0 },
      },
    });
    const run = await ask(model);
    expect(run.answers.kind).toMatchObject({
      value: "fix",
      outcome: "answered",
      source: "jev/jev-1.13.0",
      // The number reaches the record as prose, never as a typed field.
      detail: "p=0.93",
    });
    expect(run.answers.kind).not.toHaveProperty("confidence");
    expect(run.answers.kind?.version).toMatch(/^kc1-[0-9a-f]{12}$/);
    expect(run.usage[0]?.usage).toMatchObject({ input: 412, output: 0 });
    expect(run.usage[0]?.usage.cost).toBeCloseTo((412 / 1_000_000) * 0.042, 12);
  });

  it("answers the question's own abstention below the catalog floor", async () => {
    const { model } = modelWith({
      status: 200,
      json: {
        model: "jev-1.13.0",
        answers: {
          kind: { type: "choice", choice: "fix", confidence: 0.4, probabilities: { fix: 0.4 } },
        },
      },
    });
    const run = await ask(model);
    expect(run.answers.kind).toMatchObject({
      value: "unclear",
      outcome: "abstained",
      detail: "p=0.40 below 0.6",
    });
  });

  it("refuses a body it does not recognise, and an option it never offered", async () => {
    for (const json of [
      { nonsense: true },
      "not json at all",
      {
        answers: {
          kind: {
            type: "choice",
            choice: "escalate",
            confidence: 0.93,
            probabilities: { escalate: 0.93 },
          },
        },
      },
      { answers: {} },
    ]) {
      const { model } = modelWith({ status: 200, json });
      const run = await ask(model);
      expect(run.answers.kind).toMatchObject({
        value: "unclear",
        outcome: "failed",
        reason: "schema",
      });
    }
  });
});

describe("JevDecisionModel: how it fails", () => {
  it("names the vendor's own verdicts in our vocabulary", async () => {
    const cases: Array<[number, string]> = [
      [401, "key-rejected"],
      [422, "rejected"],
      [429, "rate-limited"],
      [529, "overloaded"],
      [500, "http-500"],
      // A 403 is NOT a credential verdict - it is also how a network policy
      // refuses - so it is an ordinary failure, the quota sensor's rule.
      [403, "http-403"],
    ];
    for (const [status, reason] of cases) {
      const { model } = modelWith({ status });
      const run = await ask(model);
      expect(run.answers.kind).toMatchObject({ value: "unclear", outcome: "failed", reason });
      expect(run.usage).toEqual([]);
    }
  });

  it("names a timeout and a dead network apart", async () => {
    for (const failure of ["timeout", "network", "oversized"] as const) {
      const { model } = modelWith(() => {
        throw new QuotaTransportError(failure);
      });
      const run = await ask(model);
      expect(run.answers.kind).toMatchObject({ outcome: "failed", reason: failure });
    }
  });

  it("never puts the key, or a vendor's prose, on the record", async () => {
    const { model } = modelWith(() => {
      throw new Error("Bearer ts-live-1234567890 is invalid");
    });
    const run = await ask(model);
    expect(JSON.stringify(run)).not.toContain("ts-live-1234567890");
    expect(JSON.stringify(run)).not.toContain("is invalid");
  });
});

async function stubVendor(respond: (response: ServerResponse) => void) {
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let dropped!: () => void;
  const closed = new Promise<void>((resolve) => {
    dropped = resolve;
  });
  const server = createServer((request, response) => {
    response.on("close", dropped);
    request.resume();
    request.on("end", () => {
      arrived();
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    requested,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("JevDecisionModel: over the real transport", () => {
  it("stops its request when the caller cancels, rather than waiting out 15 s", async () => {
    // The vendor never answers: only the caller's cancel can end this call.
    const vendor = await stubVendor(() => {});
    try {
      const model = new JevDecisionModel({
        row: ROW,
        key: () => "ts-live-1234567890",
        endpoint: vendor.endpoint,
      });
      const controller = new AbortController();
      const pending = model.decide(
        { purpose: "kind", taskId: "task-1" },
        STATE,
        { kind: QUESTION },
        controller.signal,
      );
      await vendor.requested;
      controller.abort();
      const run = await pending;
      expect(run.answers.kind).toMatchObject({
        value: "unclear",
        outcome: "failed",
        reason: "aborted",
      });
      expect(run.usage).toEqual([]);
      // The request itself stopped: its connection is gone.
      await vendor.closed;
    } finally {
      await vendor.close();
    }
  });

  it("refuses an answer past 64 KB unread, even a well-formed one", async () => {
    const answer = JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        kind: { type: "choice", choice: "fix", confidence: 0.93, probabilities: { fix: 0.93 } },
      },
      usage: { input_tokens: 812, output_tokens: 1 },
      // Everything the vendor might add, past the cap.
      note: "x".repeat(BODY_LIMIT_BYTES),
    });
    for (const declared of [true, false]) {
      const vendor = await stubVendor((response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          ...(declared ? { "content-length": String(Buffer.byteLength(answer)) } : {}),
        });
        response.end(answer);
      });
      try {
        const model = new JevDecisionModel({
          row: ROW,
          key: () => "ts-live-1234567890",
          endpoint: vendor.endpoint,
        });
        const run = await ask(model);
        expect(run.answers.kind).toMatchObject({
          value: "unclear",
          outcome: "failed",
          reason: "oversized",
        });
        expect(run.usage).toEqual([]);
      } finally {
        await vendor.close();
      }
    }
  });
});
