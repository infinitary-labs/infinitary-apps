import { describe, expect, it } from "vitest";
import type { ResolveClaudeSettings } from "./claudeAccess";
import { claudeCostReportingAllowed, claudeReportingHost } from "./claudeCostPolicy";
import { hasClaudeReporting } from "./claudeCostReports";
import { companyReportingFrom } from "./claudeReporting";

// Approved local-cost direction: preserve existing person/company exports;
// an unavailable policy must not change how a model session can run.
function policy(
  settings: Record<string, unknown>,
  source: "managed" | "user" = "managed",
): ResolveClaudeSettings {
  return async (options) => {
    expect(options).toEqual({ settingSources: [] });
    return { effective: settings, provenance: {}, sources: [{ source, settings }] };
  };
}

describe("local cost reporting respects existing reporting choices", () => {
  it("permits an otherwise empty managed policy", async () => {
    expect(await claudeCostReportingAllowed(policy({}))).toBe(true);
  });
  it.each([
    { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test" } },
    { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" } },
    { env: { OTEL_LOG_USER_PROMPTS: "1" } },
    { policyHelper: { command: "organization-policy" } },
  ])(
    "retains terminal accounting for a managed reporting setting or policy helper: %j",
    async (settings) => {
      expect(await claudeCostReportingAllowed(policy(settings))).toBe(false);
    },
  );
  it("does not import the person's excluded settings into the session", async () => {
    expect(
      await claudeCostReportingAllowed(policy({ env: { OTEL_LOG_USER_PROMPTS: "1" } }, "user")),
    ).toBe(true);
  });
  it("keeps terminal accounting when the policy reader fails", async () => {
    expect(
      await claudeCostReportingAllowed(async () => {
        throw new Error("settings unavailable");
      }),
    ).toBe(false);
  });
  it("preserves explicitly configured reporting and opt-outs in the host environment", () => {
    expect(hasClaudeReporting({ OTEL_LOGS_EXPORTER: "none" })).toBe(true);
    expect(hasClaudeReporting({ ANT_OTEL_LOGS_EXPORTER: "otlp" })).toBe(true);
    expect(hasClaudeReporting({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toBe(true);
    expect(hasClaudeReporting({ PATH: "/usr/bin" })).toBe(false);
  });
});

describe("the host Settings → Usage names", () => {
  // The line names where Claude work is passed on, and nothing where the receiver steps aside.
  const setup = companyReportingFrom({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318",
  });
  const deps = (allowed: boolean) => ({
    costReportingAllowed: async () => allowed,
    companyReporting: async () => setup,
  });

  it("is the collector of the person's setup, which the receiver passes records on to", async () => {
    expect(await claudeReportingHost({}, deps(true))).toEqual({ host: "otel.example.com:4318" });
  });

  it("is none where a managed setup has Claude's client report, or another reporting choice stands", async () => {
    expect(await claudeReportingHost({}, deps(false))).toEqual({ host: null });
    expect(
      await claudeReportingHost({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, deps(true)),
    ).toEqual({ host: null });
  });
});
