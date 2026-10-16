import { describe, expect, it } from "vitest";
import {
  type CatalogAccount,
  type CatalogReader,
  type CatalogReadResult,
  ServedModels,
} from "./servedModels";

/**
 * The runtime reads' two rules (docs/model-lists.md): nothing waits on a
 * read, and a failed read falls back to the shipped catalog silently.
 */

const claudeAccount: CatalogAccount = { accountId: "acct-claude", providerId: "anthropic-claude" };

function build(
  reader: CatalogReader,
  options: Partial<ConstructorParameters<typeof ServedModels>[0]> = {},
) {
  const log: string[] = [];
  let settled = 0;
  const served = new ServedModels({
    readers: { "anthropic-claude": reader },
    accounts: () => [claudeAccount],
    log: (line) => log.push(line),
    onSettled: () => {
      settled += 1;
    },
    ...options,
  });
  return { served, log, settledCount: () => settled };
}

/** A reader whose answer the test hands over when it chooses. */
function heldReader(): { reader: CatalogReader; answer: (result: CatalogReadResult) => void } {
  let answer: (result: CatalogReadResult) => void = () => {};
  const reader: CatalogReader = () =>
    new Promise<CatalogReadResult>((resolve) => {
      answer = resolve;
    });
  return { reader, answer: (result) => answer(result) };
}

const ok = (ids: string[]): CatalogReadResult => ({
  status: "ok",
  models: ids.map((id) => ({ id })),
});

describe("ServedModels - nothing waits on a read", () => {
  it("returns from refresh at once while the read is still out, serving nothing new", () => {
    const { reader } = heldReader();
    const { served } = build(reader);
    const started = Date.now();
    void served.refresh("acct-claude");
    expect(Date.now() - started).toBeLessThan(50);
    expect(served.read("acct-claude")).toBeUndefined();
  });

  it("updates the list only once the read finishes", async () => {
    const { reader, answer } = heldReader();
    const { served, settledCount } = build(reader);
    const done = served.refresh("acct-claude");
    expect(served.read("acct-claude")).toBeUndefined();
    answer(ok(["grok-4.8-high", "auto"]));
    await done;
    expect(served.read("acct-claude")?.models.map((model) => model.id)).toEqual([
      "grok-4.8-high",
      "auto",
    ]);
    expect(settledCount()).toBe(1);
  });

  it("runs one read per account at a time", async () => {
    let calls = 0;
    const { reader, answer } = heldReader();
    const counting: CatalogReader = (account) => {
      calls += 1;
      return reader(account);
    };
    const { served } = build(counting);
    const first = served.refresh("acct-claude");
    const second = served.refresh("acct-claude");
    expect(calls).toBe(1);
    answer(ok(["auto"]));
    await Promise.all([first, second]);
  });

  it("bounds a read that never answers, and counts it as failed", async () => {
    const { reader } = heldReader();
    const { served, log } = build(reader, { timeoutMs: 20 });
    await served.refresh("acct-claude");
    expect(served.read("acct-claude")).toBeUndefined();
    expect(log.join("\n")).toMatch(/\(timeout\)/);
  });
});

describe("ServedModels - a failed read falls back to the shipped catalog", () => {
  for (const [name, result] of [
    ["a missing client", { status: "failed", reason: "no_client" }],
    ["a sign-in problem", { status: "failed", reason: "signed_out" }],
    ["an unrecognised answer", { status: "failed", reason: "unrecognised" }],
    ["an empty answer", { status: "ok", models: [] }],
  ] as const) {
    it(`forgets the last good read on ${name}`, async () => {
      let next: CatalogReadResult = ok(["grok-4.8-high"]);
      const { served } = build(async () => next);
      await served.refresh("acct-claude");
      expect(served.read("acct-claude")).toBeDefined();
      next = result as CatalogReadResult;
      await served.refresh("acct-claude");
      // Undefined is the shipped catalog: the vault serves CLAUDE_MODELS again.
      expect(served.read("acct-claude")).toBeUndefined();
    });
  }

  it("counts a reader that throws as a failure, not a crash", async () => {
    const { served, log } = build(async () => {
      throw new Error("spawn EACCES");
    });
    await expect(served.refresh("acct-claude")).resolves.toBe("failed");
    expect(served.read("acct-claude")).toBeUndefined();
    expect(log).toEqual([
      "anthropic-claude model list unavailable (error): spawn EACCES; using the shipped catalog",
    ]);
  });

  it("logs a failure once until its reason changes, and again after a success", async () => {
    let next: CatalogReadResult = { status: "failed", reason: "timeout" };
    const { served, log } = build(async () => next);
    await served.refresh("acct-claude");
    await served.refresh("acct-claude");
    expect(log).toHaveLength(1);
    next = ok(["auto"]);
    await served.refresh("acct-claude");
    next = { status: "failed", reason: "timeout" };
    await served.refresh("acct-claude");
    expect(log).toHaveLength(2);
  });

  it("keeps what it has when a read is deferred (a busy store), and logs nothing", async () => {
    let next: CatalogReadResult = ok(["auto"]);
    const { served, log } = build(async () => next);
    await served.refresh("acct-claude");
    next = { status: "deferred" };
    await served.refresh("acct-claude");
    expect(served.read("acct-claude")?.models.map((model) => model.id)).toEqual(["auto"]);
    expect(log).toEqual([]);
  });

  it("refuses an answer the caller's rail does not accept, as unrecognised", async () => {
    const { served, log } = build(async () => ok(["grok-4.7"]), {
      accept: (_account, models) =>
        models.some((model) => model.id === "grok-4.8")
          ? { ok: true }
          : { ok: false, detail: "omits grok-4.8" },
    });
    await served.refresh("acct-claude");
    expect(served.read("acct-claude")).toBeUndefined();
    expect(log.join("\n")).toContain("(unrecognised): omits grok-4.8");
  });

  it("leaves one positive trace per read that changed what was served", async () => {
    const info: string[] = [];
    let next = ok(["gpt-6-sol", "gpt-6-luna"]);
    const { served } = build(async () => next, { info: (line) => info.push(line) });
    await served.refresh("acct-claude");
    await served.refresh("acct-claude");
    expect(info).toEqual(["anthropic-claude model list read: 2 models"]);
    next = ok(["gpt-6-sol"]);
    await served.refresh("acct-claude");
    expect(info).toEqual([
      "anthropic-claude model list read: 2 models",
      "anthropic-claude model list read: 1 model",
    ]);
  });

  it("cleans vendor names and drops repeated ids", async () => {
    const { served } = build(async () => ({
      status: "ok",
      models: [
        { id: "grok-4.7-high", name: "Grok 4.7  High​​" },
        { id: "grok-4.7-high", name: "again" },
      ],
    }));
    await served.refresh("acct-claude");
    expect(served.read("acct-claude")?.models).toEqual([
      { id: "grok-4.7-high", name: "Grok 4.7 High" },
    ]);
  });
});
