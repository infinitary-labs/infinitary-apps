import { ACCOUNT_LABEL_MAX, type AccountView, standingCutOff } from "@shared/accounts";
import {
  CLAUDE_ACCESS_LABEL,
  CLAUDE_ACCESS_REFUSED_TEXT,
  CLAUDE_ACCESS_TRY_AGAIN_LABEL,
  CLAUDE_GATEWAY_LABEL,
} from "@shared/claudeAccess";
import { isCustomApiProvider } from "@shared/customApi";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import { API_KEY_LABEL, CLAUDE_PROVIDER_ID, catalogEntry } from "@shared/providers";
import {
  isKeychainValueFailure,
  isSensedProvider,
  type PiModelRefView,
  type QuotaProviderView,
  type QuotaSnapshotView,
  type RoutingSettings,
} from "@shared/quota";
import { formatDurationShort, providerScopes, windowSignals } from "@shared/quotaSignals";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthAside,
  AuthMethodChoice,
  CodeExpired,
  connectMethods,
  ProviderChips,
  signInEnd,
} from "../accounts/ConnectChips";
import { CustomApiAccountsSection } from "../accounts/CustomApiForm";
import {
  answeredSignInPrompt,
  forgetSignInNotice,
  lastSignInNotice,
  runAccountAdd,
  signInFlightSnapshot,
  subscribeSignInFlight,
} from "../accounts/signInFlight";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import type { RowMenuItem, StatusDotTone } from "../design";
import { Button, Input, QuotaMicroMeter, RowMenu, StatusDot, Switch } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { useRestLabel } from "../design/core/restLabel";
import { CostLimitRow } from "./CostLimitRow";
import { DeviceSignInGroups } from "./DeviceSignIns";
import { FIRSTMATE_SELECT_STYLE, FirstmateModelRow, SettingRow } from "./GeneralTab";
import { ModelsSection } from "./ModelsSection";
import { ROW_GAP, SECTION_GAP, SettingError } from "./settingRows";
import {
  CLAUDE_FIRST_RUN_TEXT,
  CREW_PREFERRED_MARK_TITLE,
  EMPTY_QUOTA_TEXT,
  FIRSTMATE_ACCOUNT_TAG,
  FIRSTMATE_ACCOUNT_TAG_TITLE,
  noReaderText,
  PERSONAL_RESOURCES_WORDS,
  REFUSED_HOLD_LABEL,
  REFUSED_HOLD_TEXT,
  SIGNED_OUT_HOLD_LABEL,
  SIGNED_OUT_HOLD_TEXT,
} from "./subscriptionsWords";
import { useSettingSave } from "./useSettingSave";
import "./subscriptions.css";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";

/**
 * The Subscriptions tab, Instruments direction (captain's pick from the
 * prototype review, 2026-09-05): ONE flat list of accounts, in catalog order
 * then age, where each row is a status dot, the provider, the account's
 * label and plan, every quota window as a micro-meter with the row's one
 * verdict at the end, and a kebab holding the actions. Providers not yet
 * connected are chips in the "Add account" foot, not empty cards. Sign-in is
 * the provider's own flow (a browser bounce or a short code); the user sees
 * providers and their subscriptions, labeled by them, and nothing of the
 * machinery underneath.
 *
 * The honesty rules the meters carry (quota-axi display parity): a combined
 * bound is the effective minimum labeled by its LIMITING window and the
 * runway verdict comes from that scope; a stale row dims and says "as of 3h ago" where the verdict
 * would go and derives nothing; only `auth_required` says "sign in again",
 * and it keeps the one inline action; `not_measured` renders the sensor's
 * own detail verbatim; an unread window is "–", never 0. A Claude Keychain
 * VALUE refusal is `unavailable` with a `keychain_*` reason, the sensor's
 * detail, and a Retry - never a blank meter and never "sign in again". A
 * Claude row that is not signed in is first-run copy ("Sign in with Claude
 * on this Mac"), not an error and not a blank meter (CD-1=B).
 */

const kindCopy: Record<AccountView["kind"], string> = {
  subscription_oauth: "subscription",
  api_key: API_KEY_LABEL,
};

export const LABEL_STYLE = {
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

/**
 * Intelligence tab board below the account list: Firstmate's own model (and
 * its account, beside it in the same row), then dynamic routing, then the
 * models disclosure.
 */
export function IntelligenceBoard({
  firstmateModel,
  dynamicRouting,
  models,
  additionalSettings,
}: {
  firstmateModel: React.ReactNode;
  dynamicRouting: React.ReactNode;
  models: React.ReactNode;
  additionalSettings?: React.ReactNode;
}) {
  return (
    <div
      data-intelligence-board
      style={{
        display: "flex",
        flexDirection: "column",
        gap: ROW_GAP,
        marginTop: SECTION_GAP,
      }}
    >
      <div data-intelligence-block="firstmate-model">{firstmateModel}</div>
      {dynamicRouting ? (
        <div data-intelligence-block="dynamic-routing">{dynamicRouting}</div>
      ) : null}
      {models ? <div data-intelligence-block="models">{models}</div> : null}
      {additionalSettings ? (
        <div
          data-intelligence-block="additional-settings"
          style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}
        >
          {additionalSettings}
        </div>
      ) : null}
    </div>
  );
}

/** One account the Firstmate account picker lists, and why it cannot be picked when it cannot. */
export type FirstmateAccountChoice = { id: string; label: string; unavailable?: string };

/**
 * The accounts of the provider Firstmate answers with, in the list's order,
 * for the Firstmate account picker. One that cannot run Firstmate stays
 * listed with its row's own word for why - paused, sign in again, not
 * ready - and cannot be picked; anything else the app knows it refuses in
 * words. A choice needs two accounts that can answer (the captain, FI3-215),
 * so with fewer the picker offers nothing.
 */
