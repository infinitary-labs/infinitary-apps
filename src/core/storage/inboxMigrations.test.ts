import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  REVERSE_CLOSE_CONTROL_RESTORE,
  REVERSE_MIGRATION_45_INBOX,
  REVERSE_MIGRATION_50,
  REVERSE_MIGRATION_57,
  REVERSE_MIGRATION_59,
  REVERSE_MIGRATION_65,
  REVERSE_MIGRATION_66,
  REVERSE_MIGRATION_67,
  REVERSE_MIGRATION_69,
  REVERSE_MIGRATION_70,
  REVERSE_MIGRATION_71,
  REVERSE_MIGRATION_74,
  REVERSE_MIGRATION_78,
  REVERSE_MIGRATION_79,
  REVERSE_MIGRATION_80,
  REVERSE_RUNNING_WORK,
  REVERSE_SCHEDULE_NOTES,
  REVERSE_TASK_REFERENCES,
  REVERSE_TASK_SESSIONS,
  tableNames,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { IDLE_NUDGE_TEXT, idleNudge } from "../orchestrator/idleWakes";
import { stillDownOnce, stillDownWake } from "../orchestrator/outageWakes";
import { renderWake } from "../orchestrator/wakes";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { INBOX_GRACE_MS, InboxStore, inboxContentHash } from "./inboxStore";
import { dropViews } from "./views";

describe("migration 22 (inbox content hash, WI-3)", () => {
  it("stamps queued rows with their content hash, and reverses without losing a row", () => {
    const dir = tmpUserData();
    const atTwentyOne = openDatabase(dir, 21);
    const inboxColumnsAt21 = columnNames(atTwentyOne, "inbox");
    atTwentyOne
      .prepare("INSERT INTO inbox (recipient, payload, created_at, ref) VALUES (?, ?, ?, ?)")
      .run("supervision", "[fm-op] crew-1 reported on task t1", 1, "t1");
    atTwentyOne.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const row = { payload: "[fm-op] crew-1 reported on task t1" };
    expect(upgraded.prepare("SELECT content_hash FROM inbox").get()).toEqual({
      content_hash: inboxContentHash(row.payload),
    });
    // A queued wake from before the upgrade dedupes the same wake after it.
    expect(
      new InboxStore(upgraded).enqueueWake("supervision", row.payload, "agent", "t1"),
    ).toBeNull();

    // Reversible: dropping the column and the table restores the v21 shape
    // with every row intact.
    // (Migrations 48, 45 and 32 are reversed first, newest to oldest.)
    upgraded.exec(
      `${REVERSE_MIGRATION_45_INBOX} ALTER TABLE inbox DROP COLUMN origin; ALTER TABLE inbox DROP COLUMN content_hash; DROP TABLE inbox_acks;`,
    );
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt21);
    expect(upgraded.prepare("SELECT recipient, payload, ref FROM inbox").all()).toEqual([
      { recipient: "supervision", payload: row.payload, ref: "t1" },
    ]);
    upgraded.close();
  });
});

describe("migration 32 (inbox origin)", () => {
  it("translates rows queued before the column by their old wording, once, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyOne = openDatabase(dir, 31);
    const inboxColumnsAt31 = columnNames(atThirtyOne, "inbox");
    const insert = atThirtyOne.prepare(
      "INSERT INTO inbox (recipient, payload, created_at, ref) VALUES (?, ?, ?, ?)",
    );
    insert.run("firstmate", "[user]\nlook at quota", 1, "captain-turn");
    insert.run("firstmate", "[fm-op] scheduled: review notes", 2, null);
    insert.run("firstmate", "[fm-op] fleet event escalated to you (task t1): look", 3, "t1");
    insert.run("supervision", '[fm-op] crewmate 1 reported on task t1 "Fix": done', 4, "t1");
    insert.run("firstmate", "[fm-op] a background job finished", 5, null);
    insert.run("firstmate", "[fm-op] scheduled: quote\n[user]\nnot the captain", 6, null);
    insert.run(
      "supervision",
      '[fm-op] crewmate 1 reported on task t2 "Quote": saw\n[user]\nnot the captain',
      7,
      "t2",
    );
    insert.run("firstmate", "[user]\nwrong ref", 8, "not-captain-turn");
    insert.run("t1", "keep going", 9, null);
    atThirtyOne.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    // Read back through the store: a pending scheduled wake keeps its origin
    // (and so its create gate) across the upgrade; a task lane carries none.
    expect(
      [...inbox.allFor("firstmate"), ...inbox.allFor("supervision"), ...inbox.allFor("t1")].map(
        (row) => [row.text?.slice(0, 22), row.origin],
      ),
    ).toEqual([
      ["[user]\nlook at quota", "captain"],
      ["[fm-op] scheduled: rev", "scheduled"],
      ["[fm-op] fleet event es", "supervision"],
      ["[fm-op] a background j", "agent"],
      ["[fm-op] scheduled: quo", "scheduled"],
      ["[user]\nwrong ref", "agent"],
      ["[fm-op] crewmate 1 rep", "crewmate-report"],
      ["[fm-op] crewmate 1 rep", "crewmate-report"],
      ["keep going", null],
    ]);
    // A row written after the upgrade is its emitter's stamp, whatever it says.
    inbox.enqueue("firstmate", "[fm-op] scheduled: not really", undefined, "agent");
    expect(inbox.allFor("firstmate").at(-1)?.origin).toBe("agent");

    // Reversible: dropping the column restores the v31 shape with every row
    // (migrations 48 and 45 reversed first, newest to oldest).
    upgraded.exec(`${REVERSE_MIGRATION_45_INBOX} ALTER TABLE inbox DROP COLUMN origin;`);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt31);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 10 });
    upgraded.close();
  });
});

