import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { staleGeneratedFile } from "./github-errors.ts";

/**
 * INF-6366: the phone's strip and Conversation read the computer's conversation (`inf:conversation:thread`) and
 * its last turn (`inf:conversation:last-turn`). This records both as the core answers them, after the captain's
 * acts are written by their real owners - the capture side for messages, the card service for presses and lines -
 * so the phone package's tests replay real readings (`PhoneConversationTests`).
 */
const OUT = join(REPO_ROOT, "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhoneConversation.generated.json");

const runner = await openModuleRunner();
try {
  const at = (path: string) => join(REPO_ROOT, path);
  const { freshDatabase } = await runner.import<typeof import("../tests/helpers/database.ts")>(at("tests/helpers/database.ts"));
  const { CardService } = await runner.import<typeof import("../src/core/orchestrator/cardService.ts")>(at("src/core/orchestrator/cardService.ts"));
  const { seedTask } = await runner.import<typeof import("../src/core/tasks/seedTask.ts")>(at("src/core/tasks/seedTask.ts"));
  const { TaskService } = await runner.import<typeof import("../src/core/tasks/taskService.ts")>(at("src/core/tasks/taskService.ts"));
  const { CardStore } = await runner.import<typeof import("../src/core/storage/cardStore.ts")>(at("src/core/storage/cardStore.ts"));
  const { readConversation } = await runner.import<typeof import("../src/core/storage/conversationRead.ts")>(at("src/core/storage/conversationRead.ts"));
  type Card = import("../src/shared/cards.ts").Card;

  // A fixed clock, so the readings are the same on every run; the card service reads Date.now in places.
  let clock = Date.UTC(2026, 10, 22, 17);
  const realNow = Date.now;
  Date.now = () => clock;
  const tick = (ms = 60_000) => (clock += ms);
  try {
    const db = freshDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => clock });
    const cards = new CardService({
      now: () => clock,
      tasks,
      cardStore: new CardStore(db),
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
      broadcastThread: () => {},
    });
    seedTask(tasks, { id: "panel", title: "Chart the backlog", status: "running" });
    const message = (id: string, text: string, reply?: { text: string; words?: string }) => {
      tasks.capture.openAsk({ id, text, at: tick() });
      if (reply) tasks.capture.setAskReply(id, { ...reply, eligibility: "completed" });
    };
    const crewCard = (id: string, title: string): Card => {
      tick();
      const emitted = cards.emitCrewmateCard("panel", {
        id,
        title,
        body: "<p>A panel that charts the backlog.</p>",
        actions: [
          { id: "build", label: "Approve and build", default: true },
          { id: "defer", label: "Save and defer" },
        ],
      }, "model");
      cards.closeOut({ kind: "crewmate", taskId: "panel" }, "report");
      return cards.shown(emitted) as Card;
    };

    message("ask-1", "can a panel track my backlog?", { text: "Yes. I started a plan for it." });
    const plan = crewCard("plan", "A panel that charts your backlog");
    tick();
    cards.resolve(plan, "build", "build");
    const asked = crewCard("asked", "Which chart reads best?");
    tick();
    cards.addMessage(asked.id, "captain", "use bars, not lines");
    tick();
    cards.addMessage(asked.id, "crewmate", "Bars it is.");
    // The next day: a line typed under the first mate's own card, saved as a message and a card line.
    tick(24 * 60 * 60_000);
    const reminders = cards.addFirstmateCard({ title: "Your reminders", body: "<p>One reminder on Friday.</p>", actions: [] });
    tick();
    const line = cards.addMessage(reminders, "captain", "move it to Monday");
    tasks.capture.openAsk({ id: "under-card", text: "move it to Monday", at: line.at, typedUnder: { cardId: reminders, line: line.id } });
    tasks.capture.setAskReply("under-card", { text: "Moved to Monday.", eligibility: "completed" });
    tick();
    cards.addMessage(reminders, "firstmate", "Moved to Monday at 9:00 AM.");
    tick();
    const note = cards.addFirstmateCard({ title: "Usage this week", body: "<p>Light so far.</p>", actions: [] });
    tick();
    cards.pressNote(cards.shown(note) as Card);
    // A card still waiting on the captain: it is no round, and the Cards view lists it from the cards the phone holds.
    crewCard("waiting", "Which project goes first?");
    message("ask-2", "also remind me to check usage on friday", {
      text: "All set. I'll remind you Friday at 9:00 AM.",
      words: "All set.\nI'll remind you Friday at 9:00 AM.",
    });

    const whole = readConversation(db);
    // Pages of three, each read from the oldest round of the page before, as the phone reads them back.
    const pages = [readConversation(db, { limit: 3 })];
    while (pages.at(-1)!.more) {
      const oldest = pages.at(-1)!.rounds.at(-1)!;
      pages.push(readConversation(db, { before: { at: oldest.at, id: oldest.id }, limit: 3 }));
    }
    const reading = {
      lastTurn: tasks.capture.lastTurn(),
      whole,
      pages,
      // The newest page the strip reads, two rounds (the plan's rounds at rest).
      strip: readConversation(db, { limit: 2 }),
      cards: cards.snapshot(),
    };
    // The core draws card ids and offer ids at random; each gets a stable stand-in, the same one wherever it recurs.
    const stable = new Map<string, string>();
    const text = `${JSON.stringify(reading, null, 2)}\n`
      .replace(/card-fm-(\d+)-[0-9a-f]{6}\b/g, (_, n) => `card-fm-${n}`)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        if (!stable.has(id)) stable.set(id, `00000000-0000-4000-8000-${String(stable.size + 1).padStart(12, "0")}`);
        return stable.get(id)!;
      });
    if (process.argv.includes("--check")) {
      let current = "";
      try { current = readFileSync(OUT, "utf8"); } catch {}
      if (current !== text) throw staleGeneratedFile(OUT, "node scripts/generate-phone-conversation.ts");
    } else writeFileSync(OUT, text);
  } finally {
    Date.now = realNow;
  }
} finally {
  await runner.close();
}
