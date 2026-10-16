import type { AccountView } from "../../../shared/accounts";
import { COMPUTER, HERE } from "../../../shared/deviceNames";
import { API_KEY_LABEL } from "../../../shared/providers";

/** Settings → Intelligence's account-row words (`SubscriptionsTab.tsx`). */

/** First-run copy when the machine has no Claude login yet (CD-1=B). */
export const CLAUDE_FIRST_RUN_TEXT = `Sign in with Claude on ${HERE.this}.`;

/** What a row with no allowance reader says the app does, never what the credential could expose. */
export const NO_READER_TEXT = "Infinitary doesn't read the allowance for this provider.";

/** The no-reader line, after "API key set" on a key's row. */
export function noReaderText(kind: AccountView["kind"]): string {
  return `${kind === "api_key" ? `${API_KEY_LABEL} set · ` : ""}${NO_READER_TEXT}`;
}

/**
 * What a row with no window says, one line per situation the captain must
 * tell apart (`emptyQuotaText`): the sign-in itself needs redoing, the
 * provider asked us to slow down, the allowance could not be read just now,
 * or none has been read yet. None of them is ever a meter.
 */
export const EMPTY_QUOTA_TEXT = {
  signInAgain: "Sign in again to see your allowance.",
  slowDown: "Your allowance can't be read right now - the provider asked us to slow down.",
  unread: "Your allowance couldn't be read just now.",
  notYet: "No allowance reading yet.",
} as const;

/** The Claude row while a sign-out mark holds the account, allowance or not. */
export const SIGNED_OUT_HOLD_LABEL = "on hold";
export const SIGNED_OUT_HOLD_TEXT = "Work is paused until you sign in again.";

/** The row while the provider is refusing this sign-in. */
export const REFUSED_HOLD_LABEL = "refusing";
export const REFUSED_HOLD_TEXT = "This sign-in is being refused.";

/** The tag on the one row whose account Firstmate runs on, and its tooltip. */
export const FIRSTMATE_ACCOUNT_TAG = "firstmate";
export const FIRSTMATE_ACCOUNT_TAG_TITLE = "Your first mate runs on this account";
/** What the ✱ beside an account's name means: crew work prefers it. */
export const CREW_PREFERRED_MARK_TITLE = "Crew work prefers this account";

export const PERSONAL_RESOURCES_WORDS = {
  title: "Global instructions and skills",
  description: `New crewmate sessions use the global instructions and skills of the ${COMPUTER.one} they run on. Nothing is copied between ${COMPUTER.many}. Crew rules govern delivery; your file guides style and judgment.`,
} as const;
