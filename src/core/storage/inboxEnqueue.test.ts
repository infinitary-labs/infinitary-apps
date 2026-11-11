import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, openInMemoryDatabase } from "./db";
import { type InboxRow, InboxStore } from "./inboxStore";

/**
 * Intent: the approved correction plan needs new persisted captain input to
 * schedule independent work before original delivery, without historical
 * scans or a failed observer rejecting that delivery. These tests exercise
 * the existing inbox with disposable, ordinary Crewmate-tab messages; no
 * model judgment or provider behavior is simulated here.
 */
const databases: AppDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function fixture() {
  const db = openInMemoryDatabase();
  databases.push(db);
  const inbox = new InboxStore(db, { now: () => 1_000 });
  return { inbox };
}

describe("accepted inbox row observation", () => {
  it("notifies on a persisted new message before delivery, never on reads or redelivery", () => {
    const { inbox } = fixture();
    const seen: InboxRow[] = [];
    const stop = inbox.onEnqueue((row) => {
      expect(inbox.get(row.id)).toEqual(row);
      seen.push(row);
    });
    const words = "For the remaining reviews, show the exact wording before keeping it.";
    const id = inbox.enqueue("task-review", { facts: { kind: "crewmate-tab-line", words } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id,
      recipient: "task-review",
      facts: { kind: "crewmate-tab-line", words },
      deliveredAt: null,
    });
    inbox.pending("task-review");
    inbox.markDelivered([id]);
    inbox.release([id]);
    expect(seen).toHaveLength(1);
    stop();
    inbox.enqueue("task-review", { facts: { kind: "crewmate-tab-line", words } });
    expect(seen).toHaveLength(1);
  });

  it("keeps ancillary scheduling inside the original caller's transaction", () => {
    const { inbox } = fixture();
    inbox.onEnqueue((row) => {
      if (row.recipient === "task-review") inbox.enqueue("ancillary", "queued", `${row.id}`);
    });
    expect(() =>
      inbox.transaction(() => {
        inbox.enqueue("task-review", {
          facts: { kind: "crewmate-tab-line", words: "Keep the proposed scope unchanged." },
        });
        throw new Error("The original operation did not commit");
      }),
    ).toThrow("The original operation did not commit");
    expect(inbox.allFor("task-review")).toEqual([]);
    expect(inbox.allFor("ancillary")).toEqual([]);
    inbox.transaction(() => {
      inbox.enqueue("task-review", {
        facts: { kind: "crewmate-tab-line", words: "Keep the proposed scope unchanged." },
      });
    });
    expect(inbox.allFor("task-review")).toHaveLength(1);
    expect(inbox.allFor("ancillary")).toHaveLength(1);
  });

  it("rolls back a failed observer's work without rejecting the original message", () => {
    const { inbox } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = vi.fn();
    inbox.onEnqueue((row) => {
      if (row.recipient !== "task-review") return;
      inbox.enqueue("ancillary", "must roll back", `${row.id}`);
      throw new Error("An ancillary capture failed");
    });
    inbox.onEnqueue((row) => {
      if (row.recipient === "task-review") later(row.id);
    });
    const id = inbox.transaction(() =>
      inbox.enqueue("task-review", {
        facts: { kind: "crewmate-tab-line", words: "Keep the proposed scope unchanged." },
      }),
    );
    expect(inbox.get(id)).toBeDefined();
    expect(inbox.pending("task-review").map((row) => row.id)).toEqual([id]);
    expect(inbox.allFor("ancillary")).toEqual([]);
    expect(later).toHaveBeenCalledWith(id);
    expect(warning).toHaveBeenCalledExactlyOnceWith("[inbox] enqueue observer failed");
  });
});