export function firstmateAccountChoices(
  accounts: readonly AccountView[],
  providerId: string | undefined,
  quotaRowFor: (account: AccountView) => QuotaProviderView | undefined,
  now: number,
): FirstmateAccountChoice[] {
  if (!providerId) return [];
  const choices = accounts
    .filter((account) => account.providerId === providerId)
    .map((account): FirstmateAccountChoice => {
      const view = rowView(account, quotaRowFor(account), now);
      const blocked =
        view.kind === "paused" ||
        view.kind === "auth" ||
        view.kind === "disconnected" ||
        account.detail !== undefined;
      return {
        id: account.id,
        label: account.label,
        ...(blocked ? { unavailable: view.dotLabel } : {}),
      };
    });
  return choices.filter((choice) => choice.unavailable === undefined).length < 2 ? [] : choices;
}

/**
 * Which account Firstmate itself answers on, the dropdown beside its model:
 * the seat's own pin, apart from the account crew work prefers (the row
 * menu's ✱). A pick moves Firstmate at its next idle moment, never
 * mid-answer.
 */
export function FirstmateAccountSelect({
  choices,
  chosen,
  saving,
  onChoose,
}: {
  choices: readonly FirstmateAccountChoice[];
  chosen: string | null;
  saving: boolean;
  onChoose: (accountId: string) => void;
}) {
  const current = choices.some((choice) => choice.id === chosen) ? (chosen as string) : "";
  return (
    <select
      aria-label="First mate account"
      value={current}
      disabled={saving}
      onChange={(event) => {
        if (event.target.value) onChoose(event.target.value);
      }}
      style={{ ...FIRSTMATE_SELECT_STYLE, maxWidth: "calc(var(--space-9) * 2)" }}
    >
      {current === "" ? (
        <option value="" disabled>
          Not chosen yet
        </option>
      ) : null}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id} disabled={choice.unavailable !== undefined}>
          {choice.unavailable ? `${choice.label} · ${choice.unavailable}` : choice.label}
        </option>
      ))}
    </select>
  );
}

/**
 * What a row with no window says. The three situations the captain has to be
 * able to tell apart stay apart: we could not find out just now, the sign-in
 * itself needs redoing, and we simply have not read one yet. None of them is
 * ever rendered as a meter.
 */
function emptyQuotaText(status: QuotaProviderView["status"]): string {
  switch (status) {
    case "auth_required":
      return EMPTY_QUOTA_TEXT.signInAgain;
    case "rate_limited":
      return EMPTY_QUOTA_TEXT.slowDown;
    case "unavailable":
    case "error":
      return EMPTY_QUOTA_TEXT.unread;
    default:
      return EMPTY_QUOTA_TEXT.notYet;
  }
}

