import { claudeCostReportingAllowed } from "../claude/claudeCostPolicy";
import { hasClaudeReporting } from "../claude/claudeCostReports";
import { claudeLoginEmail, defaultClaudeConfigDir } from "../claude/claudeQuota";
import {
  type ClaudeCompanyReporting,
  companyHeaders,
  parseOtlpHeaders,
  readClaudeCompanyReporting,
  withoutReportingKeys,
} from "../claude/claudeReporting";
import { hostEnv } from "../hostEnv";
import type { UsageReportDestination } from "./usageReporter";

/** The company setup is read again at most this often, as the reporter asks on every heard event. */
const SETUP_REREAD_MS = 60_000;

export type CompanyDestinationDeps = {
  env(): NodeJS.ProcessEnv;
  costReportingAllowed(): Promise<boolean>;
  read(env: NodeJS.ProcessEnv): Promise<ClaudeCompanyReporting | undefined>;
  /** The person's own Claude Code login's email, which Claude's records carry as `user.email`. */
  email(env: NodeJS.ProcessEnv): Promise<string | undefined>;
};

/**
 * The company's Claude Code reporting setup (`claudeReporting.ts`) as the
 * report's one "claude-code" destination: Claude's own records already reach
 * it through the receiver, so every other provider's calls go there under
 * Claude Code's names, with the setup's headers and resource attributes and
 * the person's Claude Code login email where Claude's records carry it.
 *
 * None where the receiver steps aside, as `claudeReportingHost` decides: a
 * managed setup's own client reports and its address is never read here.
 * A signal the setup sends over gRPC takes no JSON request, so it is left out.
 */
export function companyDestination(deps: CompanyDestinationDeps): {
  destinations(): readonly UsageReportDestination[];
  refresh(): Promise<void>;
} {
  let held: readonly UsageReportDestination[] = [];
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    readAt = Date.now();
    reading ??= (async () => {
      const env = deps.env();
      const allowed =
        !hasClaudeReporting(withoutReportingKeys(env)) &&
        (await deps.costReportingAllowed().catch(() => false));
      const setup = allowed ? await deps.read(env).catch(() => undefined) : undefined;
      const email = setup ? await deps.email(env).catch(() => undefined) : undefined;
      held = setup ? toDestination(setup, deps.env, email) : [];
    })().finally(() => {
      reading = undefined;
    });
    return reading;
  };

  return {
    destinations() {
      if (Date.now() - readAt >= SETUP_REREAD_MS) void refresh();
      return held;
    },
    refresh,
  };
}

function toDestination(
  setup: ClaudeCompanyReporting,
  env: () => NodeJS.ProcessEnv,
  email: string | undefined,
): UsageReportDestination[] {
  const endpoints: UsageReportDestination["endpoints"] = {};
  for (const signal of ["logs", "metrics"] as const) {
    const found = setup.signals[signal];
    if (found && found.protocol !== "grpc") endpoints[signal] = found.endpoint;
  }
  if (!endpoints.logs && !endpoints.metrics) return [];
  const serviceName = setup.clientEnv.OTEL_SERVICE_NAME?.trim();
  return [
    {
      id: "company-claude-code",
      format: "claude-code",
      endpoints,
      headers: (signal) =>
        signal === "traces" ? Promise.resolve({}) : companyHeaders(setup, signal, env()),
      // OTLP's resource attribute list has the header list's shape.
      resource: {
        ...parseOtlpHeaders(setup.clientEnv.OTEL_RESOURCE_ATTRIBUTES),
        ...(serviceName ? { "service.name": serviceName } : {}),
      },
      ...(email ? { person: { "user.email": email } } : {}),
    },
  ];
}

/** The production source: the app's environment, the managed policy and the person's setup. */
export function companyUsageDestinations(): () => readonly UsageReportDestination[] {
  return companyDestination({
    env: () => hostEnv(),
    costReportingAllowed: () => claudeCostReportingAllowed(),
    read: (env) => readClaudeCompanyReporting(env),
    email: (env) => claudeLoginEmail(defaultClaudeConfigDir(env), env),
  }).destinations;
}
