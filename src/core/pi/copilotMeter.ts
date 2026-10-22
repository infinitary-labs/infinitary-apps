import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { COPILOT_PROVIDER_ID } from "@shared/providers";
import type { ResolvedProviderAuth } from "./piAuth";

export { COPILOT_PROVIDER_ID };

/**
 * The credential Copilot's allowance is read with. Pi's request auth for
 * Copilot is a short-lived Copilot token that only Copilot's own API
 * accepts; the allowance lives on GitHub's API, which takes the GitHub
 * sign-in Pi minted that token from (the credential's `refresh`). So this
 * reads Pi's stored credential through Pi's own read, never parsing the
 * file and never writing it, and runs no renewal: a GitHub sign-in GitHub
 * refuses is a lapsed one, which only signing in again replaces
 * (docs/quota.md, "Copilot").
 *
 * `baseUrl` is the GitHub API the account signed in to: api.github.com, or
 * `api.<domain>` for GitHub Enterprise, as Pi derives its sign-in host.
 */
export function copilotMeterAuth(authPath: string): ResolvedProviderAuth | undefined {
  let credential: ReturnType<typeof readStoredCredential>;
  try {
    credential = readStoredCredential(COPILOT_PROVIDER_ID, authPath);
  } catch {
    return undefined;
  }
  if (credential?.type !== "oauth") return undefined;
  const token = credential.refresh;
  if (typeof token !== "string" || token.length === 0) return undefined;
  const domain = enterpriseDomain(credential.enterpriseUrl);
  return {
    apiKey: token,
    baseUrl: domain ? `https://api.${domain}` : "https://api.github.com",
    usingOAuth: true,
  };
}

/**
 * The GitHub Enterprise host a Copilot account signed in to, read from Pi's
 * stored credential through Pi's own read: signing in again answers Pi's
 * Enterprise question with it rather than asking the person (INF-838).
 * Undefined is github.com, or no readable credential.
 */
export function copilotEnterpriseHost(authPath: string): string | undefined {
  try {
    const credential = readStoredCredential(COPILOT_PROVIDER_ID, authPath);
    return credential?.type === "oauth" ? enterpriseDomain(credential.enterpriseUrl) : undefined;
  } catch {
    return undefined;
  }
}

function enterpriseDomain(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname || undefined;
  } catch {
    return undefined;
  }
}
