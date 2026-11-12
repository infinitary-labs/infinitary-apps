import { z } from "zod";

/**
 * The offered provider catalog: Codex, xAI, Claude, Kimi Code and GitHub
 * Copilot are subscriptions; OpenRouter connects with an API key. API-key
 * providers are allowed (D-6) with UI emphasis on subscriptions. A supported
 * subscription is one that runs through Pi; Claude and Antigravity are the
 * two exceptions (captain, 2026-09-24 and 2026-11-11). Cursor was removed; stored accounts for its id are
 * ignored on load (`isRetiredProvider`), not deleted. Kimi Code and GitHub
 * Copilot came back through Pi on 2026-10-19 (INF-560): an account stored
 * under either id before then loads again, and a sign-in that lapsed
 * meanwhile asks to sign in again from the quota rules' own proof.
 *
 * Every entry names the backend that serves it and the roles it may serve.
 * Claude rides its own first-party client because Anthropic refuses
 * subscription OAuth from third-party clients. Since W1 (2026-09-26) it
 * serves both roles: a Claude login may seat the Firstmate too. The
 * single-vendor risk that once kept it crew-only - the always-on
 * orchestrator stopping when that one vendor cuts it off - is answered by
 * the cut-off contract (a typed cut-off pauses the seat and asks by card
 * before any move; docs/architecture.md §16), not by the catalog.
 */

