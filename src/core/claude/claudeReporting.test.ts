import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  companyForward,
  companyHeaders,
  companyReportingFrom,
  HEADERS_HELPER_REFRESH_MS,
  lastingRefusal,
  REFUSAL_LASTS_MS,
  readClaudeCompanyReporting,
  receiverStepsAside,
  resetHeadersHelperForTests,
  resetRefusalsForTests,
} from "./claudeReporting";

/**
 * Reading a company's Claude Code reporting setup from where Claude Code's
 * guide puts it for each developer. The keys are
 * the guide's own example setup.
 */

const GUIDE_SETUP = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.com:4317",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20your-token",
  OTEL_RESOURCE_ATTRIBUTES: "department=engineering,team.id=platform",
  OTEL_METRIC_EXPORT_INTERVAL: "10000",
};

function settings(user: Record<string, unknown> | undefined): () => Promise<ResolvedSettings> {
  return async () =>
    ({
      effective: {},
      sources: user ? [{ source: "user", settings: user }] : [],
    }) as unknown as ResolvedSettings;
}

describe("a company's Claude Code reporting setup", () => {
  it("sends each signal where the guide's setup says, and keeps its other keys for the client", () => {
    expect(companyReportingFrom(GUIDE_SETUP)).toEqual({
      host: "collector.example.com:4317",
      signals: {
        logs: {
          endpoint: "http://collector.example.com:4317",
          protocol: "grpc",
          headers: { Authorization: "Bearer your-token" },
          timeoutMs: 10_000,
        },
        metrics: {
          endpoint: "http://collector.example.com:4317",
          protocol: "grpc",
          headers: { Authorization: "Bearer your-token" },
          timeoutMs: 10_000,
        },
      },
      clientEnv: {
        OTEL_RESOURCE_ATTRIBUTES: "department=engineering,team.id=platform",
        OTEL_METRIC_EXPORT_INTERVAL: "10000",
      },
    });
  });

  it("adds OTLP's signal path to a shared HTTP address, and keeps a signal's own address as it is", () => {
    const setup = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com/collect/",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example.com/ingest",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "X-Scope=metrics",
    });
    expect(setup?.signals.metrics).toEqual({
      endpoint: "https://otel.example.com/collect/v1/metrics",
      protocol: "http/protobuf",
      headers: { "X-Scope": "metrics" },
      timeoutMs: 10_000,
    });
    expect(setup?.signals.logs?.endpoint).toBe("https://logs.example.com/ingest");
  });

  it("takes the setup's certificate files for a secure collector, a signal's own key winning", () => {
    const setup = companyReportingFrom({
      ...GUIDE_SETUP,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4317",
      OTEL_EXPORTER_OTLP_CERTIFICATE: "/etc/company/ca.pem",
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: "/etc/company/dev.pem",
      OTEL_EXPORTER_OTLP_CLIENT_KEY: "/etc/company/dev.key",
      OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE: "/etc/company/metrics-ca.pem",
      OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY: "",
    });
    expect(setup?.signals.logs?.tls, "an empty signal key reads as unset").toEqual({
      ca: "/etc/company/ca.pem",
      cert: "/etc/company/dev.pem",
      key: "/etc/company/dev.key",
    });
    expect(setup?.signals.metrics?.tls).toEqual({
      ca: "/etc/company/metrics-ca.pem",
      cert: "/etc/company/dev.pem",
      key: "/etc/company/dev.key",
    });
    expect(
      companyReportingFrom({
        ...GUIDE_SETUP,
        OTEL_EXPORTER_OTLP_CERTIFICATE: "/etc/company/ca.pem",
      })?.signals.logs?.tls,
      "a plain http:// collector has no use for them",
    ).toBe(undefined);
  });

  it("reads a gRPC address with no scheme as secure, unless the setup's insecure key is true", () => {
    const bare = { ...GUIDE_SETUP, OTEL_EXPORTER_OTLP_ENDPOINT: "collector.example.com:4317" };
    const secure = companyReportingFrom(bare);
    expect(secure?.host).toBe("collector.example.com:4317");
    expect(secure?.signals.logs?.endpoint).toBe("https://collector.example.com:4317");
    const insecure = companyReportingFrom({ ...bare, OTEL_EXPORTER_OTLP_METRICS_INSECURE: "TRUE" });
    expect(insecure?.signals.metrics?.endpoint).toBe("http://collector.example.com:4317");
    expect(insecure?.signals.logs?.endpoint).toBe("https://collector.example.com:4317");
    expect(
      companyReportingFrom({ ...bare, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }),
      "an HTTP address needs its scheme, as the client's HTTP exporter does",
    ).toBe(undefined);
  });

  it("is no setup while telemetry is off or no signal is exported over OTLP", () => {
    expect(companyReportingFrom({ ...GUIDE_SETUP, CLAUDE_CODE_ENABLE_TELEMETRY: "0" })).toBe(
      undefined,
    );
    expect(
      companyReportingFrom({
        ...GUIDE_SETUP,
        OTEL_METRICS_EXPORTER: "prometheus",
        OTEL_LOGS_EXPORTER: "console",
      }),
    ).toBe(undefined);
  });

  it("lays the settings file over the login shell, and the shell over the launch environment", async () => {
    const setup = await readClaudeCompanyReporting(
      {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://launch.example.com:4318",
        OTEL_SERVICE_NAME: "launch",
        HOME: "/Users/someone",
      },
      {
        shell: () => ({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://shell.example.com:4318",
          OTEL_RESOURCE_ATTRIBUTES: "from=shell",
        }),
        resolve: settings({
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://settings.example.com:4318", PATH: "/x" },
          otelHeadersHelper: "/usr/local/bin/otel-headers",
        }),
      },
    );
    expect(setup?.host).toBe("settings.example.com:4318");
    expect(setup?.headersHelper).toBe("/usr/local/bin/otel-headers");
    expect(setup?.clientEnv).toEqual({
      OTEL_SERVICE_NAME: "launch",
      OTEL_RESOURCE_ATTRIBUTES: "from=shell",
    });
  });

  it("still reads the environment's setup when the settings file cannot be read", async () => {
    const setup = await readClaudeCompanyReporting(GUIDE_SETUP, {
      shell: () => undefined,
      resolve: async () => {
        throw new Error("unreadable settings");
      },
    });
    expect(setup?.host).toBe("collector.example.com:4317");
  });
});

