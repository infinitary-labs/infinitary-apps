import type { Card, CardMessage, CardThread } from "@shared/cards";
import type { CrewResponse } from "@shared/crewResponses";
import type { FmEvent } from "@shared/events";
import type { CardStore } from "../storage/cardStore";
import type { TaskService } from "../tasks/taskService";
import type { AskEnding } from "./askEnding";
import type { CardEvidence } from "./cardEvidence";
import type { CardService } from "./cardService";
import type { CardStage } from "./cardStage";
import type { MergeBehind } from "./settleCardFacts";

export type CardActor = "captain" | "firstmate" | "crewmate";
type CardResponse = Parameters<AskEnding["captainResponded"]>[1];

/**
 * The author whose close-out releases its cards to the stage: a crewmate by
 * its task, or the Firstmate.
 */
export type CardAuthorRef = { kind: "crewmate"; taskId: string } | { kind: "firstmate" };

/**
 * What closed the author out: a crewmate's `report` or its idle (a turn
 * end, or the task ending), the Firstmate's turn end, or a restart, which
 * ended every author's turn.
 */
export type CloseOut = "report" | "idle" | "turn-end" | "restart";

/** What the card stack needs from the supervisor that composes it. */
export type CardServiceHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  cardStore: CardStore;
  /** A card placed, revised or gone on a task: the ladder's captain gate follows. */
  syncCaptainGate(taskId: string, now: number): void;
  /** An answer task closes on its card's resolution (Task B); whether it did. */
  closeAnsweredTask(card: Card, action: string, by: CardActor): boolean;
  /** The fact strip and the follow-ups a settle card carries (HTML fragments). */
  settleFacts(taskId: string): string | undefined;
  /** The words a settle card's merge reads now, when the host names it; undefined leaves it. */
  mergeLabel?(card: Card): string | undefined;
  /** Whether a settle card offers Merge anyway beside its merge now (INF-1137 friction 6). */
  mergeAnyway?(card: Card): boolean;
  /** Why a merge card no longer shows its task's current change (INF-4031, `CardActions.mergeBehind`). */
  mergeBehind?(card: Card): MergeBehind | null | undefined;
  /**
   * A merge card the strip's pass read behind its change (INF-4031): the
   * host redraws it at the current story or wakes its author. Called after
   * the pass, never inside the task read it runs in.
   */
  mergeFellBehind?(cardId: string, behind: MergeBehind): void;
  /**
   * Whether a story note stays off the stack until its task's merge has a
   * result (INF-2533): the task merges on its own, is open, and its change
   * has not merged. Read from typed facts, never the card's words.
   */
  holdsUntilMerge?(card: Card): boolean;
  /**
   * The merged line a story note carries once its change's receipt says
   * merged (INF-2678); undefined while it has not, and for any other card.
   */
  mergedLine?(card: Card): string | undefined;
  /**
   * Another of the task's pull requests the record keeps that has not
   * merged, besides the one its completion offer merges (INF-2525).
   */
  otherChangeOpen?(taskId: string): boolean;
  followupNotice(taskId: string): string | undefined;
  /**
   * Whether the captain's choice on this card still waits on its author's
   * lane, not yet handed to a turn (`InboxStore.holdsUndeliveredChoice`).
   * Absent reads as heard.
   */
  choiceUnheard?(card: Card): boolean;
  broadcastCrewCounts(): void;
  broadcastEvent: (event: FmEvent) => void;
  broadcastCards: (cards: Card[]) => void;
  presentationChanged?: () => void;
  /** One card's thread, whole, after any message lands on it (phase 1). */
  broadcastThread?: (thread: CardThread) => void;
  /**
   * The captain chose an action on a card or closed it: the message it may
   * answer hears it (INF-1610, `AskEnding.captainResponded`).
   */
  captainResponded?: (card: Card, response: CardResponse, action?: string) => void;
  /**
   * A card was placed, revised or released onto the stage from its
   * close-out hold: a notice it answers may be taken back.
   */
  cardPlaced?: (card: Card) => void;
  /** The app build every observation is stamped with (docs/card-evidence.md). */
  build?: string;
  /**
   * A card answer carries a correlated response (INF-2222's one writer):
   * check it names a live request, this card's lifecycle and the captain
   * message the line answers, before anything is written; then save it in
   * the same transaction as the line. Absent, a response is refused.
   */
  checkCardResponse?: (
    taskId: string,
    response: CrewResponse,
    card: { id: string; lifecycleId?: string; messageId?: number },
  ) => void;
  submitCardResponse?: (
    taskId: string,
    response: CrewResponse,
    text: string,
    line: { cardId: string; messageId: number },
  ) => void;
};

/**
 * The open stack as its owners share it (`CardThreads`, `CardEmits`): the
 * cards and what the stage holds back (`CardStage`), the one evidence writer, and the
 * stack's own moves, so a write from any owner lands, places and broadcasts
 * the way every other write does.
 */
export type CardStack = {
  cards: Map<string, Card>;
  stage: CardStage;
  evidence: CardEvidence;
  shown(id: string): Card | undefined;
  snapshot(): Card[];
  addMessage: CardService["addMessage"];
  placed(card: Card): void;
  scheduleBroadcast(): void;
  broadcastSnapshot(): void;
  topPriority(floor: number): number;
  othersOpen(taskId: string, except: string | undefined): boolean;
  resolve: CardService["resolve"];
  ended: Pick<CardService["ended"], "has">;
};
