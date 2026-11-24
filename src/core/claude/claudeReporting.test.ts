import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  companyHeaders,
  companyReportingFrom,
  HEADERS_HELPER_REFRESH_MS,
  readClaudeCompanyReporting,
  receiverStepsAside,
  resetHeadersHelperForTests,
} from "./claudeReporting";

/**
 * Reading a company's Claude Code reporting setup from where Claude Code's
 * guide puts it for each developer (INF-6587's plan, piece 1). The keys are
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
  // INF-6616's review: what the receiver cannot pass on stays the client's to send, as before.
  it("is passed on when the receiver can carry all of it", () => {
    expect(receiverStepsAside(GUIDE_SETUP)).toBe(false);
  });

  it("is left to the client when it holds a key the receiver cannot carry", () => {
    expect(receiverStepsAside({ ...GUIDE_SETUP, OTEL_METRICS_EXPORTER: "prometheus" })).toBe(true);
    expect(receiverStepsAside({ ...GUIDE_SETUP, OTEL_LOGS_EXPORTER: "otlp,console" })).toBe(true);
    expect(
      receiverStepsAside({
        ...GUIDE_SETUP,
        OTEL_EXPORTER_OTLP_CERTIFICATE: "/etc/ssl/company.pem",
      }),
    ).toBe(true);
    expect(
      receiverStepsAside({ ...GUIDE_SETUP, OTEL_EXPORTER_OTLP_METRICS_INSECURE: "true" }),
    ).toBe(true);
  });

  it("is left to the client beside another reporting choice", () => {
    expect(receiverStepsAside({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toBe(true);
  });
});

describe("the setup's header command", () => {
  afterEach(() => resetHeadersHelperForTests());

  // INF-6616's review: one failed run must not leave every batch without the
  // company's token for the whole refresh period.
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
