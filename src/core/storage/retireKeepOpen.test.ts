import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderWake } from "../orchestrator/wakes";
import { CardStore } from "./cardStore";
import { openDatabase } from "./db";
import { InboxStore } from "./inboxStore";

describe("migration 73 retires saved keep-open choices", () => {
  it("upgrades open cards and pending messages without touching history, and keeps exact undo rows", () => {
    const dir = scratchDir("infinitary-retire-keep-open-");
    // Seed through today's writer, then restore the actual pre-73 saved format.
    const before = openDatabase(dir);
    const cards = new CardStore(before);
    for (const [id, status] of [
      ["open", "ready"],
      ["working", "streaming"],
      ["closed", "streaming"],
      ["unchanged", "ready"],
    ] as const) {
      cards.upsert({
        id,
        title: "Choose a route",
        author: "firstmate",
        meta: "firstmate",
        priority: 30,
        createdAt: 1,
        status,
        body: "<p>Your route.</p>",
        actions: [
          ...(id === "unchanged" ? [] : [{ id: "revise", label: "Revise", keepsOpen: true }]),
          { id: "build", label: "Build", default: true },
          { id: "defer", label: "Defer" },
        ],
      });
    }
    const saved = cards.get("open");
    if (!saved) throw new Error("Missing saved card");
    cards.revise({ ...saved, body: "<p>A revised route.</p>" });
    cards.observe({
      id: "old-action",
      kind: "action",
      cardId: "open",
      lifecycleId: "life",
      at: 1,
      actor: "captain",
      source: "chrome",
      payload: {
        actionId: "revise",
        recognized: true,
        label: "Revise",
        closes: false,
        keepsOpen: true,
        effect: null,
        display: { fidelity: "legacy-missing" },
        interactionSource: "host",
      },
    });
    const history = cards.history("open");
    const observations = cards.observations("open");
    before.exec(`
      ALTER TABLE cards DROP COLUMN holds_place;
      ALTER TABLE inbox DROP COLUMN cuts;
      ALTER TABLE jobs DROP COLUMN stopped_by_quit;
      ALTER TABLE tasks DROP COLUMN start_notice;
      DROP TABLE keep_open_backfill;
      DROP TABLE task_sessions;
      DROP TABLE task_references;
      DROP TABLE task_policies;
      DROP TABLE task_execution;
      DELETE FROM schema_migrations WHERE version >= 73;
    `);
    const legacyColumns = (before.prepare("PRAGMA table_info(cards)").all() as { name: string }[])
      .map(({ name }) => JSON.stringify(name))
      .join(", ");
    before.prepare("UPDATE cards SET resolved_at = 2 WHERE id = 'closed'").run();
    const snapshot = before
      .prepare("SELECT * FROM cards WHERE id IN ('closed', 'unchanged') ORDER BY id")
      .all();
    const expected: string[] = [];
    for (const to of ["firstmate", "crewmate"] as const) {
      const source = to === "firstmate" ? "frame" : "chrome";
      const payload = JSON.stringify({
        v: 1,
        facts: {
          kind: "card-explain",
          to,
          source,
          card: { id: "open", title: "Choose a route" },
          choice: {
            id: "revise",
            label: "Revise",
            value: '{"size":2}',
            answers: [
              {
                name: "route",
                values: ["quiet"],
                labels: ["Quiet route"],
                changed: true,
                written: "Avoid tolls",
              },
              { name: "settings", values: ['{"speed":2}'], changed: false, json: true },
              { name: "empty", values: [], changed: false },
            ],
          },
        },
      });
      const text = `${to === "firstmate" ? "[fm-op] " : "Card choice: "}${source === "frame" ? "a script" : "the user"} chose "Revise" (revise) on card "Choose a route" (open). The card stays open: revise it with emit_card under the same id, keeping its decision and default.\nCard action value (JSON): {"size":2}\n${source === "frame" ? "The script submitted answers" : "The user's answers"} to the card's questions:\n- route: "Quiet route" (quiet), written in: "Avoid tolls", changed\n- settings: {"speed":2} (JSON), as proposed\n- empty: no answer, as proposed`;
      expected.push(text);
      before
        .prepare("INSERT INTO inbox (recipient, payload, created_at) VALUES (?, ?, 1)")
        .run(to === "firstmate" ? to : "task:crew", payload);
    }
    before
      .prepare("UPDATE inbox SET delivered_at = 2, attempts = 1 WHERE recipient = 'firstmate'")
      .run();
    const originals = before.prepare("SELECT id, payload FROM inbox ORDER BY id").all();
    before.close();
    const after = openDatabase(dir);
    expect(
      new CardStore(after)
        .listOpen()
        .filter((card) => card.id !== "unchanged")
        .map((card) => ({
          id: card.id,
          status: card.status,
          actions: card.actions.map((action) => action.id),
        })),
    ).toEqual([
      { id: "open", status: "ready", actions: ["build", "defer"] },
      { id: "working", status: "ready", actions: ["build", "defer"] },
    ]);
    expect(
      after
        .prepare(
          `SELECT ${legacyColumns} FROM cards WHERE id IN ('closed', 'unchanged') ORDER BY id`,
        )
        .all(),
    ).toEqual(snapshot);
    expect(after.prepare("SELECT holds_place FROM cards ORDER BY id").all()).toEqual(
      Array.from({ length: 4 }, () => ({ holds_place: null })),
    );
    expect(new CardStore(after).history("open")).toEqual(history);
    expect(new CardStore(after).observations("open")).toEqual(observations);
    const queue = new InboxStore(after);
    queue.resetInFlight();
    expect([...queue.pending("firstmate"), ...queue.pending("task:crew")].map(renderWake)).toEqual(
      expected,
    );
    const converted = after.prepare("SELECT payload FROM inbox ORDER BY id").all() as {
      payload: string;
    }[];
    expect(converted.map((row) => renderWake(JSON.parse(row.payload)))).toEqual(expected);
    const backups = after
      .prepare("SELECT source, original_json FROM keep_open_backfill ORDER BY source, row_id")
      .all() as { source: string; original_json: string }[];
    expect(backups).toHaveLength(4);
    expect(
      backups.filter((row) => row.source === "inbox").map((row) => JSON.parse(row.original_json)),
    ).toEqual(originals);
    console.log(
      JSON.stringify(
        {
          openCards: new CardStore(after)
            .listOpen()
            .map((card) => ({ id: card.id, status: card.status, actions: card.actions })),
          pendingWords: converted.map((row) => renderWake(JSON.parse(row.payload))),
          unchangedHistory: true,
          undoRows: backups.length,
        },
        null,
        2,
      ),
    );
    after.close();
    const reopened = openDatabase(dir);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM keep_open_backfill").get()).toEqual({
      n: 4,
    });
    for (const row of backups) {
      const original = JSON.parse(row.original_json);
      if (row.source === "cards")
        reopened
          .prepare("UPDATE cards SET actions_json = ?, status = ? WHERE id = ?")
          .run(original.actions_json, original.status, original.id);
      else
        reopened
          .prepare("UPDATE inbox SET payload = ? WHERE id = ?")
          .run(original.payload, original.id);
    }
    reopened.exec(
      "DROP TABLE keep_open_backfill; DELETE FROM schema_migrations WHERE version = 73;",
    );
    reopened.close();
    const undone = openDatabase(dir, 72);
    expect(new CardStore(undone).get("working")).toMatchObject({
      status: "streaming",
      actions: [{ id: "revise", keepsOpen: true }, { id: "build" }, { id: "defer" }],
    });
    expect(undone.prepare("SELECT id, payload FROM inbox ORDER BY id").all()).toEqual(originals);
    undone.close();
  });
});
