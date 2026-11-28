import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";
import { cardReaderUnsafeData } from "@shared/i18n/messages.generated";
import { APPROVAL_CHOICES, approvalQuestion } from "./googleMcpStandIn";

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

/**
 * INF-7092's approved plan: Gmail's question about a send, raised for the
 * first mate, its four choices in Google's own labels as footer buttons, to
 * check at phone width. The choices and question line are the Google
 * stand-in's. Answers the card's title, Google's question line and its buttons' ids.
 */
export function raiseGoogleQuestionCard(core: Core): {
  title: string;
  question: string;
  actions: string[];
} {
  const supervisor = core.services.supervisor;
  const question = approvalQuestion("send_message");
  const cardId = supervisor.integrationAsks.askIntegrationForFirstmate({
    id: "ia-phone-google",
    kind: "integration",
    integration: "google",
    connection: "google#1",
    place: "Google",
    action: "send_message",
    label: "Send a message",
    effect: "sends",
    signature: '["Send a message","sends"]',
    reason: "Tell Lena the invoice is paid.",
    input: JSON.stringify({ to: ["lena@ortiz-studio.com"], subject: "Invoice 2214" }),
    at: Date.now(),
    confirm: {
      message: "**Send an email** to lena@ortiz-studio.com?\n\nSubject: Invoice 2214",
      question,
      options: APPROVAL_CHOICES.map(([value, label]) => ({ value, label })),
      state: '{"tool":"send_message"}',
      asker: "Gmail",
    },
  });
  supervisor.cards.flushBroadcast();
  const card = supervisor.cards.get(cardId);
  return {
    title: card?.title ?? "",
    question,
    actions: card?.actions.map((action) => action.id) ?? [],
  };
}
