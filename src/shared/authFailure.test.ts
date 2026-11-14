import { describe, expect, it } from "vitest";
import {
  classifyClaudeSignal,
  isAuthFailureMessage,
  isLapsedRefresh,
  isOutOfCreditsRefusal,
} from "./authFailure";

describe("isAuthFailureMessage", () => {
  it("flags a provider-reported 401/403 in Pi's error shapes", () => {
    // formatProviderError "<status>: <body>" (REPRO A's exact shape).
    expect(
      isAuthFailureMessage(
        '401: {"message":"Incorrect API key provided: mock-key...","type":"invalid_request_error","code":"invalid_api_key"}',
      ),
    ).toBe(true);
    expect(isAuthFailureMessage('403: {"error":"account disabled"}')).toBe(true);
    // formatProviderError "<prefix> (<status>): <body>".
    expect(isAuthFailureMessage("openai (401): request rejected")).toBe(true);
    // SDK messages that carry the status inline.
    expect(isAuthFailureMessage("401 Unauthorized")).toBe(true);
    expect(isAuthFailureMessage("Request failed with status code 401")).toBe(true);
    expect(isAuthFailureMessage("Error Code 403: Forbidden")).toBe(true);
    expect(isAuthFailureMessage("401 unauthorized: credential expired")).toBe(true);
  });

  it("flags well-known provider auth error codes and reason phrases", () => {
    expect(isAuthFailureMessage("provider says invalid_api_key")).toBe(true);
    expect(isAuthFailureMessage('{"type":"authentication_error"}')).toBe(true);
    expect(isAuthFailureMessage("UNAUTHENTICATED: request not authenticated")).toBe(true);
    expect(isAuthFailureMessage("oauth refresh failed: invalid_grant")).toBe(true);
    expect(isAuthFailureMessage("Unauthorized")).toBe(true);
    expect(isAuthFailureMessage("Forbidden")).toBe(true);
  });

  it("flags Pi's own pre-flight credential failures", () => {
    expect(isAuthFailureMessage("No API key found for xai.\n\nUse /login to log in.")).toBe(true);
    expect(isAuthFailureMessage("No API key for xai/grok-4.6")).toBe(true);
    expect(
      isAuthFailureMessage(
        'Authentication failed for "openai-codex". Credentials may have expired or network is unavailable. ' +
          "Run '/login openai-codex' to re-authenticate.",
      ),
    ).toBe(true);
  });

  it("never flags the report's real false positives or other transient faults", () => {
    // xAI's transient error is literally spelled with "token" - the word
    // lottery that badged the captain's healthy sessions.
    expect(isAuthFailureMessage("Error Code null: Internal error during token generation")).toBe(
      false,
    );
    // A tool error echoing source code that contains "auth" inside
    // "authoritative" (and, for good measure, a bare 401 in an identifier).
    expect(
      isAuthFailureMessage(
        'Validation failed for tool "edit":\n  - oldText: Expected string\n\nReceived arguments:\n' +
          '{"oldText":"/** The authoritative crew registry (grok-401-beta) */"}',
      ),
    ).toBe(false);
    expect(isAuthFailureMessage("Connection error.")).toBe(false);
    expect(
      isAuthFailureMessage("OpenAI Responses stream ended before a terminal response event"),
    ).toBe(false);
    expect(isAuthFailureMessage("This operation was aborted")).toBe(false);
    expect(isAuthFailureMessage("model overloaded, retry later")).toBe(false);
    // English words that fed the old substring match carry no signal alone.
    expect(isAuthFailureMessage("refresh token expired")).toBe(false);
    expect(isAuthFailureMessage("the author of this commit is unknown")).toBe(false);
    expect(isAuthFailureMessage("sign in sheet processing complete")).toBe(false);
  });
});

