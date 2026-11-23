import type { ConversationRound } from "@shared/conversation";
import { forgetReadingPlace } from "../cards/cardReadingPlace";

/**
 * One visit to the conversation, kept while it stays open (INF-6364's
 * review, the captain's choice "Come back where you were reading, until you
 * close it"): the rounds read so far and whether the reader stood at the
 * foot. Opening a card from it unmounts it while the stage keeps a live
 * card ready instead, so the card keeps neither itself. Its scroll place is
 * the reading place `conversationReadingPlaceId` names. Like reading places,
 * it lives for this session only.
 */
export type ConversationLoaded = {
  rounds: ConversationRound[];
  more: boolean;
  /** The core could not be read: the two rounds the strip holds stand in. */
  fallback: boolean;
};

export type ConversationVisit = { loaded: ConversationLoaded; atFoot: boolean };

let visit: ConversationVisit | null = null;

export const keptConversationVisit = (): ConversationVisit | null => visit;

export function keepConversationVisit(next: ConversationVisit): void {
  visit = next;
}

/** Closing the conversation, or opening it afresh at a round, ends the visit. */
export function forgetConversationVisit(): void {
  visit = null;
  forgetReadingPlace(conversationReadingPlaceId);
}

export const conversationReadingPlaceId = "conversation:thread";
