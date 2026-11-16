import type { UseCheck, UseCheckProblem } from "./requests";

/** The one command name, shared by its launcher, help and a granted task's instructions. */
export const SECRETS_COMMAND = "infinitary-secrets-axi";

const SECRETS_USE_START = `Your task can request protected secret access: run \`${SECRETS_COMMAND}\` to list the secrets the captain added, and its help for exact requests, status and cancellation. Before asking, \`check\` the exact run: it says which check fails, or whether asking raises the captain's card. Values and raw recipient output never return to you. Infinitary raises its own approval card; never ask for a value in a card or conversation. `;
const SECRETS_USE_END = `A waiting request releases your shell: end the turn, and its result resumes this task through its inbox. After an app restart, read its status before continuing; never repeat an unknown outcome. Listing or naming a reference grants no access, and approval to use a secret does not authorize an external action.`;

/** Served only with the closed command facade, never because a task names a project or secret. */
export const CREWMATE_SECRETS_LINE = `${SECRETS_USE_START}When the work needs a secret the captain has not kept, run \`ask\` with its name, an optional place and your reason, or \`--replace\` with the reference of one that stopped working: Infinitary draws its own field for the captain, and you hear once which reference was kept, never the value. ${SECRETS_USE_END}`;

/**
 * Served instead to a task on a computer that runs work whose app takes uses
 * (docs/secrets.md, "On a computer that runs work"): the same uses, and no
 * ask to keep a secret, which that computer's command does not offer.
 */
export const CREWMATE_SECRETS_THERE_LINE = `${SECRETS_USE_START}This task runs on another computer, where asking the captain to keep a new secret is not offered: when the work needs one the captain has not kept, name it and its place in your report so the first mate can ask for it. ${SECRETS_USE_END}`;

/**
 * Served instead to a task on another computer, whose command lists the
 * home's catalog and has no use (docs/secrets.md, "Current command seam").
 */
export const CREWMATE_SECRETS_CATALOG_LINE = `Your task can list the secrets the captain added: run \`${SECRETS_COMMAND}\` to list them, or its \`show <reference>\` for one, by name, environment, reference and version, never a value. This task runs on another computer, so it cannot request a use; when the work needs one, say so in your report. Never ask for a value in a card or conversation, and listing or naming a reference grants no access.`;

/** What a use asked from a task on another computer answers beside `unavailable`. */
export const SECRETS_ELSEWHERE_HELP =
  "This task runs on another computer: it can list and show secrets, and a use is requested only by a task on the computer that keeps them. Say so in your report when the work needs one.";

/**
 * What the crew's pre-check answers beside its typed result (docs/secrets.md,
 * "The crew's pre-check"): host words for each failed check and each saved
 * decision a checked run meets, never a backend's text.
 */
export const SECRETS_CHECK_WORDS = {
  problem: {
    secret: `A secret this names is not one your task can use. Run \`${SECRETS_COMMAND}\` to list the secrets the captain added.`,
    folder: "The working folder could not be checked. Run the command from a folder that exists.",
    variable:
      "A variable this names cannot carry a secret: the program keeps it from this computer. Choose another variable name.",
    program:
      "The program was not found: no file at that path from the working folder, and no program by that name on the search path. Name it by its path.",
    interpreter:
      "The script's #! line names no interpreter that could be checked. Name the interpreter as the program and the script as its first argument.",
    unavailable:
      "Secrets cannot check this run now. Nothing was asked; when the work needs it, say so in your report.",
  } satisfies Record<UseCheckProblem, string>,
  decision: {
    ask: "This run passed every check. Inject it with its reason to raise the captain's approval card; nothing has been asked yet.",
    allow:
      "This run passed every check, and a saved decision already allows it: inject runs it without a card.",
    never:
      "This run passed every check, but a saved decision never gives a secret it names: inject is refused. When the work needs it, say so in your report.",
  } satisfies Record<Exclude<UseCheck, { problem: UseCheckProblem }>["decision"], string>,
  /** Beside an inject that answered unavailable: no card was raised. */
  refused: `Nothing was asked: this request did not pass its checks. Run \`${SECRETS_COMMAND} check\` with the same --env and program to see which one, then inject again with a new --id.`,
} as const;

/** The words beside a check's answer. */
export function checkWords(check: UseCheck): string {
  return "problem" in check
    ? SECRETS_CHECK_WORDS.problem[check.problem]
    : SECRETS_CHECK_WORDS.decision[check.decision];
}

/**
 * What an ask to keep a secret answers beside its state (docs/secrets.md,
 * "Asking to keep a secret"): host words, never a backend's.
 */
export const SECRET_ASK_WORDS = {
  waiting:
    "Infinitary's own card asks the captain to type it. End the turn: whether it was kept, and its reference, reach this task once through its inbox.",
  kept: "Already kept under that name and place: use its reference. Nothing was asked.",
  notOffered:
    "Secrets is not offered on this computer, so nothing was asked. Say so in your report.",
  /** A task on a computer that runs work, whose command takes uses but no ask. */
  notHere:
    "Asking to keep a secret is not offered on this computer, so nothing was asked. Name the secret and its place in your report so the first mate can ask for it.",
  cannotRead:
    "Secrets storage cannot be read now, so the secret this replaces could not be named. Nothing was asked; ask again later.",
  noSuchSecret: "That reference names no secret the captain added. List them, then ask again.",
  cancelled: "The asker withdrew it.",
  closed: "The task that asked has closed.",
} as const;
