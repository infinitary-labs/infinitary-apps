import type { UsageReporting } from "@shared/usage";
import type { ResolveClaudeSettings } from "./claudeAccess";
import { hasClaudeReporting } from "./claudeCostReports";
import type { ClaudeSessionDeps } from "./claudeQueryCore";
import { readClaudeCompanyReporting, withoutReportingKeys } from "./claudeReporting";

/**
 * The approved receiver must not overwrite an organization's reporting or
 * content-export policy. Only managed tiers are read; no user settings,
 * credentials or account probe is needed. An unreadable policy, or one a
 * policyHelper could change at startup, retains result-only accounting.
 */
export async function claudeCostReportingAllowed(
  resolve: ResolveClaudeSettings = async (options) =>
    (await import("@anthropic-ai/claude-agent-sdk")).resolveSettings(options),
): Promise<boolean> {
  try {
    const resolved = await resolve({ settingSources: [] });
    for (const tier of resolved.sources) {
      if (tier.source !== "managed") continue;
      const settings = tier.settings as { env?: NodeJS.ProcessEnv; policyHelper?: unknown };
      if (settings.policyHelper !== undefined || hasClaudeReporting(settings.env ?? {}))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A production session factory's reporting: the managed policy, and a company's setup to pass records on to. */
export function claudeReportingDeps(): Pick<
  ClaudeSessionDeps,
  "costReportingAllowed" | "companyReporting"
> {
  return {
    costReportingAllowed: () => claudeCostReportingAllowed(),
    companyReporting: (env) => readClaudeCompanyReporting(env),
  };
}

/**
 * The host Claude work is passed on to, for Settings → Usage: none where the
 * receiver steps aside (another reporting choice in the environment, or a
 * managed setup whose own client reports), as a session's attachment does.
 */
export async function claudeReportingHost(
  env: NodeJS.ProcessEnv,
  deps: ReturnType<typeof claudeReportingDeps> = claudeReportingDeps(),
): Promise<UsageReporting> {
  if (
    hasClaudeReporting(withoutReportingKeys(env)) ||
    !(await deps.costReportingAllowed?.().catch(() => false))
  )
    return { host: null };
  const setup = await deps.companyReporting?.(env).catch(() => undefined);
  return { host: setup?.host ?? null };
}
