import type { AccountView } from "@shared/accounts";
import {
  CLAUDE_ACCESS_ALLOWANCE_TEXT,
  CLAUDE_ACCESS_LABEL,
  CLAUDE_ACCESS_REFUSED_TEXT,
  CLAUDE_ACCESS_TRY_AGAIN_LABEL,
  CLAUDE_GATEWAY_LABEL,
} from "@shared/claudeAccess";
import { CLAUDE_CLIENT_MISSING_TEXT, claudeClientOutdatedText } from "@shared/claudeClient";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { QuotaProviderView } from "@shared/quota";
import { KEYCHAIN_VALUE_FAILURE_DETAIL } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { firstmateAccountChoices, rowView } from "./SubscriptionsTab";
import { SUBSCRIPTIONS_WORDS } from "./subscriptionsWords";

const account: AccountView = {
  id: "acct_cl1",
  providerId: "anthropic-claude",
  kind: "subscription_oauth",
  label: "Personal",
  enabled: true,
  connected: true,
  pinned: false,
  createdAt: 1,
};

describe("Subscriptions rowView: Keychain VALUE refusal", () => {
  it("shows the sensor's reason as a retryable failure, never a meter and never sign-in", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_access_denied",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied,
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("unavailable");
    expect(view.stateText).toBe(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied);
    expect(view.retry).toBe(true);
    expect(view.signIn).toBe(false);
    expect(view.meters).toEqual([]);
  });

  it("a locked store tells the truth: locked, and Retry asks to unlock it", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_locked",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_locked,
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.retry).toBe(true);
    expect(view.signIn).toBe(false);
    expect(view.stateText).toBe(
      "macOS has locked your saved passwords. Retry, then enter your password to unlock them.",
    );
    // No grant dialog appears for a locked store, and the machinery word
    // stays off Settings (phase5-quota.spec.ts).
    expect(view.stateText).not.toMatch(/Always Allow|keychain/i);
  });

  it("the grant refusal keeps its Always Allow instruction", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_access_denied",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied,
      stale: false,
      windows: [],
    };
    expect(rowView(account, row, Date.now()).stateText).toMatch(/Retry, then choose Always Allow/);
  });

  it("keeps last-known-good meters with a Retry when the refresh was a Keychain refusal", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_access_denied",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied,
      stale: true,
      measuredAt: Date.now() - 3_600_000,
      windows: [{ id: "session", label: "session", percentRemaining: 74, pace: "behind" }],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("stale");
    expect(view.retry).toBe(true);
    expect(view.meters[0]?.percent).toBe(74);
    expect(view.signIn).toBe(false);
    expect(view.stateText).toBe(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied);
  });

  it("a terminal auth_required row keeps the Sign in CTA, even with last-known-good windows", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "auth_required",
      reason: "rejected_after_renewal",
      stale: true,
      measuredAt: Date.now() - 3_600_000,
      windows: [{ id: "session", label: "session", percentRemaining: 74, pace: "behind" }],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("auth");
    expect(view.signIn).toBe(true);
    expect(view.retry).toBe(false);
    expect(view.stateText).toBe("Sign in again to see your allowance.");
    expect(view.meters).toEqual([]);
  });

  it("local needsReauth proof is the same CTA, even before a quota row lands", () => {
    const view = rowView({ ...account, needsReauth: true }, undefined, Date.now());
    expect(view.kind).toBe("auth");
    expect(view.signIn).toBe(true);
    expect(view.retry).toBe(false);
    expect(view.stateText).toBe("Sign in again to see your allowance.");
    expect(view.dot).toBe("danger");
    expect(view.stateTone).toBe("danger");
  });

  it("a no-interactive-session failure is retryable and never a re-auth CTA", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_no_interactive_session",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_no_interactive_session,
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("unavailable");
    expect(view.stateText).toBe(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_no_interactive_session);
    expect(view.retry).toBe(true);
    expect(view.signIn).toBe(false);
  });

  it("a missing grant is retryable and says the words the macOS dialog uses", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_needs_grant",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_needs_grant,
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("unavailable");
    expect(view.retry).toBe(true);
    expect(view.signIn).toBe(false);
    // "Always Allow" is the difference between asking once and asking every
    // launch, so the row has to name the button rather than just say Retry.
    expect(view.stateText).toContain("Always Allow");
  });

  it("an unreadable store is retryable and never a re-auth CTA", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "unavailable",
      reason: "keychain_unreadable",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_unreadable,
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("unavailable");
    expect(view.retry).toBe(true);
    expect(view.signIn).toBe(false);
  });
});

