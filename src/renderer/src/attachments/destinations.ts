import { pathInsertion } from "@shared/attachments";
import { useShellStore } from "../app/store";
import { typePathsInto } from "../design/core/ComposerField";
import { isView } from "../devices/viewWords";
import { type FileDestination, MAIN_FILES_KEY } from "./intake";

/**
 * The two kinds of input a file can be given to, bound to the store at the
 * moment a result lands - never to whatever input is on screen then.
 */

/**
 * Both inputs' words go to the Firstmate this app shows: on an app
 * controlling another Mac, a path on this Mac would mean nothing there.
 */
const takesPaths = () => !isView(useShellStore.getState().thisMac);

/** The main input: Firstmate's. Refused while it is held (`mainInputHeld`). */
export function mainDestination(
  field: () => HTMLTextAreaElement | null,
  gated: () => boolean,
): FileDestination {
  const store = () => useShellStore.getState();
  return {
    key: MAIN_FILES_KEY,
    accepts: () => !gated(),
    takesPaths,
    applyImages: (items) => store().attachImages(items),
    applyText: (text, name) => store().attachPastedText(text, name),
    notice: (notice) => store().showComposerNotice(notice),
    insertPaths: (paths) => {
      if (typePathsInto(field(), paths)) return;
      const draft = store().inputText;
      store().setInputText(draft + pathInsertion(draft, draft.length, draft.length, paths));
    },
  };
}

/** One card's reply: its recorded author's. Refuses once the card is gone or its reply is leaving. */
export function replyDestination(
  cardId: string,
  field: () => HTMLTextAreaElement | null,
): FileDestination {
  const store = () => useShellStore.getState();
  return {
    key: cardId,
    accepts: () =>
      store().cards.some((card) => card.id === cardId) && !store().sendingReplies[cardId],
    takesPaths,
    applyImages: (items) => store().attachReplyImages(cardId, items),
    applyText: (text, name) => store().attachReplyPaste(cardId, text, name),
    notice: (notice) => store().showReplyNotice(cardId, notice),
    insertPaths: (paths) => {
      if (typePathsInto(field(), paths)) return;
      const draft = store().replyDrafts[cardId] ?? "";
      store().setReplyDraft(
        cardId,
        draft + pathInsertion(draft, draft.length, draft.length, paths),
      );
    },
  };
}
