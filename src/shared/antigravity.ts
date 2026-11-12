import { HERE } from "./deviceNames.ts";

/**
 * Antigravity on a person's Google AI plan (INF-3776, the captain's
 * approved plan; docs/antigravity-client.md): the provider id its accounts
 * are stored under, which is also the provider an Antigravity-served model
 * is named under, and the words its sign-in shows before anything starts.
 * Shared so the renderer, the core and the journeys never drift on them.
 */

/** The provider id of a Google AI plan run through the installed Antigravity. */
export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

/** Google's terms for Antigravity, which the sign-in links to. */
export const ANTIGRAVITY_TERMS_URL = "https://antigravity.google/terms";

/**
 * The reply on Google's forum (November 1, 2026) that says an unmodified
 * Antigravity in an app like this one is allowed for one person's
 * interactive work with Gemini models.
 */
export const ANTIGRAVITY_FORUM_REPLY_URL =
  "https://discuss.ai.google.dev/t/conflicting-guidance-on-using-t3-code-with-personal-google-ai-subscriptions/197131/3";

/**
 * What the sign-in says before the person presses anything: what Google's
 * terms and forum say, in the approved plan's five sentences, and the two
 * buttons. Nothing starts until Sign in with Google.
 */
export const ANTIGRAVITY_SIGN_IN_WORDS = {
  title: "Use your Google AI plan",
  sentences: [
    `Infinitary runs Antigravity on ${HERE.this} with your own Google sign-in.`,
    "Google's own program signs you in, and Infinitary never sees your password or tokens.",
    "Google's terms forbid using other apps to reach Antigravity.",
    "Replies on Google's forum say this way is allowed for one person's interactive work with Gemini models.",
    "Crewmates that work while you are away may not count, and Google can suspend your Antigravity access.",
  ],
  terms: "Google's terms",
  forum: "Google's forum reply",
  go: "Sign in with Google",
  notNow: "Not now",
} as const;

/** The note beside the disabled Antigravity chip while no program is installed. */
export const ANTIGRAVITY_CHIP_INSTALL_NOTE = "install Antigravity first";

/** The one sentence a computer with no Antigravity program shows. */
export const ANTIGRAVITY_MISSING_TEXT = `Antigravity isn't installed on ${HERE.this}. Install it to use your Google AI plan here.`;
