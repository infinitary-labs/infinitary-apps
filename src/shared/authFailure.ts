/**
 * Classifies an error as a provider auth failure (needs sign-in) from real
 * auth signal only. Exactly two channels produce the strings this sees, and
 * both have known shapes:
 *
 * - Pi's pre-request throws: deterministic texts from agent-session's auth
 *   preflight ("No API key found for <provider>", "No API key for
 *   <provider>/<model>", 'Authentication failed for "<provider>"').
 * - Provider-reported stream errors (assistant `stopReason: "error"`):
 *   pi-ai's formatProviderError renders "<status>: <body>" or
 *   "<prefix> (<status>): <body>", or passes through an SDK message that
 *   leads with the status; bodies carry machine error codes such as
 *   invalid_api_key.
 *
 * This is the classifier for Pi and for rows recorded as prose. A Claude
 * session reports typed fields, so its outcomes go through
 * `classifyClaudeSignal` below and never through these patterns.
 *
 * Never a loose substring of free-form text (fm3000-devmode-auth-message-s1):
 * a bare "token" alternative matched xAI's transient "Internal error during
 * token generation", and "auth" matched a tool error quoting the word
 * "authoritative". Callers feed this ONLY provider/session errors - never
 * tool output, bash output, or anything that can quote arbitrary text.
 */

