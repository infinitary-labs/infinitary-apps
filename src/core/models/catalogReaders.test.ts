import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSessionLease, resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import type { QuotaHttp } from "../quota/http";
import { claudeListReader } from "./clientLists";
import {
  CODEX_MODELS_CLIENT_VERSION,
  codexListReader,
  grokListReader,
  parseCodexModelList,
  parseGrokModelList,
  railVerdict,
} from "./piAccountLists";

/**
 * Each provider's runtime read (docs/model-lists.md) reports a failure as a
 * failure - never as an empty catalog - so the service can fall back to the
 * shipped list, and a read that must not run right now defers.
 */

afterEach(() => resetStoreLeasesForTest());

describe("the Claude read", () => {
  const claude = { accountId: "acct-claude", providerId: "anthropic-claude" };

  it("reads the client's catalog as one row per model", async () => {
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.293",
      read: async () => [
        {
          value: "default",
          resolvedModel: "claude-opus-5-5",
          displayName: "Default (recommended)",
        },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
        { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
      ],
    });
    expect(await reader(claude)).toEqual({
      status: "ok",
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      ],
    });
  });

  it("rejects a successful older catalog instead of losing the new starter", async () => {
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.290",
      read: async () => [{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }],
    });
    expect(await reader(claude)).toMatchObject({ status: "failed", reason: "unrecognised" });
  });

  it("trusts a current client's omissions rather than injecting a shipped account row", async () => {
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.293",
      read: async () => [
        { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5" },
      ],
    });
    expect(await reader(claude)).toEqual({
      status: "ok",
      models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
    });
  });

  it("does not take the client's built-in picker for the account's list", async () => {
    // Claude Code 2.1.322 answered the app's startup read with its built-in
    // picker before the account's own list had loaded: four aliases, its
    // Fable alias still on 5.1. Served, it hid the Fable 5.2 starter from the
    // catalog and the premium level for the rest of the day (INF-4110).
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.322",
      read: async () => [
        {
          value: "default",
          resolvedModel: "claude-opus-5-5",
          displayName: "Default (recommended)",
        },
        { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
      ],
    });
    expect(await reader(claude)).toMatchObject({ status: "failed", reason: "unrecognised" });
  });

  it("defers, never reads, while a crewmate session holds the store", async () => {
    let reads = 0;
    const release = await acquireSessionLease("/claude-home");
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.293",
      read: async () => {
        reads += 1;
        return [];
      },
    });
    expect(await reader(claude)).toEqual({ status: "deferred" });
    expect(reads).toBe(0);
    release();
  });

  it("names a missing client", async () => {
    const reader = claudeListReader({
      configDir: () => "/claude-home",
      clientVersion: async () => "2.1.293",
      read: async () => {
        throw new Error(CLAUDE_CLIENT_MISSING_TEXT);
      },
    });
    expect(await reader(claude)).toEqual({ status: "failed", reason: "no_client" });
  });
});

describe("the Codex and Grok account lists", () => {
  const auth = { apiKey: "token", usingOAuth: true };

  function http(
    status: number,
    json: unknown,
    seen?: { url?: string; headers?: Record<string, string> },
  ): QuotaHttp {
    return async (url, init) => {
      if (seen) {
        seen.url = url;
        seen.headers = init.headers;
      }
      return { status, json };
    };
  }

  it("asks Codex as the pinned client version, with the account's own id", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const reader = codexListReader({
      resolveAuth: async () => auth,
      http: http(200, { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol" }] }, seen),
    });
    expect(await reader({ accountId: "a", providerId: "openai-codex" })).toEqual({
      status: "ok",
      models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }],
    });
    expect(seen.url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
    );
    expect(seen.headers?.Authorization).toBe("Bearer token");
  });

  it("reads xAI's OpenAI-shaped list", async () => {
    const reader = grokListReader({
      resolveAuth: async () => auth,
      http: http(200, { object: "list", data: [{ id: "grok-4.7" }, { id: "grok-4.6" }] }),
    });
    expect(await reader({ accountId: "a", providerId: "xai" })).toEqual({
      status: "ok",
      models: [{ id: "grok-4.7" }, { id: "grok-4.6" }],
    });
  });

  it("treats a shape it does not know as unrecognised - no filter", async () => {
    expect(parseCodexModelList({ data: [] })).toBeUndefined();
    expect(parseCodexModelList({ models: [{ id: "no-slug" }] })).toBeUndefined();
    expect(parseGrokModelList({ models: [] })).toBeUndefined();
    const reader = grokListReader({ resolveAuth: async () => auth, http: http(200, "<html>") });
    expect(await reader({ accountId: "a", providerId: "xai" })).toEqual({
      status: "failed",
      reason: "unrecognised",
    });
  });

  it("is a sign-in problem on the vendor's refusal, and reads nothing without auth", async () => {
    const refused = grokListReader({ resolveAuth: async () => auth, http: http(401, {}) });
    expect(await refused({ accountId: "a", providerId: "xai" })).toMatchObject({
      status: "failed",
      reason: "signed_out",
    });
    const signedOut = grokListReader({ resolveAuth: async () => undefined, http: http(200, {}) });
    expect(await signedOut({ accountId: "a", providerId: "xai" })).toEqual({
      status: "failed",
      reason: "signed_out",
    });
  });

  it("does not read at all under Pi's offline switch", async () => {
    let calls = 0;
    const reader = grokListReader({
      resolveAuth: async () => auth,
      offline: true,
      http: async () => {
        calls += 1;
        return { status: 200, json: { data: [] } };
      },
    });
    expect(await reader({ accountId: "a", providerId: "xai" })).toEqual({ status: "skipped" });
    expect(calls).toBe(0);
  });
});

describe("the account-list safety rail (decision A)", () => {
  const piIds = ["grok-4.5", "grok-4.6", "grok-4.7"];

  it("lets an answer that names every protected id filter the rest", () => {
    expect(
      railVerdict({
        answer: [{ id: "grok-4.7" }, { id: "grok-4.6" }],
        protectedIds: ["grok-4.7"],
        piIds,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses an answer that leaves out a default Pi can serve", () => {
    // A consumer token that lists only API models would otherwise remove
    // the Grok default from the account.
    expect(
      railVerdict({ answer: [{ id: "grok-4.5" }], protectedIds: ["grok-4.7"], piIds }),
    ).toEqual({ ok: false, detail: "omits grok-4.7" });
  });

  it("refuses an answer that leaves out a model the user kept", () => {
    expect(
      railVerdict({
        answer: [{ id: "grok-4.7" }],
        protectedIds: ["grok-4.7", "grok-4.6"],
        piIds,
      }),
    ).toEqual({ ok: false, detail: "omits grok-4.6" });
  });

  it("ignores a protected id Pi cannot serve anyway", () => {
    expect(
      railVerdict({ answer: [{ id: "grok-4.7" }], protectedIds: ["grok-4.7", "grok-9"], piIds }),
    ).toEqual({ ok: true });
  });

  it("waits for the account's catalog before trusting any answer", () => {
    expect(
      railVerdict({ answer: [{ id: "grok-4.7" }], protectedIds: [], piIds: undefined }),
    ).toMatchObject({ ok: false });
  });
});
