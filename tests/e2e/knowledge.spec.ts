import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { renderBriefKnowledge } from "../../src/core/knowledge/context";
import { renderDirections } from "../../src/core/knowledge/directions";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { type MockProviderServer, SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import { providerMessages, served } from "./providerRequest";
import { reportLine, taskKey } from "./rails";
import { readKnowledgeData, readSavedData } from "./savedData";
import { KNOWLEDGE_FACT_PROMPT_MARKER, knowledgeFact } from "./scenarios/knowledgeFact";
import {
  KNOWLEDGE_RECORD_PROMPT_MARKER,
  KNOWLEDGE_REUSE_PROMPT_MARKER,
  knowledgeRecord,
  MOCK_KNOWLEDGE_ARTICLE,
  MOCK_KNOWLEDGE_CONCEPT,
  MOCK_KNOWLEDGE_FINDING,
} from "./scenarios/knowledgeRecord";

/**
 * Knowledge (docs/knowledge.md) through the real app, its real crewmate
 * tools and its real database: what one crewmate records - a concept and a
 * finding citing a file in its working copy - outlives its task and a
 * restart, and the next crewmate, asking in other words, is offered it in
 * its brief, follows it to the finding and reads the kept evidence. And
 * where knowledge is on, a fact the captain states goes to knowledge, not
 * notes. The scripted model proves what reaches each session and what is
 * kept, not that a model reasons well with it.
 */

/** Where a run keeps what the journey saw, when asked (the crewmate's evidence folder). */
const evidence = process.env.INFINITARY_KNOWLEDGE_EVIDENCE;

function keep(name: string, value: unknown): void {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, name),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

const SOURCE = [
  "// A provider failure spends no delivery attempt;",
  "export const retryWakeOnProviderFailure = true;",
  "export const attempts = 3;",
  "",
].join("\n");

/** The standing directions' header line, as every turn that carries them opens. */
const DIRECTIONS_HEADER = (() => {
  const header = renderDirections([])?.split("\n")[0];
  if (!header) throw new Error("renderDirections gave no header line");
  return header;
})();

/** A project folder named harbor: one commit with the file the finding cites. */
function harborRepo(): string {
  const dir = join(scratchDir("infinitary-knowledge-"), "harbor");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "inbox.ts"), SOURCE);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@localhost", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

/** Every message the scripted crewmates were sent whose words carry `marker`. */
function crewmateMessages(bodies: readonly string[], marker: string): string[] {
  return bodies
    .filter((body) => !body.includes(FIRSTMATE_PERSONA) && body.includes(marker))
    .flatMap((body) => providerMessages(body).map((message) => message.text));
}

test("what one crewmate records outlives its task and a restart, and the next finds it in other words", async () => {
  const repoDir = harborRepo();
  // The journey owns the scripted model, so it outlives the first app.
  const mockProvider = await startMockProvider({ scenarios: [knowledgeRecord, knowledgeFact] });
  try {
    await journey(repoDir, mockProvider);
  } finally {
    await mockProvider.close();
  }
});