describe("Subscriptions rowView: the machine has no Claude Code (F14)", () => {
  it("shows the backend's sentence with a not-ready dot, and neither a meter nor a sign-in", () => {
    const missing: AccountView = { ...account, detail: CLAUDE_CLIENT_MISSING_TEXT };
    const view = rowView(missing, undefined, Date.now());
    expect(view.stateText).toBe(CLAUDE_CLIENT_MISSING_TEXT);
    expect(view.dot).toBe("warn");
    expect(view.dotLabel).toBe("not ready");
    expect(view.signIn).toBe(false);
    expect(view.retry).toBe(false);
    expect(view.meters).toEqual([]);
    expect(view.stateTone).toBeUndefined();
  });

  it("keeps the sentence over a quota reading, because the remedy is the client, not the meter", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: "acct_cl1",
      status: "ok",
      stale: false,
      windows: [],
    };
    const outdated = claudeClientOutdatedText("2.1.100", "2.1.234");
    const view = rowView({ ...account, detail: outdated }, row, Date.now());
    expect(view.stateText).toBe(outdated);
    expect(view.meters).toEqual([]);
  });

  it("gives a sign-out precedence: a disconnected row is first-run copy, not the client sentence", () => {
    const view = rowView(
      { ...account, connected: false, detail: CLAUDE_CLIENT_MISSING_TEXT },
      undefined,
      Date.now(),
    );
    expect(view.kind).toBe("disconnected");
    expect(view.stateText).toBe(SUBSCRIPTIONS_WORDS.claudeFirstRun);
  });
});

describe("Subscriptions rowView: Claude first-run", () => {
  const unsigned: AccountView = { ...account, connected: false };

  it("treats a missing Claude login as first-run, not a failed re-auth", () => {
    const view = rowView(unsigned, undefined, Date.now());
    expect(view.kind).toBe("disconnected");
    expect(view.stateText).toBe(SUBSCRIPTIONS_WORDS.claudeFirstRun);
    expect(view.signIn).toBe(true);
    expect(view.stateTone).toBeUndefined();
    expect(view.dot).toBe("ring");
    expect(view.dotLabel).toBe("not signed in yet");
    expect(view.meters).toEqual([]);
  });

  it("keeps a disconnected non-Claude row as sign-in-again", () => {
    const other: AccountView = { ...unsigned, providerId: "openrouter" };
    const view = rowView(other, undefined, Date.now());
    expect(view.stateText).toBe("Sign in again.");
    expect(view.stateTone).toBe("danger");
    expect(view.signIn).toBe(true);
    expect(view.dot).toBe("danger");
  });
});

describe("Subscriptions rowView: pending first read vs no reader", () => {
  const NO_READER = "API key set · Infinitary doesn't read the allowance for this provider.";

  it("a sensed provider with no snapshot row yet is reading, never the no-reader sentence", () => {
    for (const providerId of ["openai-codex", "xai", "anthropic-claude"] as const) {
      const sensed: AccountView = {
        ...account,
        id: `acct_${providerId}`,
        providerId,
        kind: providerId === "xai" ? "api_key" : "subscription_oauth",
      };
      const view = rowView(sensed, undefined, Date.now());
      expect(view.kind).toBe("pending");
      expect(view.stateText).toBe("reading…");
      expect(view.dot).toBe("ring");
      expect(view.dotLabel).toMatch(/reading…$/);
      expect(view.stateText).not.toContain("doesn't read the allowance");
      expect(view.meters).toEqual([]);
      expect(view.signIn).toBe(false);
    }
  });

  it("OpenRouter with no row keeps the no-reader sentence", () => {
    const openrouter: AccountView = {
      ...account,
      id: "acct_or",
      providerId: "openrouter",
      kind: "api_key",
    };
    const view = rowView(openrouter, undefined, Date.now());
    expect(view.kind).toBe("no_row");
    expect(view.stateText).toBe(NO_READER);
    expect(view.dotLabel).toBe("API key set · no allowance reading");
  });

  it("a failed first read leaves pending and uses the sensor's own status", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      accountId: account.id,
      status: "unavailable",
      reason: "network",
      detail: "Your allowance couldn't be read just now.",
      stale: false,
      windows: [],
    };
    const view = rowView(account, row, Date.now());
    expect(view.kind).toBe("unavailable");
    expect(view.stateText).toBe("Your allowance couldn't be read just now.");
    expect(view.stateText).not.toBe("reading…");
  });
});

