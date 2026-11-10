import type { ResolveClaudeSettings } from "./claudeAccess";
import { hasClaudeReporting } from "./claudeCostReports";

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
