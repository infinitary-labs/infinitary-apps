import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";
import type { TaskService } from "../../src/core/tasks/taskService";
import { plainProblem } from "../../src/shared/plainProblem";

/** The existing multiline reply fixture, copied from the captain's INF-1102 screenshot. */
export const REPLY_NOTE_WORDS = [
  "I've started a read-only crewmate to check the Mac mini. It's looking at:",
  "- which Linux checks your project runs today;",
  "- whether the Mac mini has room alongside the Mac checks;",
  "- the security risk of running other people's pull request code.",
  "It won't change anything on the Mac mini.",
].join("\n");

/** INF-2218's actual request, long enough to exercise the accepted two-line question fold. */
export const REPLY_READING_QUESTION =
  "also, can we improve the UI of the card that pops open when clicking on these bubbles? the card should probably render something that looks more like chat messages. give me a few prototype options to choose between";

/** Real saved-round shapes through the task owner, not a replacement reply store or renderer hook. */
export function seedReplyReading(tasks: TaskService) {
  const problemWords = plainProblem(undefined);
  const at = Date.now();
  for (const [index, round] of [
    {
      id: "reading-long",
      text: REPLY_READING_QUESTION,
      reply: { text: REPLY_NOTE_WORDS.replace(/\s+/g, " "), words: REPLY_NOTE_WORDS },
    },
    { id: "reading-picture", text: "", reply: { text: problemWords, problem: true } },
  ].entries()) {
    tasks.capture.openAsk({
      id: round.id,
      at: at + index,
      text: round.text,
      ...(round.text ? {} : { images: [{ mimeType: "image/png" }] }),
    });
    tasks.capture.setAskReply(round.id, round.reply);
    tasks.capture.setAskDelivery(round.id, "covered");
    tasks.capture.closeAsk(round.id, "closed");
    tasks.capture.markAnswered(round.id, null);
  }
  return { question: REPLY_READING_QUESTION, words: REPLY_NOTE_WORDS, problemWords };
}

/**
 * INF-6366's cards on the phone's home, each answered from the phone so the strip and the Conversation show the act
 * as a card round: `conversation-card`, a first mate card answered with its own button; `conversation-waiting`, one
 * left waiting for the Cards view and then pressed, so two card acts follow a message; `conversation-crew-card`, a
 * crewmate's note to type a line under, which is not a message; and `conversation-mate-card`, a first mate card to
 * type a line under, which is also a message and keeps its reply line.
 */
export function raiseConversationCard(core: Core, command?: string) {
  const firstmate = (card: Parameters<Core["services"]["supervisor"]["addFirstmateCard"]>[0]) => ({
    id: core.services.supervisor.addFirstmateCard(card),
    title: card.title,
  });
  switch (command) {
    case "conversation-card":
      return {
        ...firstmate({
          id: "phone-conversation-chart",
          title: "Pick the chart style",
          body: "<p>Bars read best for a week of counts; lines read best for a trend.</p>",
          actions: [
            { id: "bars", label: "Use bars", default: true },
            { id: "lines", label: "Use lines" },
          ],
        }),
        label: "Use bars",
      };
    case "conversation-waiting":
      return {
        ...firstmate({
          id: "phone-conversation-waiting",
          title: "Which harbour goes first?",
          body: "<p>Both harbours need a fresh chart this week.</p>",
          actions: [
            { id: "north", label: "North first", default: true },
            { id: "south", label: "South first" },
          ],
        }),
        label: "North first",
      };
    case "conversation-mate-card":
      return firstmate({
        id: "phone-conversation-reminder",
        title: "Your reminders",
        body: "<p>The usage check is set for Friday at 9:00 AM.</p>",
        actions: [],
      });
    default: {
      const task = seedTask(core.services.tasks, {
        id: "phone-conversation-crew",
        title: "Chart the harbour soundings",
        status: "idle",
        shape: { kind: "research", deliverable: "answer" },
      });
      const cards = core.services.supervisor.cards;
      const title = "The soundings are charted";
      const id = cards.emitCrewmateCard(
        task.id,
        {
          id: "phone-conversation-soundings",
          title,
          body: "<p>Both channels hold four fathoms at low water.</p>",
          actions: [],
        },
        "crew",
      );
      cards.closeOut({ kind: "crewmate", taskId: task.id }, "idle");
      return { id, title };
    }
  }
}