describe("classifyClaudeSignal", () => {
  const failedResult = { resultSubtype: "success", isError: true } as const;

  it.each([
    [
      "a sign-in the provider no longer accepts",
      { ...failedResult, assistantError: "authentication_failed" },
      { kind: "cut-off", cutOff: { class: "signed_out" } },
    ],
    [
      "an API 401",
      { ...failedResult, apiErrorStatus: 401 },
      { kind: "cut-off", cutOff: { class: "signed_out" } },
    ],
    [
      "an organisation that may not use this sign-in here",
      { ...failedResult, assistantError: "oauth_org_not_allowed" },
      { kind: "cut-off", cutOff: { class: "refused" } },
    ],
    [
      "a billing refusal",
      { ...failedResult, assistantError: "billing_error" },
      { kind: "cut-off", cutOff: { class: "refused" } },
    ],
    [
      "a spent allowance with its reset",
      {
        ...failedResult,
        assistantError: "rate_limit",
        rateLimitStatus: "rejected",
        resetsAt: 1_800_000_000_000,
      },
      { kind: "cut-off", cutOff: { class: "no_headroom", resetsAt: 1_800_000_000_000 } },
    ],
    [
      "a rejected reading on a failed turn",
      { ...failedResult, rateLimitStatus: "rejected" },
      { kind: "cut-off", cutOff: { class: "no_headroom" } },
    ],
    [
      "a rejected reading on a turn an API error ended, with no typed error",
      {
        resultSubtype: "error_during_execution",
        isError: true,
        rateLimitStatus: "rejected",
        resetsAt: 7,
      },
      { kind: "cut-off", cutOff: { class: "no_headroom", resetsAt: 7 } },
    ],
  ] as const)("reads %s as a cut-off", (_name, signal, outcome) => {
    expect(classifyClaudeSignal(signal)).toEqual(outcome);
  });

  it("reads a 403 as no proof of a lost sign-in or a refusal", () => {
    // A firewall's block page answers 403, and the client labels it
    // `authentication_failed`: no sign-in changes it, so it takes the retry.
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "authentication_failed",
        apiErrorStatus: 403,
      }),
    ).toEqual({ kind: "turn-failed" });
    expect(classifyClaudeSignal({ ...failedResult, apiErrorStatus: 403 })).toEqual({
      kind: "turn-failed",
    });
    // The client's own refusal word still is a refusal, whatever the status.
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "oauth_org_not_allowed",
        apiErrorStatus: 403,
      }),
    ).toEqual({ kind: "cut-off", cutOff: { class: "refused" } });
    // A 401 beside the sign-in label is the proof.
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "authentication_failed",
        apiErrorStatus: 401,
      }),
    ).toEqual({ kind: "cut-off", cutOff: { class: "signed_out" } });
  });

  it.each([
    "overloaded",
    "server_error",
    "unknown",
    "max_output_tokens",
    "invalid_request",
    "model_not_found",
  ])("reads a %s error as an ordinary failed turn", (assistantError) => {
    expect(classifyClaudeSignal({ ...failedResult, assistantError })).toEqual({
      kind: "turn-failed",
    });
  });

  it.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ])("reads a %s result as a failed turn, never a clean one", (resultSubtype) => {
    expect(classifyClaudeSignal({ resultSubtype, isError: true })).toEqual({ kind: "turn-failed" });
    // The subtype alone says the turn stopped early, whatever is_error says.
    expect(classifyClaudeSignal({ resultSubtype })).toEqual({ kind: "turn-failed" });
  });

  it("reads a turn the client cut short for a steer or an interrupt as the cut, not a failure", () => {
    for (const terminalReason of ["aborted_streaming", "aborted_tools"]) {
      expect(
        classifyClaudeSignal({
          resultSubtype: "error_during_execution",
          isError: true,
          terminalReason,
        }),
      ).toEqual({ kind: "ok" });
    }
    // An API error behind the cut is still news.
    expect(
      classifyClaudeSignal({
        resultSubtype: "success",
        isError: true,
        assistantError: "authentication_failed",
        terminalReason: "aborted_streaming",
      }),
    ).toEqual({ kind: "cut-off", cutOff: { class: "signed_out" } });
    // Any other stop reason on an error result is a failed turn.
    expect(
      classifyClaudeSignal({
        resultSubtype: "error_during_execution",
        isError: true,
        terminalReason: "model_error",
      }),
    ).toEqual({ kind: "turn-failed" });
  });

  it("reads a rate limit without the vendor's rejected reading as an ordinary failed turn", () => {
    // The client types a transient capacity 429 and a switched-off model
    // as `rate_limit` too: only a rejected reading says the allowance is spent.
    expect(classifyClaudeSignal({ ...failedResult, assistantError: "rate_limit" })).toEqual({
      kind: "turn-failed",
    });
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "rate_limit",
        rateLimitStatus: "allowed_warning",
        resetsAt: 1_800_000_000_000,
      }),
    ).toEqual({ kind: "turn-failed" });
  });

  it.each(["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"])(
    "lets a loop that stopped on its own bound (%s) beat a rejected reading",
    (resultSubtype) => {
      // Its requests were answered: the reading it saw on the way is not why
      // it stopped, and holding the allowance would hold a working login.
      expect(
        classifyClaudeSignal({
          resultSubtype,
          isError: true,
          rateLimitStatus: "rejected",
          resetsAt: 7,
        }),
      ).toEqual({ kind: "turn-failed" });
    },
  );

  it("lets a typed error that is not a cut-off beat a rejected reading", () => {
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "overloaded",
        rateLimitStatus: "rejected",
        resetsAt: 1,
      }),
    ).toEqual({ kind: "turn-failed" });
  });

  it("takes whether the turn failed from the result alone", () => {
    // A typed error on a turn whose result answered (a subagent's, recovered
    // from) is not a failure.
    expect(
      classifyClaudeSignal({
        resultSubtype: "success",
        isError: false,
        assistantError: "authentication_failed",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("reads a turn that answered as ok, whatever its pushed reading said", () => {
    expect(classifyClaudeSignal({ resultSubtype: "success", isError: false })).toEqual({
      kind: "ok",
    });
    // A rejected window on a turn that still answered is the quota store's
    // fact, not the turn's.
    expect(
      classifyClaudeSignal({
        resultSubtype: "success",
        isError: false,
        rateLimitStatus: "rejected",
        resetsAt: 1,
      }),
    ).toEqual({ kind: "ok" });
    expect(classifyClaudeSignal({})).toEqual({ kind: "ok" });
  });

  it("lets the sign-in win, then a refusal, when one turn carries several signals", () => {
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "rate_limit",
        rateLimitStatus: "rejected",
        apiErrorStatus: 401,
      }),
    ).toEqual({ kind: "cut-off", cutOff: { class: "signed_out" } });
    expect(
      classifyClaudeSignal({
        ...failedResult,
        assistantError: "oauth_org_not_allowed",
        rateLimitStatus: "rejected",
      }),
    ).toEqual({ kind: "cut-off", cutOff: { class: "refused" } });
  });

  it("classifies from typed fields only, never from a status that is not one", () => {
    // A 429 or 500 status is not a cut-off class on its own.
    expect(classifyClaudeSignal({ ...failedResult, apiErrorStatus: 429 })).toEqual({
      kind: "turn-failed",
    });
    expect(classifyClaudeSignal({ ...failedResult, apiErrorStatus: 500 })).toEqual({
      kind: "turn-failed",
    });
  });
});