describe("Firstmate account choices", () => {
  const codex = (id: string, label: string, extra: Partial<AccountView> = {}): AccountView => ({
    ...account,
    id,
    providerId: "openai-codex",
    label,
    ...extra,
  });
  const noRow = () => undefined;

  it("lists only the accounts of the provider Firstmate answers with, in the list's order", () => {
    const accounts = [
      codex("acct_cx1", "Personal"),
      account,
      codex("acct_cx2", "Work", { pinned: true }),
    ];
    expect(firstmateAccountChoices(accounts, "openai-codex", noRow, Date.now())).toEqual([
      { id: "acct_cx1", label: "Personal" },
      { id: "acct_cx2", label: "Work" },
    ]);
  });

  it("offers no choice for a provider with one account, or before Firstmate has one", () => {
    const accounts = [codex("acct_cx1", "Personal"), account];
    expect(firstmateAccountChoices(accounts, "openai-codex", noRow, Date.now())).toEqual([]);
    expect(firstmateAccountChoices(accounts, "anthropic-claude", noRow, Date.now())).toEqual([]);
    expect(firstmateAccountChoices(accounts, undefined, noRow, Date.now())).toEqual([]);
  });

  it("offers no choice unless two accounts can answer, however many are listed", () => {
    const accounts = [
      codex("acct_cx1", "Personal"),
      codex("acct_cx2", "Old team", { enabled: false }),
      codex("acct_cx3", "Lapsed", { needsReauth: true }),
    ];
    expect(firstmateAccountChoices(accounts, "openai-codex", noRow, Date.now())).toEqual([]);
    // Old team resumed: two can answer, and the lapsed one stays listed.
    const resumed = accounts.map((entry) =>
      entry.id === "acct_cx2" ? { ...entry, enabled: true } : entry,
    );
    expect(
      firstmateAccountChoices(resumed, "openai-codex", noRow, Date.now()).map((choice) => [
        choice.id,
        choice.unavailable,
      ]),
    ).toEqual([
      ["acct_cx1", undefined],
      ["acct_cx2", undefined],
      ["acct_cx3", "sign in again"],
    ]);
  });

  it("keeps an account that cannot run Firstmate listed, with its row's word for why", () => {
    const accounts = [
      codex("acct_cx1", "Personal"),
      codex("acct_cx2", "Old team", { enabled: false }),
      codex("acct_cx3", "Lapsed", { needsReauth: true }),
      codex("acct_cx4", "Signed out", { connected: false }),
      codex("acct_cx5", "No client", { detail: "Something it needed is missing on this Mac." }),
      codex("acct_cx6", "Work"),
    ];
    const rejected: QuotaProviderView = {
      provider: "codex",
      label: "Codex",
      accountId: "acct_cx1",
      status: "auth_required",
      stale: false,
      windows: [],
    };
    const choices = firstmateAccountChoices(accounts, "openai-codex", noRow, Date.now());
    expect(choices.map((choice) => [choice.label, choice.unavailable])).toEqual([
      ["Personal", undefined],
      ["Old team", "paused"],
      ["Lapsed", "sign in again"],
      ["Signed out", "sign in again"],
      ["No client", "not ready"],
      ["Work", undefined],
    ]);
    // The vendor's own refusal of a sign-in counts the same as local proof,
    // which leaves one account that can answer: no choice.
    const read = firstmateAccountChoices(
      accounts,
      "openai-codex",
      (entry) => (entry.id === "acct_cx1" ? rejected : undefined),
      Date.now(),
    );
    expect(read).toEqual([]);
  });
});

