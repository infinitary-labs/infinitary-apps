import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { measured, PERF_TAG } from "./perf";
import { seedPersonalWorkspace } from "./personalFixtures";

/**
 * The captain's token dashboard, end to end (plugin data surface, Phase B):
 * the `usage` skill's fixture (tests/fixtures/personal-skills/token-watch)
 * in the personal workspace, compiled and mounted by the real host, reading
 * `v_usage_v1` through the `sql` read - the query process, the published
 * view, the grant from its manifest - while real Firstmate turns through the
 * mock provider write the usage it counts.
 *
 * The lag is the claim: the core writes a usage row when a model request
 * ends, and the panel paints the new count within the read's coalescing
 * window. It is logged as an order (the paint follows the write) and a
 * measured duration (./perf.ts), never a wall-clock assertion.
 *
 * The time cap runs in the real app too: a statement that never ends is
 * stopped at 250 ms, the next query is answered by a fresh query process,
 * and the app still quits cleanly with nothing of it left behind.
 */

/** A stall ceiling: rows land within the ~40-55 ms window; graded only on a perf run. */
const LAG_BUDGET_MS = 1_000;
const TURNS = 3;
const RUNAWAY =
  "WITH RECURSIVE forever(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM forever) SELECT COUNT(*) AS n FROM forever";

let launched: LaunchedApp;
let quit = false;

test.beforeAll(async () => {
  const userDataDir = scratchDir("infinitary-e2e-tokens-");
  seedPersonalWorkspace(
    userDataDir,
    join(process.cwd(), "tests", "fixtures", "personal-skills", "token-watch"),
    "token-watch",
  );
  launched = await launchApp({ userDataDir, withMockProvider: true });
  await expect
    .poll(
      () =>
        launched.page.evaluate(() =>
          window.infinitary.plugins.personal
            .list()
            .then((snapshot) =>
              snapshot.extensions.map((extension) => [
                extension.id,
                extension.error?.message ?? "compiled",
                extension.sql,
              ]),
            ),
        ),
      { timeout: 60_000 },
    )
    .toEqual([["token-watch", "compiled", ["v_usage_v1"]]]);
});

test.afterAll(async () => {
  if (!quit) await launched?.close();
});

/** Every process still naming this app's userData: the app and its children. */
function queryProcessesOf(userDataDir: string): string[] {
  return execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(userDataDir));
}

function panel(page: Page) {
  return page.locator('[data-side-panel="token-watch"]');
}

/** What the panel's own code draws, inside its frame (INF-2205 piece C). */
function panelPage(page: Page) {
  return panelBody(page, "token-watch");
}