export const providerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Catalog placement. `key` is an API-key sign-in. `escape_hatch` remains
   * so an older view still parses; nothing in the catalog uses it, and the
   * chip labels both as "API key".
   */
  tier: z.enum(["subscription", "key", "escape_hatch"]),
  /** Auth methods Pi offers for this provider. */
  authTypes: z.array(z.enum(["oauth", "api_key"])),
  /**
   * Why there is no way in right now, when the provider's backend has a
   * sentence for it and `authTypes` is empty: `note` is the short line on the
   * chip, `detail` the sentence behind it. A Claude account runs the Claude
   * Code the person installed (F14), so a Mac without it says so here.
   */
  unavailable: z.object({ note: z.string(), detail: z.string() }).optional(),
  /** Whether credentials are currently configured. */
  connected: z.boolean(),
  /** Which auth type is active when connected. */
  activeAuthType: z.enum(["oauth", "api_key"]).optional(),
  /**
   * D-18 billed-per-token flag. Currently always false: Anthropic/Claude is
   * not offered. Kept on the view so a future API-key re-introduction does
   * not need a schema change.
   */
  billedPerToken: z.boolean(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const authPromptSchema = z.object({
  promptId: z.string(),
  providerId: z.string(),
  /** Which account row this prompt belongs to, when a login is account-scoped. */
  accountId: z.string().optional(),
  kind: z.enum(["text", "secret", "select", "manual_code"]),
  message: z.string(),
  placeholder: z.string().optional(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
});
export type AuthPromptView = z.infer<typeof authPromptSchema>;

export const authNoticeSchema = z.object({
  providerId: z.string(),
  /** Which account row this notice belongs to, when a login is account-scoped. */
  accountId: z.string().optional(),
  kind: z.enum(["info", "auth_url", "device_code", "progress"]),
  message: z.string(),
  url: z.string().optional(),
  userCode: z.string().optional(),
  /**
   * When a device code stops working, in epoch milliseconds, from the
   * provider's own answer (`expires_in`): the code step says the code
   * expired once a sign-in ends past it.
   */
  expiresAt: z.number().optional(),
});
export type AuthNotice = z.infer<typeof authNoticeSchema>;

/**
 * Which backend serves a provider's accounts. `pi` is the default; `claude`
 * is the one subscription Pi cannot reach. Each has a Firstmate seat of its
 * own (`src/core/orchestrator/seat.ts`), so either may serve either role.
 */
export const backendIdSchema = z.enum(["pi", "claude"]);
export type BackendId = z.infer<typeof backendIdSchema>;

/** The Firstmate orchestrator role, and the crewmate role. */
export type ProviderRole = "firstmate" | "crewmate";

export type ProviderCatalogEntry = {
  id: string;
  name: string;
  tier: ProviderView["tier"];
  backend: BackendId;
  /** Roles this provider's accounts may be bound to. */
  roles: ReadonlyArray<ProviderRole>;
  /**
   * The provider signs in with a code the person types on its page, and the
   * app offers no key for it: its chip starts that sign-in at once, with no
   * browser-or-key question (INF-838). `site` names the page in the step's
   * words; `enterprise` offers the Use GitHub Enterprise row.
   */
  codeSignIn?: { site: string; enterprise?: true };
};

/** Claude Max: a subscription Pi cannot reach, hence its own backend. */
export const CLAUDE_PROVIDER_ID = "anthropic-claude";

/**
 * Offered providers, in display order. Ids are Pi provider ids where Pi
 * serves them; names follow the design skill's product vocabulary.
 */
export const PROVIDER_CATALOG: ReadonlyArray<ProviderCatalogEntry> = [
  {
    id: "openai-codex",
    name: "Codex",
    tier: "subscription",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
  },
  {
    id: "xai",
    name: "Grok",
    tier: "subscription",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
  },
  {
    id: CLAUDE_PROVIDER_ID,
    name: "Claude",
    tier: "subscription",
    backend: "claude",
    roles: ["firstmate", "crewmate"],
  },
  {
    // Pi offers a device code or a pasted Kimi Code key; the chip starts
    // the code (INF-838).
    id: "kimi-coding",
    name: "Kimi Code",
    tier: "subscription",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
    codeSignIn: { site: "Kimi" },
  },
  {
    // Pi's Copilot sign-in presents itself to GitHub as VS Code's Copilot
    // Chat: the client id and editor headers are fixed inside Pi's provider,
    // outside its login options. The captain chose to proceed through Pi
    // knowing this (INF-560, 2026-10-19), and later chose a chip with no
    // note and a code step that says GitHub asks to approve a Copilot app
    // (INF-838, 2026-10-22).
    id: "github-copilot",
    name: "Copilot",
    tier: "subscription",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
    codeSignIn: { site: "GitHub", enterprise: true },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    tier: "key",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
  },
];

/** The chip and sign-in label for every provider that connects with an API key. */
export const API_KEY_LABEL = "API key";

/**
 * Providers removed from the catalog. Their credential directories and
 * registry rows stay on disk (nothing is deleted), and every live read
 * skips them so an old sign-in is neither a row nor a routing candidate.
 */
export const RETIRED_PROVIDER_IDS = ["cursor"] as const;

export function isRetiredProvider(id: string): boolean {
  return (RETIRED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** The mono note on a provider's chip: "API key" on a non-subscription, else none. */
export function providerSignInNote(provider: Pick<ProviderView, "tier">): string | undefined {
  return provider.tier === "subscription" ? undefined : API_KEY_LABEL;
}

/** Pi's provider id for GitHub Copilot. */
export const COPILOT_PROVIDER_ID = "github-copilot";

/**
 * The code step's words (INF-838), shared by the first screen and Settings,
 * after the GitHub sign-in in Settings -> Integrations.
 */
export const CODE_STEP_WORDS = {
  enter: (site: string) => `Enter this code on ${site}:`,
  copyAndOpen: (site: string) => `Copy code and open ${site}`,
  waiting: (site: string) => `Waiting for ${site}...`,
  /** GitHub names the app it asks to approve after VS Code's Copilot, never Infinitary. */
  approve: "GitHub will ask you to approve a GitHub Copilot app. That is this sign-in.",
  expired: "The code expired.",
  newCode: "Get a new code",
  useEnterprise: "Use GitHub Enterprise",
  useGitHubCom: "Use github.com",
  enterpriseLabel: "GitHub Enterprise address",
  enterprisePlaceholder: "company.ghe.com",
  getCode: "Get a code",
  badEnterprise: "That is not a GitHub Enterprise address. It looks like company.ghe.com.",
} as const;

/**
 * The GitHub Enterprise host a person typed, as the sign-in uses it: the
 * host name alone, or null when it is not one. Blank is github.com, and
 * github.com itself is not an Enterprise host.
 */
export function githubEnterpriseHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
    if (!host.includes(".") || host === "github.com") return null;
    return host;
  } catch {
    return null;
  }
}

/** True when `id` is in the offered catalog (connect UI, routing, login). */
export function isOfferedProvider(id: string): boolean {
  return PROVIDER_CATALOG.some((entry) => entry.id === id);
}

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

/** The backend serving a provider; unknown providers default to Pi. */
export function backendForProvider(id: string): BackendId {
  return catalogEntry(id)?.backend ?? "pi";
}

/**
 * Whether a provider's accounts may serve a role. The catalog's roles are
 * read here, at every selection and rebind point, so one catalog edit
 * governs them rather than a backend-specific branch. An id
 * outside the catalog is a custom provider from models.json: it rides the
 * base Pi runtime (`backendForProvider` defaults to Pi), which serves every
 * role - `resolveModel()` can auto-derive and persist such a pin. A retired
 * provider serves no role at all.
 */
export function providerServesRole(id: string, role: ProviderRole): boolean {
  if (isRetiredProvider(id)) return false;
  const entry = catalogEntry(id);
  return entry ? entry.roles.includes(role) : backendForProvider(id) === "pi";
}

/** Providers whose accounts ride Pi's in-process runtime. */
export function isPiProvider(id: string): boolean {
  return backendForProvider(id) === "pi" && isOfferedProvider(id);
}
