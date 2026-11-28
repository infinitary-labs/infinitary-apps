import type { AttachmentRef } from "@shared/attachments";
import { type CutOff, isAuthFailureMessage } from "@shared/authFailure";
import type { TurnFailureReason } from "@shared/diagnostics";
import { isRunawayProviderError } from "@shared/plainProblem";
import type { KnowledgeOrigin } from "../knowledge/origin";
import type { TurnOrigin } from "./askCapture";
import type { ReplyFacts } from "./replyLine";
import type { TagSuggestionFacts } from "./tagSuggestionNote";

/**
 * The running turn, field by field: what it read, did and met. One record
 * for the agent and the owners its tools and context reach; `runTurn`
 * clears what each turn starts afresh, and the wake that begins a turn
 * stamps its origin first.
 */
export type FirstmateTurn = {
  /**
   * Set when the current turn ends in a provider error (Pi resolves such
   * turns instead of rejecting), so runTurn's ack-after-handling releases
   * the inbox batch for retry instead of deleting it.
   */
  failed: boolean;
  contextOverflow: boolean;
  /** The running turn's failure text, for the ask it files. */
  error?: string;
  /** The coarse kind of this turn's first failure, for Diagnostics; never its text. */
  failureKind?: TurnFailureReason;
  /**
   * Origin and create-gate for the in-flight turn, stamped from the wake
   * (never from model prose). Default is fail-closed for creates.
   */
  origin: KnowledgeOrigin;
  canCreate: boolean;
  appWake: "captain" | "captain-choice" | "scheduled" | "other";
  /** The closing assistant text of the running turn: its reply line, a card-thread answer, a fallback question's answer. */
  closingText?: string;
  delivered: boolean;
  replyFacts: ReplyFacts;
  /** Exact inputs waiting for the backend's read witness, in send order. */
  pendingReads: { sha: string; asks: string[]; inboxIds: number[] }[];
  read: Set<string>;
  /** The automation runs, clicks and reports the running turn has read, in reading order. */
  originsRead: TurnOrigin[];
  /**
   * The Firstmate card this captain turn is about (phase 2). Set only for
   * an idle runTurn so closing prose can land in that card's thread.
   */
  aboutCardId?: string;
  /** The captain's words the running turn answers, for the digest. */
  asked: string[];
  /**
   * The running turn carries words the captain typed - a message, parked or
   * live, or a steer - never only a card choice's label or a choice the app
   * carried out (INF-6091; the hold `card-question` reads it).
   */
  typed: boolean;
  /** The tools the running turn called, for the digest. */
  tools: string[];
  cutOff?: CutOff;
  /** That cut-off paused the seat: the ladder's card speaks for it. */
  pausing: boolean;
  /** The captain's live words the running turn carries on no inbox row. */
  liveCaptain?: AcceptedSteer;
};

/** What each turn starts afresh: its origin, wake, card and live words were stamped before it. */
export function beginTurn(turn: FirstmateTurn, asked: readonly string[], typed: boolean): void {
  Object.assign(turn, {
    failed: false,
    contextOverflow: false,
    error: undefined,
    failureKind: undefined,
    closingText: undefined,
    delivered: false,
    replyFacts: {},
    pendingReads: [],
    originsRead: [],
    asked: [...asked],
    typed,
    tools: [],
    cutOff: undefined,
    pausing: false,
  } satisfies Partial<FirstmateTurn>);
  turn.read.clear();
}

/** One conclusion for every owner settling a running turn. */
export type TurnEnd =
  | { kind: "clean"; failure?: never }
  | {
      kind: "broke" | "failed";
      failure: {
        reason: TurnFailureReason;
        error: string | undefined;
        cutOff: CutOff | undefined;
        pausing: boolean;
        recoverContext: boolean;
      };
    };

export function endedTurn(
  turn: FirstmateTurn,
  threw: boolean,
  recoveryAttempted: boolean,
): TurnEnd {
  if (!threw && !turn.failed) return { kind: "clean" };
  return {
    kind: threw ? "broke" : "failed",
    failure: {
      reason: turn.failureKind ?? turnFailureReason(turn.error, turn.failed),
      error: turn.error,
      cutOff: turn.cutOff,
      pausing: turn.cutOff !== undefined && turn.pausing,
      recoverContext: turn.contextOverflow && !recoveryAttempted && !threw,
    },
  };
}

/**
 * The coarse kind of a failed turn, for Diagnostics: a refused sign-in,
 * the provider's time limit, a provider-failed turn, or anything else that
 * threw. Only the kind leaves; the message never does.
 */
export function turnFailureReason(
  error: string | undefined,
  providerFailed: boolean,
): TurnFailureReason {
  // Classified from the raw message: the model-labelled one moves a status
  // code out of the position the auth classifier reads.
  const message = error ?? "";
  if (isAuthFailureMessage(message) || message.includes("No signed-in model")) return "sign_in";
  if (isRunawayProviderError(message)) return "time_limit";
  return providerFailed ? "provider" : "error";
}

export type AcceptedSteer = {
  words: string;
  attachments?: AttachmentRef[];
  aboutCardId?: string;
  askId?: string;
  /** The Suggest tags press these words came from; its note rides every copy of them. */
  tagSuggestion?: TagSuggestionFacts;
};
