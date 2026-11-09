import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  REVERSE_MIGRATION_57,
  REVERSE_MIGRATION_59,
  REVERSE_MIGRATION_65,
  REVERSE_MIGRATION_66,
  REVERSE_MIGRATION_67,
  REVERSE_MIGRATION_69,
  REVERSE_MIGRATION_70,
  REVERSE_MIGRATION_71,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { migrateOneMergeEffect, restoreCloseControls } from "./cardMigrations";
import { CardStore } from "./cardStore";
import { openDatabase } from "./db";
import { MIGRATIONS } from "./migrations";

// The card record's shape migrations (cardMigrations.ts): card lineage, one card shape with
// effects, and revision threads.

describe("migrations 24-25 (card lineage and the duplicate label, interaction P1)", () => {
  it("adds card_revisions and three nullable duplicate columns, keeps existing cards, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyThree = openDatabase(dir, 23);
    atTwentyThree
      .prepare(
        `INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', NULL, 'note', 30, 'A card', 'crewmate 1', '<p>a</p>', '[]', 'ready', 1)`,
      )
      .run();
    const before = columnNames(atTwentyThree, "cards");
    atTwentyThree.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Migration 29 (cards/tasks/agents P1) adds `author` after these,
    // migration 41 (card pictures) `pictures_json`, migration 52 (the card
    // return rule) `awaiting`, migration 54 (inline decisions)
    // `answers_json`, migration 55 (card width) `width`, migration 56 (the
    // model chip) `model`, and migration 57 (the card evidence) the
    // lifecycle and offer pointers, migration 59 (reply to the back)
    // `sent_back_at`, migration 65 (a card's live attachment)
    // `attachment_json`, migration 67 (where its task runs) `place`,
    // migration 69 (a merge card's risk) `risk_json`, and migration 70 (a
    // card that takes no reply) `replies`, migration 77 `holds_place`,
    // migration 82 `required_actions_json`, migration 87 `review_task_id`,
    // INF-476 `minimized`, INF-1226 `continues`, INF-1610 `answering`,
    // INF-1670 `answered_by`, INF-2796 `after_merge_json` and INF-3071
    // `ended_json`.
    expect(columnNames(upgraded, "cards")).toEqual([
      ...before,
      "duplicate_of",
      "duplicate_note",
      "duplicate_at",
      "author",
      "pictures_json",
      "awaiting",
      "answers_json",
      "width",
      "model",
      "lifecycle_id",
      "offer_id",
      "sent_back_at",
      "attachment_json",
      "place",
      "risk_json",
      "replies",
      "holds_place",
      "required_actions_json",
      "review_task_id",
      "minimized",
      "continues",
      "answering",
      "answered_by",
      "after_merge_json",
      "ended_json",
    ]);
    expect(columnNames(upgraded, "card_revisions")).toEqual([
      "id",
      "card_id",
      "revision",
      "kind",
      "title",
      "body",
      "actions_json",
      "created_at",
      "replaced_at",
      "replaced_by",
    ]);
    // An existing card is unlabelled, never "not a duplicate".
    expect(
      upgraded
        .prepare("SELECT id, title, duplicate_of, duplicate_note, duplicate_at FROM cards")
        .all(),
    ).toEqual([
      {
        id: "card-old",
        title: "A card",
        duplicate_of: null,
        duplicate_note: null,
        duplicate_at: null,
      },
    ]);

    // Reversible: dropping what 24, 25 (and 29, 41, 52, 54, 55, 56 and 57 on top) added
    // restores the version-23 shape and rows.
    upgraded.exec(`
      DROP TABLE card_revisions;
      DROP TABLE card_effect_backfill;
      ALTER TABLE cards DROP COLUMN author;
      ALTER TABLE cards DROP COLUMN duplicate_of;
      ALTER TABLE cards DROP COLUMN duplicate_note;
      ALTER TABLE cards DROP COLUMN duplicate_at;
      ALTER TABLE cards DROP COLUMN pictures_json;
      ALTER TABLE cards DROP COLUMN awaiting;
      ALTER TABLE cards DROP COLUMN answers_json;
      ALTER TABLE cards DROP COLUMN width;
      ALTER TABLE cards DROP COLUMN model;
    `);
    upgraded.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(upgraded, "cards")).toEqual(before);
    expect(upgraded.prepare("SELECT id, title FROM cards").all()).toEqual([
      { id: "card-old", title: "A card" },
    ]);
    upgraded.close();
  });
});

