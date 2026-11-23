import type { Theme } from "@shared/preferences";
import { openDatabase } from "../../../src/core/storage/db";
import { SettingsStore } from "../../../src/core/storage/settingsStore";
import { TaskService } from "../../../src/core/tasks/taskService";

type Round = { ask: string; reply: string };

type Input = { theme: Theme; rounds: Round[] };

/**
 * A conversation of two finished turns in the look the captain chose: both
 * rounds hang above the input, the older one quieter, as a finished turn
 * keeps them. Both theme files seed through it
 * (./quiet-messages-light.ts).
 */
export default function seed(userDataDir: string, { theme, rounds }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const settings = new SettingsStore(db);
    const start = Date.now() - rounds.length * 60_000;
    settings.setFirstRun({ welcomedAt: start, welcomeState: "consumed", firstTurnAt: start });
    settings.setAppearance({ ...settings.getAppearance(), theme });
    const tasks = new TaskService({ db, strict: true });
    rounds.forEach(({ ask, reply }, index) => {
      const id = `ask-quiet-${index + 1}`;
      tasks.capture.openAsk({ id, text: ask, at: start + index * 60_000 });
      tasks.capture.setAskReply(id, { text: reply, eligibility: "completed" });
      tasks.capture.closeAsk(id, "closed");
    });
  } finally {
    db.close();
  }
}
