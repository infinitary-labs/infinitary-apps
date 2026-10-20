import { z } from "zod";

/**
 * The offered provider catalog: Codex, xAI, Claude and Kimi Code are
 * subscriptions; OpenRouter connects with an API key. API-key providers are
 * allowed (D-6) with UI emphasis on subscriptions. A supported subscription
 * is one that runs through Pi; Claude is the sole exception (captain,
 * 2026-09-24). GitHub Copilot and Cursor were removed; stored accounts for
 * those ids are ignored on load (`isRetiredProvider`), not deleted. Kimi Code
 * came back on 2026-10-19 (INF-560): an account stored under its id before
 * then loads again, and a sign-in that lapsed meanwhile asks to sign in
 * again from the quota rules' own proof.
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
    // Pi's device code, or a pasted Kimi Code key: Pi offers both.
    id: "kimi-coding",
    name: "Kimi Code",
    tier: "subscription",
    backend: "pi",
    roles: ["firstmate", "crewmate"],
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
export const RETIRED_PROVIDER_IDS = ["github-copilot", "cursor"] as const;

export function isRetiredProvider(id: string): boolean {
  return (RETIRED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** The mono note on a non-subscription chip. Subscriptions carry none. */
export function providerSignInNote(tier: ProviderView["tier"]): string | undefined {
  return tier === "subscription" ? undefined : API_KEY_LABEL;
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
