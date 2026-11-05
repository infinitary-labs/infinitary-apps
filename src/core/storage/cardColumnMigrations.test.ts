import type { Card } from "@shared/cards";
import type { RiskAssessment } from "@shared/risk";
import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  REVERSE_ANSWERED_BY,
  REVERSE_MIGRATION_57,
  REVERSE_MIGRATION_59,
  REVERSE_MIGRATION_65,
  REVERSE_MIGRATION_66,
  REVERSE_MIGRATION_67,
  REVERSE_MIGRATION_69,
  REVERSE_MIGRATION_70,
  REVERSE_MIGRATION_71,
  REVERSE_MIGRATION_77,
  REVERSE_MIGRATION_88,
  REVERSE_MIGRATION_93,
  REVERSE_MIGRATION_101,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { CardStore } from "./cardStore";
import type { AppDatabase } from "./db";
import { CARD_ANSWERER_MIGRATION_VERSION, openDatabase } from "./db";
import { dropViews } from "./views";

// The migrations that add one column to a card, as one table: each upgrades a
// card the older version saved, reads it as it was, saves the new value
// through today's writer, reads it back, and reverses to the older shape
// without losing a card.

type CardColumnCase = {
  /** The describe block the test sits in, when it has one. */
  describe?: string;
  it: string;
  /** The newest migration the older database ran. */
  from: number;
  /** The column the migration adds, which the older shape must lack. */
  added?: string;
  /** The older card, inserted as that version saved it, and its id. */
  card: string;
  id: string;
  /** False for the tests that do not check the upgrade ran every migration. */
  everyVersion?: false;
  /** What the older card reads as once upgraded. */
  legacy: (old: Card, store: CardStore) => void;
  /** Saves the new value through today's writer. */
  write: (old: Card, store: CardStore, db: AppDatabase) => void;
  /** False to read the value back on the same connection instead of after a restart. */
  restart?: false;
  readBack: (store: CardStore, old: Card) => void;
  /** Drops the views first, as a reversal that meets them must. */
  dropViews?: true;
  /** The SQL that undoes the column, after every later one over the cards. */
  reverse: string;
  /** The cards left after the reversal: a count, or the older card alone, still ready. */
  rows: number | "older card";
};

/** An older crewmate card with this meta, as the versions before migration 57 saved it. */
const olderCard = (meta: string) =>
  `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
   VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', '${meta}', '<p>Old.</p>', '[]', 'ready', 1)`;

/** An older first mate card, as the versions before migrations 77 and 87 saved it. */
const OLDER_FIRSTMATE_CARD =
  "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('legacy', 'card', 'firstmate', 15, 'Before', 'firstmate', '<p>Old.</p>', '[]', 'ready', 1)";

/** Drops these card columns, newest last, one statement each. */
const dropCardColumns = (...columns: string[]) =>
  columns.map((column) => `ALTER TABLE cards DROP COLUMN ${column};\n`).join("");

/** What a reversal of a card column from before migration 57 undoes after its own columns. */
const REVERSE_THROUGH_57 =
  REVERSE_MIGRATION_71 +
  REVERSE_MIGRATION_70 +
  REVERSE_MIGRATION_69 +
  REVERSE_MIGRATION_67 +
  REVERSE_MIGRATION_66 +
  REVERSE_MIGRATION_65 +
  REVERSE_MIGRATION_59 +
  REVERSE_MIGRATION_57;

const PICTURES = [
  {
    id: "t1-0123456789abcdef0123456789abcdef",
    alt: "Before",
    width: 1200,
    height: 760,
    group: 0,
  },
  {
    id: "t1-fedcba9876543210fedcba9876543210",
    alt: "After",
    width: 900,
    height: 2660,
    group: 0,
  },
];

const ANSWERS = [{ name: "speed", values: ["fast"], labels: ["Fast"], changed: true }];

