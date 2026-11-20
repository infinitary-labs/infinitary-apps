import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { useShellStore } from "../app/store";

/**
 * What the docked request's field gives Return control (INF-4587, the
 * captain's choice on its review): a return carries words alone, so
 * pictures, files or notes in the field go first as an ordinary reply,
 * words and all; words past a reply's limit hold the return with a plain
 * line, as the field already shows. A reply refused or still preparing
 * keeps the field, and the browser stays the captain's (`held`).
 */
export async function returnWordsOf(
  cardId: string,
): Promise<{ words: string } | { refusal: string } | { held: true }> {
  const shell = useShellStore.getState();
  if ((shell.replyDrafts[cardId]?.trim().length ?? 0) > CARD_REPLY_MAX_CHARS) {
    return { refusal: m.cardBrowserReturnWordsTooLong() };
  }
  const attached = () => {
    const now = useShellStore.getState();
    return (
      (now.replyImages[cardId]?.length ?? 0) > 0 ||
      (now.replyPastes[cardId]?.length ?? 0) > 0 ||
      (now.replyNotes[cardId]?.length ?? 0) > 0
    );
  };
  if (attached()) {
    await shell.sendReply(cardId);
    if (attached()) return { held: true };
  }
  return { words: useShellStore.getState().replyDrafts[cardId]?.trim() ?? "" };
}
