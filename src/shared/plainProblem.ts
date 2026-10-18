import {
  CUT_OFF_CLASSES,
  type CutOff,
  type CutOffClass,
  isAuthFailureMessage,
} from "./authFailure";
import { HERE } from "./deviceNames";

/**
 * What a failure means for the person, in the vocabulary's words (roadmap
 * 1.5; the design skill's `copy/Vocabulary.prompt.md`, row "error,
 * exception, stack, 401, 403, ENOENT"). A feed line never passes a raw error
 * through: it says what happened and what to do, and the raw text stays one
 * click deeper - on the task's timeline in the record, and in Observe.
 *
 * Each rule keys on a KNOWN error shape; anything else is the plain
 * fallback, never a guess from loose words in free text. Auth reuses the
 * one classifier (`isAuthFailureMessage`), so a feed line and the sign-in
 * card can never disagree about whether a failure was a sign-in.
 *
 * A failure from a backend that reports it typed (`TypedFailure`, docs/quota.md
 * "Typed cut-offs") is never classified from its words: its cut-off class
 * picks the line, and without one the rules that would read a class out of
 * the words (sign-in, allowance, slow down) are skipped.
 */

/**
 * How a forge phrases a host's REST answer (`GitHub answered 409 to PUT
 * /repos/...`, `GitLab answered 422 to PUT /projects/...`, or a self-hosted
 * server by its own address): the start of every rule below that reads one.
 */
const FORGE_PLACE = String.raw`(?:GitHub|GitLab|[a-z0-9-]+(?:\.[a-z0-9-]+)+)`;
const ANSWERED = `^${FORGE_PLACE} answered`;

/** A host's REST answer with one of these statuses, as the forge phrases it. */
function answered(statuses: string): RegExp {
  return new RegExp(`${ANSWERED} (?:${statuses}) to [A-Z]+ /`);
}

/**
 * The merge endpoint's refusal of a change that conflicts with newer work
 * (GitHub's 405, or 409 beside the words; GitLab's "Branch cannot be
 * merged"), as it reads on a settle's `problem`. A head mismatch alone is no
 * conflict.
 */
export function isMergeConflict(error: string | undefined): boolean {
  return (
    error !== undefined &&
    (/^GitHub answered 40[59] to PUT \S+\/merge: .*(?:merge conflicts|not mergeable)/i.test(
      error,
    ) ||
      new RegExp(`${ANSWERED} 4(?:06|22) to PUT \\S+/merge: Branch cannot be merged`).test(error))
  );
}

/** True when the provider error is the grok thinking-runaway class. */
export function isRunawayProviderError(error: string): boolean {
  return (
    /max_time_limit/i.test(error) ||
    /internal error during token generation/i.test(error) ||
    /timed out after/i.test(error)
  );
}

type Rule = {
  test: (error: string) => boolean;
  line: string;
  /** The rule reads a cut-off class out of words; a typed failure never uses it. */
  readsClass?: true;
};

/** A failure a typed backend reported: its cut-off class, when it has one. */
export type TypedFailure = { cutOff?: CutOff };

const SIGN_IN_LINE = "the provider did not accept your sign-in - sign in again";
const ALLOWANCE_LINE = "your plan's allowance ran out - it comes back when it resets";

/**
 * Git and GitHub failures, checked FIRST so a project's host never reads as
 * the AI provider: git's and gh's own words for a sign-in the host refused,
 * a project it cannot find, and a host it cannot reach, plus the three
 * refusals the local put-in writes itself (`WorkspaceService.landTaskWork`).
 * Keyed on the exact texts those programs print, never on loose words.
 */
const GIT_RULES: readonly Rule[] = [
  // The app's own sign-in where projects live (git integration PR 1.2):
  // the forge seam's words for no sign-in, and a host's REST answers as the
  // REST forges phrase them (`GitHub answered <status> to <request>`).
  {
    test: (error) => /^Not signed in to [^()]+ \([a-z0-9.-]+\)/.test(error),
    line: `the app is not signed in where the project lives - sign in under Settings, Projects, or keep the project on ${HERE.this}`,
  },
  {
    test: (error) => answered("401").test(error),
    line: `the project's host did not accept the sign-in on ${HERE.this} - sign in again under Settings, Projects`,
  },
  {
    test: (error) => answered("403").test(error),
    line: "the project's host did not allow it - ask the project's owner for access",
  },
  {
    test: (error) => answered("404").test(error),
    line: "the project could not be found where it lives",
  },
  {
    // The merge endpoint's refusal of a change that conflicts with newer
    // work: retrying cannot help, bringing the change up to date does.
    test: isMergeConflict,
    line: "it conflicts with newer work in the project - its crewmate needs to bring it up to date",
  },
  {
    test: (error) =>
      new RegExp(`^could not reach ${FORGE_PLACE}: `).test(error) ||
      answered("50[234]").test(error),
    line: "could not reach the project's host - try again",
  },
  {
    test: (error) =>
      /could not read (?:Username|Password) for '|Authentication failed for '|Permission denied \(publickey\)|gh auth login|HTTP 401: Bad credentials/.test(
        error,
      ),
    line: `the project's host did not accept the sign-in on ${HERE.this}`,
  },
  {
    test: (error) => /remote: Repository not found|Could not resolve to a Repository/.test(error),
    line: "the project could not be found where it lives",
  },
  {
    test: (error) =>
      /Could not resolve host: |Failed to connect to \S+ port \d+|error connecting to api\.github\.com/.test(
        error,
      ),
    line: "could not reach the project's host - try again",
  },
  {
    test: (error) => /^The repository has uncommitted changes/m.test(error),
    line: "your project has edits that are not committed yet - commit or set them aside first",
  },
  {
    test: (error) => /^The repository is on a detached HEAD/m.test(error),
    line: "your project is not on a named branch - switch to one first",
  },
  {
    test: (error) => /hit a conflict; resolve it manually/.test(error),
    line: "could not bring it up to date - the work and your project changed the same place",
  },
];

