/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/orchestrator/cardService.ts
 * @journey-area src/core/orchestrator/cardEmit.ts
 * @journey-area src/core/orchestrator/cardEvidence.ts
 * @journey-area src/core/orchestrator/cardThreads.ts
 */
import type { Page } from "@playwright/test";
import { CardService } from "../../src/core/orchestrator/cardService";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";

export const REVISION_TITLE = "Review the project checks";
/** The base card's draft field, and the sign-in line its first revision rewrites. */
export const REVISION_NOTE_LABEL = "Review note";
const REVISION_ACCOUNT_BEFORE = "Use another account.";
export const REVISION_ACCOUNT_AFTER = "Use your connected account.";
/** The heading and line of each new area the many-revisions card adds, from 1. */
export const revisionArea = (n: number) => ({ heading: `Area ${n}`, line: `New area ${n}` });
export const REVISION_BASE = `<h2>What you asked</h2><p>Review the project before starting work.</p><h2>What stays the same</h2>${Array.from({ length: 6 }, (_, i) => `<p>The review keeps your project and your connected accounts unchanged. Item ${i + 1} stays as it was.</p>`).join("")}<h2 id="signin">Sign-in</h2><p>${REVISION_ACCOUNT_BEFORE}</p><h2 id="checks">Checks</h2><details data-checks><summary>What I will check</summary><p data-check-result>Check the account after starting work.</p></details><h2>Next</h2><p>Nothing starts until you choose.</p><label>${REVISION_NOTE_LABEL} <input name="note" value="Keep this draft"></label><details data-unrelated><summary>Other information</summary><p>Unrelated disclosure stays closed.</p></details>`;

/** Seed through the real producer, storage and publication seams; a launch reads its saved result. */
export function seedRevisionCard(
  options: { many?: boolean; preview?: boolean; simple?: boolean } = {},
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
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  const base = options.simple
    ? REVISION_BASE.replace(`<h2 id="signin">Sign-in</h2><p>${REVISION_ACCOUNT_BEFORE}</p>`, "")
        .replace(" data-checks", "")
        .replace(" data-check-result", "")
        .replace(new RegExp(`<label>${REVISION_NOTE_LABEL}[\\s\\S]*$`), "")
    : REVISION_BASE;
  const initial = {
    id: "revision-demo",
    title: REVISION_TITLE,
    body: base,
    actions: [],
  };
  const id = service.addFirstmateCard(initial);
  const asked = service.addMessage(id, "captain", "Check the connected account before starting.");
  // The captain's line waits on the Firstmate, so each revision answers it,
  // naming it: only a line that names the captain's message answers it.
  const revise = (card: Parameters<typeof service.addFirstmateCard>[0]) =>
    service.addFirstmateCard({ ...card, reply: "Done.", answersMessage: asked.id });
  const account = base.replace(REVISION_ACCOUNT_BEFORE, REVISION_ACCOUNT_AFTER);
  if (!options.simple) revise({ ...initial, body: account });
  const checks = account.replace(
    "Check the account after starting work.",
    "I will check the connected account before starting work.",
  );
  revise({ ...initial, body: checks });
  if (options.many)
    revise({
      ...initial,
      body:
        checks +
        Array.from({ length: 5 }, (_, i) => revisionArea(i + 1))
          .map(({ heading, line }) => `<h2>${heading}</h2><p>${line}</p>`)
          .join(""),
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