describe("a setup in the environment the app was started from", () => {
  // What the receiver cannot pass on stays the client's to send.
  it("is passed on when the receiver can carry all of it, its certificate keys included", () => {
    expect(receiverStepsAside(GUIDE_SETUP)).toBe(false);
    expect(
      receiverStepsAside({
        ...GUIDE_SETUP,
        OTEL_EXPORTER_OTLP_CERTIFICATE: "/etc/ssl/company.pem",
        OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: "/etc/ssl/dev.pem",
        OTEL_EXPORTER_OTLP_CLIENT_KEY: "/etc/ssl/dev.key",
      }),
    ).toBe(false);
    expect(
      receiverStepsAside({ ...GUIDE_SETUP, OTEL_EXPORTER_OTLP_METRICS_INSECURE: "true" }),
    ).toBe(false);
  });

  it("is left to the client when it names an exporter the receiver cannot carry", () => {
    expect(receiverStepsAside({ ...GUIDE_SETUP, OTEL_METRICS_EXPORTER: "prometheus" })).toBe(true);
    expect(receiverStepsAside({ ...GUIDE_SETUP, OTEL_LOGS_EXPORTER: "otlp,console" })).toBe(true);
  });

  it("is left to the client beside another reporting choice", () => {
    expect(receiverStepsAside({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toBe(true);
  });
});

describe("the setup's header command", () => {
  afterEach(() => resetHeadersHelperForTests());

  // The client does not resend a batch its collector refused for a missing token.
  it("runs again soon after a failed run, and keeps a good run for the refresh period", async () => {
    const dir = scratchDir("infinitary-headers-helper-");
    const count = join(dir, "runs");
    writeFileSync(count, "0");
    const command = join(dir, "otel-headers");
    writeFileSync(
      command,
      `#!/bin/sh\nn=$(( $(cat "${count}") + 1 ))\nprintf '%s' "$n" > "${count}"\n[ "$n" -gt 1 ] || exit 1\nprintf '{"Authorization":"Bearer token-%s"}' "$n"\n`,
    );
    chmodSync(command, 0o755);
    const setup = companyReportingFrom({ ...GUIDE_SETUP, OTEL_EXPORTER_OTLP_HEADERS: "" }, command);
    if (!setup) throw new Error("the guide's setup reads as a setup");
    const env = { PATH: process.env.PATH ?? "" };
    let at = 0;
    const headersAt = async (time: number) => {
      at = time;
      return companyHeaders(setup, "logs", env, () => at);
    };
    expect(await headersAt(0), "the first run failed").toEqual({});
    expect(await headersAt(5_000), "a failed run waits a little before running again").toEqual({});
    expect(await headersAt(11_000)).toEqual({ Authorization: "Bearer token-2" });
    expect(await headersAt(11_000 + HEADERS_HELPER_REFRESH_MS - 1)).toEqual({
      Authorization: "Bearer token-2",
    });
    expect(readFileSync(count, "utf8"), "the good run served the whole refresh period").toBe("2");
  });
});

describe("a collector that keeps refusing", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    resetRefusalsForTests();
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  /** A collector over OTLP/HTTP that answers each batch with the next status given. */
  async function collector(statuses: number[]): Promise<string> {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(statuses.shift() ?? 200).end());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function forwardTo(endpoint: string, clock: { at: number }) {
    const setup = companyReportingFrom({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    });
    if (!setup) throw new Error("the setup reads as a setup");
    const forward = companyForward(setup, {}, () => {}, { now: () => clock.at });
    return { setup, send: () => forward.send("logs", Buffer.from("{}"), "application/json") };
  }

  it("is named once its refusals have gone on for a minute, and no longer after a batch gets through", async () => {
    const endpoint = await collector([401, 401, 401, 200]);
    const clock = { at: 1_000_000 };
    const { setup, send } = forwardTo(endpoint, clock);
    expect((await send()).status, "the client reads the collector's own answer").toBe(401);
    clock.at += REFUSAL_LASTS_MS - 1;
    await send();
    expect(lastingRefusal(setup, clock.at), "one batch's retries pass quietly").toBe(undefined);
    clock.at += 1;
    await send();
    expect(lastingRefusal(setup, clock.at)).toEqual({
      host: new URL(endpoint).host,
      reason: "refused",
    });
    clock.at += 1_000;
    expect((await send()).status).toBe(200);
    expect(lastingRefusal(setup, clock.at)).toBe(undefined);
  });

  it("says the collector could not be reached when nothing answers at its address", async () => {
    const endpoint = await collector([]);
    await new Promise((resolve) => servers.splice(0)[0]?.close(resolve));
    const clock = { at: 1_000_000 };
    const { setup, send } = forwardTo(endpoint, clock);
    expect((await send()).status, "the client retries a collector it could not reach").toBe(503);
    clock.at += REFUSAL_LASTS_MS;
    await send();
    expect(lastingRefusal(setup, clock.at)?.reason).toBe("unreachable");
  });
});
