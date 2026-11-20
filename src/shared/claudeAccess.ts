/**
 * Where a Claude account's access comes from when it is not a Claude
 * subscription sign-in: a token command Claude Code runs, named in the
 * settings an organization installed for Claude Code on this computer, or in
 * the person's own Claude Code settings (docs/claude-client.md, "Access a
 * company set up"). Infinitary never runs that command and never sees what
 * it prints: the client does both. Shared so the account row, the core and
 * every card that names the access say it in the same words.
 */
export const CLAUDE_ACCESS_SOURCES = ["organization", "claude-settings"] as const;
export type ClaudeAccessSource = (typeof CLAUDE_ACCESS_SOURCES)[number];

/** What the account row says the access is, in place of a plan. */
export const CLAUDE_ACCESS_LABEL: Record<ClaudeAccessSource, string> = {
  organization: "set up by your organization",
  "claude-settings": "from your Claude Code settings",
};

/**
 * The name of a Claude account on such access. Claude's row follows its
 * current identity (docs/principles.md), and the access is that identity:
 * an account that signed in with a subscription before and now signs in
 * with the access stops carrying the subscription's email.
 */
export const CLAUDE_ACCESS_ACCOUNT_LABEL = "Claude Code access";

/**
 * The row's words when Claude Code's settings name only an address, with no
 * token command: the subscription sign-in still serves, and its requests
 * go to that address instead of Claude's own.
 */
export const CLAUDE_GATEWAY_LABEL: Record<ClaudeAccessSource, string> = {
  organization: "sent through your organization's address",
  "claude-settings": "sent through the address in your Claude Code settings",
};

/** What Connect and the row's Try again say once the access is in use: nothing opens. */
export const CLAUDE_ACCESS_IN_USE_TEXT: Record<ClaudeAccessSource, string> = {
  organization: "Using the Claude access your organization set up for Claude Code.",
  "claude-settings": "Using the Claude access in your Claude Code settings.",
};

/**
 * The allowance line: the organization or the person's gateway sets the
 * limits, and Infinitary reads none of them. Never a zero.
 */
export const CLAUDE_ACCESS_ALLOWANCE_TEXT: Record<ClaudeAccessSource, string> = {
  organization: "Your organization sets this allowance, so Infinitary doesn't measure it.",
  "claude-settings":
    "The address in your Claude Code settings sets this allowance, so Infinitary doesn't measure it.",
};

/**
 * The row while Claude refused the access: the sign-in behind the token
 * command lapsed. It is renewed the way the person renews it for Claude
 * Code, never with a Claude browser sign-in here.
 */
export const CLAUDE_ACCESS_REFUSED_TEXT: Record<ClaudeAccessSource, string> = {
  organization:
    "Work is paused because your organization's Claude sign-in was refused. Renew it the way your organization asks, then press Try again.",
  "claude-settings":
    "Work is paused because the Claude sign-in in your Claude Code settings was refused. Renew it, then press Try again.",
};

/**
 * The first mate's pause when Claude refused the access: what stopped it,
 * in place of a sign-in to redo, and the way back.
 */
export const CLAUDE_ACCESS_PAUSED_SENTENCE: Record<ClaudeAccessSource, string> = {
  organization: "Your organization's Claude sign-in was refused.",
  "claude-settings": "The Claude sign-in in your Claude Code settings was refused.",
};

/** A sign-in card's title, a crewmate's or the first mate's, on a refused access. */
export const CLAUDE_ACCESS_SIGN_IN_TITLE = "Claude refused the sign-in set up for Claude Code";

/** The first mate's pause card's title on a refused access. */
export const CLAUDE_ACCESS_PAUSE_TITLE = "Your first mate's Claude sign-in was refused";

/**
 * The plain line when Claude refused the access - under the first mate's
 * reply and on a crewmate's failed turn in the feed - in place of a sign-in
 * to redo, in the plain lines' own style (`plainProblem`).
 */
export const CLAUDE_ACCESS_REFUSED_LINE: Record<ClaudeAccessSource, string> = {
  organization: "your organization's Claude sign-in was refused - renew it, then press Try again",
  "claude-settings":
    "the Claude sign-in in your Claude Code settings was refused - renew it, then press Try again",
};

/** The pause card's way back on a refused access: renewed where Claude Code's is. */
export const CLAUDE_ACCESS_RENEW_WORDS: Record<ClaudeAccessSource, string> = {
  organization: "Renew it the way your organization asks, then choose Try again.",
  "claude-settings": "Renew it, then choose Try again.",
};

/** The row's button in place of Sign in: it checks the access again and opens nothing. */
export const CLAUDE_ACCESS_TRY_AGAIN_LABEL = "Try again";

/**
 * A crewmate's or the first mate's card when Claude refused the access:
 * who could not reach Claude, why, and where the way back is. `where` names
 * the computer a task runs on, when it is not this one.
 */
export function claudeAccessRefusedText(
  who: string,
  source: ClaudeAccessSource,
  where?: string,
): string {
  const there = where ? ` ${where}` : "";
  return source === "organization"
    ? `${who} could not reach Claude because your organization's Claude sign-in was refused${there}. Renew it the way your organization asks, then press Try again on Claude in Settings → Intelligence.`
    : `${who} could not reach Claude because the Claude sign-in in your Claude Code settings was refused${there}. Renew it, then press Try again on Claude in Settings → Intelligence.`;
}
