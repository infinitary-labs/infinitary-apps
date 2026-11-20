import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { RootKeys, sha256 } from "./custody";
import { type JournalEntry, UseJournal } from "./journal";

const io = vi.hoisted(() => ({
  history: "",
  beforeRemove: undefined as (() => Promise<void>) | undefined,
  appendOpened: false,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    // Hold a real deletion at its I/O boundary; all reads, writes and results remain real.
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (args[0] === io.history) await io.beforeRemove?.();
      return actual.rm(...args);
    },
    open: (...args: Parameters<typeof actual.open>) => {
      if (args[0] === io.history && args[1] === "a") io.appendOpened = true;
      return actual.open(...args);
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function request(id: string): JournalEntry {
  return {
    kind: "requested",
    request: id,
    intent: id,
    inputDigest: sha256(id),
    digest: sha256(`checked:${id}`),
    secrets: ["staging-deploy"],
    program: "/bin/sh",
    reason: "Run the reviewed staging deployment",
    rule: "ask",
  };
}

// Intent: INF-1109's explicit history deletion must not unlink a newer use's
// consumption record. Order, not a time window: deletion holds the writer until
// it has finished; a subsequent request then owns a complete new journal chain.
it("queues a new request behind history deletion and preserves it after reopening", async () => {
  const dir = scratchDir("secrets-history-delete-");
  const keys = await RootKeys.open(disposableCustody(), { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error("No fixture keys.");
  const journal = await UseJournal.open(dir, keys);
  await journal.append(request("earlier"));
  await journal.append({ kind: "consumed", request: "earlier" });
  await journal.append({ kind: "completed", request: "earlier", exitCode: 0 });
  const removing = deferred();
  const release = deferred();
  io.history = join(dir, "history.jsonl");
  io.appendOpened = false;
  io.beforeRemove = async () => {
    removing.resolve();
    await release.promise;
  };
  const clearing = journal.clear();
  let appending: Promise<void> | undefined;
  let openedDuringDelete = false;
  try {
    await removing.promise;
    appending = journal.append(request("next"));
    // Flush the queued JavaScript writer turn, not a guessed I/O duration.
    await Promise.resolve();
    openedDuringDelete = io.appendOpened;
  } finally {
    io.beforeRemove = undefined;
    release.resolve();
    await Promise.allSettled([clearing, appending]);
  }
  expect(openedDuringDelete).toBe(false);
  expect(await clearing).toBe("cleared");
  await appending;
  const reopened = await UseJournal.open(dir, keys);
  expect(reopened.history()).toMatchObject([{ request: "next", state: "invalidated" }]);
  expect(reopened.restored()).toMatchObject([
    { intent: "next", receipt: { state: "invalidated" } },
  ]);
});

it("refuses new journal writes after a partial deletion until deletion can finish", async () => {
  const dir = scratchDir("secrets-history-partial-delete-");
  const keys = await RootKeys.open(disposableCustody(), { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error("No fixture keys.");
  const journal = await UseJournal.open(dir, keys);
  await journal.append(request("earlier"));
  await journal.append({ kind: "consumed", request: "earlier" });
  await journal.append({ kind: "completed", request: "earlier", exitCode: 0 });
  io.history = join(dir, "history.jsonl");
  const retained = join(dir, "history.retained.jsonl");
  await writeFile(retained, await readFile(io.history));
  // A listed old file becomes a directory before unlink: the real filesystem
  // refuses it only after the current journal has already been removed.
  io.beforeRemove = async () => {
    await rm(retained);
    await mkdir(retained);
  };
  try {
    await expect(journal.clear([retained])).rejects.toThrow();
  } finally {
    io.beforeRemove = undefined;
  }
  await expect(journal.append(request("next"))).rejects.toThrow("Secrets history is unavailable.");
  await expect(readFile(io.history)).rejects.toMatchObject({ code: "ENOENT" });
  await rm(retained, { recursive: true });
  expect(await journal.clear([retained])).toBe("cleared");
  await journal.append(request("next"));
  const reopened = await UseJournal.open(dir, keys);
  expect(reopened.history()).toMatchObject([{ request: "next", state: "invalidated" }]);
});