describe("Subscriptions rowView: scope forecasts", () => {
  const now = 1_800_000_000_000;
  const hour = 3600_000;
  const modelWindow = {
    id: "model:opus",
    label: "Opus",
    percentRemaining: 90,
    resetsAtMs: now + hour / 2,
    windowSeconds: 3600,
  };
  const view = (windows: QuotaProviderView["windows"], extra: Partial<QuotaProviderView> = {}) =>
    rowView(
      account,
      {
        provider: "claude",
        label: "Claude",
        status: "ok",
        stale: false,
        windows,
        ...extra,
      },
      now,
    );

  it("never warns of model-only exhaustion beyond or exactly at reset", () => {
    for (const percentRemaining of [90, 50, 100]) {
      expect(view([{ ...modelWindow, percentRemaining }]).verdict).toEqual({
        text: "on pace",
        tone: "ok",
      });
    }
  });

  it("still warns of exhaustion before reset and an already empty model scope", () => {
    expect(view([{ ...modelWindow, percentRemaining: 10 }]).verdict).toEqual({
      text: "empty in 3m",
      tone: "danger",
    });
    expect(view([{ ...modelWindow, percentRemaining: 0 }]).verdict).toEqual({
      text: "empty now",
      tone: "danger",
    });
  });

  it("never bypasses an unread or unmeasurable account-wide bound", () => {
    for (const missing of [
      { id: "session", label: "session" },
      { id: "session", label: "session", percentRemaining: 95 },
      {
        id: "session",
        label: "session",
        percentRemaining: 95,
        resetsAtMs: now - 1,
        windowSeconds: 3600,
      },
    ]) {
      for (const percentRemaining of [90, 10]) {
        const readable = { ...modelWindow, percentRemaining };
        expect(view([missing, readable]).verdict).toBeUndefined();
        expect(view([missing, { ...readable, id: "weekly" }]).verdict).toBeUndefined();
      }
    }
  });

  it("keeps the account-wide scope authoritative and excludes extra usage", () => {
    expect(
      view([
        { ...modelWindow, id: "session" },
        { ...modelWindow, percentRemaining: 10 },
      ]).verdict,
    ).toEqual({ text: "on pace ✓", tone: "ok" });
    expect(
      view([{ ...modelWindow, id: "extra_usage", percentRemaining: 0 }]).verdict,
    ).toBeUndefined();
  });

  it("selects the lowest model scope without ignoring its other bounds", () => {
    const lower = { ...modelWindow, id: "model:fable", percentRemaining: 10 };
    expect(view([modelWindow, lower]).verdict).toEqual({ text: "empty in 3m", tone: "danger" });
    expect(view([lower, modelWindow]).verdict).toEqual({ text: "empty in 3m", tone: "danger" });
    const unread = { id: "model:fable:1h", label: "Fable" };
    expect(view([modelWindow, lower, unread]).verdict).toBeUndefined();
    expect(view([unread, modelWindow, lower]).verdict).toBeUndefined();
  });

  it("allows an untriggered scope but derives nothing from a stale or expired reading", () => {
    expect(view([{ id: "model:opus", label: "Opus", percentRemaining: 100 }]).verdict).toEqual({
      text: "on pace",
      tone: "ok",
    });
    expect(view([{ ...modelWindow, resetsAtMs: now }]).verdict).toBeUndefined();
    expect(view([modelWindow], { stale: true, measuredAt: now - hour }).verdict).toEqual({
      text: "as of 1h ago",
      tone: "warn",
    });
  });
});

describe("Subscriptions rowView: a withholding cut-off", () => {
  const ok: QuotaProviderView = {
    provider: "claude",
    label: "Claude",
    accountId: "acct_cl1",
    status: "ok",
    stale: false,
    windows: [
      {
        id: "session",
        label: "session",
        percentRemaining: 42,
        pace: "on_pace",
        resetsAtMs: Date.now() + 3_600_000,
      },
    ],
  };

  it("shows a sign-out hold, and Sign in, while the allowance still reads", () => {
    const view = rowView({ ...account, cutOff: { class: "signed_out", since: 1 } }, ok, Date.now());
    expect(view.meters).toHaveLength(1);
    expect(view.dotLabel).toBe(SUBSCRIPTIONS_WORDS.signedOutHoldLabel);
    expect(view.stateText).toBe(SUBSCRIPTIONS_WORDS.signedOutHoldText);
    expect(view.signIn).toBe(true);
  });

  it("shows a refusal without offering Sign in", () => {
    const view = rowView({ ...account, cutOff: { class: "refused", since: 1 } }, ok, Date.now());
    expect(view.stateText).toBe(SUBSCRIPTIONS_WORDS.refusedHoldText);
    expect(view.signIn).toBe(false);
    expect(view.meters).toHaveLength(1);
  });
});

/**
 * A Claude row on access an organization or the person set up for Claude
 * Code (INF-3449, the accepted plan: "The row says the access is set up by
 * the organization, shows no plan, and shows the allowance as not measured,
 * never zero"; a refused token command is renewed where Claude Code's is,
 * never through a browser sign-in).
 */
