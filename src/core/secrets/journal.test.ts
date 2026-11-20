import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { RootKeys, sha256 } from "./custody";
import { type JournalEntry, UseJournal } from "./journal";

// Intent: INF-1105 - atomic durable pre-effect journaling and unknown-outcome
// reconciliation; INF-1085's saved history choice: kept until the captain
// deletes it, with export and a clear storage-use display.
async function keys() {
  const opened = await RootKeys.open(disposableCustody(), { initialize: true, hasRecords: false });
  if (typeof opened === "string") throw new Error(opened);
  return opened;
}

function requested(request: string): JournalEntry {
  return {
    kind: "requested",
    request,
    intent: `intent-${request}`,
    inputDigest: sha256(request),
    digest: sha256(`checked ${request}`),
    secrets: ["staging-deploy"],
    program: "/bin/sh",
    reason: "Deploy the reviewed staging build",
    rule: "ask",
  };
}

describe("use journal", () => {
  it("settles an interrupted launch as unknown and a waiting use as invalidated, once", async () => {
    const dir = scratchDir("secrets-journal-");
    const root = await keys();
    const before = await UseJournal.open(dir, root);
    await before.append(requested("launched"));
    await before.append({ kind: "approved", request: "launched", method: "local" });
    await before.append({ kind: "consumed", request: "launched" });
    await before.append(requested("waiting"));

    const after = await UseJournal.open(dir, root);
    expect(
      after.history().map(({ request, state, reconciled }) => ({ request, state, reconciled })),
    ).toEqual([
      { request: "launched", state: "unknown", reconciled: true },
      { request: "waiting", state: "invalidated", reconciled: true },
    ]);
    expect(after.restored().map(({ intent, receipt }) => [intent, receipt.state])).toEqual([
      ["intent-launched", "unknown"],
      ["intent-waiting", "invalidated"],
    ]);
    const lines = readFileSync(join(dir, "history.jsonl"), "utf8").split("\n").length;
    await UseJournal.open(dir, root);
    expect(readFileSync(join(dir, "history.jsonl"), "utf8").split("\n").length).toBe(lines);
  });

  it("stops reading at a forged line, sets the whole file aside and continues from the readable part", async () => {
    const dir = scratchDir("secrets-journal-");
    const root = await keys();
    const journal = await UseJournal.open(dir, root);
    await journal.append(requested("genuine"));
    await journal.append({ kind: "ended", request: "genuine", state: "denied" });
    const forged = {
      seq: 2,
      at: 5,
      entry: { kind: "completed", request: "genuine", exitCode: 0 },
      mac: "0".repeat(64),
    };
    appendFileSync(join(dir, "history.jsonl"), `${JSON.stringify(forged)}\n`);

    const reopened = await UseJournal.open(dir, root);
    expect(reopened.broken).toBe(true);
    expect(reopened.history()).toMatchObject([{ request: "genuine", state: "denied" }]);
    const aside = readdirSync(dir).filter((name) => name.startsWith("history.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), "utf8")).toContain(JSON.stringify(forged));
    await reopened.append(requested("next"));
    const again = await UseJournal.open(dir, root);
    expect(again.broken).toBe(false);
    expect(again.history().map((item) => item.request)).toEqual(["genuine", "next"]);
  });

  it("exports metadata, counts its storage, and deletes on the captain's word once no launch is unsettled", async () => {
    const dir = scratchDir("secrets-journal-");
    const journal = await UseJournal.open(dir, await keys(), () => 42);
    await journal.append(requested("deploy"));
    await journal.append({ kind: "consumed", request: "deploy" });
    expect(await journal.storageUse()).toBe(readFileSync(join(dir, "history.jsonl")).length);
    expect(await journal.clear()).toBe("busy");
    await journal.append({ kind: "completed", request: "deploy", exitCode: 3 });
    expect(JSON.parse(journal.export())).toEqual({
      exportedAt: 42,
      uses: [
        {
          request: "deploy",
          intent: "intent-deploy",
          program: "/bin/sh",
          secrets: ["staging-deploy"],
          reason: "Deploy the reviewed staging build",
          requestedAt: 42,
          state: "completed",
          exitCode: 3,
        },
      ],
    });
    expect(await journal.clear()).toBe("cleared");
    expect(await journal.storageUse()).toBe(0);
    expect(journal.history()).toEqual([]);
  });
});