async function journey(repoDir: string, mockProvider: MockProviderServer): Promise<void> {
  const first = await launchApp({ reuseMockProvider: mockProvider });
  const { userDataDir, homeDir } = first;

  // Recording: the first crewmate on harbor records a concept and a finding.
  const { repo } = await first.page.evaluate(
    (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
    repoDir,
  );
  expect(repo.name).toBe("harbor");
  const directionText = "Review Harbor changes before final delivery.";
  const privateText = "Keep this private captain direction out of project work.";
  const directionWords = "Keep these two standing directions.";
  mockProvider.scriptFirstmateTurn(
    served({
      kind: "user",
      origin: "captain",
      body: renderWake(captainTurn(directionWords, false)),
    }),
    [
      {
        name: "app_change",
        args: {
          action: "direction",
          value: { op: "add", id: "harbor-review", scope: repo.id, text: directionText },
          evidence: directionWords,
        },
      },
      {
        name: "app_change",
        args: {
          action: "direction",
          value: { op: "add", id: "private-rule", scope: "captain", text: privateText },
          evidence: directionWords,
        },
      },
      {
        name: "emit_card",
        args: { title: "Directions kept", body: "<p>Both standing directions are saved.</p>" },
      },
    ],
  );
  await askFirstmate(first.page, directionWords);
  const input = promptInput(first.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${KNOWLEDGE_RECORD_PROMPT_MARKER}`);
  await input.press("Enter");
  const recorder = await taskKey(first.page, KNOWLEDGE_RECORD_PROMPT_MARKER);
  await expect(reportLine(first.page, recorder)).toBeVisible({ timeout: 60_000 });
  await waitForFirstmateIdle(first.page);

  // Its task closes - discarded, its working copy gone - and the app restarts.
  const recorderId = readSavedData(
    userDataDir,
    (db) => db.prepare("SELECT id FROM tasks WHERE key = ?").pluck().get(recorder) as string,
  );
  const initialCrew = crewmateMessages(
    mockProvider.requestBodies(),
    KNOWLEDGE_RECORD_PROMPT_MARKER,
  );
  expect(initialCrew.join("\n")).toContain(directionText);
  expect(initialCrew.join("\n")).not.toContain(privateText);
  const revisedText = "Read Harbor changes and their verification before final delivery.";
  const steerWords = "Update Harbor's direction.";
  const steering = "Continue with the current Harbor direction.";
  const start = mockProvider.requestBodies().length;
  mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(steerWords, false)) }),
    [
      {
        name: "app_change",
        args: {
          action: "direction",
          value: { op: "revise", id: "d:harbor-review", expectedRevision: 1, text: revisedText },
          evidence: steerWords,
        },
      },
      {
        name: "emit_card",
        args: {
          title: "Direction updated",
          body: "<p>The updated direction is saved.</p>",
        },
      },
    ],
  );
  await askFirstmate(first.page, steerWords);
  const updated = await first.page.evaluate(() =>
    window.infinitary.plugins.read("knowledge.direction", { id: "harbor-review" }),
  );
  expect(updated.state === "ready" && updated.direction.text).toBe(revisedText);
  const continueWords = "Ask Harbor's crewmate to continue.";
  mockProvider.scriptFirstmateTurn(
    served({
      kind: "user",
      origin: "captain",
      body: renderWake(captainTurn(continueWords, false)),
    }),
    [
      { name: "steer_crewmate", args: { task_id: recorderId, message: steering } },
      {
        name: "emit_card",
        args: { title: "Crewmate continued", body: "<p>The crewmate is continuing.</p>" },
      },
    ],
  );
  await askFirstmate(first.page, continueWords);
  const currentCrewTurn = () =>
    crewmateMessages(mockProvider.requestBodies().slice(start), steering).find(
      (text) => text.includes(steering) && text.includes(DIRECTIONS_HEADER),
    );
  await expect.poll(currentCrewTurn).toContain(revisedText);
  expect(currentCrewTurn()).not.toContain(privateText);
  expect(currentCrewTurn()).not.toContain(directionText);
  await expect
    .poll(() => first.page.evaluate(() => window.infinitary.crew.counts()))
    .toMatchObject({ idle: 1, working: 0 });
  keep("direction-fresh-and-resumed-crew.json", {
    initial: initialCrew,
    resumed: currentCrewTurn(),
  });
  await first.page.evaluate((id) => window.infinitary.task.delete(id), recorderId);
  await first.close();
  const kept = readKnowledgeData(userDataDir, (db) => ({
    entries: db
      .prepare("SELECT kind, scope, author, lifecycle, lane FROM entries ORDER BY kind")
      .all(),
    sources: db.prepare("SELECT id, kind, origin, text FROM sources").all() as {
      id: string;
      kind: string;
      origin: string;
      text: string;
    }[],
  }));
  expect(kept.entries).toEqual([
    {
      kind: "concept",
      scope: "captain",
      author: `task:${recorderId}`,
      lifecycle: "active",
      lane: "reference",
    },
    {
      kind: "finding",
      scope: "captain",
      author: `task:${recorderId}`,
      lifecycle: "active",
      lane: "reference",
    },
  ]);
  expect(kept.sources.length).toBeGreaterThanOrEqual(1);
  expect(kept.sources.every((source) => source.kind === "article")).toBe(true);
  expect(kept.sources.map((source) => source.text)).toContain(MOCK_KNOWLEDGE_ARTICLE.excerpt);
  expect(JSON.parse(kept.sources[0]?.origin ?? "{}")).toMatchObject({
    kind: "article",
    url: MOCK_KNOWLEDGE_ARTICLE.url,
    title: MOCK_KNOWLEDGE_ARTICLE.title,
    author: MOCK_KNOWLEDGE_ARTICLE.author,
    published: MOCK_KNOWLEDGE_ARTICLE.published,
  });
  expect(
    crewmateMessages(mockProvider.requestBodies(), KNOWLEDGE_RECORD_PROMPT_MARKER).some((text) =>
      text.includes("already saved"),
    ),
  ).toBe(true);

  // Reuse: after the restart, a crewmate asked in other words finds the
  // concept by searching - its brief lists no saved entry, only how much is
  // saved (INF-4008) - follows it to the finding and reads the evidence.
  const second = await launchApp({ userDataDir, homeDir, reuseMockProvider: mockProvider });
  try {
    const again = promptInput(second.page);
    await again.click();
    await again.fill(`${SPAWN_PROMPT_MARKER} ${KNOWLEDGE_REUSE_PROMPT_MARKER}`);
    await again.press("Enter");
    const reader = await taskKey(second.page, KNOWLEDGE_REUSE_PROMPT_MARKER);
    await expect(reportLine(second.page, reader)).toBeVisible({ timeout: 60_000 });
    await waitForFirstmateIdle(second.page);
  } finally {
    await second.close();
  }
  const seen = crewmateMessages(mockProvider.requestBodies(), KNOWLEDGE_REUSE_PROMPT_MARKER);
  // The brief says how much is saved and names nothing in it.
  const countLine = renderBriefKnowledge({
    state: "held",
    counts: { personal: 0, sources: 1, findings: 1 },
  }) as string;
  const brief = seen.find((text) => text.includes(countLine));
  expect(brief).toBeDefined();
  expect(brief).not.toContain(MOCK_KNOWLEDGE_CONCEPT.title);
  expect(brief).toContain(revisedText);
  expect(brief).not.toContain(privateText);
  // A search answer, not the brief, is what named the concept.
  const found = seen.find((text) => text.includes(`concept "${MOCK_KNOWLEDGE_CONCEPT.title}"`));
  expect(found).toBeDefined();
  expect(found).not.toBe(brief);
  // The finding as the crewmate read it: what it says, and the saved link.
  // Kept text is requested separately by source id.
  const read = seen.find(
    (text) =>
      text.includes(MOCK_KNOWLEDGE_FINDING.statement) && text.includes(MOCK_KNOWLEDGE_ARTICLE.url),
  );
  expect(read).toContain(MOCK_KNOWLEDGE_ARTICLE.author);
  const sourceRead = seen.find((text) => text.includes(MOCK_KNOWLEDGE_ARTICLE.excerpt));
  expect(sourceRead).toBeDefined();
  // Its declared use records the revision it relied on and that its
  // source still read the same in the closed task's absence.
  const uses = readKnowledgeData(userDataDir, (db) =>
    db.prepare("SELECT actor, revision, observed FROM uses").all(),
  ) as { actor: string; revision: number; observed: string }[];
  expect(uses).toHaveLength(1);
  expect(uses[0]?.revision).toBe(1);
  expect(uses[0]?.actor).not.toBe(`task:${recorderId}`);
  const observed = JSON.parse(uses[0]?.observed ?? "{}") as {
    current: number;
    lifecycle: string;
    sources: Record<string, string>;
  };
  expect(observed.current).toBe(1);
  expect(observed.lifecycle).toBe("active");
  expect(Object.values(observed.sources)).toEqual(["kept"]);
  keep("knowledge-journey-brief.txt", brief);
  keep("knowledge-journey-crewmate-messages.txt", seen.join("\n\n----- next message -----\n\n"));
  keep("knowledge-journey-rows.json", {
    entries: kept.entries,
    sources: kept.sources,
    uses: readKnowledgeData(userDataDir, (db) => db.prepare("SELECT * FROM uses").all()),
    revisions: readKnowledgeData(userDataDir, (db) =>
      db.prepare("SELECT entry_id, revision, op, actor, origin, body FROM revisions").all(),
    ),
  });
  expect(brief).not.toContain(MOCK_KNOWLEDGE_FINDING.statement);
}

test("a fact the captain states goes to knowledge, not notes, where knowledge is on", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [knowledgeRecord, knowledgeFact],
  });
  try {
    const input = promptInput(launched.page);
    await input.click();
    await input.fill(KNOWLEDGE_FACT_PROMPT_MARKER);
    await input.press("Enter");
    await expect
      .poll(
        () =>
          (launched.mockProvider?.requestBodies() ?? []).some((body) =>
            providerMessages(body).some(
              (message) =>
                message.role === "tool" &&
                /Recorded concept c-[a-z0-9]{6} "Deploy day"/.test(message.text),
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await waitForFirstmateIdle(launched.page);
  } finally {
    await launched.close();
  }
  const notes = readSavedData(launched.userDataDir, (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").all(),
  );
  expect(notes).toEqual([]);
  expect(
    readKnowledgeData(launched.userDataDir, (db) =>
      db.prepare("SELECT kind, scope, author FROM entries").all(),
    ),
  ).toEqual([{ kind: "concept", scope: "captain", author: "firstmate" }]);
});
