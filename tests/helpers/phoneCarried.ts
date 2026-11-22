import type { Core } from "@core/index";
import { CARD_FILES_FIRST, PAST_CARD_WORDS_LEAD } from "@shared/cards";
import { carriedWithChoiceWords } from "@shared/choiceCarried";
import { formatList } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * The phone cards-carried part's card (INF-5608's approved plan, piece 2, and
 * INF-5487): a first mate card whose body holds a paragraph to note and two
 * choices. It answers the card's words and, from their owners, the words the
 * phone shows: the footer's line for one photo and one note, and the past
 * card's lead, and the Mac's words for buttons that wait on a computer
 * without the change. A second card takes its own id.
 */
export function raiseCarriedCard(core: Core, cardId = "phone-carried") {
  const title = "The harbour chart goes to print";
  const part = "The new chart moves the north buoy twenty metres east.";
  const id = core.services.supervisor.addFirstmateCard({
    id: cardId,
    title,
    body: `<p>${part}</p><p>The printer needs an answer today.</p>`,
    actions: [
      { id: "print", label: "Print it", default: true },
      { id: "hold", label: "Hold the print" },
    ],
  });
  core.services.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
  core.services.supervisor.cards.flushBroadcast();
  return {
    id,
    title,
    part,
    line: carriedWithChoiceWords({ pictures: 1, files: 0, notes: 1 }),
    sentLead: PAST_CARD_WORDS_LEAD,
    held: CARD_FILES_FIRST,
  };
}

/**
 * What reached the computer from the phone's one press: the first mate's turn
 * that read the choice (the mock provider's request), and what the card's
 * record kept with the choice, its notes and its pictures by name.
 */
export async function carriedHeard(core: Core, id: string, bodies: readonly string[]) {
  const past = await core.dispatch("inf:cards:past", [id]);
  const turn = bodies.find((body) => body.includes(`(${id})`) && body.includes("Choice on")) ?? "";
  // The turn's words from the choice on, as the request carries them (JSON-escaped), and whether a JPEG photo rode
  // the turn as an image.
  const at = turn.indexOf("Choice on");
  return {
    turn: at < 0 ? null : turn.slice(at, at + 2_000),
    turnImage: turn.includes("image/jpeg"),
    chosen: past?.ending.actionId ?? null,
    carried: past?.carried ?? null,
    pictureWords: past?.carried?.pictures?.length
      ? m.cardPastPictures({
          count: past.carried.pictures.length,
          names: formatList(past.carried.pictures),
        })
      : null,
  };
}

/** Opens the chosen card again as a past card, as its notice does. */
export function showCarriedPast(core: Core, id: string): Promise<unknown> {
  return core.dispatch("inf:cards:show-past", [id]);
}
