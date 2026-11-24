import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { companyReportingFrom, readClaudeCompanyReporting } from "./claudeReporting";

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
