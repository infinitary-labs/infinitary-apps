import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardService } from "@core/orchestrator/cardService";
import { CardStore } from "@core/storage/cardStore";
import { type AppDatabase, openDatabase } from "@core/storage/db";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { NOTE_GOT_IT_LABEL } from "@shared/cardLeave";
import { cardMediaFileName, cardPictureFileName } from "@shared/cardPictures";
import type { Card, CardQuestion } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { type CorpusExportResult, exportCorpus, main } from "../scripts/export-corpus.ts";
import type { Episode } from "../scripts/human-supervision.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The human-supervision view (docs/card-evidence.md, "The export"), proven
 * against a fixture userData the app's own migrations, stores and card
 * service wrote: the evidence under test is the real capture, only the
 * journey is ours. The episodes are read back from the files the command
 * wrote, the way a reader of the pack would.
 */

const PICTURE_ID = `t1-${"a".repeat(32)}`;
const LOST_PICTURE_ID = `t1-${"b".repeat(32)}`;
const RECORDING_ID = `t1-${"c".repeat(32)}`;

const scopeQuestion: CardQuestion = {
  name: "scope",
  kind: "single",
  control: "radio",
  prompt: "Which projects may it read?",
  promptBasis: "legend",
  options: [
    {
      value: "this",
      label: "Just this one",
      authoredDefault: true,
      disabled: false,
      hidden: false,
    },
    {
      value: "all",
      label: "Every project",
      authoredDefault: false,
      disabled: false,
      hidden: false,
    },
  ],
  defaultBasis: "authored",
  required: true,
  gaps: [],
  complete: true,
};

/** A userData whose card evidence came from a real journey through the card service. */
function buildUserData(dir: string): { first: Card; revisedTitle: string } {
  const db = openDatabase(dir);
  // A card resolved before the capture existed: only its final row remains.
  const legacy = new CardStore(db);
  legacy.upsert({
    id: "card-legacy",
    author: "firstmate",
    priority: 30,
    title: "An old question",
    meta: "firstmate",
    body: "<p>From before.</p>",
    actions: [{ id: "yes", label: "Yes", default: true }],
    status: "ready",
    createdAt: 10,
  });
  legacy.resolve("card-legacy", "yes");

  let clock = 1_000;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    now: () => {
      clock += 1;
      return clock;
    },
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    build: "0.1.24",
  });
  const decision = {
    title: "Pick the reach",
    body: [
      "<p>Choose how far it reaches. api_key=sk-live-1234567890abcdef</p>",
      `<img src="app-frame://images/${cardPictureFileName(PICTURE_ID, "png")}" alt="the plan">`,
    ].join(""),
    actions: [
      { id: "narrow", label: "Keep it narrow" },
      { id: "wide", label: "Go wide", default: true },
    ],
    pictures: [
      {
        id: PICTURE_ID,
        alt: "the plan",
        width: 10,
        height: 10,
        group: 0,
        demo: {
          id: RECORDING_ID,
          kind: "mp4" as const,
          width: 10,
          height: 10,
          durationMs: 3000,
          bytes: 9,
          sha256: "f".repeat(64),
        },
      },
      { id: LOST_PICTURE_ID, alt: "gone", width: 10, height: 10, group: 1 },
    ],
  };
  const id = cards.emitCrewmateCard("t1", decision, "Build it");
  cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
  const first = cards.shown(id) as Card;
  const asked = cards.addMessage(id, "captain", "Does wide include archived projects?", {
    id: "gesture-reply",
    offerId: first.offerId,
  });
  cards.replyFromCrewmate("t1", {
    cardId: id,
    text: "No, archived ones stay out.",
    answersMessage: asked.id,
  });
  cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
  // The author revises while the answered version is on the stage.
  const revisedTitle = "Pick the reach, archived excluded";
  cards.emitCrewmateCard("t1", { ...decision, id, title: revisedTitle }, "Build it");
  const shown = cards.shown(id) as Card;
  cards.resolve(
    shown,
    "wide",
    "wide",
    [{ name: "scope", values: ["all"], labels: ["Every project"], changed: true }],
    "captain",
    {
      source: "chrome",
      submission: {
        id: "gesture-choice",
        offerId: shown.offerId,
        lifecycleId: shown.lifecycleId,
        reading: "fresh",
        questions: [scopeQuestion],
      },
      context: tasks.capture.decisionContext("t1"),
    },
  );
  // A Firstmate note the captain closed on its Got it (INF-2794).
  const dismissed = cards.addFirstmateCard({
    title: "A side note",
    body: "<p>FYI.</p>",
    actions: [],
  });
  cards.pressNote(cards.shown(dismissed) as Card, { id: "gesture-close" });
  db.close();

  // The first picture's verified copy, where the app keeps it; the second is gone.
  const pictures = join(dir, "crewmates", "t1", "cards");
  mkdirSync(pictures, { recursive: true });
  writeFileSync(join(pictures, cardPictureFileName(PICTURE_ID, "png")), "png-bytes");
  writeFileSync(join(pictures, cardMediaFileName(RECORDING_ID, "mp4")), "mp4-bytes");
  return { first, revisedTitle };
}

