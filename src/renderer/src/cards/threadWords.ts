import type { CardMessageWho } from "@shared/cards";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/** Who wrote a thread's message, in the words the thread shows (`CardThread.tsx`, and the phone's card). */
export const THREAD_WHO_LABELS: Readonly<Record<CardMessageWho, string>> = {
  get captain() {
    return m.cardThreadWhoCaptain();
  },
  get crewmate() {
    return m.cardThreadWhoCrewmate();
  },
  get firstmate() {
    return m.cardThreadWhoFirstmate();
  },
  get host() {
    return m.cardThreadWhoHost();
  },
};

/**
 * The thread's live tail while the author's turn runs. Like `THREAD_CARD`
 * and `THREAD_CARD_UPDATED`, it holds the source language's words as the
 * module loads, for the phone's generated words; the window words it when
 * shown (`m.cardThreadWorking`).
 */
export const THREAD_WORKING = m.cardThreadWorking();

/** The folded line over the settings a reply carried. */
export function settingsCountWords(count: number): string {
  return m.cardThreadSettingsCount({ count });
}

/** How many messages a thread holds: the collapsed thread's latest line, and the phone's. */
export function messageCountWords(count: number): string {
  return m.cardThreadMessageCount({ count });
}

/** The name the collapsed thread's latest line reads to assistive technology: its count words, or that the author is working. */
export function threadCueLabel(count: string, working: boolean): string {
  return working ? m.cardThreadCueWorking() : m.cardThreadCue({ count });
}

/** The replies that came while the card showed its face: the phone's latest line (INF-1919). */
export function newCountWords(count: number): string {
  return m.cardThreadNewCount({ count: formatNumber(count) });
}

/**
 * The thread's jump down while the captain reads above its foot (INF-3124):
 * a plain arrow until messages arrive below, then how many came, on the Mac
 * and the phone's card back.
 */
export function threadJumpWords(count: number): string {
  return count > 0 ? `↓ ${newCountWords(count)}` : "↓";
}

/** What the jump down reads to assistive technology on the Mac. */
export function threadJumpLabel(count: number): string {
  return count > 0 ? m.cardThreadJumpNew({ count }) : m.cardThreadJumpLatest();
}

/** The thread with its count: the in-place rung's segment, and the head of the phone card's back. */
export function threadCountWords(count: number): string {
  return m.cardThreadCount({ count: formatNumber(count) });
}

/** The way back from the thread to the card's face: the in-place rung's segment, and the phone card's back. */
export const THREAD_CARD = m.cardThreadCard();

/** The card changed while its thread showed: what the mark beside the phone card back's Card says (INF-2565). */
export const THREAD_CARD_UPDATED = m.cardThreadCardUpdated();

/**
 * Who really wrote a thread line that is not the card's own answerer's, and
 * whether it is a clarification on a closed card (docs/card-threads.md,
 * "Shared cards"): the same words on the Mac and the phone. `label` is the
 * host's own name for the writer, such as "the crewmate on INF-12".
 */
export function contributorWords(line: {
  host: boolean;
  label?: string;
  clarification?: boolean;
}): string {
  const label = line.label;
  if (!line.clarification) {
    if (!label) return "";
    return line.host ? m.cardThreadRevisedBy({ label }) : m.cardThreadWrittenBy({ label });
  }
  if (!label) return m.cardThreadWrittenAfterClose();
  return line.host
    ? m.cardThreadRevisedByAfterClose({ label })
    : m.cardThreadWrittenByAfterClose({ label });
}
