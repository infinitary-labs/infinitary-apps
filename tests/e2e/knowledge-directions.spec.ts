import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIONS } from "@shared/actions";
import Database from "better-sqlite3";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import {
  browserCard,
  browsersOnStage,
  filterDirections,
  focusInBrowser,
  inspector,
  KNOWLEDGE_PANEL,
  OPEN_KNOWLEDGE,
  row,
  section,
  tab,
} from "./knowledgeBrowser";
import { HARBOR, seedKnowledge } from "./knowledgeSeed";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { panelCardChrome, panelHeaderButton } from "./panelCards";
import {
  holdsSegment,
  latestContext,
  latestServedTurn,
  providerMessages,
  served,
} from "./providerRequest";
import { readKnowledgeData, readSavedData } from "./savedData";
import {
  RELAYED_DIRECTION,
  RELAYED_DIRECTION_CARD,
  RELAYED_DIRECTION_CHOICE,
  RELAYED_DIRECTION_MARKER,
  RELAYED_DIRECTION_REASON,
  type RelayedDirectionSeen,
  relayedDirection,
} from "./scenarios/relayedDirection";
import { showCard, shownEntry } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

const DIRECTION = {
  id: "release-review",
  first: "Ask me before publishing a Harbor release.",
  text: "Do not publish a Harbor release until I approve its release card.",
  evidence: "The captain clarified the release approval boundary.",
};
const PERSONAL = {
  title: "Weekend walks",
  text: "I walk by the harbor on Sunday mornings.",
};

