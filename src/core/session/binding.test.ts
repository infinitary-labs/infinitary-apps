import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../pi/types";
import { SessionBinder } from "./binding";

const baseRuntime = { kind: "base" } as unknown as ModelRuntime;

/** A binder over a vault whose Pi stores build a runtime, except the ones named dead. */
function binderOf(dead: string[] = []) {
  const built: string[] = [];
  const binder = new SessionBinder({
    runtimeFor: async (accountId) => {
      built.push(accountId);
      if (dead.includes(accountId)) throw new Error(`the store of ${accountId} is unreadable`);
      return { kind: `runtime-${accountId}` } as unknown as ModelRuntime;
    },
    baseRuntime,
  });
  return { binder, built };
}

describe("SessionBinder", () => {
  it("binds a Pi account to its own runtime", async () => {
    const { binder, built } = binderOf();

    const binding = await binder.bind("acct_codex", "openai-codex");

    expect(binding).toEqual({
      backend: "pi",
      accountId: "acct_codex",
      runtime: { kind: "runtime-acct_codex" },
    });
    expect(built).toEqual(["acct_codex"]);
  });

  it("binds a Claude account to the machine's login without building a runtime", async () => {
    const { binder, built } = binderOf();

    const binding = await binder.bind("acct_claude", "anthropic-claude");

    expect(binding).toEqual({ backend: "claude", accountId: "acct_claude" });
    expect(built).toEqual([]);
  });

  it("needs no base runtime for a Claude-only binding", async () => {
    const runtimeFor = vi.fn(async () => {
      throw new Error("Pi is not configured");
    });
    const binder = new SessionBinder({ runtimeFor });
    expect(await binder.bind("acct_claude", "anthropic-claude")).toEqual({
      backend: "claude",
      accountId: "acct_claude",
    });
    expect(runtimeFor).not.toHaveBeenCalled();
    expect(() => binder.base()).toThrow("No Pi base runtime is configured.");
  });

  it("binds no account to the base runtime", async () => {
    const { binder, built } = binderOf();

    expect(await binder.bind()).toEqual({ backend: "pi", runtime: baseRuntime });
    expect(binder.base()).toEqual({ backend: "pi", runtime: baseRuntime });
    expect(built).toEqual([]);
  });

  it("falls back to the base runtime, account-less, when a Pi store cannot build one", async () => {
    const { binder } = binderOf(["acct_dead"]);

    const binding = await binder.bind("acct_dead", "openai-codex");

    expect(binding).toEqual({ backend: "pi", runtime: baseRuntime });
  });

  it("treats an account with no known provider as a Pi account", async () => {
    const { binder, built } = binderOf();

    const binding = await binder.bind("acct_gone", undefined);

    expect(binding).toEqual({
      backend: "pi",
      accountId: "acct_gone",
      runtime: { kind: "runtime-acct_gone" },
    });
    expect(built).toEqual(["acct_gone"]);
  });

  it("lets a dead Pi store throw when asked for the account's binding alone", async () => {
    const { binder } = binderOf(["acct_dead"]);

    await expect(binder.bindAccount("acct_dead", "openai-codex")).rejects.toThrow(
      "the store of acct_dead is unreadable",
    );
    await expect(binder.bindAccount("acct_claude", "anthropic-claude")).resolves.toEqual({
      backend: "claude",
      accountId: "acct_claude",
    });
  });
});
