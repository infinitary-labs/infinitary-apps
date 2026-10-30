import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ServedStarters } from "../../src/shared/modelSlots";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { modelPill, openModelsBoard } from "./modelsBoard";
import { readSavedData } from "./savedData";
import { starterFor } from "./starters";

/**
 * The served starter list end to end (captain's direction C on INF-1904:
 * "a starter list served by us so defaults move for every install without
 * a release"; docs/model-lists.md, "The served starter list").
 *
 * The first start has no account and reads the list from a stand-in feed
 * on this computer, which moves Grok's medium starter to high. The second
 * start has no feed at all - the list is asked of an unused port - and a
 * Grok key signed in since: the model starts at the served level from the
 * saved answer, offline. Grok's catalog is Pi's bundled one (PI_OFFLINE).
 */

const GROK_ACCOUNT = "acct_grok_served";

function seedGrokKey(userDataDir: string): void {
  const accountsDir = join(userDataDir, "accounts");
  const dir = join(accountsDir, "xai", GROK_ACCOUNT);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ xai: { type: "api_key", key: "k" } }), {
    mode: 0o600,
  });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: GROK_ACCOUNT,
          providerId: "xai",
          kind: "api_key",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-10-29T18:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

/** A feed that answers the one starter list and counts the asks. */
async function standInFeed(body: ServedStarters): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url !== "/infinitary-starters.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/infinitary-starters.json`, server };
}

test("a served starter list places a newly signed-in model at its served level, offline after one read", async () => {
  const grok = starterFor("xai", "medium");
  const key = `xai/${grok}`;
  const served: ServedStarters = { schema: 1, starters: { xai: { [grok]: ["high"] } } };
  const userDataDir = scratchDir("infinitary-e2e-");

  // Part 1: the feed answers, and the app keeps its answer.
  const feed = await standInFeed(served);
  try {
    const first = await launchApp({
      userDataDir,
      env: { INFINITARY_STARTERS_URL: feed.url },
    });
    try {
      await expect
        .poll(() =>
          readSavedData(userDataDir, (db) => {
            const row = db
              .prepare("SELECT value FROM settings WHERE key = 'served-starters'")
              .get() as { value: string } | undefined;
            return row ? (JSON.parse(row.value) as { starters: unknown }).starters : null;
          }),
        )
        .toEqual(served.starters);
    } finally {
      await first.close();
    }
  } finally {
    await new Promise<void>((resolve) => feed.server.close(() => resolve()));
  }

  // Part 2: a Grok key signed in, no feed, and the board shows the served level.
  seedGrokKey(userDataDir);
  const second = await launchApp({ userDataDir });
  try {
    const { page } = second;
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const models = await openModelsBoard(page);
    await expect(modelPill(models, "high", key)).toBeVisible();
    await expect(modelPill(models, "medium", key)).toHaveCount(0);
  } finally {
    await second.close();
  }
});