const ATTACHMENT = {
  kind: "browser",
  label: "Try it",
  taskId: "t1",
  session: "run-1",
  generation: 1,
};

const rating = { level: "low", why: "One file in the footer" } as const;
const RISK: RiskAssessment = {
  declared: {
    blast: rating,
    behavior: { level: "medium", why: "A switch, off until turned on" },
    undo: rating,
    evidence: rating,
    sensitivity: rating,
    novelty: rating,
    deps: rating,
  },
};

const CARD_COLUMNS: CardColumnCase[] = [
  {
    describe: "migration 41 (the pictures a card shows, card pictures phase 2)",
    it: "adds the nullable column, keeps every card with no pictures, records new ones, and reverses",
    from: 40,
    added: "pictures_json",
    card: olderCard("m"),
    id: "card-old",
    // A card from before the column shows no pictures.
    legacy: (old) => expect(old).not.toHaveProperty("pictures"),
    write: (old, store) => store.upsert({ ...old, id: "card-new", pictures: PICTURES }),
    restart: false,
    readBack: (store) => expect(store.get("card-new")?.pictures).toEqual(PICTURES),
    // Dropping the column (and 52's, 54's and 55's after it) restores the v40 shape.
    reverse:
      dropCardColumns("pictures_json", "awaiting", "answers_json", "width", "model") +
      REVERSE_THROUGH_57,
    rows: 2,
  },
  {
    describe: "migration 52 (what a card off the stage awaits, the card return rule)",
    it: "adds the nullable column, keeps every card on the stage, reads a hold back after a restart, and reverses",
    from: 51,
    added: "awaiting",
    card: olderCard("m"),
    id: "card-old",
    // A card from before the column is on the stage: it awaits nothing.
    legacy: (old) => expect(old).not.toHaveProperty("awaiting"),
    write: (old, store) => store.upsert({ ...old, id: "card-held", awaiting: "answer" }),
    readBack: (store) => expect(store.get("card-held")?.awaiting).toBe("answer"),
    reverse: dropCardColumns("awaiting", "answers_json", "width", "model") + REVERSE_THROUGH_57,
    rows: 2,
  },
  {
    describe: "migration 54 (the answers a card's own questions got, inline decisions)",
    it: "adds the nullable column, keeps every resolved card without answers, records new ones, and reverses",
    from: 53,
    added: "answers_json",
    card: `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
           VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'm', '<p>Old.</p>', '[{"id":"go","label":"Go"}]', 'ready', 1, 2, 'go')`,
    id: "card-old",
    // A card resolved before the column carried no answers.
    legacy: (_old, store) => {
      expect(store.resolvedSince(0, 5)).toEqual([expect.objectContaining({ action: "go" })]);
      expect(store.resolvedSince(0, 5)[0]).not.toHaveProperty("answers");
    },
    write: (old, store) => {
      store.upsert({ ...old, id: "card-new", createdAt: 3 });
      store.resolve("card-new", "go", ANSWERS);
    },
    restart: false,
    readBack: (store) =>
      expect(
        store.resolvedSince(0, 5).find((entry) => entry.card.id === "card-new")?.answers,
      ).toEqual(ANSWERS),
    reverse: dropCardColumns("answers_json", "width", "model") + REVERSE_THROUGH_57,
    rows: 2,
  },
  {
    describe: "migration 55 (how wide a card is, the captain's Q5 to Q7 A)",
    it: "adds the nullable column, keeps every earlier card regular, reads a width back after a restart, and reverses",
    from: 54,
    added: "width",
    card: olderCard("m"),
    id: "card-old",
    // A card from before the column is a regular card.
    legacy: (old) => expect(old).not.toHaveProperty("width"),
    write: (old, store) => store.upsert({ ...old, id: "card-wide", width: "wide" }),
    readBack: (store) => expect(store.get("card-wide")?.width).toBe("wide"),
    reverse: dropCardColumns("width", "model") + REVERSE_THROUGH_57,
    rows: 2,
  },
  {
    describe: "migration 56 (the model a card's author ran on, the model chip)",
    it: "adds the nullable column, keeps an older card's meta whole, records the model, and reverses",
    from: 55,
    added: "model",
    card: olderCard("Build it · GPT-6 Sol"),
    id: "card-old",
    // A card written before the column keeps its meta as it was, and names no model.
    legacy: (old) => {
      expect(old.meta).toBe("Build it · GPT-6 Sol");
      expect(old).not.toHaveProperty("model");
    },
    write: (old, store) =>
      store.upsert({ ...old, id: "card-new", meta: "Build it", model: "GPT-6 Sol", createdAt: 3 }),
    readBack: (store) =>
      expect(store.get("card-new")).toMatchObject({ meta: "Build it", model: "GPT-6 Sol" }),
    reverse: dropCardColumns("model") + REVERSE_THROUGH_57,
    rows: 2,
  },
  {
    describe: "migration 65 (a card's live attachment, the task browser from a card)",
    it: "adds the nullable column, keeps every earlier card without one, reads one back, and reverses",
    from: 64,
    added: "attachment_json",
    card: "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-old', 'card', 'crewmate', 30, 'A card', 'crewmate 1', 'Body.', '[]', 'ready', 1)",
    id: "card-old",
    // A card written before the column points at nothing.
    legacy: (old) => expect(old.attachment).toBeUndefined(),
    write: (_old, _store, db) =>
      db
        .prepare("UPDATE cards SET attachment_json = ? WHERE id = 'card-old'")
        .run(JSON.stringify(ATTACHMENT)),
    readBack: (store) => expect(store.get("card-old")?.attachment).toEqual(ATTACHMENT),
    dropViews: true,
    reverse:
      REVERSE_MIGRATION_71 +
      REVERSE_MIGRATION_70 +
      REVERSE_MIGRATION_69 +
      REVERSE_MIGRATION_67 +
      REVERSE_MIGRATION_65,
    rows: 1,
  },
  {
    describe: "migration 67 (where a crewmate card's task runs, FI3-1019)",
    it: "adds the nullable column, keeps an older card's meta whole, records the place, and reverses",
    from: 66,
    added: "place",
    card: `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, model, body, actions_json, status, created_at)
           VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'footer · on Mac mini', 'GPT-6 Sol', '<p>Old.</p>', '[]', 'ready', 1)`,
    id: "card-old",
    // A card written before the column keeps its meta as it was, and names no place.
    legacy: (old) => {
      expect(old.meta).toBe("footer · on Mac mini");
      expect(old).not.toHaveProperty("place");
    },
    write: (old, store) =>
      store.upsert({ ...old, id: "card-new", meta: "footer", place: "on Mac mini", createdAt: 3 }),
    readBack: (store) =>
      expect(store.get("card-new")).toMatchObject({
        meta: "footer",
        model: "GPT-6 Sol",
        place: "on Mac mini",
      }),
    dropViews: true,
    reverse:
      REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70 + REVERSE_MIGRATION_69 + REVERSE_MIGRATION_67,
    rows: 2,
  },
  {
    describe: "migration 69 (a merge card's risk, FI3-1128)",
    it: "adds the nullable column, keeps an older card with no risk, keeps a risk, and reverses",
    from: 68,
    added: "risk_json",
    card: olderCard("footer"),
    id: "card-old",
    // A card written before the column carries no risk.
    legacy: (old) => expect(old).not.toHaveProperty("risk"),
    write: (old, store) => store.upsert({ ...old, id: "card-new", risk: RISK, createdAt: 3 }),
    readBack: (store) => expect(store.get("card-new")?.risk).toEqual(RISK),
    dropViews: true,
    reverse: REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70 + REVERSE_MIGRATION_69,
    rows: 2,
  },
  {
    describe: "migration 70 (a card that takes no reply, FI3-1164)",
    it: "adds the nullable column, keeps an older card taking replies, keeps the welcome's none, and reverses",
    from: 69,
    added: "replies",
    card: `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
           VALUES ('card-old', NULL, 'card', 'firstmate', 15, 'Before', 'firstmate', '<p>Old.</p>', '[]', 'ready', 1)`,
    id: "card-old",
    // A card written before the column takes replies as its author allows.
    legacy: (old) => expect(old).not.toHaveProperty("replies"),
    write: (old, store) =>
      store.upsert({
        ...old,
        id: "card-welcome",
        title: "Welcome aboard",
        replies: false,
        createdAt: 3,
      }),
    readBack: (store) => expect(store.get("card-welcome")?.replies).toBe(false),
    dropViews: true,
    reverse: REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70,
    rows: 2,
  },
  {
    describe: "migration 77 (declared card continuity)",
    it: "keeps legacy cards unmarked, persists the mark and reverses without losing rows",
    from: 76,
    card: OLDER_FIRSTMATE_CARD,
    id: "legacy",
    everyVersion: false,
    legacy: (old) => expect(old).not.toHaveProperty("holdsPlace"),
    write: (old, store) => store.upsert({ ...old, id: "marked", holdsPlace: true }),
    readBack: (store) => expect(store.get("marked")?.holdsPlace).toBe(true),
    reverse: REVERSE_MIGRATION_77,
    rows: 2,
  },
  // INF-63: a review-finding label survives an upgrade and restart without relabeling old cards.
  {
    it: "migration 87 preserves legacy cards and persists reversible review attribution",
    from: 86,
    card: OLDER_FIRSTMATE_CARD,
    id: "legacy",
    everyVersion: false,
    legacy: (old) => expect(old.reviewTaskId).toBeUndefined(),
    write: (old, store) => store.upsert({ ...old, id: "finding", reviewTaskId: "review-footer" }),
    readBack: (store) => expect(store.get("finding")?.reviewTaskId).toBe("review-footer"),
    reverse: `${REVERSE_MIGRATION_88}ALTER TABLE cards DROP COLUMN review_task_id`,
    rows: 2,
  },
  {
    it: "INF-476 upgrades existing cards with no minimized state, persists a minimized card and reverses without losing it",
    from: 87,
    card: "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('launch-review', 'card', 'firstmate', 20, 'The launch review is ready', 'firstmate', '<p>Keep the review beside the launch.</p>', '[]', 'ready', 1)",
    id: "launch-review",
    legacy: (review) => expect(review).not.toHaveProperty("minimized"),
    write: (review, store) => store.upsert({ ...review, minimized: true }),
    readBack: (store, review) =>
      expect(store.get(review.id)).toMatchObject({
        minimized: true,
        status: "ready",
        title: review.title,
      }),
    reverse: REVERSE_MIGRATION_88,
    rows: "older card",
  },
  // INF-1610: a card its author marked as answering the captain's message keeps
  // the mark across a restart, so the card stays the answer to that message.
  {
    it: "INF-1610 upgrades existing cards with no answering mark, keeps a marked card's across reopen and reverses without losing it",
    from: 100,
    card: "INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-firstmate-stack-order', NULL, 'card', 'firstmate', 30, 'Yes: a card you replied under keeps its place', '', '<p>The stack now keeps a card you replied under in its place while its author answers.</p>', '[]', 'ready', 1)",
    id: "card-firstmate-stack-order",
    legacy: (answer) => expect(answer).not.toHaveProperty("answering"),
    write: (answer, store) => store.upsert({ ...answer, answering: true }),
    readBack: (store, answer) => {
      expect(store.get(answer.id)).toMatchObject({
        answering: true,
        status: "ready",
        title: answer.title,
      });
      // A revision without the mark removes it.
      store.upsert(answer);
      expect(store.get(answer.id)).not.toHaveProperty("answering");
    },
    reverse: REVERSE_MIGRATION_101,
    rows: "older card",
  },
  // INF-1670: the stuck alert names the first mate as the one who answers a
  // reply under it, and a restart must keep its reply row.
  {
    it: "INF-1670 upgrades existing cards with no answerer, keeps the stuck alert's across reopen and reverses without losing it",
    from: CARD_ANSWERER_MIGRATION_VERSION - 1,
    card: "INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-stall-a99caa29', 'a99caa29', 'card', 'host', 90, 'Move integration secrets has been stuck for 1h 21m', '', '<p>It stopped with nothing running and no question for you.</p>', '[]', 'ready', 1)",
    id: "card-stall-a99caa29",
    legacy: (alert) => expect(alert).not.toHaveProperty("answeredBy"),
    write: (alert, store) => store.upsert({ ...alert, answeredBy: "firstmate" }),
    readBack: (store, alert) =>
      expect(store.get(alert.id)).toMatchObject({
        answeredBy: "firstmate",
        status: "ready",
        title: alert.title,
      }),
    reverse: REVERSE_ANSWERED_BY,
    rows: "older card",
  },
  // INF-1226: a consent card its crewmate declared `continues` can wait across
  // a restart, and the captain's choice on it must still not close its task.
  {
    it: "INF-1226 upgrades existing cards with no continues declaration, keeps a declared card's across reopen and reverses without losing it",
    from: 92,
    card: "INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-6f0d2a1c-allow-signing', '6f0d2a1c', 'card', 'crewmate', 30, 'Allow signing the Secrets test app on the Mac mini?', 'Sign the Secrets test app', '<p>Signing it needs your permission to use your Developer ID identity there.</p>', '[{\"id\":\"leave-blocked\",\"label\":\"Leave blocked\"},{\"id\":\"allow-mac-mini-signing\",\"label\":\"Allow signing on the Mac mini\",\"default\":true}]', 'ready', 1)",
    id: "card-6f0d2a1c-allow-signing",
    legacy: (consent) => expect(consent).not.toHaveProperty("continues"),
    write: (consent, store) => store.upsert({ ...consent, continues: true }),
    readBack: (store, consent) => {
      expect(store.get(consent.id)).toMatchObject({
        continues: true,
        status: "ready",
        title: consent.title,
      });
      // A revision without the declaration removes it.
      store.upsert(consent);
      expect(store.get(consent.id)).not.toHaveProperty("continues");
    },
    reverse: REVERSE_MIGRATION_93,
    rows: "older card",
  },
];