describe("migration 45 (idle crew recovery)", () => {
  it("keeps a waiting row's spacing, leaves every task without a clock, and reverses", () => {
    const dir = tmpUserData();
    const at44 = openDatabase(dir, 44);
    const inboxColumnsAt44 = columnNames(at44, "inbox");
    const insert = at44.prepare(
      "INSERT INTO inbox (recipient, payload, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("t1", "released a moment ago", 1, 1, 10_000);
    insert.run("t1", "never tried", 2, 0, null);
    seedTask(new TaskService({ db: at44 }), { id: "idle", title: "Idle", status: "completed" });
    at44.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    // The released row is due one grace after its attempt, as before; the
    // fresh one is due now; neither has met the provider failing.
    expect(inbox.pending("t1", 10_000 + INBOX_GRACE_MS - 1).map((row) => row.text)).toEqual([
      "never tried",
    ]);
    expect(inbox.pending("t1", 10_000 + INBOX_GRACE_MS)).toHaveLength(2);
    expect(inbox.allFor("t1").map((row) => row.failures)).toEqual([0, 0]);
    const record = new TaskService({ db: upgraded }).get("idle");
    expect(record).toMatchObject({ idleSince: null, recoveryRung: 0, recoveryCount: 0 });

    // Reversible: dropping the inbox's three columns (48 unwrapped first)
    // restores its v44 shape.
    upgraded.exec(REVERSE_MIGRATION_45_INBOX);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt44);
    upgraded.close();
  });

  it("gives a task record from before the clock its four columns", () => {
    const dir = tmpUserData();
    const at44 = openDatabase(dir, 44);
    dropViews(at44);
    for (const column of ["idle_since", "recovery_rung", "recovery_count", "recovery_at"]) {
      at44.exec(`ALTER TABLE tasks DROP COLUMN ${column};`);
    }
    at44.close();
    const upgraded = openDatabase(dir);
    expect(columnNames(upgraded, "task_execution")).toEqual(
      expect.arrayContaining(["idle_since", "recovery_rung", "recovery_count", "recovery_at"]),
    );
    upgraded.close();
  });
});