/** An HTTP 401/403 in a position Pi's error shapes put a status. */
const STATUS_PATTERNS: readonly RegExp[] = [
  // formatProviderError "<status>: <body>"; SDK messages leading with the status.
  /^\s*40[13]\b/,
  // formatProviderError "<prefix> (<status>): <body>".
  /\(40[13]\)/,
  // "status code 401", "Error Code 403", '"status": 401'.
  /\b(?:status(?:\s+code)?|code)["']?\s*[:=]?\s*["']?40[13]\b/i,
  // "401 Unauthorized" / "403 Forbidden" reason-phrase pairs anywhere.
  /\b40[13]\s+(?:unauthorized|forbidden)\b/i,
];

/** An HTTP 402 in a position Pi's error shapes put a status. */
const PAYMENT_STATUS_PATTERNS: readonly RegExp[] = [
  // formatProviderError "<status>: <body>"; SDK messages leading with the status.
  /^\s*402\b/,
  // formatProviderError "<prefix> (<status>): <body>", as xAI's reads.
  /\(402\)/,
];

/**
 * Whether a Pi provider failure is xAI saying the account's credits are
 * spent: status 402, read from where Pi's error puts the number and never
 * from the words, and only for xAI. Another provider's 402 can be about one
 * oversized request (OpenRouter's), so it stays an ordinary failed turn.
 */
export function isOutOfCreditsRefusal(provider: string | undefined, message: string): boolean {
  return provider === "xai" && PAYMENT_STATUS_PATTERNS.some((pattern) => pattern.test(message));
}

/** HTTP reason phrases: standalone words in provider errors, not prose. */
const REASON_PHRASE_PATTERN = /\b(?:unauthorized|forbidden)\b/i;

/** Provider/OAuth machine error codes that mean the credential is bad. */
const AUTH_CODE_PATTERN =
  /\b(?:invalid_api_key|authentication_error|unauthenticated|permission_denied|permission_error|invalid_grant|invalid_token|token_expired|access_denied)\b/i;

/** Pi's own deterministic pre-flight credential failures (thrown channel). */
const PI_PREFLIGHT_PATTERNS: readonly RegExp[] = [
  /^No API key (?:found )?for /m,
  /^Authentication failed for "/m,
];

/** True when the error carries a real auth signal (needs sign-in). */
export function isAuthFailureMessage(message: string): boolean {
  return (
    STATUS_PATTERNS.some((pattern) => pattern.test(message)) ||
    REASON_PHRASE_PATTERN.test(message) ||
    AUTH_CODE_PATTERN.test(message) ||
    PI_PREFLIGHT_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * A refresh the provider's sign-in server answered 401 or `invalid_grant`,
 * where Pi's refresh errors put them: "(401)", "status 401". A 403 is not
 * here, since a network policy refuses with it too (docs/quota.md).
 */
const REFRESH_REFUSED_PATTERNS: readonly RegExp[] = [
  /\(401\)/,
  /\bstatus(?:\s+code)?\s*[:=]?\s*401\b/i,
  /\binvalid_grant\b/,
];

/**
 * Whether a Pi credential read failed because the provider refused the
 * stored refresh token: the lapsed-refresh-token proof that may say "sign
 * in again" (src/shared/credentialHealth.ts). `code` is the Pi failure's own
 * typed kind, and only its OAuth kind is a refresh at all; a timeout, a
 * network failure or a 5xx is never this.
 */
export function isLapsedRefresh(code: unknown, message: string): boolean {
  return code === "oauth" && REFRESH_REFUSED_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Why a provider stopped serving an account, by class (the cut-off contract,
 * docs/quota.md "Typed cut-offs"). The names are product-neutral, so no
 * provider's own vocabulary crosses the event seam:
 *
 * - `signed_out`: the provider no longer accepts the sign-in.
 * - `no_headroom`: the plan's allowance is spent until `resetsAt`.
 * - `refused`: the provider declines to serve this sign-in here at all.
 */
export const CUT_OFF_CLASSES = ["signed_out", "no_headroom", "refused"] as const;
export type CutOffClass = (typeof CUT_OFF_CLASSES)[number];

/** A typed cut-off. `resetsAt` (epoch ms) rides `no_headroom` when the provider named one. */
export type CutOff = { class: CutOffClass; resetsAt?: number };

/**
 * The typed fields a Claude session reports about one turn, as its own
 * messages carry them (the Agent SDK's `assistant.error`, the result's
 * `subtype` / `is_error` / `api_error_status`, and the pushed rate-limit
 * `status` / `resetsAt`). Never a sentence.
 */
export type ClaudeSignal = {
  /** `SDKAssistantMessageError` on this turn's own (main-thread) assistant message. */
  assistantError?: string;
  /** The result's subtype: `success`, or the `error_*` reason the turn stopped early. */
  resultSubtype?: string;
  /** The result's `is_error`. */
  isError?: boolean;
  /** The HTTP status of the API error that ended the turn, when there was one. */
  apiErrorStatus?: number | null;
  /** The result's `terminal_reason`: why the client's loop stopped. */
  terminalReason?: string;
  /** The latest pushed rate-limit `status` this turn. */
  rateLimitStatus?: string;
  /** That reading's reset, epoch ms; a `rejected` one is when the allowance returns. */
  resetsAt?: number;
  /** That reading's `overageStatus`: whether extra usage answers past the plan window. */
  overageStatus?: string;
};

export type ClaudeOutcome =
  | { kind: "ok" }
  | { kind: "turn-failed" }
  | { kind: "cut-off"; cutOff: CutOff };

/** The typed errors that mean the sign-in is no longer accepted. */
const SIGNED_OUT_ERRORS: ReadonlySet<string> = new Set(["authentication_failed"]);
/** The typed errors that mean the provider declines this sign-in here. */
const REFUSED_ERRORS: ReadonlySet<string> = new Set(["oauth_org_not_allowed", "billing_error"]);
/** The loop stopped because it was cut short: a steer or an interrupt landed. */
const ABORTED_REASONS: ReadonlySet<string> = new Set(["aborted_streaming", "aborted_tools"]);
/**
 * The result subtypes an API error ends a turn with. Every other `error_*`
 * subtype is the loop stopping on a bound of its own (turns, budget,
 * structured-output retries), which it reached with its requests answered.
 */
const API_STOP_SUBTYPES: ReadonlySet<string> = new Set(["success", "error_during_execution"]);

/**
 * The one classifier of a Claude turn's outcome, over typed fields only
 * (the cut-off contract's signal table, docs/quota.md). Whether the turn
 * FAILED is the result's to say (`is_error`, or a subtype other than
 * `success`): a turn that answered is `ok` whatever else it saw - a
 * subagent's error it recovered from, or a pushed quota reading, which is
 * the quota store's fact, not the turn's. A failed turn is a cut-off only
 * when a typed field names one; every other failure (`overloaded`,
 * `server_error`, `max_output_tokens`, an `error_*` result, ...) is an
 * ordinary failed turn, which takes the honest retry.
 *
 * A spent allowance needs the vendor's own word: a `rejected` rate-limit
 * reading in the same turn, and no word in that reading that extra usage
 * still answers (`overageStatus` `allowed` or `allowed_warning`): an
 * account on extra usage keeps working past its plan window, so a turn
 * that failed there failed for another reason. The client also types a transient capacity 429
 * and a model it has switched off as `rate_limit`, so that error alone is
 * an ordinary failure, and a typed error that is not a cut-off beats a
 * reading. So does a loop that stopped on its own bound (`error_max_turns`,
 * ...): its requests were answered, so a reading it saw on the way is not
 * why it stopped, and an allowance held on it would hold a working login.
 *
 * Only proof of a lost sign-in is `signed_out`: a 401, or the client's
 * `authentication_failed` with no status beside it. The client types a 403
 * that way too, and a 403 is also a firewall's block page, which no sign-in
 * changes; so a 403 is never a cut-off on its own - neither a lost sign-in
 * nor a refusal - and takes the honest retry.
 *
 * A turn the client cut short (`terminal_reason` `aborted_*`) with no API
 * error behind it is the cut a steer or an interrupt makes, not a failure:
 * the client can close such a turn with an `error_*` result.
 *
 * When one turn carries several signals, the sign-in wins (a login that is
 * no longer accepted explains everything after it), then a refusal, then a
 * spent allowance.
 */
export function classifyClaudeSignal(signal: ClaudeSignal): ClaudeOutcome {
  const failed =
    signal.isError === true ||
    (signal.resultSubtype !== undefined && signal.resultSubtype !== "success");
  if (!failed) return { kind: "ok" };
  const error = signal.assistantError;
  const apiError = error !== undefined || typeof signal.apiErrorStatus === "number";
  if (!apiError && signal.terminalReason && ABORTED_REASONS.has(signal.terminalReason)) {
    return { kind: "ok" };
  }
  // The client types every 401 and every 403 it gets as
  // `authentication_failed`, and a 403 is also how a firewall in front of
  // the API refuses (a block page). So the typed error is proof of a lost
  // sign-in only where no status says otherwise: beside a 403 it is not.
  const status = typeof signal.apiErrorStatus === "number" ? signal.apiErrorStatus : undefined;
  const signInError = error !== undefined && SIGNED_OUT_ERRORS.has(error);
  if (status === 401 || (signInError && status === undefined)) {
    return { kind: "cut-off", cutOff: { class: "signed_out" } };
  }
  // A refusal needs the client's own word for one; a bare 403 is not it.
  if (error && REFUSED_ERRORS.has(error)) {
    return { kind: "cut-off", cutOff: { class: "refused" } };
  }
  const onExtraUsage =
    signal.overageStatus === "allowed" || signal.overageStatus === "allowed_warning";
  const rejected = signal.rateLimitStatus === "rejected" && !onExtraUsage;
  const apiStop = signal.resultSubtype === undefined || API_STOP_SUBTYPES.has(signal.resultSubtype);
  if (rejected && apiStop && (error === undefined || error === "rate_limit")) {
    return {
      kind: "cut-off",
      cutOff: {
        class: "no_headroom",
        ...(signal.resetsAt !== undefined ? { resetsAt: signal.resetsAt } : {}),
      },
    };
  }
  return { kind: "turn-failed" };
}