// INF-443 piece 1: only xAI's 402 is the typed fact "credits are spent".
describe("isOutOfCreditsRefusal", () => {
  it("reads xAI's 402 from where Pi's error puts the status", () => {
    // pi-ai's formatProviderError "<prefix> (<status>): <body>".
    expect(
      isOutOfCreditsRefusal(
        "xai",
        "xai API error (402): Your team has either used all available credits or reached its monthly spending limit.",
      ),
    ).toBe(true);
    expect(isOutOfCreditsRefusal("xai", "402: payment required")).toBe(true);
  });

  it("leaves every other provider, status and mention of 402 an ordinary failure", () => {
    // OpenRouter's 402 can be about one oversized request.
    expect(isOutOfCreditsRefusal("openrouter", "402: This request requires more credits")).toBe(
      false,
    );
    expect(isOutOfCreditsRefusal(undefined, "xai API error (402): out of credits")).toBe(false);
    expect(isOutOfCreditsRefusal("xai", "xai API error (403): forbidden")).toBe(false);
    expect(isOutOfCreditsRefusal("xai", "xai API error (429): too many requests")).toBe(false);
    // The words alone are not the status.
    expect(isOutOfCreditsRefusal("xai", "Error: a 402 appeared in a tool's output")).toBe(false);
  });
});

// INF-560: an old Kimi Code account's row says sign in again once its
// refresh token has lapsed. The messages are Pi 1.1.0's own, as its
// ModelsError wraps each provider's refresh failure.
describe("isLapsedRefresh", () => {
  it("reads a refresh the provider's sign-in server refused", () => {
    expect(
      isLapsedRefresh(
        "oauth",
        "OAuth refresh failed for kimi-coding: Kimi Code token refresh unauthorized (status 401): The refresh token is invalid or expired",
      ),
    ).toBe(true);
    expect(
      isLapsedRefresh(
        "oauth",
        'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {"error":"invalid_grant"}',
      ),
    ).toBe(true);
  });

  it("leaves a busy server, a 403 and any other kind of failure unproven", () => {
    expect(
      isLapsedRefresh(
        "oauth",
        "OAuth refresh failed for kimi-coding: Kimi Code token refresh failed with status 503",
      ),
    ).toBe(false);
    expect(
      isLapsedRefresh(
        "oauth",
        "OAuth refresh failed for kimi-coding: Kimi Code token refresh unauthorized (status 403)",
      ),
    ).toBe(false);
    expect(
      isLapsedRefresh("auth", "Credential store modify failed for kimi-coding: status 401"),
    ).toBe(false);
    expect(isLapsedRefresh(undefined, "fetch failed")).toBe(false);
  });
});