describe("Subscriptions rowView: Claude access set up for Claude Code", () => {
  const organization: AccountView = { ...account, kind: "api_key", access: "organization" };
  const notMeasured: QuotaProviderView = {
    provider: "claude",
    label: "Claude",
    accountId: "acct_cl1",
    status: "not_measured",
    stale: false,
    windows: [],
    detail: CLAUDE_ACCESS_ALLOWANCE_TEXT.organization,
  };

  it("names the organization in place of a plan and says the allowance is not measured", () => {
    const view = rowView({ ...organization, plan: "max" }, notMeasured, Date.now());
    expect(view.sub).toBe(CLAUDE_ACCESS_LABEL.organization);
    expect(view.meters).toHaveLength(0);
    expect(view.stateText).toBe(CLAUDE_ACCESS_ALLOWANCE_TEXT.organization);
    expect(view.signIn).toBe(false);
  });

  it("asks to renew a refused token command and offers Try again, never Sign in", () => {
    const view = rowView(
      { ...organization, cutOff: { class: "signed_out", since: 1 } },
      notMeasured,
      Date.now(),
    );
    expect(view.stateText).toBe(CLAUDE_ACCESS_REFUSED_TEXT.organization);
    expect(view.signIn).toBe(true);
    expect(view.signInLabel).toBe(CLAUDE_ACCESS_TRY_AGAIN_LABEL);
  });

  it("drops the email a subscription reading left behind once the access serves", () => {
    // An account signed in with a subscription before the update keeps the
    // email its last readings named; on access, it is not who signs in.
    const view = rowView(
      { ...organization, identity: "kun@example.com" },
      { ...notMeasured, account: "kun@example.com" },
      Date.now(),
    );
    expect(view.sub).toBe(CLAUDE_ACCESS_LABEL.organization);
  });

  it("says a subscription's requests go to the address in Claude Code's settings", () => {
    const view = rowView(
      { ...account, identity: "kun@example.com", plan: "Max", gateway: "claude-settings" },
      undefined,
      Date.now(),
    );
    expect(view.sub).toBe(`Max · kun@example.com · ${CLAUDE_GATEWAY_LABEL["claude-settings"]}`);
  });

  it("names the person's own Claude Code settings when the access is theirs", () => {
    const view = rowView(
      { ...account, kind: "api_key", access: "claude-settings" },
      notMeasured,
      Date.now(),
    );
    expect(view.sub).toBe(CLAUDE_ACCESS_LABEL["claude-settings"]);
  });
});

describe("Subscriptions rowView: credits past the allowance (INF-4104 piece 1)", () => {
  const now = 1_800_000_000_000;
  const reading = (
    provider: string,
    credits: QuotaProviderView["credits"],
    extra: Partial<QuotaProviderView> = {},
  ): QuotaProviderView => ({
    provider,
    label: provider,
    status: "ok",
    stale: false,
    windows: [{ id: "five_hour", label: "session", percentRemaining: 0 }],
    ...(credits ? { credits } : {}),
    ...extra,
  });
  const where = (site: string) => m.settingsSubscriptionsCreditsWhere({ site });

  it("says what the provider says, then where to change it", () => {
    expect(
      rowView(account, reading("claude", { state: "available", usedPercent: 12, inUse: true }), now)
        .credits,
    ).toBe(
      `${m.settingsSubscriptionsCreditsClaudeInUseUsed({ percent: formatNumber(12) })} · ${where("claude.ai")}`,
    );
    expect(rowView(account, reading("claude", { state: "off" }), now).credits).toBe(
      `${m.settingsSubscriptionsCreditsClaudeOff()} · ${where("claude.ai")}`,
    );
    const codex = { ...account, providerId: "openai-codex" };
    expect(
      rowView(codex, reading("codex", { state: "available", balance: "32684.7473575000" }), now)
        .credits,
    ).toBe(
      `${m.settingsSubscriptionsCreditsCodexBalance({
        balance: formatNumber(32684.7473575, { maximumFractionDigits: 2 }),
      })} · ${where("chatgpt.com")}`,
    );
  });

  it("says nothing when the fact is unknown or the row is not a reading", () => {
    expect(rowView(account, reading("claude", undefined), now).credits).toBeUndefined();
    expect(rowView(account, reading("claude", { state: "unknown" }), now).credits).toBeUndefined();
    const unread = reading(
      "claude",
      { state: "available" },
      { status: "unavailable", windows: [], reason: "http_500" },
    );
    expect(rowView(account, unread, now).credits).toBeUndefined();
  });
});
