import * as m from "@shared/i18n/messages.generated";
import type { AccountView } from "../../../shared/accounts";
import { COMPUTER, HERE } from "../../../shared/deviceNames";
import { API_KEY_LABEL } from "../../../shared/providers";

/** Settings → Intelligence's account-row words (`SubscriptionsTab.tsx`). */
export const SUBSCRIPTIONS_WORDS = {
  /** First-run copy when the machine has no Claude login yet (CD-1=B). */
  get claudeFirstRun() {
    return m.settingsSubscriptionsClaudeFirstRun({ here: HERE.this });
  },
  /** What a row with no allowance reader says the app does, never what the credential could expose. */
  get noReader() {
    return m.settingsSubscriptionsNoReader();
  },
  /** The Claude row while a sign-out mark holds the account, allowance or not. */
  get signedOutHoldLabel() {
    return m.settingsSubscriptionsSignedOutHoldLabel();
  },
  get signedOutHoldText() {
    return m.settingsSubscriptionsSignedOutHoldText();
  },
  /** The row while the provider is refusing this sign-in. */
  get refusedHoldLabel() {
    return m.settingsSubscriptionsRefusedHoldLabel();
  },
  get refusedHoldText() {
    return m.settingsSubscriptionsRefusedHoldText();
  },
  /** The tag on the one row whose account Firstmate runs on, and its tooltip. */
  get firstmateAccountTag() {
    return m.settingsSubscriptionsFirstmateAccountTag();
  },
  get firstmateAccountTagTitle() {
    return m.settingsSubscriptionsFirstmateAccountTagTitle();
  },
  /** What the ✱ beside an account's name means: crew work prefers it. */
  get crewPreferredMarkTitle() {
    return m.settingsSubscriptionsCrewPreferredMarkTitle();
  },
} as const;

/** The no-reader line, after "API key set" on a key's row. */
export function noReaderText(kind: AccountView["kind"]): string {
  return kind === "api_key"
    ? m.settingsSubscriptionsNoReaderKey({ apiKey: API_KEY_LABEL })
    : m.settingsSubscriptionsNoReader();
}

/**
 * What a row with no window says, one line per situation the captain must
 * tell apart (`emptyQuotaText`): the sign-in itself needs redoing, the
 * provider asked us to slow down, the allowance could not be read just now,
 * or none has been read yet. None of them is ever a meter.
 */
export const EMPTY_QUOTA_TEXT = {
  get signInAgain() {
    return m.settingsSubscriptionsEmptySignInAgain();
  },
  get slowDown() {
    return m.settingsSubscriptionsEmptySlowDown();
  },
  get unread() {
    return m.settingsSubscriptionsEmptyUnread();
  },
  get notYet() {
    return m.settingsSubscriptionsEmptyNotYet();
  },
} as const;

/** The mark beside an account crew work prefers, on the computer's row and the phone's alike. */
export const CREW_PREFERRED_MARK = "✱";

export const PERSONAL_RESOURCES_WORDS = {
  get title() {
    return m.settingsSubscriptionsPersonalResourcesTitle();
  },
  get description() {
    return m.settingsSubscriptionsPersonalResourcesDescription({
      computer: COMPUTER.one,
      computers: COMPUTER.many,
    });
  },
} as const;
