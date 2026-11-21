import { describe, expect, it } from "vitest";
import { tmpUserData } from "../../../tests/helpers/migrations";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initOverflowDir, withPastedFiles } from "../overflow";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardStore } from "./cardStore";
import { CAPTAIN_TEXT_VERSION, openDatabase } from "./db";
import { InboxStore } from "./inboxStore";
import { TaskEventStore } from "./taskEventStore";

/**
 * Intent: the approved detector must not reinterpret older decorated
 * messages as original captain input. This fixture uses the real pasted
 * file producer and an actual predecessor database; it owns the upgrade
 * boundary, not current-caption extraction or classification quality.
 */
describe("original captain input migration", () => {
  it("preserves old text without inventing captions, while new rows retain their original input", () => {
    const dir = tmpUserData();
    initOverflowDir(scratchDir("captain-migration-overflow-"));
    const caption = "For later work in this project, show the wording first.";
    const decorated = withPastedFiles(caption, [
      { name: "example.txt", text: "Attached examples are not captain instructions." },
    ]);
    const legacy = openDatabase(dir, CAPTAIN_TEXT_VERSION - 1);
    // Today's card writer names the later `files_json` and `live_reads_json`
    // columns, lent to the older schema here; their own migrations leave a
    // column already there.
    legacy.exec("ALTER TABLE cards ADD COLUMN files_json TEXT");
    legacy.exec("ALTER TABLE cards ADD COLUMN live_reads_json TEXT");
    const at = Date.now();
    new CardStore(legacy).upsert({
      id: "source-card",
      author: "firstmate",
      priority: 30,
      title: "Review this approach",
      meta: "first mate",
      body: "<p>The original proposal.</p>",
      actions: [{ id: "continue", label: "Continue", default: true }],
      status: "ready",
      createdAt: at,
    });
    const oldMessage = legacy
      .prepare("INSERT INTO card_messages (card_id, who, text, at) VALUES (?, 'captain', ?, ?)")
      .run("source-card", decorated, at);
    legacy
      .prepare("INSERT INTO captain_asks (id, at, text, turn_state) VALUES (?, ?, ?, 'closed')")
      .run("source-ask", at, decorated);
    new CardStore(legacy).observe({
      id: "old-input",
      kind: "message_ref",
      cardId: "source-card",
      lifecycleId: "source-life",
      at,
      actor: "captain",
      source: "thread",
      messageId: Number(oldMessage.lastInsertRowid),
      payload: { messageId: Number(oldMessage.lastInsertRowid), who: "captain" },
    });
    const tasks = new TaskService({ db: legacy });
    seedTask(tasks, { id: "source-task", title: "Review the work", status: "running" });
    const inboxId = new InboxStore(legacy).enqueue("source-task", decorated);
    const oldSteer = tasks.turns.recordSteer("source-task", {
      text: decorated,
      actor: "captain",
      outcome: "mid-turn",
      via: "thread",
      decision: null,
      cardId: null,
      inboxId,
    });
    if (oldSteer === undefined) throw new Error("The legacy fixture has no accepted steer.");
    const oldSteerText = new TaskEventStore(legacy).get(oldSteer)?.text;
    legacy.close();

    const upgraded = openDatabase(dir);
    try {
      const oldRows = [
        upgraded
          .prepare("SELECT text, captain_text FROM card_messages WHERE id = ?")
          .get(Number(oldMessage.lastInsertRowid)),
        upgraded
          .prepare("SELECT text, captain_text FROM captain_asks WHERE id = ?")
          .get("source-ask"),
      ];
      for (const row of oldRows) expect(row).toEqual({ text: decorated, captain_text: null });
      const events = new TaskEventStore(upgraded);
      expect(events.get(oldSteer)?.text).toBe(oldSteerText);
      expect(events.captainText("source-task", oldSteer)).toBeUndefined();
      const store = new CardStore(upgraded);
      expect(store.captainInput("old-input")).toBeUndefined();
      const added = store.appendMessage({
        cardId: "source-card",
        who: "captain",
        text: decorated,
        captainText: caption,
      });
      store.observe({
        id: "new-input",
        kind: "message_ref",
        cardId: "source-card",
        lifecycleId: "source-life",
        at: added.at,
        actor: "captain",
        source: "thread",
        messageId: added.id,
        payload: { messageId: added.id, who: "captain" },
      });
      expect(store.captainInput("new-input")?.text).toBe(caption);
      expect(store.messages("source-card").at(-1)?.text).toBe(decorated);
    } finally {
      upgraded.close();
    }
  });
});