const RULES: readonly Rule[] = [
  ...GIT_RULES,
  {
    test: (error) => isAuthFailureMessage(error) || error.includes("No signed-in model"),
    line: SIGN_IN_LINE,
    readsClass: true,
  },
  { test: isRunawayProviderError, line: "the model ran out of time on its answer - try again" },
  {
    // Checked before the rate limit: a 429 that says the allowance is spent
    // is the allowance, not a request to slow down.
    test: (error) =>
      /\b(?:insufficient_quota|quota exceeded|exceeded your current quota|usage limit|out of credits)\b/i.test(
        error,
      ),
    line: ALLOWANCE_LINE,
    readsClass: true,
  },
  {
    test: (error) =>
      /^\s*429\b|\(429\)|\b(?:status(?:\s+code)?|code)["']?\s*[:=]?\s*["']?429\b|\brate[_ -]?limit|\btoo many requests\b/i.test(
        error,
      ),
    line: "the provider asked to slow down - try again shortly",
    readsClass: true,
  },
  {
    test: (error) =>
      /\b(?:context[_ ]length|context window|maximum context|prompt is too long|context_length_exceeded)\b/i.test(
        error,
      ),
    line: "the conversation grew too long for the model - try again",
  },
  {
    test: (error) =>
      /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|\bconnection error\b|\bfetch failed\b|\bsocket hang up\b|\bnetwork error\b/i.test(
        error,
      ),
    line: "could not reach the provider - try again",
  },
  {
    test: (error) =>
      /^\s*5\d\d\b|\(5\d\d\)|\b(?:status(?:\s+code)?|code|upstream)["']?\s*[:=]?\s*["']?5\d\d\b|\boverloaded\b|\binternal server error\b|\bservice unavailable\b|\bbad gateway\b/i.test(
        error,
      ),
    line: "the provider had a problem on its side - try again",
  },
  {
    test: (error) => /\bENOENT\b|\bcommand not found\b/i.test(error),
    line: `something it needed is missing on ${HERE.this}`,
  },
  {
    test: (error) => /\b(?:AbortError|aborted)\b/i.test(error),
    line: "it was stopped before it finished",
  },
];

/** The fallback when no known shape matches: plain, and still true. */
export const PLAIN_PROBLEM_FALLBACK = "something went wrong - try again";

/** Each cut-off class's line. A refusal has no sentence of its own yet. */
const CUT_OFF_LINES: Record<CutOffClass, string> = {
  signed_out: SIGN_IN_LINE,
  no_headroom: ALLOWANCE_LINE,
  refused: PLAIN_PROBLEM_FALLBACK,
};

const WORD_RULES = RULES.filter((rule) => !rule.readsClass);

/** The plain line for a raw error, or the fallback; a typed failure by its class. */
export function plainProblem(error: string | undefined, typed?: TypedFailure): string {
  if (typed?.cutOff) return CUT_OFF_LINES[typed.cutOff.class];
  const raw = error?.trim() ?? "";
  if (!raw) return PLAIN_PROBLEM_FALLBACK;
  const rules = typed ? WORD_RULES : RULES;
  return rules.find((rule) => rule.test(raw))?.line ?? PLAIN_PROBLEM_FALLBACK;
}

/**
 * The typed failure a timeline event recorded (`TaskService.recordTurnFailure`),
 * or undefined for a failure recorded as prose.
 */
export function typedFailureOf(
  data: Record<string, unknown> | null | undefined,
): TypedFailure | undefined {
  if (data?.failureSignals !== "typed") return undefined;
  const cutOff = data.cutOff;
  if (
    cutOff &&
    typeof cutOff === "object" &&
    CUT_OFF_CLASSES.includes((cutOff as { class?: unknown }).class as CutOffClass)
  ) {
    const { class: cls, resetsAt } = cutOff as { class: CutOffClass; resetsAt?: unknown };
    return { cutOff: { class: cls, ...(typeof resetsAt === "number" ? { resetsAt } : {}) } };
  }
  return {};
}
