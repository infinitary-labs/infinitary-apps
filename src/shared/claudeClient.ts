import { HERE } from "./deviceNames";
/**
 * The Claude client is the one the person installed (F14, captain lock
 * 2026-09-20): the app ships no copy and downloads none. When the machine
 * has none, or one too old for the SDK, the account is not signed out - its
 * credential is fine - but it cannot serve, and the ONE sentence below is
 * what the account row, the connect chip and a refused spawn say about it.
 * Shared so the renderer and the core never drift on the words.
 *
 * "Claude Code" is the name of the app the person installs and signs in to,
 * which is why it appears here and nowhere else on a user surface: the
 * standing rule hides the machinery that reaches Claude (harness, SDK,
 * transport, config dir), and the person's own installed app is not that.
 */

/** Health/status reason: no client on this machine. */
export const CLIENT_MISSING = "client_missing";
/** Health/status reason: a client older than the SDK's co-released one. */
export const CLIENT_OUTDATED = "client_outdated";

export function isClientIssueReason(reason: string | undefined): boolean {
  return reason === CLIENT_MISSING || reason === CLIENT_OUTDATED;
}

export const CLAUDE_CLIENT_MISSING_TEXT = `Claude Code isn't installed on ${HERE.this}. Install it to use Claude here.`;

/** One plain line naming the fix: the client's own updater (plan.md 1.6). */
export function claudeClientOutdatedText(version: string, floor: string): string {
  return `Claude Code ${version} is installed; ${floor} or newer is needed. Run "claude update".`;
}

/** The note beside the disabled Claude chip while no client is installed. */
export const CLAUDE_CHIP_INSTALL_NOTE = "install Claude Code first";