function checkCardColumn(row: CardColumnCase): void {
  const dir = tmpUserData();
  const older = openDatabase(dir, row.from);
  const columns = columnNames(older, "cards");
  if (row.added) expect(columns).not.toContain(row.added);
  older.prepare(row.card).run();
  older.close();

  const upgraded = openDatabase(dir);
  if (row.everyVersion !== false) expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
  const store = new CardStore(upgraded);
  const old = store.get(row.id);
  if (!old) throw new Error(`The upgraded card ${row.id} is missing`);
  row.legacy(old, store);
  row.write(old, store, upgraded);
  let db = upgraded;
  if (row.restart !== false) {
    upgraded.close();
    // An app restart reads the value back from disk.
    db = openDatabase(dir);
  }
  row.readBack(new CardStore(db), old);

  // Reversible: the older shape comes back with every card.
  if (row.dropViews) dropViews(db);
  db.exec(row.reverse);
  expect(columnNames(db, "cards")).toEqual(columns);
  if (row.rows === "older card")
    expect(db.prepare("SELECT id, status FROM cards").all()).toEqual([
      { id: old.id, status: "ready" },
    ]);
  else expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: row.rows });
  db.close();
}

for (const row of CARD_COLUMNS) {
  if (row.describe) describe(row.describe, () => it(row.it, () => checkCardColumn(row)));
  else it(row.it, () => checkCardColumn(row));
}
