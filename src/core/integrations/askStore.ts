import type {
  IntegrationAllowance,
  IntegrationAsk,
  WriteAsk,
  WriteAskOutcome,
} from "@shared/writeAsk";

/**
 * Where the integrations service keeps a call's ask for the captain's click,
 * and what that click did (docs/integrations.md, "The rules"). The host
 * writes the store over its task records; the service only calls it.
 */
export type IntegrationAskStore = {
  /** Keep the ask, answering the task's waiting asks the cap dropped for it (`WRITE_ASK_CAP`). */
  keep: (taskId: string, ask: IntegrationAsk) => readonly WriteAsk[] | void;
  /**
   * Put the ask on its task's approval card: the card already waiting for
   * the same connection, or a new one (INF-2993 piece 2), refusing the
   * waiting asks the cap dropped. It answers whether the ask joined a card
   * that was already up.
   */
  present?: (taskId: string, ask: IntegrationAsk, dropped: readonly WriteAsk[]) => boolean | void;
  /**
   * The first mate has no task (INF-1108): the host files the row its card
   * gates (`TaskService.capture.fileHostCardTask`), keeps the ask there and
   * presents the card, answering with its id. Absent, the first mate's call
   * is refused.
   */
  keepForFirstmate?: (ask: IntegrationAsk) => string;
  /**
   * A panel has no task either: the host keeps its ask on a row it files
   * for the card, one card per panel and action at a time
   * (docs/integrations.md, "Panels"). It answers the new card's id, or that
   * one is already up for that panel and action, or that the captain chose
   * Not now and the panel's line has not asked again since. Absent, a
   * panel's call that asks is refused.
   */
  keepForPanel?: (ask: IntegrationAsk) => PanelAskKept;
  take: (taskId: string, askId: string) => IntegrationAskTaken;
  record: (taskId: string, askId: string, outcome: WriteAskOutcome) => void;
  /**
   * Keep the captain's Allow for the rest of this task on the asking task
   * (INF-2993), and read a task's allowances, none once it closed. Absent,
   * the choice runs the call once and keeps nothing.
   */
  allow?: (taskId: string, allowance: IntegrationAllowance) => void;
  allowances?: (taskId: string) => readonly IntegrationAllowance[];
};

/** What keeping a panel's ask came to (`IntegrationAskStore.keepForPanel`). */
export type PanelAskKept = { card: string } | { held: "asking" | "declined" };

/** A kept ask the captain's click took, once, or why it took none. */
export type IntegrationAskTaken = { ask: WriteAsk } | { refused: string };

/** What the captain's click on a kept integration ask did. */
export type IntegrationAskSent = {
  ok: boolean;
  ask?: IntegrationAsk;
  /** The action's name, as it was kept. */
  call: string;
  place: string;
  outcome: WriteAskOutcome;
  answer?: string;
  /** The captain's Allow for the rest of this task this click kept (INF-2993). */
  allowance?: IntegrationAllowance;
};