describe("migration 29 (one card shape with effects, cards/tasks/agents P1)", () => {
  it("stamps the author, rewrites an open card's reserved ids into effects, leaves closed cards alone, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyEight = openDatabase(dir, 28);
    const insert = atTwentyEight.prepare(
      `INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
       VALUES (?, ?, ?, 30, ?, 'm', '<p>b</p>', ?, 'ready', ?, ?, ?)`,
    );
    const actions = (value: unknown) => JSON.stringify(value);
    // An open crewmate completion card under the old protocol: keep, the
    // reserved merge id, and a discard.
    insert.run(
      "card-t1-1",
      "t1",
      "decision",
      "The PR is ready",
      actions([
        { id: "keep", label: "Keep" },
        { id: "merge-pr", label: "Merge PR", variant: "primary", default: true },
        { id: "discard", label: "Discard" },
      ]),
      1,
      null,
      null,
    );
    // An open host card whose action id carried the account it restores.
    insert.run(
      "card-auth-account-acct_1",
      null,
      "decision",
      "Claude needs you to sign in again.",
      actions([{ id: "restore-account:acct_1", label: "Sign in", variant: "primary" }]),
      2,
      null,
      null,
    );
    // An open Firstmate decision with an ordinary reply and a Later.
    insert.run(
      "card-fm-plan",
      null,
      "decision",
      "Plan first",
      actions([
        { id: "approve", label: "Go ahead", default: true },
        { id: "later", label: "Later" },
      ]),
      3,
      null,
      null,
    );
    // The no-headroom host card.
    insert.run(
      "card-fm-no-headroom",
      null,
      "decision",
      "Firstmate has used up its allowance",
      actions([{ id: "open-settings", label: "Open settings", variant: "primary" }]),
      4,
      null,
      null,
    );
    // A closed settle card: history, untouched.
    insert.run(
      "card-t2-9",
      "t2",
      "decision",
      "Done",
      actions([
        { id: "keep", label: "Keep" },
        { id: "land", label: "Land", default: true },
      ]),
      5,
      6,
      "land",
    );
    // An open note with nothing to rewrite.
    insert.run("card-fm-note", null, "note", "A fact", "[]", 7, null, null);
    atTwentyEight.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // The author is derived from the id: the host's own singletons, the
    // Firstmate's prefix, and every other card a crewmate's.
    expect(
      upgraded.prepare("SELECT id, author, kind FROM cards ORDER BY created_at").all(),
    ).toEqual([
      { id: "card-t1-1", author: "crewmate", kind: "decision" },
      { id: "card-auth-account-acct_1", author: "host", kind: "decision" },
      { id: "card-fm-plan", author: "firstmate", kind: "decision" },
      { id: "card-fm-no-headroom", author: "host", kind: "decision" },
      { id: "card-t2-9", author: "crewmate", kind: "decision" },
      { id: "card-fm-note", author: "firstmate", kind: "note" },
    ]);
    // The real consumer reads every open card back as the one shape, with
    // the effects the old ids meant: a discard is danger, and the account
    // rides the host effect. Keep and Later stay the replies they were,
    // since no corner closes a card any more (INF-3108's approved plan).
    const open = new CardStore(upgraded).listOpen();
    const byId = (id: string) => open.find((card) => card.id === id);
    expect(byId("card-t1-1")).toMatchObject({ author: "crewmate", taskId: "t1" });
    expect(byId("card-t1-1")?.actions).toEqual([
      { id: "keep", label: "Keep" },
      {
        id: "merge-pr",
        label: "Merge PR",
        variant: "primary",
        default: true,
        effect: { kind: "merge", after: "close" },
      },
      {
        id: "discard",
        label: "Discard",
        effect: { kind: "settle", mode: "discard" },
        danger: true,
        variant: "danger",
      },
    ]);
    expect(byId("card-auth-account-acct_1")?.actions).toEqual([
      {
        id: "restore-account:acct_1",
        label: "Sign in",
        variant: "primary",
        effect: { kind: "host", op: "restore-account", arg: "acct_1" },
      },
    ]);
    expect(byId("card-fm-plan")?.actions).toEqual([
      { id: "approve", label: "Go ahead", default: true },
      { id: "later", label: "Later" },
    ]);
    expect(byId("card-fm-no-headroom")?.actions).toEqual([
      {
        id: "open-settings",
        label: "Open settings",
        variant: "primary",
        effect: { kind: "open", target: "settings" },
      },
    ]);
    expect(byId("card-fm-note")?.actions).toEqual([]);
    for (const card of open) expect(card).not.toHaveProperty("kind");
    // The closed card is history and keeps its old ids verbatim.
    expect(
      (
        upgraded.prepare("SELECT actions_json FROM cards WHERE id = 'card-t2-9'").get() as {
          actions_json: string;
        }
      ).actions_json,
    ).toBe(
      actions([
        { id: "keep", label: "Keep" },
        { id: "land", label: "Land", default: true },
      ]),
    );

    // Reversible: the backfill table holds every rewritten card's original
    // actions; nothing is logged for a card the rewrite left as it was.
    const backfill = upgraded
      .prepare("SELECT card_id, actions_json FROM card_effect_backfill ORDER BY card_id")
      .all() as { card_id: string; actions_json: string }[];
    expect(backfill.map((row) => row.card_id)).toEqual([
      "card-auth-account-acct_1",
      "card-fm-no-headroom",
      "card-t1-1",
    ]);
    const restore = upgraded.prepare("UPDATE cards SET actions_json = ? WHERE id = ?");
    for (const row of backfill) restore.run(row.actions_json, row.card_id);
    upgraded.exec(`
      DROP TABLE card_effect_backfill;
      ALTER TABLE cards DROP COLUMN author;
    `);
    expect(columnNames(upgraded, "cards")).not.toContain("author");
    expect(
      (
        upgraded.prepare("SELECT actions_json FROM cards WHERE id = 'card-t1-1'").get() as {
          actions_json: string;
        }
      ).actions_json,
    ).toBe(
      actions([
        { id: "keep", label: "Keep" },
        { id: "merge-pr", label: "Merge PR", variant: "primary", default: true },
        { id: "discard", label: "Discard" },
      ]),
    );
    upgraded.close();
  });
});