/** The Firstmate's newest usage row, read the way the panel reads it. */
async function newestFirstmateUsage(page: Page): Promise<{ at: number; total: number }> {
  return page.evaluate(async () => {
    const answer = await window.infinitary.plugins.read(
      "sql",
      {
        sql: "SELECT MAX(at) AS at, SUM(input) + SUM(output) AS total FROM v_usage_v1 WHERE key = 'FIRSTMATE'",
      },
      { sql: ["v_usage_v1"] },
    );
    if ("refused" in answer) throw new Error(answer.message);
    const row = answer.rows[0] as { at: number | null; total: number | null };
    return { at: row.at ?? 0, total: row.total ?? 0 };
  });
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  const k = value / 1_000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

test(`the token dashboard counts every Firstmate turn, its row painting after the core's write ${PERF_TAG}`, async () => {
  const { page } = launched;
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  const tokens = panelPage(page);
  await expect(tokens.getByText("Tokens · last hour")).toBeVisible();

  // Every text change the panel paints, stamped on its own page's clock -
  // the same wall clock the core stamps a usage row with.
  await tokens.locator("body").evaluate((target) => {
    const paints: { at: number; text: string }[] = [];
    (window as unknown as { __tokenPaints: typeof paints }).__tokenPaints = paints;
    new MutationObserver(() => {
      paints.push({ at: Date.now(), text: target.textContent ?? "" });
    }).observe(target, { subtree: true, childList: true, characterData: true });
  });

  const lags: number[] = [];
  for (let turn = 0; turn < TURNS; turn++) {
    const before = await newestFirstmateUsage(page);
    await askFirstmate(page, `how are we doing, check ${turn}`);
    const after = await newestFirstmateUsage(page);
    // The turn wrote usage, and the panel's Firstmate row says the new total.
    expect(after.at).toBeGreaterThan(before.at);
    expect(after.total).toBeGreaterThan(before.total);
    const shown = `${formatTokens(after.total)} tokens`;
    await expect(tokens.getByText(shown, { exact: true })).toBeVisible({ timeout: 10_000 });
    const paint = await tokens
      .locator("body")
      .evaluate(
        (_body, text) =>
          (
            window as unknown as { __tokenPaints: { at: number; text: string }[] }
          ).__tokenPaints.find((entry) => entry.text.includes(text))?.at ?? null,
        shown,
      );
    expect(paint, "the panel painted the new total").not.toBeNull();
    // The order is the claim: the count is painted after the core wrote it.
    expect(paint as number).toBeGreaterThanOrEqual(after.at);
    lags.push((paint as number) - after.at);
  }
  // The Firstmate is the app, labelled as such, apart from any crewmate.
  await expect(tokens.getByText("Firstmate", { exact: true })).toBeVisible();
  measured("tokens:lag", lags, LAG_BUDGET_MS);
});

test("a read reaches only the views it was granted, and never a table", async () => {
  const { page } = launched;
  const answers = await page.evaluate(async () => {
    const ask = (sql: string, views: string[]) =>
      window.infinitary.plugins.read("sql", { sql }, { sql: views as never });
    return {
      ungranted: await ask("SELECT key FROM v_usage_v1", []),
      table: await ask("SELECT body FROM cards", ["v_usage_v1"]),
      write: await ask("DELETE FROM v_usage_v1", ["v_usage_v1"]),
      attach: await ask("ATTACH DATABASE 'elsewhere.db' AS other", ["v_usage_v1"]),
    };
  });
  expect(answers.ungranted).toMatchObject({ refused: "sql_view_not_declared" });
  expect(answers.table).toMatchObject({ refused: "sql_view_not_declared" });
  expect(answers.write).toMatchObject({ refused: "sql_not_readonly" });
  expect(answers.attach).toMatchObject({ refused: "sql_not_readonly" });
});

test("a runaway statement is stopped at the cap, the next query is answered, and the app quits cleanly", async () => {
  const { page, app, userDataDir } = launched;
  // A Firstmate turn of its own, so the view has a row for the next query.
  await askFirstmate(page, "how are we doing");
  // The query process is a utility process of this app's own, so it names
  // the app's userData on its command line.
  expect(queryProcessesOf(userDataDir).length).toBeGreaterThan(0);

  const stopped = await page.evaluate(
    (sql) => window.infinitary.plugins.read("sql", { sql }, { sql: [] }),
    RUNAWAY,
  );
  expect(stopped).toMatchObject({ refused: "sql_timeout" });

  const next = await page.evaluate(() =>
    window.infinitary.plugins.read(
      "sql",
      { sql: "SELECT COUNT(*) AS n FROM v_usage_v1 WHERE key = 'FIRSTMATE'" },
      { sql: ["v_usage_v1"] },
    ),
  );
  expect(next).toMatchObject({ truncated: false });
  expect("rows" in next && next.rows[0]?.n).toBeGreaterThan(0);

  // A second runaway while a panel is subscribed: the panel's own query is
  // answered by the fresh process that follows.
  expect(
    await page.evaluate(
      (sql) => window.infinitary.plugins.read("sql", { sql }, { sql: [] }),
      RUNAWAY,
    ),
  ).toMatchObject({ refused: "sql_timeout" });
  await expect(panelPage(page).getByText("Firstmate", { exact: true })).toBeVisible();

  // A clean quit: the app exits on its own, not by the harness's kill
  // (which would leave a signal, not an exit code).
  const child = app.process();
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  quit = true;
  await launched.close();
  expect(await exited).toBe(0);
  // Nothing of the query process outlives the app.
  await expect.poll(() => queryProcessesOf(userDataDir), { timeout: 5_000 }).toEqual([]);
});
