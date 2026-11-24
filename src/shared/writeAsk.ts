import type { ChangeRequestKind } from "./forgeKinds";

/**
 * A write a crewmate asked to send where a project lives, kept on its task
 * until the captain's click sends it (FI3-1571 piece 4, `docs/forge.md`,
 * "A write that asks"): one outside the task's own project, any write of a
 * task that only answers but a run start or rerun on its own project, and
 * any write through the github.com sign-in.
 * The host stores the exact call; the card names it by `id` and never
 * carries the call itself, so only what was stored is ever sent.
 */
export type WriteAsk = ForgeWriteAsk | IntegrationAsk | WebReadAsk | BuildRowAsk;

/** A write where a project lives, through its host's REST API. */
export type ForgeWriteAsk = {
  id: string;
  /** The host's kind: GitHub, including Enterprise, or GitLab. */
  kind: ChangeRequestKind;
  /** The host's address: `github.com`, a GitHub Enterprise or GitLab server's own. */
  host: string;
  /** The host in a sentence: "GitHub", "GitLab", or a server's own address. */
  place: string;
  /** Whose sign-in sends it: the project's own host, or the github.com sign-in. */
  via: "project" | "account";
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** The relative path as the host's policy spelled it, with its query. */
  path: string;
  /** The request's JSON text, as the crewmate gave it. */
  body?: string;
  /** A release file in the working copy, relative to it. The bytes are read when the click sends it. */
  file?: string;
  validationEffect?: string;
  /**
   * A /feedback report's issue or comment (docs/feedback.md): the card's
   * strip draws its title and body as readable text, never JSON.
   */
  feedback?: FeedbackAskFacts;
  /**
   * The host's approval card that lists it: an unsafe data reader's write
   * (docs/agents-reach.md, "An unsafe data reader") joins its task's card of
   * waiting writes, or raises its own. Absent on every other crewmate's
   * write, which its crewmate asks for on a card of its own.
   */
  card?: string;
  at: number;
  /** When the captain's click took it, set before it was sent: it is never sent again. */
  sentAt?: number;
  /** What came of the click: the host's answer, an outcome nobody knows, or nothing sent. */
  outcome?: WriteAskOutcome;
};

/**
 * A web page an unsafe data reader asked to open once it held something of
 * the captain's (docs/agents-reach.md, "Web pages"): the address itself
 * could carry what it read, so it waits on the reader's approval card, and
 * the captain's Only this time opens it once, signed out. An address the
 * captain opened this way opens at once after that.
 */
export type WebReadAsk = {
  id: string;
  kind: "web";
  /** The whole address, as the card shows it and the click opens it. */
  url: string;
  /** Its host, as the card and the timeline name where it goes. */
  place: string;
  /** The reader's approval card that lists it. */
  card?: string;
  at: number;
  sentAt?: number;
  outcome?: WriteAskOutcome;
};

/**
 * How a Build row's task starts (docs/agents-reach.md, "A reader's Build
 * rows"): a bug as a read-only reproduce step, an idea as a read-only plan.
 */
export type BuildRowStart = "reproduce" | "plan";

/**
 * An unsafe data reader's `file_followup` naming the open issue it answers
 * (docs/agents-reach.md, "A reader's Build rows"): kept on its task's
 * approval card as a Build row, never filed at once. The captain's click
 * files the brief exactly as the row showed it, starts it on Start now,
 * or files nothing.
 */
export type BuildRowAsk = {
  id: string;
  kind: "build";
  /** The host in a sentence, such as "GitHub". */
  place: string;
  /** The issue's number in the reader's own project, read open when the row was kept. */
  issue: number;
  /** The issue's page where the project lives, as the row links it. */
  issueUrl: string;
  start: BuildRowStart;
  title: string;
  goal: string;
  why: string;
  /** The host's approval card that lists it, beside the reader's kept writes. */
  card?: string;
  at: number;
  sentAt?: number;
  outcome?: WriteAskOutcome;
};

/** A Build row's three answers on its card, Keep for later the one it comes picked with. */
export const BUILD_ROW_CHOICES = ["start", "later", "skip"] as const;
export type BuildRowChoice = (typeof BUILD_ROW_CHOICES)[number];
export const BUILD_ROW_FIELD = "inf-build-";
export function buildRowFieldOf(askId: string): string {
  return `${BUILD_ROW_FIELD}${askId}`;
}
/**
 * Each Build row's answer as the click read it; a row the click carries no
 * reading of keeps Keep for later, which starts nothing.
 */
export function buildRowChoiceOf(
  answers: readonly { name: string; values: readonly string[] }[] | undefined,
  askId: string,
): BuildRowChoice {
  const value = answers?.find((answer) => answer.name === buildRowFieldOf(askId))?.values[0];
  return (BUILD_ROW_CHOICES as readonly string[]).includes(value ?? "")
    ? (value as BuildRowChoice)
    : "later";
}

