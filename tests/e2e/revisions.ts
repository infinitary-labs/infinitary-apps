import type { Page } from "@playwright/test";
import { CardService } from "../../src/core/orchestrator/cardService";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";

export const REVISION_TITLE = "Review the project checks";
export const REVISION_BASE = `<h2>What you asked</h2><p>Review the project before starting work.</p><h2>What stays the same</h2>${Array.from({ length: 6 }, (_, i) => `<p>The review keeps your project and your connected accounts unchanged. Item ${i + 1} stays as it was.</p>`).join("")}<h2 id="signin">Sign-in</h2><p>Use another account.</p><h2 id="checks">Checks</h2><details data-checks><summary>What I will check</summary><p data-check-result>Check the account after starting work.</p></details><h2>Next</h2><p>Nothing starts until you choose.</p><label>Review note <input name="note" value="Keep this draft"></label><details data-unrelated><summary>Other information</summary><p>Unrelated disclosure stays closed.</p></details>`;

/** Seed through the real producer, storage and publication seams; a launch reads its saved result. */
export function seedRevisionCard(
  options: {
    removed?: boolean;
    many?: boolean;
    chrome?: boolean;
    preview?: boolean;
    simple?: boolean;
    legacy?: boolean;
  } = {},
) {
  const userDataDir = scratchDir("infinitary-revisions-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const cardStore = new CardStore(db);
  const service = new CardService({
    now: () => Date.now(),
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    noteCapAnswered: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  const base = options.simple
    ? REVISION_BASE.replace('<h2 id="signin">Sign-in</h2><p>Use another account.</p>', "")
        .replace(" data-checks", "")
        .replace(" data-check-result", "")
        .replace(/<label>Review note[\s\S]*$/, "")
    : REVISION_BASE;
  const initial = {
    id: "revision-demo",
    title: options.chrome ? "Earlier project checks" : REVISION_TITLE,
    body: options.legacy ? "First paragraph.\n\nSecond paragraph." : base,
    actions: [],
  };
  const id = service.addFirstmateCard(initial);
  service.addMessage(id, "captain", "Check the connected account before starting.");
  if (options.legacy) {
    service.addMessage(id, "host", "An earlier revision");
    service.closeOut({ kind: "firstmate" }, "turn-end");
    service.dispose();
    db.close();
    return { userDataDir, id };
  }
  // The captain's line waits on the Firstmate, so each revision answers it.
  const revise = (card: Parameters<typeof service.addFirstmateCard>[0]) =>
    service.addFirstmateCard({ ...card, reply: "Done." });
  const account = base.replace("Use another account.", "Use your connected account.");
  if (!options.simple) revise({ ...initial, body: account });
  const checks = account.replace(
    "Check the account after starting work.",
    "I will check the connected account before starting work.",
  );
  revise({ ...initial, body: checks });
  if (options.removed)
    revise({
      ...initial,
      body: checks.replace('<h2 id="signin">Sign-in</h2><p>Use your connected account.</p>', ""),
    });
  if (options.many)
    revise({
      ...initial,
      body:
        checks +
        Array.from({ length: 5 }, (_, i) => `<h2>Area ${i + 1}</h2><p>New area ${i + 1}</p>`).join(
          "",
        ),
    });
  if (options.chrome)
    revise({
      ...initial,
      title: REVISION_TITLE,
      body: checks,
      actions: [
        { id: "keep", label: "Keep waiting", default: true },
        { id: "leave", label: "Leave it" },
      ],
    });
  if (options.preview)
    revise({
      ...initial,
      body: `${checks}<script>document.body.dataset.previewReady='yes'</script>`,
    });
  service.closeOut({ kind: "firstmate" }, "turn-end");
  service.dispose();
  db.close();
  return { userDataDir, id };
}

export const revisionRows = (page: Page) =>
  page.locator("[data-stage-entry='shown'] [data-revision-links]");
export const revisionLinks = (page: Page) => revisionRows(page).locator("[data-revision-link]");
export const revisionFrame = (page: Page) => cardBody(page, REVISION_TITLE);
export const cardScroller = (page: Page) =>
  page.locator("[data-stage-entry='shown'] [data-card-body]");
export const revisionTarget = (page: Page) =>
  revisionFrame(page).locator("[data-inf-revision-highlight]");
