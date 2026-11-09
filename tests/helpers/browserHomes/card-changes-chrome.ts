import { CardService } from "../../../src/core/orchestrator/cardService";
import { resolveFirstmateCardId } from "../../../src/core/pi/cardTool";
import type { EmittedAction } from "../../../src/core/session/tools";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { TaskService } from "../../../src/core/tasks/taskService";
import { revisedLineWords } from "../../../src/shared/threadLines";
import type { HomeRead } from "../browserFreshHome";

/** The first mate's one card, revised in place under its stable id. */
const STABLE_ID = "revision-demo";

/** One write of the card: its words, and the choices it offers. */
type Write = { title: string; body: string; actions?: EmittedAction[] };

/**
 * What a card-changes test's story reads back: the card's first write, the
 * captain's line under it, then either each revision the first mate wrote
 * with its answer to that line, or - a card from before revisions carried
 * their links - the host's plain note of an earlier revision, by its title.
 */
type Input = {
  first: Write;
  captain: string;
  revisions?: { write: Write; reply: string }[];
  earlier?: string;
};

/** The card's thread, read when it shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [resolveFirstmateCardId(STABLE_ID)]]];

/**
 * The card's history, written through the real producer, storage and
 * publication seams (`CardService`), as the first mate's turn leaves it; the
 * window reads its saved result.
 */
export default function seed(userDataDir: string, input: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const service = new CardService({
      now: () => Date.now(),
      tasks: new TaskService({ db, strict: true }),
      cardStore: new CardStore(db),
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
    });
    try {
      const first = { id: STABLE_ID, actions: [], ...input.first };
      const id = service.addFirstmateCard(first);
      const question = service.addMessage(id, "captain", input.captain);
      // A revision saved before revisions kept their links: its line, as the
      // host wrote it then, with no links.
      if (input.earlier !== undefined)
        service.addMessage(id, "host", revisedLineWords(input.earlier));
      // The captain's line waits on the first mate, so each revision answers it,
      // naming it: only a line that names the captain's message answers it.
      for (const { write, reply } of input.revisions ?? [])
        service.addFirstmateCard({
          ...first,
          actions: [],
          ...write,
          reply,
          answersMessage: question.id,
        });
      service.closeOut({ kind: "firstmate" }, "turn-end");
    } finally {
      service.dispose();
    }
  } finally {
    db.close();
  }
}