/** What a feedback write is, beside its exact call: its kind, title, the issue it comments on and whose account sends it. */
export type FeedbackAskFacts = {
  kind: "bug" | "idea";
  title: string;
  commentOn?: number;
  /** The GitHub account the sign-in last said it is, as the captain's card names it. */
  login?: string;
};

/**
 * An integration's action at Asks you, requested with the agent's reason (`docs/integrations.md`, "The rules"): kept the same
 * way, with the exact checked input, and run once on the captain's click
 * through the integration's own binding.
 */
export type IntegrationAsk = {
  id: string;
  kind: "integration";
  /**
   * The first mate asked it, so it waits on the row the host filed for its
   * card and runs as the first mate's call (INF-1108); `panel`, a panel
   * asked it, so it waits the same way and runs as that panel's call
   * (`panel`); absent, the task's crewmate asked it.
   */
  by?: "firstmate" | "panel";
  /** The panel that asked it (`by: "panel"`): its key and what the card calls it. */
  panel?: { key: string; title: string };
  /** The integration's id, such as `google`. */
  integration: string;
  /**
   * Which connection the id stood for when it was asked
   * (docs/integrations.md, "Which connection"); absent on an ask kept
   * before connections had one, which is never sent.
   */
  connection?: string;
  /** Its name when it was asked, as the card says it. */
  place: string;
  action: string;
  /** Facts shown on the host's approval card (absent on older kept asks). */
  label?: string;
  description?: string;
  effect?: "reads" | "changes" | "sends";
  reason?: string;
  signature?: string;
  /** The action's input as JSON text, after its schema checked it. */
  input: string;
  /**
   * What Allow for the rest of this task would cover for a crewmate's ask
   * (INF-2993), read from its input when it was asked; absent on the first
   * mate's, a panel's and older kept asks, whose cards offer no such choice.
   */
  scope?: IntegrationScope;
  /**
   * The approval card that lists it (INF-2993 piece 2): a crewmate's ask
   * that arrives while an unanswered card of its task waits for the same
   * connection joins that card. Absent on asks kept before cards listed
   * several, whose card is `integration-ask-<id>`.
   */
  card?: string;
  at: number;
  sentAt?: number;
  outcome?: WriteAskOutcome;
};

/**
 * The calls one allowance covers (`IntegrationActionSpec.scope`): `key`
 * compares two calls, and `words` say it to the captain and the crewmate,
 * such as "POST requests to octo/repo".
 */
export type IntegrationScope = { key: string; words: string };

/**
 * The captain's Allow for the rest of this task (INF-2993), kept on the
 * task: its crewmate's later calls of the same action, within the same
 * scope, run without a card until the task closes. It binds what ends
 * Always allow - the connection's reference, the action's signature and
 * the action's rule mark, which every Settings change of that action's rule
 * or switch renews - and `card` is the approval card it was chosen on.
 */
export type IntegrationAllowance = {
  connection: string;
  action: string;
  signature: string;
  scope: string;
  words: string;
  /** The action's rule mark when it was chosen (`IntegrationSettingsStore.ruleMarks`). */
  mark: string;
  at: number;
  card: string;
};

/**
 * Whether an allowance covers a task's waiting ask (INF-2993): the same
 * connection, action, signature and scope. The ask's rule is checked again
 * when it runs.
 */
export function allowanceCovers(allowance: IntegrationAllowance, ask: IntegrationAsk): boolean {
  return (
    ask.by === undefined &&
    ask.scope !== undefined &&
    ask.connection === allowance.connection &&
    ask.action === allowance.action &&
    ask.signature === allowance.signature &&
    ask.scope.key === allowance.scope
  );
}

export type WriteAskOutcome =
  | { kind: "answered"; status: number; requestId: string | null }
  /** An integration's action ran and answered. */
  | { kind: "ran" }
  | { kind: "unknown"; why: string }
  | { kind: "refused"; why: string }
  /** A Build row's task was filed, and started on Start now. */
  | {
      kind: "filed";
      /** The filed task's key. */
      task: string;
      /** The captain picked Start now, and the app asked for its start. */
      started: boolean;
      /** What that start answered, such as a refusal or that the first mate applies directions first. */
      start?: string;
    };

/**
 * How many asks a task keeps, newest first. Past it the oldest answered ask
 * drops first, and a waiting one only when none answered is left; a waiting
 * ask that drops is refused at once (INF-2993 piece 2).
 */
export const WRITE_ASK_CAP = 8;

/** What the crewmate hears of a waiting ask the cap dropped. */
export const DROPPED_ASK_WHY = `more than ${WRITE_ASK_CAP} asks waited on this task, so the app dropped this one, the oldest, before the captain answered it. Nothing ran; ask again if it is still needed.`;

/** What a refusal says about a send the captain's click already took: it is never sent again. */
export const NEVER_SENT_AGAIN = "never sent again";