/** The captain requested a journey of both record types and how Firstmate receives them. */
test("directions stay distinct from personal facts in the browser and in Firstmate's served context", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-directions-");
  await seedKnowledge(userDataDir);
  const knowledge = new KnowledgeService({
    dir: join(userDataDir, "knowledge"),
    projects: {
      list: () => [{ ...HARBOR, path: userDataDir }],
      get: (id) => (id === HARBOR.id ? { ...HARBOR, path: userDataDir } : undefined),
    },
  });
  const actor = { kind: "firstmate", origin: "captain-turn", canCreate: true } as const;
  let fact = "";
  let beforeHistory: unknown;
  try {
    knowledge.directions.change({
      op: "add",
      id: DIRECTION.id,
      scope: HARBOR.id,
      text: DIRECTION.first,
      reason: DIRECTION.first,
    });
    // Forty short directions exceed the former budget once labels are rendered.
    for (let i = 0; i < 39; i += 1) {
      knowledge.directions.change({
        op: "add",
        id: `z-rule-${i}`,
        scope: HARBOR.id,
        text: `Standing project direction ${i}: `.padEnd(99, "x"),
        reason: "The captain set this direction.",
      });
    }
    // The direction inspected below is the newest instruction on the first page.
    knowledge.directions.change({
      op: "revise",
      id: `d:${DIRECTION.id}`,
      expectedRevision: 1,
      text: DIRECTION.text,
      reason: DIRECTION.evidence,
    });
    const concept = await knowledge.record(actor, {
      action: "publish",
      requestId: "walks-concept",
      kind: "concept",
      title: PERSONAL.title,
      explanation: "Where the captain likes to walk.",
    });
    expect(concept.committed).toBe(true);
    const kept = await knowledge.record(actor, {
      action: "publish",
      requestId: "walks-fact",
      kind: "finding",
      statement: PERSONAL.text,
      basis: "observation",
      conditions: "The captain described his current routine.",
      about: concept.ids,
      sources: [{ kind: "quote", text: PERSONAL.text, citation: "The captain's own words" }],
    });
    expect(kept.committed, kept.text).toBe(true);
    fact = kept.ids[0] as string;
    const original = knowledge.directions.read({ id: DIRECTION.id });
    beforeHistory = original.state === "ready" ? original.direction.history : undefined;
  } finally {
    knowledge.close();
  }

  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await test.step("the Knowledge panel's header Open Knowledge puts the browser up on Directions", async () => {
      // The captain: "when i click the expand button here, it should show the
      // directions tab by default".
      const open = panelHeaderButton(app.page, KNOWLEDGE_PANEL, "open").locator("button");
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.click();
      await expect(browserCard(app.page)).toBeVisible();
      await expect(tab(app.page, "directions")).toHaveAttribute("aria-selected", "true");
      await expect(row(app.page, DIRECTION.id)).toBeVisible();
      await panelCardChrome(app.page).hide.click();
      await expect(browsersOnStage(app.page)).toHaveCount(0);
    });

    await test.step("read a direction's project, origin and exact history without changing it", async () => {
      // The browser puts the keyboard where it opens, and an opened row on the
      // inspector's selected section, a frame after it draws: each wait lets
      // that land before the next key, or it takes focus back from that key.
      await runFromSearch(app.app, app.page, OPEN_KNOWLEDGE);
      await expect.poll(() => focusInBrowser(app.page)).toBe("graph");
      await filterDirections(app.page, HARBOR.id);
      await expect(tab(app.page, "directions")).toHaveAttribute("aria-selected", "true");
      await pressKey(tab(app.page, "directions"), "Enter");
      await pressKey(row(app.page, DIRECTION.id), "Enter");
      await expect.poll(() => focusInBrowser(app.page)).toBe("section:overview");
      await expect(inspector(app.page)).toContainText(DIRECTION.text);
      const direction = await app.page.evaluate(
        (id) => window.infinitary.plugins.read("knowledge.direction", { id }),
        DIRECTION.id,
      );
      expect(direction).toMatchObject({
        state: "ready",
        direction: {
          kind: "direction",
          scope: HARBOR.id,
          authority: "instruction",
          origin: "captain-turn",
          text: DIRECTION.text,
          revision: 2,
        },
      });
      await pressKey(section(app.page, "history"), "Enter");
      await expect(inspector(app.page)).toContainText(DIRECTION.first);
      await expect(inspector(app.page)).toContainText(DIRECTION.evidence);
      await app.page.keyboard.press("Escape");
      await app.page.keyboard.press("Escape");
    });

    await test.step("an unrelated ask carries the full standing direction, while a personal fact is read explicitly", async () => {
      await waitForFirstmateIdle(app.page);
      if (!app.mockProvider) throw new Error("This journey needs its scripted provider");
      const words = "Tell me about my weekend walks.";
      const input = served({
        kind: "user",
        origin: "captain",
        body: renderWake(captainTurn(words, false)),
      });
      const answer = app.mockProvider.scriptFirstmateTurn(input, [
        { name: "knowledge", args: { action: "get", ids: [fact, `d:${DIRECTION.id}`] } },
        { name: "emit_card", args: { title: PERSONAL.title, body: `<p>${PERSONAL.text}</p>` } },
      ]);
      const start = app.mockProvider.requestBodies().length;
      await askFirstmate(app.page, words);
      await expect.poll(() => answer.outcome().state).toBe("closed");
      const requests = app.mockProvider.requestBodies().slice(start);
      const firstRequest = requests.find((body) => {
        const turn = latestServedTurn(body);
        return turn && holdsSegment(turn, input);
      });
      expect(firstRequest).toBeDefined();
      const context = latestContext(firstRequest as string) as
        | (ReturnType<typeof latestContext> & { directions?: string; knowledge?: unknown })
        | undefined;
      expect(context?.directions).toContain(DIRECTION.text);
      expect(context?.directions).not.toContain(PERSONAL.text);
      for (let i = 0; i < 39; i += 1) {
        expect(context?.directions).toContain(`Standing project direction ${i}: `.padEnd(99, "x"));
      }

      expect(context?.knowledge).toBeDefined();
      expect(JSON.stringify(context?.knowledge)).not.toContain(PERSONAL.text);
      const results = requests
        .flatMap((body) => providerMessages(body))
        .filter((message) => message.role === "tool")
        .map((message) => message.text)
        .join("\n");
      expect(results).toContain(PERSONAL.text);
      expect(results).toContain(DIRECTION.text);
      expect(answer.outcome().results.join("\n")).toContain(fact);
      const evidence = process.env.INFINITARY_KNOWLEDGE_EVIDENCE;
      if (evidence)
        writeFileSync(
          join(evidence, "direction-firstmate-use.json"),
          JSON.stringify({ context, results }, null, 2),
        );
    });
    const afterRead = await app.page.evaluate(
      (id) => window.infinitary.plugins.read("knowledge.direction", { id }),
      DIRECTION.id,
    );
    expect(afterRead.state === "ready" && afterRead.direction.history).toEqual(beforeHistory);
  } finally {
    await app.close();
  }
});

/**
 * INF-638, the captain's words: "btw that was another example of rigidness
 * in our logic". On INF-626 he chose a direction on a crewmate's card; the
 * first mate, woken by that crewmate's report rather than by his words, was
 * refused, and he had to type the rule twice more. His ruling: "why not just
 * give first mate a tool to freely read and write standing directions, and
 * then rely on the agent's judgment on when/how to do it?" The first mate
 * saves it on that report, as his instruction, through the same app action
 * catalog as every setting: one Activity line, and its reason kept.
 */