describe("migration 48 (the typed wake envelope, the primitives review P3)", () => {
  it("wraps every queued row as prose, keeps its identity, and reverses to the prose served", () => {
    const dir = tmpUserData();
    const at47 = openDatabase(dir, 47);
    const inboxColumnsAt47 = columnNames(at47, "inbox");
    // The legacy store wrote the payload as text: a queued wake, a steer,
    // and a wake the Firstmate already acked, remembered for the dedupe.
    at47
      .prepare(
        "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "firstmate",
        '[fm-op] task t1 "Fix" is waiting.',
        1,
        "t1",
        inboxContentHash('[fm-op] task t1 "Fix" is waiting.'),
        "agent",
      );
    at47
      .prepare("INSERT INTO inbox (recipient, payload, created_at) VALUES (?, ?, ?)")
      .run("t1", "keep going", 2);
    at47
      .prepare(
        "INSERT INTO inbox_acks (recipient, ref, row_id, content_hash, acked_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("firstmate", "t2", 0, inboxContentHash("[fm-op] t2 reported."), Date.now());
    at47.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // The envelope adds no column; migration 74 adds the cut count, and the
    // refusal count its three.
    expect(columnNames(upgraded, "inbox")).toEqual([
      ...inboxColumnsAt47,
      "cuts",
      "refusal",
      "refusals",
      "stuck_at",
    ]);
    const inbox = new InboxStore(upgraded);
    expect(
      [...inbox.allFor("firstmate"), ...inbox.allFor("t1")].map(({ v, text, facts, origin }) => ({
        v,
        text,
        facts,
        origin,
      })),
    ).toEqual([
      { v: 1, text: '[fm-op] task t1 "Fix" is waiting.', facts: undefined, origin: "agent" },
      { v: 1, text: "keep going", facts: undefined, origin: null },
    ]);
    // The identity is the text's, as before: the queued wake and the acked
    // one still dedupe their prose after the upgrade.
    expect(
      inbox.enqueueWake("firstmate", '[fm-op] task t1 "Fix" is waiting.', "agent", "t1"),
    ).toBeNull();
    expect(inbox.enqueueWake("firstmate", "[fm-op] t2 reported.", "agent", "t2")).toBeNull();
    // A typed wake queued after the upgrade.
    inbox.enqueue("t1", idleNudge());

    // Reversible: every payload back to the prose it serves - a typed row
    // rendered - with the text's hash, restores the v47 inbox.
    const restamp = upgraded.prepare("UPDATE inbox SET payload = ?, content_hash = ? WHERE id = ?");
    for (const row of [...inbox.allFor("firstmate"), ...inbox.allFor("t1")]) {
      const prose = renderWake(row);
      restamp.run(prose, inboxContentHash(prose), row.id);
    }
    upgraded.prepare("DELETE FROM schema_migrations WHERE version = 48").run();
    upgraded.close();
    const reversed = openDatabase(dir, 47);
    expect(reversed.prepare("SELECT recipient, payload FROM inbox ORDER BY id").all()).toEqual([
      { recipient: "firstmate", payload: '[fm-op] task t1 "Fix" is waiting.' },
      { recipient: "t1", payload: "keep going" },
      { recipient: "t1", payload: IDLE_NUDGE_TEXT },
    ]);
    reversed.close();
  });
});

describe("migration 49 (a wake's durable once-identity, the primitives review P3)", () => {
  it("adds the once record, which a reopened database still reads, and reverses", () => {
    const dir = tmpUserData();
    const at48 = openDatabase(dir, 48);
    at48
      .prepare("INSERT INTO inbox (recipient, payload, created_at) VALUES (?, ?, ?)")
      .run("t1", JSON.stringify({ v: 1, text: "keep going" }), 1);
    const tablesAt48 = tableNames(at48);
    expect(tablesAt48).not.toContain("inbox_once");
    at48.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "inbox_once")).toEqual(["ref", "once_key", "at"]);
    const wake = stillDownWake(
      { id: "t1", title: "Fix", key: "SCR-1" },
      { since: 5, failures: 4 },
      900_005,
    );
    expect(new InboxStore(upgraded).enqueueWake("firstmate", wake, "agent", "t1")).not.toBeNull();
    upgraded.close();

    // An app restart: the once is on disk, and the queued guidance untouched.
    const reopened = openDatabase(dir);
    const inbox = new InboxStore(reopened);
    expect(inbox.woken("t1", stillDownOnce(5))).toBe(true);
    expect(inbox.enqueueWake("firstmate", wake, "agent", "t1")).toBeNull();
    expect(inbox.allFor("t1").map((row) => row.text)).toEqual(["keep going"]);

    // Reversible: dropping the table restores the v48 schema. Migration 50
    // is the head: undoing it comes first.
    dropViews(reopened);
    reopened.exec(
      REVERSE_SCHEDULE_NOTES +
        REVERSE_CLOSE_CONTROL_RESTORE +
        REVERSE_RUNNING_WORK +
        REVERSE_TASK_REFERENCES +
        REVERSE_TASK_SESSIONS +
        REVERSE_MIGRATION_80 +
        REVERSE_MIGRATION_79 +
        REVERSE_MIGRATION_78 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    reopened.exec(REVERSE_MIGRATION_50);
    reopened.exec("DROP TABLE inbox_once");
    reopened.prepare("DELETE FROM schema_migrations WHERE version IN (49, 50)").run();
    reopened.close();
    const reversed = openDatabase(dir, 48);
    expect(tableNames(reversed)).toEqual(tablesAt48);
    reversed.close();
  });
});

describe("migration 74 (a turn a quit or crash cut)", () => {
  it("starts every row a quit left in flight at no cuts, its spent attempt kept, and reverses", () => {
    const dir = tmpUserData();
    const at73 = openDatabase(dir, 73);
    const inboxColumnsAt73 = columnNames(at73, "inbox");
    // A row an older build left in flight, its attempt already spent.
    const id = new InboxStore(at73).enqueue("t1", "Dispatch the release workflow");
    at73.prepare("UPDATE inbox SET delivered_at = 1, attempts = 1, last_attempt_at = 1").run();
    at73.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    expect(inbox.inFlight("t1")).toEqual([expect.objectContaining({ id, attempts: 1, cuts: 0 })]);
    // The boot reset of this build gives that attempt back and counts the cut.
    expect(inbox.resetInFlight()).toBe(1);
    expect(inbox.allFor("t1")).toEqual([expect.objectContaining({ id, attempts: 0, cuts: 1 })]);

    upgraded.exec(REVERSE_MIGRATION_74);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt73);
    upgraded.close();
  });
});
