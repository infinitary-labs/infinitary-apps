/** The one command name, shared by its launcher, help and a granted task's instructions. */
export const SECRETS_COMMAND = "infinitary-secrets-axi";

/** Served only with the closed command facade, never because a task names a project or secret. */
export const CREWMATE_SECRETS_LINE = `Your task can request protected secret access: run \`${SECRETS_COMMAND}\` to list the secrets the captain added, and its help for exact requests, status and cancellation. Values and raw recipient output never return to you. Infinitary raises its own approval card; never ask for a value in a card or conversation. A waiting request releases your shell: end the turn, and its result resumes this task through its inbox. After an app restart, read its status before continuing; never repeat an unknown outcome. Listing or naming a reference grants no access, and approval to use a secret does not authorize an external action.`;

/**
 * Served instead to a task on another computer, whose command lists the
 * home's catalog and has no use (docs/secrets.md, "Current command seam").
 */
export const CREWMATE_SECRETS_CATALOG_LINE = `Your task can list the secrets the captain added: run \`${SECRETS_COMMAND}\` to list them, or its \`show <reference>\` for one, by name, environment, reference and version, never a value. This task runs on another computer, so it cannot request a use; when the work needs one, say so in your report. Never ask for a value in a card or conversation, and listing or naming a reference grants no access.`;

/** What a use asked from a task on another computer answers beside `unavailable`. */
export const SECRETS_ELSEWHERE_HELP =
  "This task runs on another computer: it can list and show secrets, and a use is requested only by a task on the computer that keeps them. Say so in your report when the work needs one.";