function exported(result: CorpusExportResult): Extract<CorpusExportResult, { status: "exported" }> {
  if (result.status !== "exported") throw new Error(`expected an export, got ${result.status}`);
  return result;
}

function exportInto(dir: string, out: string, humanSupervision = true): CorpusExportResult {
  return exportCorpus({
    gate: { isPackaged: false },
    dbPath: join(dir, "firstmate.db"),
    sessionsDir: join(dir, "firstmate", "sessions"),
    outDir: out,
    humanSupervision,
    userDataDir: dir,
    now: 5_000,
  });
}

function episodesIn(out: string): Episode[] {
  return readFileSync(join(out, "human-supervision.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Episode);
}

describe("corpus export - the human-supervision view", () => {
  it("writes one episode per lifecycle, naming the offer the captain chose from", () => {
    const dir = scratchDir("infinitary-hs-");
    const { first, revisedTitle } = buildUserData(dir);
    const out = join(dir, "pack");
    exported(exportInto(dir, out));
    const episodes = episodesIn(out);
    expect(episodes.map((episode) => [episode.basis, episode.card_id])).toEqual([
      ["captured", "card-t1-1"],
      ["captured", expect.stringMatching(/^card-fm-/)],
      ["legacy-reconstructed", "card-legacy"],
    ]);

    const [choice] = episodes as [Episode];
    expect(choice.episode_id).toBe(first.lifecycleId);
    // Two offers; the stage still showed the first when the captain chose.
    expect(choice.offers.map((offer) => offer.title)).toEqual(["Pick the reach", revisedTitle]);
    expect(choice.offers[0]?.offer_id).toBe(first.offerId);
    const [interaction] = choice.interactions;
    expect(interaction).toMatchObject({
      interaction_id: "gesture-choice",
      offer_id: first.offerId,
      actor: "captain",
      source: "chrome",
      actionId: "wide",
      label: "Go wide",
      closes: true,
      answers: [{ name: "scope", values: ["all"], labels: ["Every project"], changed: true }],
      questions: [scopeQuestion],
      display: { fidelity: "matched" },
      context: { taskId: "t1", status: "active" },
      outcome: "unknown",
      eligibility: {
        human_source: true,
        display_matched: true,
        questions: "complete",
        context_present: true,
        outcome_known: false,
        labelled: false,
      },
    });
    expect(choice.end).toMatchObject({ kind: "action", interaction_id: "gesture-choice" });
    // The thread, with its words, against the offer each line was about:
    // the host's line names the revision it announces.
    const revised = choice.offers[1]?.offer_id;
    expect(choice.thread.map((line) => [line.who, line.text, line.offer_id])).toEqual([
      ["captain", "Does wide include archived projects?", first.offerId],
      ["crewmate", "No, archived ones stay out.", first.offerId],
      ["host", `revised: ${revisedTitle}`, revised],
    ]);
    // Later evidence stays apart from what the choice was made on.
    expect(choice.later).toEqual({
      join: "same-task-at-cutoff",
      task: { status: "active", closed_reason: null, closed_at: null },
      effect_receipts: [],
    });
    expect(choice.missing).toEqual(["outcome:unknown", "pictures:missing"]);
    expect(choice.rights).toEqual({ scope: "owner-local", external_use: "not-authorized" });

    const gotIt = episodes[1] as Episode;
    expect(gotIt.interactions).toMatchObject([
      { interaction_id: "gesture-close", actor: "captain", label: NOTE_GOT_IT_LABEL, closes: true },
    ]);
    expect(gotIt.end).toMatchObject({ kind: "action", interaction_id: "gesture-close" });
  });

  it("reconstructs a card from before the capture without inventing a click or a shown version", () => {
    const dir = scratchDir("infinitary-hs-legacy-");
    buildUserData(dir);
    const out = join(dir, "pack");
    exported(exportInto(dir, out));
    const legacy = episodesIn(out).find((episode) => episode.basis === "legacy-reconstructed");
    expect(legacy?.offers.map((offer) => offer.basis)).toEqual(["legacy-final-row"]);
    expect(legacy?.interactions).toMatchObject([
      {
        basis: "legacy-final-row",
        actor: "unknown",
        offer_id: null,
        actionId: "yes",
        display: { fidelity: "legacy-missing" },
        eligibility: { human_source: false, display_matched: false, context_present: false },
      },
    ]);
    expect(legacy?.missing).toEqual([
      "context:not-recorded",
      "display:shown-offer-unknown",
      "lifecycle:start-unknown",
      "outcome:unknown",
      "stage:not-recorded",
    ]);
  });

  it("ships the pictures an offer shows, names the one it cannot find, and checksums the pack", () => {
    const dir = scratchDir("infinitary-hs-assets-");
    buildUserData(dir);
    const out = join(dir, "pack");
    const result = exported(exportInto(dir, out));
    const [choice] = episodesIn(out) as [Episode];
    const pictures = choice.offers[0]?.pictures ?? [];
    expect(pictures.map((picture) => [picture.id, picture.asset, picture.missing ?? null])).toEqual(
      [
        [PICTURE_ID, `assets/pictures/${PICTURE_ID}.png`, null],
        [LOST_PICTURE_ID, null, "not-found"],
      ],
    );
    expect(readFileSync(join(out, `assets/pictures/${PICTURE_ID}.png`), "utf8")).toBe("png-bytes");
    // A poster's demo recording rides beside it, copied and checksummed the same way.
    expect(pictures[0]?.demo).toMatchObject({
      id: RECORDING_ID,
      kind: "mp4",
      duration_ms: 3000,
      asset: `assets/pictures/${RECORDING_ID}.mp4`,
    });
    expect(readFileSync(join(out, `assets/pictures/${RECORDING_ID}.mp4`), "utf8")).toBe(
      "mp4-bytes",
    );
    const section = result.manifest.human_supervision;
    expect(section?.counts.pictures).toEqual({ copied: 2, missing: 2 });
    expect(Object.keys(section?.files ?? {})).toEqual([
      "supervision.jsonl",
      "supervision-turns.jsonl",
      "decisions.jsonl",
      "dispatch.jsonl",
      "human-supervision.jsonl",
      "human-supervision-labels.jsonl",
      `assets/pictures/${PICTURE_ID}.png`,
      `assets/pictures/${RECORDING_ID}.mp4`,
    ]);
    expect(readFileSync(join(out, "human-supervision-labels.jsonl"), "utf8")).toBe("");
    // The choice card's first offer and the side note's; the revision never
    // reached the stage. The choice and the side note's Got it are both the
    // captain's clicks on host controls.
    expect(section?.funnel).toEqual({
      offers_available: 2,
      host_control_interactions: 2,
      matched_offers: 1,
      question_and_context_complete: 1,
      labels: 0,
    });
  });

  it("produces the same records and checksums from the same cutoff", () => {
    const dir = scratchDir("infinitary-hs-repeat-");
    buildUserData(dir);
    const one = exported(exportInto(dir, join(dir, "one")));
    const two = exported(exportInto(dir, join(dir, "two")));
    expect(readFileSync(join(dir, "two", "human-supervision.jsonl"), "utf8")).toBe(
      readFileSync(join(dir, "one", "human-supervision.jsonl"), "utf8"),
    );
    expect(two.manifest.human_supervision?.files).toEqual(one.manifest.human_supervision?.files);
    expect(two.manifest.human_supervision?.cutoff).toEqual(one.manifest.human_supervision?.cutoff);
  });

  it("scrubs credential shapes and says so, without calling the pack anonymous", () => {
    const dir = scratchDir("infinitary-hs-redact-");
    buildUserData(dir);
    const out = join(dir, "pack");
    exported(exportInto(dir, out));
    const text = readFileSync(join(out, "human-supervision.jsonl"), "utf8");
    expect(text).not.toContain("sk-live-1234567890abcdef");
    const [choice] = episodesIn(out) as [Episode];
    expect(choice.redacted).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.human_supervision.rights.external_use).toBe("not-authorized");
  });

  it("refuses a destination that already holds anything, and leaves it and its folder as they were", () => {
    const dir = scratchDir("infinitary-hs-refuse-");
    buildUserData(dir);
    const out = join(dir, "pack");
    mkdirSync(out);
    writeFileSync(join(out, "reviewed.txt"), "a freeze someone reviewed");
    expect(exportInto(dir, out)).toMatchObject({ status: "refused" });
    expect(readdirSync(out)).toEqual(["reviewed.txt"]);
    expect(readdirSync(dir).filter((name) => name.includes("staging"))).toEqual([]);
    // An empty destination is new enough.
    const empty = join(dir, "empty");
    mkdirSync(empty);
    exported(exportInto(dir, empty));
    expect(existsSync(join(empty, "human-supervision.jsonl"))).toBe(true);
  });

  it("excludes an observation it cannot read, naming why, and exports the rest", () => {
    const dir = scratchDir("infinitary-hs-exclude-");
    buildUserData(dir);
    const db: AppDatabase = openDatabase(dir);
    db.prepare(
      `INSERT INTO card_observations
         (id, card_id, lifecycle_id, kind, schema_version, capture_version, recorded_at, actor, source, payload_json)
       VALUES ('odd', 'card-x', 'life-x', 'exit', 1, 1, 9, 'host', 'host', '{"reason":"vanished"}')`,
    ).run();
    const seq = (
      db.prepare("SELECT seq FROM card_observations WHERE id = 'odd'").get() as {
        seq: number;
      }
    ).seq;
    db.close();
    const result = exported(exportInto(dir, join(dir, "pack")));
    expect(result.manifest.human_supervision?.exclusions).toEqual([
      { reason: "invalid-payload", seqs: [seq] },
    ]);
    expect(episodesIn(join(dir, "pack")).some((episode) => episode.card_id === "card-x")).toBe(
      false,
    );
  });

  it("reads nothing and writes nothing through the CLI while the gate is shut, and prints no bodies", () => {
    const dir = scratchDir("infinitary-hs-cli-");
    buildUserData(dir);
    const out = join(dir, "pack");
    const said: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      const args = ["--user-data", dir, "--out", out, "--human-supervision"];
      expect(main(args, { isPackaged: true, env: {} })).toBe(3);
      expect(existsSync(out)).toBe(false);
      expect(main(args, { isPackaged: false })).toBe(0);
      expect(existsSync(join(out, "human-supervision.jsonl"))).toBe(true);
      // A second run into the same pack is refused.
      expect(main(args, { isPackaged: false })).toBe(4);
    } finally {
      stderr.mockRestore();
    }
    const output = said.join("");
    expect(output).toContain("human supervision: 3 episode(s)");
    for (const words of ["Pick the reach", "archived", "Every project", "sk-live"]) {
      expect(output).not.toContain(words);
    }
  });
});
