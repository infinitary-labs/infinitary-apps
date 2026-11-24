import type { Card } from "@shared/cards";
import type { CardResolution } from "../storage/cardStore";
import type { CardThreads } from "./cardThreads";
import { answersWithAuthorWordsMarked } from "./readerData";

type ReaderCards = {
  readonly threads: Pick<CardThreads, "readerCard" | "servedCardWords">;
  newestForTask(taskId: string): Card | undefined;
  newestResolutionForTask(taskId: string): CardResolution | undefined;
};

/** A task's newest card body as the by-key read serves it (`CardThreads.servedCardWords`). */
export function servedNewestBody(cards: ReaderCards, taskId: string): string | undefined {
  const card = cards.newestForTask(taskId);
  return card ? cards.threads.servedCardWords(card, card.body) : undefined;
}

/**
 * A task's newest captain resolution as the by-key read serves it
 * (`newestResolutionForTask`): a reader's card and closing offer with
 * their title, body, button labels and the option labels in the
 * captain's answers marked as data, the captain's own written words left
 * as written, with the same marks as the newest body, so a body the two
 * share is still shown once.
 */
export function servedResolutionForTask(
  cards: ReaderCards,
  taskId: string,
): CardResolution | undefined {
  const resolved = cards.newestResolutionForTask(taskId);
  if (!resolved || !cards.threads.readerCard(resolved.card)) return resolved;
  const card = resolved.card;
  const words = (text: string) => cards.threads.servedCardWords(card, text);
  const actions = <T extends { label: string }>(list: T[]) =>
    list.map((action) => ({ ...action, label: words(action.label) }));
  return {
    ...resolved,
    ...(resolved.answers ? { answers: answersWithAuthorWordsMarked(resolved.answers, words) } : {}),
    card: {
      ...card,
      title: words(card.title),
      body: words(card.body),
      actions: actions(card.actions),
    },
    ...(resolved.offer
      ? {
          offer: {
            ...resolved.offer,
            title: words(resolved.offer.title),
            body: words(resolved.offer.body),
            actions: actions(resolved.offer.actions),
          },
        }
      : {}),
  };
}
