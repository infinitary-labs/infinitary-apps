import { openDatabase } from "../../../src/core/storage/db";
import { SettingsStore } from "../../../src/core/storage/settingsStore";
import { TaskService } from "../../../src/core/tasks/taskService";

type Input = { ask: string; reply: string };

/**
 * A profile past its first launch: it was welcomed, the captain's first turn
 * was taken, and their last message sits above the input with the first
 * mate's reply line beside it, as a finished turn keeps it. No account is
 * left that can answer the first mate, so its core reads the gate open.
 */
export default function seed(userDataDir: string, { ask, reply }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const at = Date.now();
    new SettingsStore(db).setFirstRun({
      welcomedAt: at,
      welcomeState: "consumed",
      firstTurnAt: at,
    });
    const tasks = new TaskService({ db, strict: true });
    tasks.capture.openAsk({ id: "ask-pause", text: ask, at });
    tasks.capture.setAskReply("ask-pause", { text: reply, eligibility: "completed" });
    tasks.capture.closeAsk("ask-pause", "closed");
  } finally {
    db.close();
  }
}