test("a direction the captain chose on a crewmate's card is saved without him typing it", async () => {
  const userDataDir = scratchDir("infinitary-relayed-direction-");
  const seen: RelayedDirectionSeen = { results: [] };
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [relayedDirection(seen)],
  });
  const evidence = process.env.INFINITARY_KNOWLEDGE_EVIDENCE;
  try {
    await waitForFirstmateIdle(app.page);
    await askFirstmate(app.page, `${SPAWN_PROMPT_MARKER} ${RELAYED_DIRECTION_MARKER}`);
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.cards.list())).some(
            (card) => card.title === RELAYED_DIRECTION_CARD && !card.awaiting,
          ),
        { timeout: 45_000 },
      )
      .toBe(true);
    await showCard(app.page, RELAYED_DIRECTION_CARD);
    // His one act: the card's default, by key. He types nothing.
    await pressKey(
      shownEntry(app.page).getByRole("button", {
        name: RELAYED_DIRECTION_CHOICE.label,
        exact: true,
      }),
      "Enter",
    );
    // The crewmate relays the choice and the first mate acts on the report.
    await expect.poll(() => seen.results.length, { timeout: 45_000 }).toBeGreaterThan(0);
    await waitForFirstmateIdle(app.page);
    // One Activity line, the trail every catalog change writes.
    const kept = ACTIONS.direction.done({ op: "add", text: RELAYED_DIRECTION });
    expect(
      (await app.page.evaluate(() => window.infinitary.feed.recent())).filter((line) =>
        line.text.endsWith(kept),
      ),
    ).toHaveLength(1);
    if (evidence) {
      writeFileSync(join(evidence, "relayed-direction-result.txt"), `${seen.results.join("\n")}\n`);
      await app.page.screenshot({ path: join(evidence, "relayed-direction-window.png") });
    }
    const listed = await app.page.evaluate(() =>
      window.infinitary.plugins.read("knowledge.directions", { scope: "captain" }),
    );
    expect(listed.state === "ready" && listed.rows.map(({ text }) => text)).toEqual([
      RELAYED_DIRECTION,
    ]);
    const saved = listed.state === "ready" ? listed.rows[0] : undefined;
    expect(saved).toMatchObject({ authority: "instruction", origin: "captain-turn" });
    const direction = await app.page.evaluate(
      (id) => window.infinitary.plugins.read("knowledge.direction", { id }),
      saved?.id ?? "",
    );
    const history = direction.state === "ready" ? direction.direction.history : [];
    expect(history.map((row) => row.evidence)).toEqual([RELAYED_DIRECTION_REASON]);

    await runFromSearch(app.app, app.page, OPEN_KNOWLEDGE);
    // With no concept to draw the graph takes no focus; the browser still
    // holds the keyboard once it lands.
    await expect.poll(() => focusInBrowser(app.page)).not.toBeNull();
    await pressKey(tab(app.page, "directions"), "Enter");
    await pressKey(row(app.page, saved?.id ?? ""), "Enter");
    await expect.poll(() => focusInBrowser(app.page)).toBe("section:overview");
    await expect(inspector(app.page)).toContainText(RELAYED_DIRECTION);
    await pressKey(section(app.page, "history"), "Enter");
    // The reason the first mate gave, as the direction's history keeps it.
    await expect(inspector(app.page)).toContainText(RELAYED_DIRECTION_REASON);
    if (evidence) {
      await inspector(app.page).getByText(RELAYED_DIRECTION_REASON).scrollIntoViewIfNeeded();
      await browserCard(app.page).screenshot({
        path: join(evidence, "relayed-direction-history.png"),
      });
    }
  } finally {
    await app.close();
  }
});