describe("migration 72 (revision thread associations)", () => {
  it("keeps older messages unavailable and persists new typed lists", () => {
    const dir = tmpUserData();
    const older = openDatabase(dir, 71);
    // Deliberately write the prior message contract before its column exists.
    older
      .prepare("INSERT INTO card_messages (card_id, who, text, at) VALUES (?, ?, ?, ?)")
      .run("kept", "host", "Earlier revision", 1);
    older.close();
    const upgraded = openDatabase(dir);
    const store = new CardStore(upgraded);
    expect(store.messages("kept")[0]?.revision).toBeUndefined();
    const revision = {
      lifecycleId: "life",
      offerId: "new",
      previousOfferId: "previous",
      released: false,
      targets: [{ id: 0, label: "Title", region: "title" as const }],
      removed: 0,
    };
    store.appendMessage({ cardId: "kept", who: "host", text: "New revision", revision });
    expect(store.releaseRevisions("kept", "life")).toBe(true);
    upgraded.close();
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).messages("kept")[1]?.revision).toEqual({
      ...revision,
      released: true,
    });
    reopened.exec("ALTER TABLE card_messages DROP COLUMN revision_json");
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM card_messages").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

// INF-2744, the captain's approved plan: "one merge effect replaces settle
// merge and request_merge; legacy cards read as it". Its migration
// rewrites every open card once and keeps what it rewrote; a closed card is
// history, left as saved and read as the merge it was.
describe("the one merge effect (INF-2744)", () => {
  it("rewrites an open card's settle merge and request_merge into the merge, keeps the originals, and reads a closed card's as the merge", () => {
    const dir = tmpUserData();
    // The database as it stood just before the one merge effect's migration,
    // read from the migration list so a later migration does not move it.
    const before = openDatabase(dir, MIGRATIONS.indexOf(migrateOneMergeEffect));
    const insert = before.prepare(
      `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
       VALUES (?, 't1', 'decision', 'crewmate', 30, ?, 'crewmate 1', '<p>a</p>', ?, 'ready', 1, ?, ?)`,
    );
    const own = JSON.stringify([
      { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
      {
        id: "discard",
        label: "Discard",
        danger: true,
        effect: { kind: "settle", mode: "discard" },
      },
    ]);
    const requested = JSON.stringify([
      {
        id: "merge",
        label: "Merge the pull request",
        default: true,
        effect: { kind: "request_merge", review: "mr-7" },
      },
      { id: "not-now", label: "Not now" },
    ]);
    insert.run("card-own", "The meter fix is ready", own, null, null);
    insert.run("card-release", "Merge the release", requested, null, null);
    insert.run("card-past", "An earlier merge", own, 2, "merge");
    before.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    expect(store.get("card-own")?.actions.map((action) => action.effect)).toEqual([
      { kind: "merge", after: "close" },
      { kind: "settle", mode: "discard" },
    ]);
    expect(store.get("card-release")?.actions[0]?.effect).toEqual({
      kind: "merge",
      review: "mr-7",
      after: "continue",
    });
    // The closed card stays as saved, and its read is the merge it was.
    const saved = upgraded
      .prepare("SELECT actions_json FROM cards WHERE id = 'card-past'")
      .get() as { actions_json: string };
    expect(saved.actions_json).toBe(own);
    expect(store.get("card-past")?.actions[0]?.effect).toEqual({ kind: "merge", after: "close" });
    const backfill = upgraded
      .prepare(
        "SELECT card_id, actions_json FROM card_effect_backfill WHERE card_id IN ('card-own', 'card-release', 'card-past') ORDER BY card_id",
      )
      .all();
    expect(backfill).toEqual([
      { card_id: "card-own", actions_json: own },
      { card_id: "card-release", actions_json: requested },
    ]);
    upgraded.close();
  });
});

// INF-3108's approved plan, piece 1: a home the 0.6.4 upgrade rewrote gets
// back the Not now, Keep and Dismiss buttons that upgrade dropped, on open
// cards still exactly as it left them. The cards are the ones INF-3102
// reproduced: a first mate question whose Not now was the old close id.
describe("the close controls the 0.6.4 upgrade dropped (INF-3108)", () => {
  it("gives them back to open cards unchanged since, leaves revised and closed cards, keeps them on a later upgrade, and reverses", () => {
    const dir = tmpUserData();
    // The database as 0.6.4 left it, read from the migration list so a later
    // migration does not move it: its rewrite already ran and kept each
    // card's actions from before in `card_effect_backfill`.
    const before = openDatabase(dir, MIGRATIONS.indexOf(restoreCloseControls));
    const question = [
      { id: "review", label: "Review now", default: true },
      { id: "later", label: "Not now" },
    ];
    const asUpgraded = [{ id: "review", label: "Review now", default: true }];
    const insert = before.prepare(
      `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
       VALUES (?, NULL, 'decision', 'firstmate', 30, ?, 'firstmate', '<p>The launch review can happen now or after the checklist is done.</p>', ?, 'ready', ?, ?, ?)`,
    );
    const backup = before.prepare(
      "INSERT INTO card_effect_backfill (card_id, actions_json, migrated_at) VALUES (?, ?, 1)",
    );
    // Open and as the upgrade left it: the one to restore.
    insert.run(
      "card-fm-review",
      "Choose when to review the launch",
      JSON.stringify(asUpgraded),
      1,
      null,
      null,
    );
    backup.run("card-fm-review", JSON.stringify(question));
    // A merge card whose Keep the upgrade dropped beside its new merge effect.
    const kept = [
      { id: "keep", label: "Keep" },
      { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
    ];
    const keptUpgraded = [
      { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
    ];
    insert.run(
      "card-merge-keep",
      "The export fix is ready",
      JSON.stringify(keptUpgraded),
      2,
      null,
      null,
    );
    backup.run("card-merge-keep", JSON.stringify(kept));
    // Revised by its author since the upgrade: its newer buttons stay.
    const revised = [
      { id: "review", label: "Review now", default: true },
      { id: "after", label: "After the checklist" },
    ];
    insert.run(
      "card-fm-revised",
      "Choose when to review the docs",
      JSON.stringify(revised),
      3,
      null,
      null,
    );
    backup.run("card-fm-revised", JSON.stringify(question));
    // Closed since the upgrade: history, untouched.
    insert.run(
      "card-fm-closed",
      "Choose when to review the site",
      JSON.stringify(asUpgraded),
      4,
      5,
      "review",
    );
    backup.run("card-fm-closed", JSON.stringify(question));
    before.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    expect(store.get("card-fm-review")?.actions).toEqual(question);
    expect(store.get("card-merge-keep")?.actions).toEqual([
      { id: "keep", label: "Keep" },
      keptUpgraded[0],
    ]);
    expect(store.get("card-fm-revised")?.actions).toEqual(revised);
    const saved = (id: string) =>
      (
        upgraded.prepare("SELECT actions_json FROM cards WHERE id = ?").get(id) as {
          actions_json: string;
        }
      ).actions_json;
    expect(saved("card-fm-closed")).toBe(JSON.stringify(asUpgraded));

    // A later upgrade that re-runs the mapping keeps them.
    migrateOneMergeEffect(upgraded);
    expect(store.get("card-fm-review")?.actions).toEqual(question);
    expect(store.get("card-merge-keep")?.actions[0]).toEqual({ id: "keep", label: "Keep" });

    // Reversible: each restored card's actions before the restore are kept.
    const restored = upgraded
      .prepare("SELECT card_id, actions_json FROM card_close_control_restore ORDER BY card_id")
      .all() as { card_id: string; actions_json: string }[];
    expect(restored).toEqual([
      { card_id: "card-fm-review", actions_json: JSON.stringify(asUpgraded) },
      { card_id: "card-merge-keep", actions_json: JSON.stringify(keptUpgraded) },
    ]);
    const put = upgraded.prepare("UPDATE cards SET actions_json = ? WHERE id = ?");
    for (const row of restored) put.run(row.actions_json, row.card_id);
    upgraded.exec("DROP TABLE card_close_control_restore");
    expect(saved("card-fm-review")).toBe(JSON.stringify(asUpgraded));
    upgraded.close();
  });
});
