import { describe, expect, it, vi } from "vitest";
import type { ClaudeCallCost } from "./claudeCallUsage";
import {
  CLAUDE_COST_REPORT_BODY_MAX,
  ClaudeCostReports,
  type ClaudeReportForward,
} from "./claudeCostReports";

// Approved local-cost direction: actual OTLP/HTTP envelope and request values
// observed from the boxed client, with identity and content added to verify
// they do not cross the receiver's projection. No real account is used.
vi.setConfig({ testTimeout: 10_000 });
function batch(sessionId: string, fields: Record<string, string | number> = {}) {
  const attributes = {
    "session.id": sessionId,
    "event.name": "api_request",
    request_id: "req_local_1",
    model: "claude-haiku-4-5",
    input_tokens: 42,
    output_tokens: 7,
    cost_usd: 0.000077,
    ...fields,
  };
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "user.email", value: { stringValue: "dummy@example.test" } }],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: "claude_code.api_request" },
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === "number" ? { doubleValue: value } : { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}
function post(endpoint: string, body: unknown) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the approved private same-computer cost receiver", () => {
  it("isolates attachments, projects only usage fields and keeps the client's batching default", async () => {
    const reports = new ClaudeCostReports();
    const first: ClaudeCallCost[] = [];
    const second: ClaudeCallCost[] = [];
    const a = await reports.subscribe("session-a", (cost) => first.push(cost));
    const b = await reports.subscribe("session-b", (cost) => second.push(cost));
    const endpoint = a.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string;
    try {
      expect(new URL(endpoint).hostname).toBe("127.0.0.1");
      const route = new URL(endpoint).pathname.slice(1);
      expect(a.redact(`export failed: ${endpoint}`).includes(route)).toBe(false);
      expect(a.redact("ordinary client diagnostic")).toBe("ordinary client diagnostic");
      expect(a.env.OTEL_LOGS_EXPORT_INTERVAL).toBeUndefined();
      expect(a.env.OTEL_LOG_USER_PROMPTS).toBe("0");
      expect(a.env.OTEL_METRICS_EXPORTER).toBe("none");
      expect(a.env.OTEL_TRACES_EXPORTER).toBe("none");
      expect(
        (
          await post(
            endpoint,
            batch("session-a", {
              "user.email": "dummy@example.test",
              prompt: "do not retain this",
            }),
          )
        ).status,
      ).toBe(200);
      expect(first).toEqual([
        {
          requestId: "req_local_1",
          model: "claude-haiku-4-5",
          input: 42,
          output: 7,
          cost: 0.000077,
        },
      ]);
      expect(second).toEqual([]);
      expect((await post(endpoint, batch("session-b"))).status).toBe(200);
      expect(first).toHaveLength(1);
      const foreign = new URL(endpoint);
      foreign.pathname = "/not-an-attachment";
      expect((await post(foreign.href, batch("session-a"))).status).toBe(404);
      a.close();
      expect((await post(endpoint, batch("session-a"))).status).toBe(404);
      expect(
        (await post(b.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string, batch("session-b"))).status,
      ).toBe(200);
      expect(second).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
    await expect(post(endpoint, batch("session-a"))).rejects.toThrow();
  });
  it("refuses malformed/oversized exports and does not export reports without a provider request identity", async () => {
    const reports = new ClaudeCostReports();
    const seen: ClaudeCallCost[] = [];
    const subscription = await reports.subscribe("session", (cost) => seen.push(cost));
    const endpoint = subscription.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string;
    try {
      expect((await fetch(endpoint, { method: "POST", body: "not JSON" })).status).toBe(400);
      await post(endpoint, batch("session", { request_id: "" }));
      await post(endpoint, batch("session", { cost_usd: -1 }));
      expect(seen).toEqual([]);
      expect(
        (await post(endpoint, { padding: "x".repeat(CLAUDE_COST_REPORT_BODY_MAX) })).status,
      ).toBe(413);
      await post(endpoint, batch("session"));
      expect(seen).toHaveLength(1);
    } finally {
      subscription.close();
    }
  });
  it("a reporting callback failure remains a reporting failure, and a later attachment still works", async () => {
    const reports = new ClaudeCostReports();
    const failed = await reports.subscribe("failed", () => {
      throw new Error("listener unavailable");
    });
    try {
      expect(
        (await post(failed.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string, batch("failed"))).status,
      ).toBe(400);
    } finally {
      failed.close();
    }
    const seen: ClaudeCallCost[] = [];
    const next = await reports.subscribe("next", (cost) => seen.push(cost));
    try {
      await post(next.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string, batch("next"));
      expect(seen).toHaveLength(1);
    } finally {
      next.close();
    }
  });

  // The client never resends a refused batch, so a large one must still reach the collector.
  it("passes a batch over the pricing bound on to the company's collector, unpriced", async () => {
    const reports = new ClaudeCostReports();
    const seen: ClaudeCallCost[] = [];
    const sent: Buffer[] = [];
    const forward: ClaudeReportForward = {
      signals: { logs: { protocol: "http/json" } },
      clientEnv: {},
      send: async (_signal, body) => {
        sent.push(body);
        return { status: 200, body: Buffer.from("{}"), contentType: "application/json" };
      },
    };
    const subscription = await reports.subscribe("session", (cost) => seen.push(cost), forward);
    const endpoint = subscription.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string;
    try {
      const large = batch("session", { prompt: "x".repeat(CLAUDE_COST_REPORT_BODY_MAX) });
      expect((await post(endpoint, large)).status).toBe(200);
      expect(sent.map((body) => body.toString("utf8"))).toEqual([JSON.stringify(large)]);
      expect(seen).toEqual([]);
      await post(endpoint, batch("session"));
      expect(seen).toHaveLength(1);
      expect(sent).toHaveLength(2);
    } finally {
      subscription.close();
    }
  });
});