/** How old a carried-forward reading is, in the words a person would use. */
function measuredAgeText(measuredAt: number, now: number): string {
  const minutes = Math.floor((now - measuredAt) / 60_000);
  if (minutes < 1) return "as of just now";
  if (minutes < 60) return `as of ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `as of ${hours}h ago`;
  return `as of ${Math.floor(hours / 24)}d ago`;
}

function timeOf(at: number): string {
  const t = new Date(at);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

type RowKind =
  | "ok"
  | "stale"
  | "paused"
  | "auth"
  | "disconnected"
  | "pending"
  | "no_row"
  | "no_data"
  | "not_measured"
  | "rate_limited"
  | "unavailable"
  | "error"
  | "skipped";

type Verdict = { text: string; tone: "ok" | "danger" | "warn" | "neutral" };

type RowView = {
  kind: RowKind;
  dot: StatusDotTone;
  dotLabel: string;
  /** The mono second line: plan · identity, else the kind word. */
  sub: string;
  meters: {
    id: string;
    label: string;
    percent?: number;
    pace: "ahead" | "on_pace" | "behind" | "unknown";
    resetText?: string;
    clock?: number;
  }[];
  verdict?: Verdict;
  /** The one-line state for a row with no meter to show. */
  stateText?: string;
  stateTone?: "danger";
  /** The only inline action: nothing moves on this row until it is pressed. */
  signIn: boolean;
  /**
   * The inline action's own words when they are not Sign in: on Claude
   * access set up for Claude Code it checks that access again and opens
   * nothing.
   */
  signInLabel?: string;
  /** A Keychain VALUE refusal: retry the read (may raise the macOS ask). */
  retry: boolean;
};

/**
 * Stage 1: which situation the row is in. The order is the priority a person
 * would give the facts: paused first (nothing else matters while it is off),
 * then a sign-in the vendor rejected after a real renewal, then a store with
 * no credential, then what the sensor established. `needsReauth` is the same
 * terminal state from local proof (a lapsed refresh token) when the quota
 * row has not landed yet.
 */
function rowKind(account: AccountView, row: QuotaProviderView | undefined): RowKind {
  if (!account.enabled) return "paused";
  if (row?.status === "auth_required" || account.needsReauth) return "auth";
  if (!account.connected) return "disconnected";
  // A sensed provider with no snapshot row yet is waiting on its first
  // read - not a provider Infinitary never reads. OpenRouter and other
  // unsensed providers stay `no_row` (the existing sentence).
  if (!row) return isSensedProvider(account.providerId) ? "pending" : "no_row";
  if (row.stale) return "stale";
  if (row.status === "ok") return row.windows.length > 0 ? "ok" : "no_data";
  return row.status;
}

function runwayVerdict(
  runway: { status: string; projectedExhaustedAtMs?: number },
  now: number,
  allModels: boolean,
): Verdict | undefined {
  if (runway.status === "through_reset") {
    // The check mark is the all-models claim; a narrower scope is just "on pace".
    return { text: allModels ? "on pace ✓" : "on pace", tone: "ok" };
  }
  if (runway.status === "projected_exhaustion" && runway.projectedExhaustedAtMs !== undefined) {
    return {
      text: `empty in ${formatDurationShort(runway.projectedExhaustedAtMs - now)}`,
      tone: "danger",
    };
  }
  if (runway.status === "exhausted_now") return { text: "empty now", tone: "danger" };
  return undefined;
}

/**
 * The row's one verdict. A combined bound speaks for all models; a stale
 * row says its age and derives nothing (providerScopes already returns
 * nothing for it).
 */
function verdictFor(kind: RowKind, row: QuotaProviderView | undefined, now: number) {
  if (kind === "paused") return { text: "paused", tone: "neutral" } as Verdict;
  if (kind === "stale" && row) {
    return {
      text: row.measuredAt !== undefined ? measuredAgeText(row.measuredAt, now) : "stale",
      tone: "warn",
    } as Verdict;
  }
  if (kind !== "ok" || !row) return undefined;
  const { allModels, scopes } = providerScopes(row, now);
  // An account-wide bound remains authoritative even when it is unknown.
  // Never fall back to a readable window and bypass an unread bound.
  if (allModels) return runwayVerdict(allModels.runway, now, true);
  // With only narrower bounds, keep the lowest-headroom scope's verdict,
  // without the all-models check mark. Unknown headroom takes precedence.
  const lowest = scopes.reduce<(typeof scopes)[number] | undefined>((a, b) => {
    if (!a || b.effectivePercentRemaining === undefined) return b;
    if (a.effectivePercentRemaining === undefined) return a;
    return b.effectivePercentRemaining < a.effectivePercentRemaining ? b : a;
  }, undefined);
  return lowest ? runwayVerdict(lowest.runway, now, false) : undefined;
}

export function rowView(
  account: AccountView,
  row: QuotaProviderView | undefined,
  now: number,
): RowView {
  const kind = rowKind(account, row);
  // Prefer what the provider itself says about the account; fall back to the
  // quota sensor's view, and only then to the kind of credential. Never the
  // internal account id - it means nothing to the person reading it.
  const identity = account.identity ?? row?.account;
  const plan = account.plan ?? row?.plan;
  // Claude access set up for Claude Code has no plan and no email: the row
  // says where it comes from instead, never a subscription's email an
  // earlier reading kept. A subscription whose requests go to an address in
  // Claude Code's settings says so after its plan.
  const sub = account.access
    ? CLAUDE_ACCESS_LABEL[account.access]
    : [
        plan ?? kindCopy[account.kind],
        identity,
        account.gateway ? CLAUDE_GATEWAY_LABEL[account.gateway] : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
  const signedIn = account.kind === "api_key" ? `${API_KEY_LABEL} set` : "signed in";
  const claudeFirstRun = kind === "disconnected" && account.providerId === CLAUDE_PROVIDER_ID;
  const dot: { tone: StatusDotTone; label: string } =
    kind === "ok"
      ? { tone: "ok", label: signedIn }
      : kind === "stale"
        ? { tone: "warn", label: `${signedIn} · last reading is stale` }
        : claudeFirstRun
          ? { tone: "ring", label: "not signed in yet" }
          : kind === "auth" || kind === "disconnected"
            ? { tone: "danger", label: "sign in again" }
            : kind === "paused"
              ? { tone: "idle", label: "paused" }
              : kind === "pending"
                ? { tone: "ring", label: `${signedIn} · reading…` }
                : { tone: "ring", label: `${signedIn} · no allowance reading` };
  const view: RowView = {
    kind,
    dot: dot.tone,
    dotLabel: dot.label,
    sub,
    meters: [],
    signIn: false,
    retry: false,
  };
  if (kind === "auth") {
    view.stateText = emptyQuotaText("auth_required");
    view.stateTone = "danger";
    view.signIn = true;
    return view;
  }
  if (kind === "disconnected") {
    if (account.providerId === CLAUDE_PROVIDER_ID) {
      // First-run, not a failed re-auth: the machine has no Claude login yet.
      view.stateText = CLAUDE_FIRST_RUN_TEXT;
      view.signIn = true;
      return view;
    }
    view.stateText = "Sign in again.";
    view.stateTone = "danger";
    view.signIn = true;
    return view;
  }
  if (account.detail) {
    // The credential is fine and the machine cannot run it (F14: no Claude
    // Code, or one too old). The backend's sentence says what to do; no
    // meter and no sign-in, because neither is the remedy.
    view.dot = "warn";
    view.dotLabel = "not ready";
    view.stateText = account.detail;
    return view;
  }
  if (kind === "pending") {
    // First read in flight (or about to be). Muted mono like other empty
    // states; a failed read replaces this with the sensor's own status.
    view.stateText = "reading…";
    return withHold(view, account, now);
  }
  if (kind === "no_row") {
    // Says what the app does, never what the credential could expose.
    view.stateText = noReaderText(account.kind);
    return view;
  }
  view.retry = isKeychainValueFailure(row?.reason);
  if (row && kind !== "ok" && kind !== "paused") {
    if (kind === "stale") {
      // Last-known-good meters stay; the disclosed reason must not vanish
      // behind "as of Nd ago".
      if (row.detail) view.stateText = row.detail;
    } else {
      view.stateText = row.detail ?? emptyQuotaText(row.status);
      // Access set up for Claude Code is never measured, so its hold would
      // never show behind the allowance line: the hold says it instead.
      return account.access ? withHold(view, account, now) : view;
    }
  }
  view.meters = (row?.windows ?? []).map((window) => {
    const signals = windowSignals(window, now);
    return {
      id: window.id,
      label: window.label,
      ...(window.percentRemaining !== undefined ? { percent: window.percentRemaining } : {}),
      pace: window.pace ?? "unknown",
      ...(window.resetText ? { resetText: window.resetText } : {}),
      ...(signals.kind === "measured" ? { clock: signals.timeRemainingPercent } : {}),
    };
  });
  const verdict = verdictFor(kind, row, now);
  if (verdict) view.verdict = verdict;
  return withHold(view, account, now);
}

/**
 * A withholding cut-off is invisible when the allowance still reads: the
 * row keeps its meters and says the hold, with Sign in for a sign-out.
 */
function withHold(view: RowView, account: AccountView, now: number): RowView {
  const hold = standingCutOff(account, now);
  if (!account.enabled || !account.connected) return view;
  if (hold?.class !== "signed_out" && hold?.class !== "refused") return view;
  view.dot = "warn";
  view.dotLabel = hold.class === "signed_out" ? SIGNED_OUT_HOLD_LABEL : REFUSED_HOLD_LABEL;
  view.stateText = hold.class === "signed_out" ? SIGNED_OUT_HOLD_TEXT : REFUSED_HOLD_TEXT;
  view.stateTone = "danger";
  if (hold.class === "signed_out") {
    view.signIn = true;
    // A refused token command is renewed where the person renews it for
    // Claude Code; the row's button checks again and opens no browser.
    if (account.access) {
      view.stateText = CLAUDE_ACCESS_REFUSED_TEXT[account.access];
      view.signInLabel = CLAUDE_ACCESS_TRY_AGAIN_LABEL;
    }
  }
  return view;
}

/**
 * A mark beside an account's name (✱, firstmate) whose meaning is not
 * written out: a Tab stop of its own that shows its words on rest, the
 * pointer's or the keyboard's focus, and names itself with them
 * (docs/keyboard.md, "Facts shown on rest").
 */
function AccountMark({
  words,
  style,
  children,
  ...data
}: {
  words: string;
  style: React.CSSProperties;
  children: React.ReactNode;
} & Record<`data-${string}`, string>) {
  const rest = useRestLabel(words, { fact: true });
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a fact shown on rest is a stop of its own, so the keyboard reads it as the pointer does
    <span role="img" aria-label={words} tabIndex={0} {...rest} {...data} style={style}>
      {children}
    </span>
  );
}

export function AccountRow({
  account,
  providerName,
  quotaRow,
  isFlagship,
  hasModels,
  renaming,
  signingIn,
  signInOff,
  refreshing,
  onStartRename,
  onRename,
  onCancelRename,
  onTogglePin,
  onSetEnabled,
  onDisconnect,
  onSignIn,
  onRetry,
  onShowModels,
  onResetSlots,
  menu,
}: {
  account: AccountView;
  providerName: string;
  quotaRow?: QuotaProviderView;
  isFlagship: boolean;
  hasModels: boolean;
  renaming: boolean;
  signingIn: boolean;
  signInOff?: string;
  refreshing: boolean;
  onStartRename: () => void;
  onRename: (label: string) => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onDisconnect: () => void;
  onSignIn: () => void;
  /**
   * Reads this account's allowance again, asking macOS when it must. Absent
   * for an account on a computer that runs work, which never asks there:
   * the row says why and offers no Retry.
   */
  onRetry?: () => void;
  onShowModels: () => void;
  onResetSlots: () => void;
  /**
   * The row's menu in place of this Mac's own: an account on a computer that
   * runs work offers only what that computer does with it.
   */
  menu?: RowMenuItem[];
}) {
  const [renameValue, setRenameValue] = useState(account.label);
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => {
    if (renaming) setRenameValue(account.label);
  }, [renaming, account.label]);
  const view = rowView(account, quotaRow, Date.now());
  const repeated =
    view.dotLabel === "paused" && view.verdict?.text === "paused"
      ? view.verdict.text
      : view.dotLabel === "sign in again" && view.stateText
        ? view.stateText
        : undefined;
  const repeatedFit = useOverflowTitle(repeated);

  const items: RowMenuItem[] = menu ?? [
    {
      id: "prefer",
      label: account.pinned ? "Stop preferring for crew work" : "Prefer for crew work",
      trailing: <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>✱</span>,
      onSelect: onTogglePin,
    },
    ...(account.providerId === CLAUDE_PROVIDER_ID
      ? []
      : [{ id: "rename", label: "Rename", onSelect: onStartRename }]),
    {
      id: "pause",
      label: account.enabled ? "Pause" : "Resume",
      onSelect: () => onSetEnabled(!account.enabled),
    },
    ...(hasModels
      ? [
          { id: "models", label: "Model slots", onSelect: onShowModels },
          {
            id: "reset-slots",
            label: "Reset model slots",
            onSelect: () => setResetArmed(true),
          },
        ]
      : []),
    { separator: true },
    { id: "disconnect", label: "Disconnect", tone: "danger", onSelect: onDisconnect },
  ];

  return (
    <>
      <div
        className="fm-subs-row"
        data-account-row={account.id}
        data-row-kind={view.kind}
        data-hold={standingCutOff(account, Date.now())?.class}
        data-paused={account.enabled ? undefined : "true"}
      >
        <span className="fm-subs-dot">
          <StatusDot
            tone={view.dot}
            label={view.dotLabel}
            nativeTitle={repeated ? repeatedFit.hidden : true}
            focusable
          />
        </span>
        <span className="fm-subs-prov">{providerName}</span>
        <div className="fm-subs-who">
          {renaming ? (
            // Wraps inside its own column, so a cramped row stacks the
            // buttons under the input instead of overlapping the meters.
            <form
              style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}
              onSubmit={(event: React.FormEvent) => {
                event.preventDefault();
                onRename(renameValue);
              }}
            >
              <Input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                placeholder="Account name"
                maxLength={ACCOUNT_LABEL_MAX}
                autoFocus
                style={{ width: 140 }}
              />
              <Button variant="primary" size="sm" type="submit">
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelRename}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <span className="fm-subs-label">
                <span className="fm-subs-name" data-account-name="">
                  <span className="fm-subs-prov-inline">{providerName} · </span>
                  {account.label}
                </span>
                {account.pinned && (
                  <AccountMark
                    words={CREW_PREFERRED_MARK_TITLE}
                    data-crew-preferred=""
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm)",
                      color: "var(--accent)",
                    }}
                  >
                    ✱
                  </AccountMark>
                )}
                {isFlagship && (
                  <AccountMark
                    words={FIRSTMATE_ACCOUNT_TAG_TITLE}
                    data-firstmate-account=""
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--accent)",
                      border: "1px solid var(--line-2)",
                      borderRadius: "var(--radius-s)",
                      padding: "1px 6px",
                      whiteSpace: "nowrap",
                      lineHeight: 1.4,
                    }}
                  >
                    {FIRSTMATE_ACCOUNT_TAG}
                  </AccountMark>
                )}
              </span>
              <span className="fm-subs-sub">{view.sub}</span>
            </>
          )}
        </div>
        <div className="fm-subs-flow">
          {view.meters.map((meter) => (
            <QuotaMicroMeter
              key={meter.id}
              label={meter.label}
              {...(meter.percent !== undefined ? { percentRemaining: meter.percent } : {})}
              pace={meter.pace}
              {...(meter.resetText ? { resetText: meter.resetText } : {})}
              {...(meter.clock !== undefined ? { clockPercent: meter.clock } : {})}
              stale={view.kind === "stale"}
            />
          ))}
          {view.verdict && (
            <span
              className="fm-subs-verdict"
              data-tone={view.verdict.tone}
              ref={repeated === view.verdict.text ? repeatedFit.ref : undefined}
            >
              {view.verdict.text}
            </span>
          )}
          {view.stateText ? (
            <span
              className="fm-subs-state"
              data-tone={view.stateTone}
              ref={repeated === view.stateText ? repeatedFit.ref : undefined}
            >
              {view.stateText}
            </span>
          ) : null}
          {view.signIn && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onSignIn}
              off={Boolean(signInOff)}
              note={signInOff}
              pending={signingIn}
              pendingLabel="Connecting..."
            >
              {view.signInLabel ?? "Sign in"}
            </Button>
          )}
          {view.retry && onRetry && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              pending={refreshing}
              pendingLabel="Retrying..."
            >
              Retry
            </Button>
          )}
        </div>
        <span className="fm-subs-menu">
          <RowMenu label={`${account.label} actions`} items={items} />
        </span>
      </div>
      {resetArmed && (
        <div
          className="fm-subs-reset-confirm"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "8px 18px 12px",
            background: "var(--bg-1)",
          }}
        >
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", flex: 1, minWidth: 0 }}>
            Reset this provider's slots to the starter map. Always use choices are untouched.
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              onResetSlots();
              setResetArmed(false);
            }}
          >
            Confirm reset
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setResetArmed(false)}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Asks the allowance sensor to read now, after a sign-in or an add ended,
 * rather than at its next tick. A refused reading changes nothing: the row
 * keeps what it last read, the attempt already said how it ended, and the
 * sensor's own tick reads again.
 */
function askSensorNow(apply: (snapshot: QuotaSnapshotView | null) => void): void {
  void window.infinitary.quota
    .refresh()
    .then(apply)
    .catch(() => {});
}

/** No accounts read yet, as one value so the list's readers keep their identity. */
const NO_ACCOUNTS: AccountView[] = [];

export function SubscriptionsTab() {
  const place = useFirstMatePlace();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  // The list is the saved state an account's edit returns to when refused.
  const accountsSave = useSettingSave(() => window.infinitary.accounts.list());
  const accounts = accountsSave.value ?? NO_ACCOUNTS;
  // Which account the last edit was, so a refusal is told under its row.
  const [editedAccountId, setEditedAccountId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<QuotaSnapshotView | null>(null);
  const slotSave = useSettingSave(() => window.infinitary.models.slots());
  const decisionSave = useSettingSave(() => window.infinitary.models.decisions());
  const personalSave = useSettingSave(() => window.infinitary.settings.getPersonalResources());
  const routingSave = useSettingSave(() => window.infinitary.settings.getRouting());
  const slots = slotSave.value;
  const decisions = decisionSave.value;
  const routing = routingSave.value;
  // Firstmate's own seat: its account (beside the row menu's crew ✱) and the
  // model whose provider that account must belong to.
  const accountSave = useSettingSave(() => window.infinitary.settings.getFirstmateAccount());
  const flagshipAccountId = accountSave.value;
  const [seatModel, setSeatModel] = useState<PiModelRefView | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<AuthPromptView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [notices, setNotices] = useState<Record<string, AuthNotice>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(true);
  const [modelsFocus, setModelsFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How a sign-in ended when it did not end signed in: its words, or a code
  // that expired, beside the step it belongs to - the row signing in again,
  // or the "Add account" foot (INF-838). The person's own Cancel says nothing.
  const [signInEnded, setSignInEnded] = useState<{
    anchor: { accountId: string } | { foot: string };
    expired: boolean;
    text: string;
  } | null>(null);
  const cancelled = useRef(false);
  const restart = useRef<{ provider: ProviderView; host: string | undefined } | null>(null);
  const [enterpriseHost, setEnterpriseHost] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  // A computer that runs work signs in on its own; once one is listed,
  // this Mac's accounts sit under their own label.
  const [grouped, setGrouped] = useState(false);

  const refresh = useCallback(() => {
    void window.infinitary.auth
      .providers()
      .then(setProviders)
      .catch(() => {});
    void accountsSave.refresh();
    void accountSave.refresh();
    void window.infinitary.settings
      .getFirstmateModel()
      .then(setSeatModel)
      .catch(() => {});
    // The shortlist follows the routing pool, which moves when an account
    // attaches or the live catalog refreshes.
    void slotSave.refresh();
    // The Decisions group polls with the rest: a native model's row can
    // turn to `key rejected` from a background classification, and the row
    // is the only place that state is shown.
    void decisionSave.refresh();
  }, [accountsSave.refresh, accountSave.refresh, slotSave.refresh, decisionSave.refresh]);

  useEffect(() => {
    refresh();
    void window.infinitary.quota.snapshot().then(setSnapshot);
    void routingSave.refresh();
    void personalSave.refresh();
    // Status dots poll while the tab is open.
    const interval = setInterval(refresh, 10_000);
    const offSnapshot = window.infinitary.quota.onSnapshot((incoming) => {
      setSnapshot(incoming);
      // The same reading can discover a changed Claude login and row label.
      void accountsSave.refresh();
      void slotSave.refresh();
    });
    const offPrompt = window.infinitary.auth.onPrompt((incoming) => {
      setPrompt(incoming);
      setPromptValue("");
    });
    const offNotice = window.infinitary.auth.onNotice((notice) => {
      setNotices((current) => ({ ...current, [notice.providerId]: notice }));
    });
    // A Firstmate model change takes an account of its provider with it.
    const offModels = window.infinitary.models.onChanged(refresh);
    return () => {
      clearInterval(interval);
      offSnapshot();
      offPrompt();
      offNotice();
      offModels();
    };
  }, [refresh, routingSave.refresh, slotSave.refresh, personalSave.refresh, accountsSave.refresh]);

  const saveRouting = (next: RoutingSettings) => {
    void routingSave.save(() => window.infinitary.settings.setRouting(next));
  };

  const clearAuthFlow = useCallback((providerId: string) => {
    setPrompt(null);
    setNotices((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  }, []);

  // A provider that signs in either way asks which first (the same choice
  // the first-launch gate offers); one way goes at once.
  const [methodChoice, setMethodChoice] = useState<ProviderView | null>(null);
  const addAccount = (provider: ProviderView) => {
    const methods = connectMethods(provider);
    setSignInEnded(null);
    if (methods.length > 1) {
      setMethodChoice(provider);
      return;
    }
    startAdd(provider, methods[0] ?? "api_key");
  };
  // Reads only a ref and setters, so it never changes.
  const ended = useCallback(
    (anchor: { accountId: string } | { foot: string }, providerId: string, caught: unknown) => {
      const end = signInEnd({
        cancelled: cancelled.current,
        notice: lastSignInNotice(providerId),
        now: Date.now(),
      });
      if (end === "cancelled") return;
      setSignInEnded({
        anchor,
        expired: end === "expired",
        text: caught instanceof Error ? caught.message : String(caught),
      });
    },
    [],
  );
  const startAdd = (provider: ProviderView, type: "oauth" | "api_key", host?: string) => {
    setMethodChoice(null);
    setBusyProvider(provider.id);
    setSignInEnded(null);
    setEnterpriseHost(host);
    cancelled.current = false;
    void runAccountAdd(provider.id, () =>
      window.infinitary.accounts.add(
        provider.id,
        type,
        host ? { enterpriseHost: host } : undefined,
      ),
    )
      .then((added) => {
        // The sign-in finished in the browser: the window comes forward.
        void window.infinitary.app.controlWindow("front").catch(() => {});
        // Invite a rename right away ("Personal", "Work #2" are editable),
        // unless the sign-in named the account itself.
        if (!added.identity) setRenamingId(added.id);
      })
      .catch((caught) => ended({ foot: provider.id }, provider.id, caught))
      .finally(() => {
        setBusyProvider(null);
        clearAuthFlow(provider.id);
        refresh();
        // Same as signIn: ask the sensor now rather than wait for the tick,
        // so a sensed row leaves "reading…" once the first pass lands.
        askSensorNow(setSnapshot);
        const next = restart.current;
        restart.current = null;
        if (next) startAdd(next.provider, "oauth", next.host);
      });
  };
  const cancelSignIn = () => {
    cancelled.current = true;
    void window.infinitary.auth.cancel().catch(() => {});
  };

  // Leaving this tab used to drop the busy flag while the sign-in kept
  // running. Coming back joins that sign-in instead of starting another.
  useEffect(() => {
    let sawFlight = false;
    const apply = () => {
      const snap = signInFlightSnapshot();
      if (snap.providerId) {
        sawFlight = true;
        setBusyProvider(snap.providerId);
        const notice = snap.notice;
        if (notice) {
          setNotices((current) => ({ ...current, [notice.providerId]: notice }));
        }
        if (snap.prompt) setPrompt(snap.prompt);
        return;
      }
      if (!sawFlight) return;
      sawFlight = false;
      setBusyProvider(null);
      setPrompt(null);
      setNotices({});
    };
    apply();
    return subscribeSignInFlight(apply);
  }, []);

  const signIn = useCallback(
    (account: AccountView) => {
      setBusyAccount(account.id);
      setSignInEnded(null);
      cancelled.current = false;
      forgetSignInNotice(account.providerId);
      void window.infinitary.accounts
        .signIn(account.id)
        .then(() => {
          void window.infinitary.app.controlWindow("front").catch(() => {});
        })
        .catch((caught) => ended({ accountId: account.id }, account.providerId, caught))
        .finally(() => {
          setBusyAccount(null);
          clearAuthFlow(account.providerId);
          refresh();
          // The sensor's verdict on the old credential stands until it reads
          // the new one; ask now rather than at the next tick.
          askSensorNow(setSnapshot);
        });
    },
    [refresh, clearAuthFlow, ended],
  );

  const pendingRestoreAccountId = useShellStore((s) => s.pendingRestoreAccountId);
  useEffect(() => {
    if (!pendingRestoreAccountId) return;
    const account = accounts.find((row) => row.id === pendingRestoreAccountId);
    if (!account) return;
    useShellStore.getState().clearPendingRestore();
    signIn(account);
  }, [pendingRestoreAccountId, accounts, signIn]);

  /**
   * One edit of an account, then the list as saved: a refused edit says why
   * under the account's row, and the row shows what is saved.
   */
  const editAccount = (accountId: string, edit: () => Promise<unknown>) => {
    setEditedAccountId(accountId);
    return accountsSave
      .save(async () => {
        await edit();
        return window.infinitary.accounts.list();
      })
      .then(refresh);
  };

  const disconnect = (account: AccountView) => {
    void editAccount(account.id, () => window.infinitary.accounts.remove(account.id));
  };

  const chooseFirstmateAccount = (accountId: string) => {
    void accountSave.save(() => window.infinitary.settings.setFirstmateAccount(accountId));
  };

  const togglePin = (account: AccountView) => {
    void editAccount(account.id, () =>
      window.infinitary.accounts.pin(account.providerId, account.pinned ? null : account.id),
    );
  };

  const setEnabled = (account: AccountView, enabled: boolean) => {
    void editAccount(account.id, () => window.infinitary.accounts.setEnabled(account.id, enabled));
  };

  const rename = (accountId: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    void editAccount(accountId, () => window.infinitary.accounts.rename(accountId, trimmed)).then(
      () => setRenamingId(null),
    );
  };

  const answerPrompt = (value: string | null) => {
    if (!prompt) return;
    if (value === null) cancelled.current = true;
    void window.infinitary.auth.replyPrompt(prompt.promptId, value);
    answeredSignInPrompt(prompt.promptId);
    setPrompt(null);
  };

  const recheckKeys = useCommandKeys("allowance.recheck");
  const refreshQuota = () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setError(null);
    void window.infinitary.quota
      .refresh()
      .then((next) => {
        setSnapshot(next);
        return slotSave.refresh(true);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        refreshInFlight.current = false;
        setRefreshing(false);
      });
  };

  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]));
  const providerName = (id: string) =>
    providers.find((provider) => provider.id === id)?.name ?? catalogEntry(id)?.name ?? id;
  const ordered = [...accounts].sort(
    (a, b) =>
      (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
  );
  const quotaRowFor = (account: AccountView): QuotaProviderView | undefined =>
    snapshot?.providers.find((row) => row.accountId === account.id);
  const seatProvider =
    seatModel?.provider ?? ordered.find((account) => account.id === flagshipAccountId)?.providerId;
  const firstmateChoices = firstmateAccountChoices(ordered, seatProvider, quotaRowFor, Date.now());
  const hasModels = (providerId: string) =>
    slots?.models.some((model) => model.provider === providerId) ?? false;
  // A sign-in's notice and prompt each land under whatever started them: the
  // existing row signing in again, or the "Add account" foot when the account
  // is not listed yet (its id is minted before the row exists).
  const listed = (accountId: string | undefined) =>
    accountId !== undefined && accounts.some((account) => account.id === accountId);
  const asideFor = (anchor: { accountId: string } | { foot: string }) => {
    const wanted = (id: string | undefined) =>
      "accountId" in anchor ? id === anchor.accountId : !listed(id);
    const notice = Object.values(notices).find(
      (entry) =>
        ("foot" in anchor ? entry.providerId === anchor.foot : true) && wanted(entry.accountId),
    );
    const anchoredPrompt =
      prompt &&
      ("foot" in anchor ? prompt.providerId === anchor.foot : true) &&
      wanted(prompt.accountId)
        ? prompt
        : undefined;
    const endedHere =
      signInEnded &&
      ("accountId" in anchor
        ? "accountId" in signInEnded.anchor && signInEnded.anchor.accountId === anchor.accountId
        : "foot" in signInEnded.anchor && signInEnded.anchor.foot === anchor.foot)
        ? signInEnded
        : null;
    if (!notice && !anchoredPrompt) {
      if (!endedHere) return null;
      const retry = () => {
        if ("accountId" in anchor) {
          const account = accounts.find((row) => row.id === anchor.accountId);
          if (account) signIn(account);
          return;
        }
        const provider = providers.find((entry) => entry.id === anchor.foot);
        if (provider) startAdd(provider, "oauth", enterpriseHost);
      };
      return endedHere.expired ? (
        <CodeExpired
          providerId={
            "accountId" in anchor
              ? (accounts.find((row) => row.id === anchor.accountId)?.providerId ?? "")
              : anchor.foot
          }
          onNewCode={retry}
          onClose={() => setSignInEnded(null)}
        />
      ) : (
        <div className="fm-connect-aside">
          <p role="alert" className="fm-code-step-error" data-settings-error="sign-in">
            {endedHere.text}
          </p>
        </div>
      );
    }
    const provider = "foot" in anchor ? providers.find((entry) => entry.id === anchor.foot) : null;
    return (
      <AuthAside
        {...(notice ? { notice } : {})}
        {...(anchoredPrompt ? { prompt: anchoredPrompt } : {})}
        promptValue={promptValue}
        onPromptValue={setPromptValue}
        onAnswerPrompt={answerPrompt}
        onCancel={cancelSignIn}
        {...(provider && catalogEntry(provider.id)?.codeSignIn?.enterprise
          ? {
              enterprise: {
                ...(enterpriseHost ? { host: enterpriseHost } : {}),
                onUse: (host: string | null) => {
                  restart.current = { provider, host: host ?? undefined };
                  cancelSignIn();
                },
              },
            }
          : {})}
      />
    );
  };

  return (
    <div data-subscriptions>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          marginBottom: ROW_GAP,
        }}
      >
        <div style={LABEL_STYLE}>AI subscriptions</div>
        {snapshot && snapshot.providers.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
            }}
          >
            <span>as of {timeOf(snapshot.fetchedAt)}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshQuota}
              {...recheckKeys}
              pending={refreshing}
              pendingLabel="Refreshing..."
            >
              Refresh
            </Button>
          </div>
        )}
      </div>
      {grouped && (
        <div style={{ ...LABEL_STYLE, marginBottom: ROW_GAP }} data-sign-ins-group="this-mac">
          {place.This}
        </div>
      )}
      <div
        data-subscriptions-list
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-m)",
          overflow: "hidden",
        }}
      >
        {ordered
          .filter((account) => !isCustomApiProvider(account.providerId))
          .map((account) => {
            const row = quotaRowFor(account);
            return (
              <div key={account.id}>
                <AccountRow
                  account={account}
                  providerName={providerName(account.providerId)}
                  {...(row ? { quotaRow: row } : {})}
                  isFlagship={flagshipAccountId === account.id}
                  hasModels={hasModels(account.providerId)}
                  renaming={renamingId === account.id}
                  signingIn={busyAccount === account.id}
                  refreshing={refreshing}
                  onStartRename={() => setRenamingId(account.id)}
                  onRename={(label) => rename(account.id, label)}
                  onCancelRename={() => setRenamingId(null)}
                  onTogglePin={() => togglePin(account)}
                  onSetEnabled={(enabled) => setEnabled(account, enabled)}
                  onDisconnect={() => disconnect(account)}
                  onSignIn={() => signIn(account)}
                  onRetry={refreshQuota}
                  onShowModels={() => {
                    setModelsOpen(true);
                    setModelsFocus(account.id);
                  }}
                  onResetSlots={() => {
                    void slotSave.save(() =>
                      window.infinitary.models.resetSlots(account.providerId),
                    );
                  }}
                />
                {editedAccountId === account.id && accountsSave.error ? (
                  <div className="fm-connect-aside" data-account-error={account.id}>
                    <SettingError error={accountsSave.error} />
                  </div>
                ) : null}
                {asideFor({ accountId: account.id })}
              </div>
            );
          })}
        <div className="fm-subs-add">
          <span style={LABEL_STYLE}>Add account</span>
          <ProviderChips
            providers={providers}
            accounts={accounts}
            busyProviderId={busyProvider}
            onConnect={addAccount}
            variant="foot"
          />
        </div>
        {methodChoice && (
          <AuthMethodChoice
            provider={methodChoice}
            onPick={(type) => startAdd(methodChoice, type)}
            onCancel={() => setMethodChoice(null)}
          />
        )}
        {providers.map((provider) => (
          <div key={provider.id}>{asideFor({ foot: provider.id })}</div>
        ))}
      </div>
      <DeviceSignInGroups
        providerName={providerName}
        onGroups={setGrouped}
        renderRow={(row) => (
          <AccountRow
            account={row.account}
            providerName={row.providerName}
            {...(row.quotaRow ? { quotaRow: row.quotaRow } : {})}
            isFlagship={false}
            hasModels={false}
            renaming={false}
            signingIn={row.signingIn}
            signInOff={row.signInOff}
            refreshing={false}
            onStartRename={() => {}}
            onRename={() => {}}
            onCancelRename={() => {}}
            onTogglePin={() => {}}
            onSetEnabled={() => {}}
            onDisconnect={() => {}}
            onSignIn={row.onSignIn}
            onShowModels={() => {}}
            onResetSlots={() => {}}
            menu={row.menu}
          />
        )}
      />
      <CustomApiAccountsSection />
      <IntelligenceBoard
        firstmateModel={
          <FirstmateModelRow
            {...(seatProvider && firstmateChoices.length > 0
              ? {
                  account: {
                    providerName: providerName(seatProvider),
                    error: accountSave.error,
                    select: (
                      <FirstmateAccountSelect
                        choices={firstmateChoices}
                        chosen={flagshipAccountId}
                        saving={accountSave.saving}
                        onChoose={chooseFirstmateAccount}
                      />
                    ),
                  },
                }
              : {})}
          />
        }
        dynamicRouting={
          routing ? (
            <SettingRow
              id="dynamic-routing"
              error={routingSave.error}
              title="Dynamic routing"
              description="Send work to the slot the work's shape calls for, then to the model with the most of its plan's allowance left. A model set to always use ✱ wins."
              control={
                <Switch
                  checked={routing.dynamicRouting}
                  disabled={routingSave.saving}
                  onChange={(checked) => saveRouting({ ...routing, dynamicRouting: checked })}
                />
              }
            />
          ) : null
        }
        models={
          // Whenever any model can be placed, a custom API's alone included.
          (snapshot && snapshot.providers.length > 0) ||
          (slots && slots.models.length + slots.byName.length > 0) ? (
            <ModelsSection
              saving={slotSave.saving || decisionSave.saving || routingSave.saving}
              slots={slots}
              routing={routing}
              decisions={decisions}
              open={modelsOpen}
              onToggle={() => setModelsOpen((open) => !open)}
              focusAccountId={modelsFocus}
              onFocused={() => setModelsFocus(null)}
              onSaveRouting={saveRouting}
              onSetSlotMembership={(key, slot, on) =>
                slotSave.save(() => window.infinitary.models.setSlotMembership(key, slot, on))
              }
              onSetSpeed={(key, speed) =>
                slotSave.save(() => window.infinitary.models.setSpeed(key, speed))
              }
              onSetReasoning={(key, slot, level) =>
                slotSave.save(() => window.infinitary.models.setReasoning(key, slot, level))
              }
              onResetSlots={() => {
                void slotSave.save(() => window.infinitary.models.resetSlots());
              }}
              onSetDecisions={(next) => {
                void decisionSave.save(() => window.infinitary.models.setDecisions(next));
              }}
              onSetDecisionKey={(id, key) =>
                decisionSave.save(() => window.infinitary.models.setDecisionKey(id, key))
              }
              onRemoveDecisionKey={(id) => {
                void decisionSave.save(() => window.infinitary.models.removeDecisionKey(id));
              }}
            />
          ) : null
        }
        additionalSettings={
          <>
            <CostLimitRow />
            <SettingRow
              id="personal-resources"
              error={personalSave.error}
              title={PERSONAL_RESOURCES_WORDS.title}
              description={PERSONAL_RESOURCES_WORDS.description}
              control={
                <Switch
                  aria-label={PERSONAL_RESOURCES_WORDS.title}
                  checked={personalSave.value ?? false}
                  disabled={personalSave.value === null || personalSave.saving}
                  onChange={(enabled) =>
                    void personalSave.save(() =>
                      window.infinitary.settings.setPersonalResources(enabled),
                    )
                  }
                />
              }
            />
          </>
        }
      />
      {editedAccountId !== null && accountsSave.error && !listed(editedAccountId) ? (
        // A disconnect that went through before failing has no row to stand under.
        <SettingError error={accountsSave.error} surface="accounts" />
      ) : null}
      <SettingError error={slotSave.error} surface="model-slots" />
      <SettingError error={decisionSave.error} surface="decisions" />
      {error && (
        <div
          role="alert"
          data-settings-error="subscriptions"
          style={{ marginTop: 12, fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
