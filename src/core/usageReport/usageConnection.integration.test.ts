import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type CollectorTls, collectorTlsFixture } from "../../../tests/helpers/collectorTlsFixture";
import { integrationKeys } from "../../../tests/helpers/integrationKeys";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { useSystemRootsForTests } from "../claude/claudeReporting";
import { openInMemoryDatabase } from "../storage/db";
import { homeUsage } from "../storage/homeUsage";
import { USAGE_CONNECTION_FILE, usageConnection } from "./usageConnection";

/**
 * This task's goal: the reporting connection a person adds reaches a
 * collector on a certificate authority only this computer trusts, as the
 * company setup's collector is reached (docs/usage.md, "Certificates"), and
 * one it cannot trust is said in Settings → Usage, not only the log. The
 * collector is a real local HTTPS server on certificates OpenSSL made for
 * the run, under an authority no computer trusts, and Secrets the real
 * controller over disposable custody.
 */

let tls: CollectorTls;
beforeAll(() => {
  tls = collectorTlsFixture(scratchDir("infinitary-usage-connection-tls-"));
});

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  useSystemRootsForTests();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const TOKEN = "glc_invented-grafana-cloud-token";

/** The company's collector, on a certificate its own authority signed. */
async function secureCollector() {
  const received: { path: string; authorization?: string }[] = [];
  const server = createServer({ cert: tls.serverCert, key: tls.serverKey }, (request, response) => {
    request.resume();
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      });
      response.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** A connection saved with a kept header, and one Codex call reported through it and sent. */
async function reportThrough(url: string) {
  const secrets = integrationKeys();
  const connection = usageConnection({
    file: join(scratchDir("usage-connection-"), USAGE_CONNECTION_FILE),
    keys: secrets.keys,
  });
  const usage = homeUsage(openInMemoryDatabase(), {
    appLimit: () => DEFAULT_COST_LIMIT,
    projectLimit: () => null,
    isTask: () => false,
    hearEvents: () => {},
    reportDestinations: () => connection.destinations(),
  });
  const saved = await connection.save({
    endpoint: url,
    format: "standard",
    headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
  });
  expect(saved.saved).toBe(true);
  usage.recordUsage({
    taskId: "task-1",
    accountId: "acct-codex",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    usage: { input: 1200, output: 340, cost: 0.0123, costSource: "listed-prices" },
  });
  await usage.usageReporter.flush();
  await connection.stop();
  return connection;
}

describe("the reporting connection to a collector on a company's own authority", () => {
  it("reaches one the computer's trusted list vouches for, with its kept header", async () => {
    const collector = await secureCollector();
    useSystemRootsForTests(() => [tls.ca]);
    const connection = await reportThrough(collector.url);
    expect(collector.received.map((r) => r.path).sort()).toEqual(["/v1/metrics", "/v1/traces"]);
    for (const batch of collector.received) expect(batch.authorization).toBe(`Bearer ${TOKEN}`);
    expect(connection.refusal()).toBeUndefined();
  });

  it("says it could not connect securely to one the computer does not trust", async () => {
    const collector = await secureCollector();
    useSystemRootsForTests(() => []);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = await reportThrough(collector.url);
    expect(collector.received).toEqual([]);
    expect(connection.refusal()).toBe("secure-connection");
    const host = new URL(collector.url).host;
    expect(warn.mock.calls.map((call) => String(call[0])).sort()).toEqual([
      `[usage report] ${host} unreachable for a metrics batch (secure-connection); dropped`,
      `[usage report] ${host} unreachable for a traces batch (secure-connection); dropped`,
    ]);
  });
});
