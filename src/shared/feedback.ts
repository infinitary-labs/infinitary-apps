/**
 * `/feedback` (docs/feedback.md): a message whose first word is the
 * command word reaches the first mate as a feedback request for
 * Infinitary's makers, from any message field. The command word is a typed
 * fact the host reads; what the words mean stays the agents' judgment.
 */

/** The command word, as a person types it. */
export const FEEDBACK_WORD = "/feedback";

/** What Send feedback starts the message box with. */
export const FEEDBACK_DRAFT = `${FEEDBACK_WORD} `;

/** The crewmate's command for a feedback report (docs/axi-commands.md, "The feedback command"). */
export const FEEDBACK_COMMAND = "infinitary-feedback-axi";

/** The kinds of report an issue can be. */
export const FEEDBACK_KINDS = ["bug", "idea"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** The longest filled-in new-issue link the app offers without a GitHub sign-in: GitHub refuses longer addresses. */
export const FEEDBACK_LINK_MAX = 8000;

/** GitHub's longest issue title, in characters. */
export const GITHUB_ISSUE_TITLE_MAX = 256;

/** GitHub's longest issue or comment body, in characters. */
export const GITHUB_ISSUE_BODY_MAX = 65_536;

const LEADING = /^\s*\/feedback(?=\s|$)/i;

/**
 * Whether a message is a feedback request: its first word is `/feedback`,
 * in any letter case, alone or followed by a space or a new line.
 */
export function isFeedbackRequest(text: string | null | undefined): boolean {
  return typeof text === "string" && LEADING.test(text);
}

/** The hidden mark at the end of every issue the app drafts, which the project's triage reads. */
export function feedbackMark(kind: FeedbackKind, version: string): string {
  return `<!-- infinitary-feedback v1 kind=${kind} version=${version.replace(/[^0-9A-Za-z.+-]/g, "")} -->`;
}
