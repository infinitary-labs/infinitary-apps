import { z } from "zod";

export {
  AUTO_ROUTABLE_BUCKETS,
  AUTO_ROUTABLE_SLOTS,
  type IntelligenceBucket,
  intelligenceBucketSchema,
  isAutoRoutableBucket,
  isAutoRoutableSlot,
  PREMIUM_BUCKET,
  PREMIUM_SLOT,
  SLOTS,
  type Slot,
  slotSchema,
} from "./modelSlots";

/**
 * When an allowance comes back, in the words every reader shows it: the
 * time on the same day ("resets 1:10pm"), else the day ("resets Fri"). The
 * one formatter, shared by the usage readings the core builds and the
 * waiting line a card thread derives (docs/card-threads.md).
 */
/** A moment's local time of day the way the allowance words write it: "6pm", "2:30pm". */
export function clockTime(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour12 = hours % 12 || 12;
  const suffix = hours < 12 ? "am" : "pm";
  return minutes === 0
    ? `${hour12}${suffix}`
    : `${hour12}:${String(minutes).padStart(2, "0")}${suffix}`;
}

export function formatResetText(resetsAtMs: number, now: number): string | undefined {
  if (!Number.isFinite(resetsAtMs)) return undefined;
  const reset = new Date(resetsAtMs);
  const nowDate = new Date(now);
  if (reset.toDateString() === nowDate.toDateString()) return `resets ${clockTime(resetsAtMs)}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return `resets ${days[reset.getDay()]}`;
}

/**
 * Quota views (decision D-7): percent remaining, pace, and resets with
 * visible staleness and no live-accuracy guarantee. Filled from Infinitary's
 * own provider fetches using managed keys.
 */

export const quotaWindowViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  percentRemaining: z.number().optional(),
  /**
   * Pace vocabulary follows quota-axi: "ahead" is usage ahead of the reset
   * clock (burning faster than linear - conserve), "behind" is usage behind
   * the clock (allowance on track to go unused).
   */
  pace: z.enum(["ahead", "on_pace", "behind", "unknown"]).optional(),
  resetText: z.string().optional(),
  /**
   * The trusted cycle evidence (quota-axi parity): the window's own reset
   * instant and cycle length, when the vendor supplied them. Everything
   * derived - pace, runway, spend priority - is recomputed from these at
   * read time rather than persisted, so a stored snapshot never carries a
   * stale projection.
   */
  resetsAtMs: z.number().optional(),
  startsAtMs: z.number().optional(),
  windowSeconds: z.number().optional(),
});
export type QuotaWindowView = z.infer<typeof quotaWindowViewSchema>;

export const quotaProviderViewSchema = z.object({
  /** Quota provider id: codex, grok, claude, copilot. */
  provider: z.string(),
  label: z.string(),
  /**
   * The vault account these windows belong to (broker phase 2). Absent only
   * in legacy fixtures/snapshots, which render as a single unnamed account.
   */
  accountId: z.string().optional(),
  /** The account's user label ("Personal", "Work #2"). */
  accountLabel: z.string().optional(),
  plan: z.string().optional(),
  /** Provider-reported identity (an email or org), when the fetch knows it. */
  account: z.string().optional(),
  /**
   * What the sensor actually established, kept distinct so the surface can
   * say it (quota reliability, 2026-09-04):
   * - `ok` a real reading,
   * - `auth_required` the terminal re-auth state (CD-3): reached only from
   *   proof - a lapsed refresh token (`refresh_token_lapsed`) or a vendor
   *   rejection that SURVIVED a real renewal (`rejected_after_renewal`).
   *   The ONLY status that may say "sign in again", raise the re-auth card,
   *   or clear a recovered card. Transient failures never take this shape,
   * - `rate_limited` the vendor asked us to back off (`retryAfter` when given),
   * - `unavailable` we could not find out this time (network, timeout, a
   *   non-2xx, an unreadable store, a renewal that could not run). Transient
   *   by assumption; last-known-good survives it,
   * - `not_measured` Infinitary does not read a usage window for this sign-in.
   *   NOT a claim that the credential cannot expose one,
   * - `skipped` the account was not sensed on this pass.
   * `error` remains only so older persisted snapshots still parse.
   */
  status: z.enum([
    "ok",
    "auth_required",
    "rate_limited",
    "unavailable",
    "not_measured",
    "error",
    "skipped",
  ]),
  stale: z.boolean(),
  /**
   * When these windows were actually measured. Present whenever a row is
   * carried forward, so a stale card can state its age instead of borrowing
   * the new snapshot's fetch time.
   */
  measuredAt: z.number().optional(),
  /**
   * A sanitized machine reason for a non-ok status: a code from our own
   * vocabulary, never provider text, never a header, never a URL.
   */
  reason: z.string().optional(),
  /** RFC 9110 Retry-After, as the vendor sent it, when it sent one. */
  retryAfter: z.string().optional(),
  windows: z.array(quotaWindowViewSchema),
  /**
   * Disclosed uncertainty, in the user's words, for a row with no window.
   * The surface renders it instead of a silent blank, and it is never a
   * substitute for a real window. It says what Infinitary did or did not do -
   * never that a credential is incapable of exposing usage, which no test
   * here has established.
   */
  detail: z.string().optional(),
});
export type QuotaProviderView = z.infer<typeof quotaProviderViewSchema>;

/**
 * Why a Claude Keychain VALUE read failed. Machine vocabulary for `reason`;
 * the user-facing `detail` is KEYCHAIN_VALUE_FAILURE_DETAIL. Never rendered
 * as "Keychain" - that word is machinery; the person's word is "saved
 * passwords", and the credential inside is "your sign-in" (the vocabulary).
 *
 * Captain decision D-3 / Option B (2026-09-09): a declined or failed value
 * read is a visible, retryable meter failure, never a process-lifetime poison.
 */
export const KEYCHAIN_VALUE_FAILURES = [
  "keychain_locked",
  "keychain_access_denied",
  "keychain_prompt_timeout",
  "keychain_unavailable",
  "keychain_unreadable",
  "keychain_needs_grant",
  "keychain_no_interactive_session",
  "keychain_read_incomplete",
] as const;
/**
 * The status the host reports when a read through Apple's tool ran out of
 * time or failed: not an OSStatus, and not a refusal. The read is simply tried
 * again on the next refresh.
 */
export const KEYCHAIN_READ_INCOMPLETE_CODE = -1;
export type KeychainValueFailure = (typeof KEYCHAIN_VALUE_FAILURES)[number];

/**
 * "Always Allow" is the whole difference between asking once and asking every
 * time: it writes the app into the item's access list, and every later read is
 * silent. Say the words the macOS dialog uses, on every failure a grant fixes -
 * and only there: a locked store is not a missing grant, no "Always Allow"
 * appears for it, and Retry asks macOS to unlock it with the person's password.
 */
export const KEYCHAIN_VALUE_FAILURE_DETAIL: Record<KeychainValueFailure, string> = {
  keychain_locked:
    "macOS has locked your saved passwords. Retry, then enter your password to unlock them.",
  keychain_access_denied:
    "macOS didn't allow reading your sign-in. Retry, then choose Always Allow so it only asks once.",
  keychain_prompt_timeout:
    "The permission prompt timed out. Retry, then choose Always Allow so it only asks once.",
  keychain_unavailable: "This account's sign-in couldn't be read. Retry to try again.",
  keychain_unreadable: "This account's sign-in couldn't be read. Retry to try again.",
  keychain_needs_grant:
    "macOS needs your permission to read your sign-in. Retry, then choose Always Allow so it only asks once.",
  keychain_no_interactive_session:
    "Infinitary was started where macOS can't ask for your saved passwords. Relaunch it from the Dock, then Retry and allow the read.",
  keychain_read_incomplete:
    "Reading your sign-in didn't finish this time. Infinitary tries again on the next refresh.",
};

const ASKS_THERE =
  "Infinitary can't read this allowance there: macOS asks before it may read your sign-in, and nobody may be at that screen to answer.";
const UNREADABLE_THERE =
  "Your sign-in there couldn't be read. Infinitary tries again in a few minutes.";

/**
 * The same failures on a computer that runs work, drawn at the home in that
 * computer's group (docs/helper.md, "Its own sign-ins"). That computer never
 * lets macOS ask - nobody may be at its screen to answer - so there is no
 * Retry and no Always Allow to choose: each says why the allowance is not
 * read there, and the computer reads again on its own clock.
 */
export const KEYCHAIN_VALUE_FAILURE_THERE: Record<KeychainValueFailure, string> = {
  keychain_locked:
    "macOS has locked the saved passwords there. Infinitary reads this allowance again once they are unlocked.",
  keychain_access_denied:
    "macOS there didn't let Infinitary read your sign-in, so this allowance isn't read.",
  keychain_prompt_timeout: ASKS_THERE,
  keychain_unavailable: UNREADABLE_THERE,
  keychain_unreadable: UNREADABLE_THERE,
  keychain_needs_grant: ASKS_THERE,
  keychain_no_interactive_session: ASKS_THERE,
  keychain_read_incomplete: UNREADABLE_THERE,
};

export function isKeychainValueFailure(reason: string | undefined): reason is KeychainValueFailure {
  return reason !== undefined && (KEYCHAIN_VALUE_FAILURES as readonly string[]).includes(reason);
}

export const quotaSnapshotViewSchema = z.object({
  generatedAt: z.string(),
  fetchedAt: z.number(),
  providers: z.array(quotaProviderViewSchema),
});
export type QuotaSnapshotView = z.infer<typeof quotaSnapshotViewSchema>;

/**
 * Slot names still ride routing_decisions.bucket, difficulty, and quota-gate
 * refs. The catalog itself no longer stamps a per-model intelligence tier;
 * the user's slot record supplies that (src/shared/modelSlots.ts).
 */
export const catalogModelViewSchema = z.object({
  /** Quota provider id. */
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  effectivePercentRemaining: z.number().optional(),
  paceStatus: z.enum(["ahead", "on_pace", "behind", "unknown"]).optional(),
  /**
   * The per-scope selection signal, quota-axi semantics: positive means paid
   * allowance is on track to reach reset unused (spend here first), zero is
   * exact utilization, negative is overdrawn against the reset clock.
   * Absent means unmeasurable - never rendered or ranked as zero.
   */
  spendPriority: z.number().optional(),
  /**
   * Whether every window bounding this scope is projected, at its observed
   * burn, to last until its reset (INF-898): true lasts, false runs out
   * first (or is spent). Absent means the runway is unknown.
   */
  lastsThroughReset: z.boolean().optional(),
});
export type CatalogModelView = z.infer<typeof catalogModelViewSchema>;

/**
 * Models in spend-priority order for routing (highest reclaimable allowance
 * first, quota-axi ranking semantics), with remaining-quota runway order as
 * the fallback among models whose signal is unmeasurable.
 */
export const modelsCatalogViewSchema = z.object({
  generatedAt: z.string(),
  models: z.array(catalogModelViewSchema),
});
export type ModelsCatalogView = z.infer<typeof modelsCatalogViewSchema>;

export const modelPinSchema = z.object({ provider: z.string(), id: z.string() });
export type ModelPin = z.infer<typeof modelPinSchema>;

/** A Pi provider/model pair, as Pi resolves it (not quota provider ids). */
export const piModelRefViewSchema = z.object({ provider: z.string(), id: z.string() });
export type PiModelRefView = z.infer<typeof piModelRefViewSchema>;

export const routingSettingsSchema = z.object({
  dynamicRouting: z.boolean(),
  pins: z.array(modelPinSchema),
});
export type RoutingSettings = z.infer<typeof routingSettingsSchema>;

/**
 * Quota provider ids to provider ids: routing needs both worlds (slots and
 * runway come from quota fetches, availability and sessions from the account's
 * own backend). Claude is here too - a broker-managed subscription with its
 * own backend, even though Pi never serves it. Read it only through the
 * functions below.
 */
export const QUOTA_TO_PI_PROVIDER: Readonly<Record<string, string>> = {
  codex: "openai-codex",
  grok: "xai",
  claude: "anthropic-claude",
  kimi: "kimi-coding",
  copilot: "github-copilot",
  antigravity: "google-antigravity",
};

/**
 * The provider id a served model carries for one the allowance catalog or a
 * pin names (`claude` is `anthropic-claude`, `codex` is `openai-codex`,
 * `grok` is `xai`, `copilot` is `github-copilot`); any other id, a served one included, is its own. A place
 * that forgets this drops every Claude, Codex and Grok model without a word
 * (FI3-1783), so the translation lives here alone.
 */
export function servedProviderOf(provider: string): string {
  return isAllowanceProvider(provider) ? (QUOTA_TO_PI_PROVIDER[provider] ?? provider) : provider;
}

/** Whether the allowance catalog names a provider by this id (`claude`, `codex`, `grok`, `copilot`). */
export function isAllowanceProvider(provider: string): boolean {
  return Object.hasOwn(QUOTA_TO_PI_PROVIDER, provider);
}

/**
 * The allowance catalog's provider id for a served one (`anthropic-claude`
 * is `claude`); undefined for a provider whose allowance nobody reads
 * (OpenRouter).
 */
export function allowanceProviderOf(provider: string): string | undefined {
  return Object.keys(QUOTA_TO_PI_PROVIDER).find((id) => QUOTA_TO_PI_PROVIDER[id] === provider);
}

/**
 * The `provider/id` key a model is compared by, in served names whichever
 * name it arrives in: every comparison between an allowance catalog row or
 * a pin and a served model goes through this, on both sides.
 */
export function servedModelKey(model: { provider: string; id: string }): `${string}/${string}` {
  return `${servedProviderOf(model.provider)}/${model.id}`;
}

/**
 * Whether Infinitary reads an allowance for this provider id. Sensed providers
 * (Codex, Grok, Claude, Kimi Code, Copilot) get a pending "reading…" row until the first
 * sensor pass lands; everyone else (OpenRouter today) keeps the no-reader
 * sentence. Matches the sensor's own catalog (`QUOTA_PROVIDERS` in core).
 */
export function isSensedProvider(providerId: string): boolean {
  return allowanceProviderOf(providerId) !== undefined;
}