/** The captain has eight current directions, five for this project; no archive is needed. */
test("eight active directions survive carryover, stable restart, forget and purge without an old writer", async () => {
  const userDataDir = scratchDir("infinitary-active-directions-");
  const seeded = await seedKnowledge(userDataDir);
  // Reconstitute the stopped pre-retirement schema. The reference family was
  // project-owned then; one captain-owned reference must remain unchanged.
  const prior = new Database(join(userDataDir, "knowledge", "knowledge.db"));
  const kept = prior.prepare("SELECT * FROM entries WHERE id = ?").get(seeded.website);
  prior.prepare("UPDATE entries SET scope = ? WHERE id <> ?").run(HARBOR.id, seeded.website);
  prior.prepare("UPDATE search SET scope = ? WHERE entry_id <> ?").run(HARBOR.id, seeded.website);
  prior.prepare("UPDATE sources SET scope = ?").run(HARBOR.id);
  prior.exec(
    "DROP TABLE direction_history; DROP TABLE directions; DELETE FROM schema_migrations WHERE version = 4;",
  );
  prior.close();
  const db = openDatabase(userDataDir);
  const directions = Array.from({ length: 8 }, (_, index) => ({
    id: `current-direction-${index}`,
    scope: index < 5 ? HARBOR.id : "captain",
    text: `Keep this current direction exactly, including its project: ${index}.`,
    origin: index === 4 ? "agent" : "captain-turn",
  }));
  // A stopped profile still on notes. Its active records alone cross the boundary.
  for (const row of directions) {
    db.prepare(`INSERT INTO memories (id, kind, scope, origin, content, status, created_at, updated_at, version)
      VALUES (?, 'preference', ?, ?, ?, 'active', 100, 200, 2)`).run(
      row.id,
      row.scope,
      row.origin,
      row.text,
    );
  }
  db.close();
  const read = (app: Awaited<ReturnType<typeof launchApp>>, scope: string) =>
    app.page.evaluate(
      (scope) => window.infinitary.plugins.read("knowledge.directions", { scope }),
      scope,
    );
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    packaged: true,
    version: "0.2.0",
  });
  try {
    for (const scope of [HARBOR.id, "captain"]) {
      const listed = await read(app, scope);
      expect(listed.state).toBe("ready");
      if (listed.state !== "ready") throw new Error("Directions unavailable");
      expect(
        listed.rows.map(({ id, scope, text, origin }) => ({ id, scope, text, origin })),
      ).toEqual(directions.filter((row) => row.scope === scope));
    }
    await test.step("old project knowledge is removed, while captain-owned knowledge stays", async () => {
      const oldEntry = await app.page.evaluate(
        (id) => window.infinitary.plugins.read("knowledge.entry", { id }),
        seeded.pins,
      );
      expect(oldEntry.state).toBe("missing");
      const ownEntry = await app.page.evaluate(
        (id) => window.infinitary.plugins.read("knowledge.entry", { id }),
        seeded.website,
      );
      expect(ownEntry.state).toBe("ready");
      readKnowledgeData(userDataDir, (saved) => {
        expect(saved.prepare("SELECT * FROM entries").all()).toEqual([kept]);
        for (const table of ["sources", "assessments", "relations", "uses", "edges"]) {
          expect(saved.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
            count: 0,
          });
        }
        expect(saved.prepare("SELECT DISTINCT entry_id FROM revisions").all()).toEqual([
          { entry_id: seeded.website },
        ]);
      });
    });
    const project = await read(app, HARBOR.id);
    expect(project.state === "ready" && project.rows[4]?.authority).toBe("advice");
    expect(
      readSavedData(userDataDir, (saved) =>
        saved
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('memories', 'memory_revisions')")
          .all(),
      ),
    ).toEqual([]);
    const evidence = process.env.INFINITARY_KNOWLEDGE_EVIDENCE;
    if (evidence)
      writeFileSync(
        join(evidence, "active-direction-carryover.json"),
        JSON.stringify({ directions, project }, null, 2),
      );
  } finally {
    await app.close();
  }
  const again = await launchApp({
    userDataDir,
    withMockProvider: true,
    packaged: true,
    version: "0.2.0",
  });
  try {
    const project = await read(again, HARBOR.id);
    expect(project.state === "ready" && project.total).toBe(5);
    const original = await again.page.evaluate(() =>
      window.infinitary.plugins.read("knowledge.direction", { id: "current-direction-0" }),
    );
    expect(original.state === "ready" && original.direction.history).toHaveLength(1);
    if (!again.mockProvider) throw new Error("The scripted provider is required");
    const words = "Forget current direction zero.";
    const input = served({
      kind: "user",
      origin: "captain",
      body: renderWake(captainTurn(words, false)),
    });
    const answer = again.mockProvider.scriptFirstmateTurn(input, [
      {
        name: "app_change",
        args: {
          action: "direction",
          value: { op: "retire", id: "d:current-direction-0", expectedRevision: 1 },
          evidence: words,
        },
      },
      {
        name: "emit_card",
        args: { title: "Direction forgotten", body: "<p>This direction no longer applies.</p>" },
      },
    ]);
    await askFirstmate(again.page, words);
    expect(answer.outcome().state).toBe("closed");
    const left = await read(again, HARBOR.id);
    expect(left.state === "ready" && left.rows.map((row) => row.id)).not.toContain(
      "current-direction-0",
    );
    await again.page.evaluate(() => window.infinitary.retention.purge());
  } finally {
    await again.close();
  }
  const purged = await launchApp({
    userDataDir,
    withMockProvider: true,
    packaged: true,
    version: "0.2.0",
  });
  try {
    const kept = await read(purged, "captain");
    expect(kept.state === "ready" && kept.rows).toEqual([]);
    const gone = await purged.page.evaluate(() =>
      window.infinitary.plugins.read("knowledge.direction", { id: "current-direction-0" }),
    );
    expect(gone.state).toBe("missing");
  } finally {
    await purged.close();
  }
});
