import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";
import { cardReaderUnsafeData } from "@shared/i18n/messages.generated";

/** Puts every card away, so a part's own card is the only one the phone shows. */
export async function clearPhoneCards(core: Core): Promise<void> {
  for (const card of await core.dispatch("inf:cards:list", []))
    await core.dispatch(
      card.noteDone && !card.noteDone.closesTask ? "inf:cards:note-done" : "inf:cards:close",
      [card.id],
    );
}

/**
 * INF-6388: a decision from an unsafe data reader, a crewmate that reads
 * words anyone can write; its card says a link or request on it may come
 * from a stranger. Answers the card's title and that line.
 */
export async function raiseReaderCard(core: Core): Promise<{ title: string; line: string }> {
  await clearPhoneCards(core);
  const reading = seedTask(core.services.tasks, {
    id: "phone-reader",
    title: "Triage the waiting outside issues",
    status: "idle",
    shape: { kind: "research", deliverable: "answer", unsafe_data_reader: true },
  });
  const cards = core.services.supervisor.cards;
  const title = "Reply to issue 12?";
  cards.emitCrewmateCard(
    reading.id,
    {
      id: "reader-reply",
      title,
      body: "<p>Issue 12 asks for a reply about the meter idling on a cold start.</p>",
      actions: [
        { id: "reply", label: "Reply", default: true },
        { id: "later", label: "Not now" },
      ],
    },
    reading.title,
    "Opus 5.5",
    "on Mac mini",
  );
  cards.closeOut({ kind: "crewmate", taskId: reading.id }, "idle");
  cards.flushBroadcast();
  return { title, line: cardReaderUnsafeData() };
}
