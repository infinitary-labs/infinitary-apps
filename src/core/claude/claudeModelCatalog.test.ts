import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { checkCatalog } from "../models/catalogChecks";
import {
  type ClaudeModelRow,
  canonicalClaudeModelId,
  canonicalClaudeModelIds,
  claudeCatalogIsBuiltInPicker,
  claudeCatalogIsOutdated,
  claudeServedModels,
  readClaudeModelCatalog,
} from "./claudeModelCatalog";
import { CLAUDE_MODELS } from "./claudeModels";

/**
 * The comparison half of the drift guard, hermetically. The rows below are
 * the shapes Claude's own client actually answers with - recorded from the
 * live read in docs/claude-model-probe.md - so the normalization is tested
 * against the real catalog's habits (an alias row, a context-window
 * variant, a dated snapshot, two rows for one model) rather than invented
 * ones. The live half is claudeModelProbe.test.ts.
 */

/**
 * The catalog the machine's subscription answered with on 2026-09-20,
 * through the installed Claude Code 2.1.278 (docs/claude-model-probe.md).
 */
const LIVE_ROWS: ClaudeModelRow[] = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
];

describe("normalizing the client's catalog rows", () => {
  it("takes the client's own resolution of an alias", () => {
    expect(canonicalClaudeModelId({ value: "sonnet", resolvedModel: "claude-sonnet-5" })).toBe(
      "claude-sonnet-5",
    );
    expect(canonicalClaudeModelId({ value: "default", resolvedModel: "claude-opus-5-5[1m]" })).toBe(
      "claude-opus-5-5",
    );
  });

  it("falls back to the row's own value where the client resolves nothing", () => {
    // The value is the id the client accepts for that row either way, so an
    // unresolved row is reported rather than dropped - a model that exists
    // and is unnamed here is the failure this guard is for.
    expect(canonicalClaudeModelId({ value: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(canonicalClaudeModelId({ value: "claude-sonnet-5[1m]" })).toBe("claude-sonnet-5");
  });

  it("drops the context-window variant, which is a window and not a model", () => {
    expect(
      canonicalClaudeModelId({ value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" }),
    ).toBe("claude-opus-5-5");
  });

  it("drops a dated snapshot, because the catalog names families", () => {
    // Otherwise the check would fail on every point release - a guard that
    // cries drift at a new build is worse than none.
    expect(
      canonicalClaudeModelId({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }),
    ).toBe("claude-haiku-4-5");
  });

  it("collapses aliases that resolve to the same model, keeping the client's order", () => {
    expect(canonicalClaudeModelIds(LIVE_ROWS)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("ignores a row that normalizes to nothing", () => {
    expect(
      canonicalClaudeModelIds([{ value: "  " }, { value: "sonnet", resolvedModel: " " }]),
    ).toEqual(["sonnet"]);
  });
});

/**
 * Current Fable 5.2, Haiku 5.5 and Sonnet 5.5 with the earlier generations a client
 * may re-list. A composite fixture, not one historical catalog snapshot
 * (docs/claude-model-probe.md).
 */
// Fable 5.2 row: the installed 2.1.321 client's live listing, verified for the catalog update.
const RELISTED_ROWS: ClaudeModelRow[] = [
  { value: "claude-fable-5-2", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  {
    value: "claude-haiku-4-5",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
  },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
  { value: "claude-opus-4-7", resolvedModel: "claude-opus-4-7", displayName: "Opus 4.7" },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
];

const SHIPPED = CLAUDE_MODELS.map((model) => model.id);

function check(served: string[], shipped: readonly string[] = SHIPPED) {
  return checkCatalog({
    providerId: "anthropic-claude",
    served,
    shipped,
    namesEveryHead: true,
  });
}

describe("Haiku catalog metadata compatibility", () => {
  it("recognizes a successful older list as incomplete, not an entitlement denial", () => {
    expect(claudeCatalogIsOutdated(LIVE_ROWS, "2.1.290")).toBe(true);
    expect(claudeCatalogIsOutdated(RELISTED_ROWS, "2.1.290")).toBe(false);
    expect(claudeCatalogIsOutdated(LIVE_ROWS, "2.1.293")).toBe(false);
    expect(claudeCatalogIsOutdated(LIVE_ROWS, undefined)).toBe(false);
  });

  it("names the new model once, retaining legacy Haiku by name", () => {
    const served = claudeServedModels(RELISTED_ROWS);
    expect(served.filter((row) => row.id === "claude-haiku-5-5")).toEqual([
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    ]);
    expect(served).toContainEqual({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" });
  });
});

describe("the Claude catalog check (docs/model-lists.md)", () => {
  it("passes when the client re-lists earlier generations - they are digest, not drift", () => {
    // Both re-listed older generations and the Sonnet replaced by 5.5
    // remain reachable by name, without making the current starter stale.
    const result = check(canonicalClaudeModelIds(RELISTED_ROWS));
    expect(result.failures).toEqual([]);
    expect(result.digest).toContain("9 more by name only");
  });

  it("fails when a family's newest generation is missing from CLAUDE_MODELS", () => {
    // Claude Code 2.1.280 moving Opus 5 to Opus 5.5 while the list still
    // named Opus 5: the newest opus is unnamed and the starter is behind.
    const served = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
    const result = check(served, ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
    expect(result.failures.join("\n")).toContain("newest generation is missing");
    expect(result.failures.join("\n")).toContain("claude-opus-5-5");
  });

  it("fails on a brand-new family nobody names - FI3-74's shape", () => {
    const served = canonicalClaudeModelIds([
      ...RELISTED_ROWS,
      { value: "claude-lyric-1", resolvedModel: "claude-lyric-1" },
    ]);
    expect(check(served).failures.join("\n")).toContain("claude-lyric-1");
  });

  it("fails on a dead default: a starter the client no longer serves", () => {
    // Claude Code 2.1.234 served claude-fable-5 and no claude-fable-5-1.
    const served = ["claude-fable-5", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];
    const failures = check(served).failures.join("\n");
    expect(failures).toContain("Dead default");
    expect(failures).toContain("claude-fable-5-2");
  });

  it("names each served model as CLAUDE_MODELS does, else by the client's own label", () => {
    const served = claudeServedModels(RELISTED_ROWS);
    expect(served).toContainEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect(served).toContainEqual({ id: "claude-opus-4-8", name: "Claude Opus 4.8" });
    // The "default" alias row never names a model.
    expect(served.some((model) => /default/i.test(model.name))).toBe(false);
    expect(served).toHaveLength(new Set(canonicalClaudeModelIds(RELISTED_ROWS)).size);
  });
});

describe("naming an alias row's model", () => {
  // Claude Code 2.1.322's built-in picker rows: its Fable alias still on 5.1,
  // and the Sonnet 4.6 1M row it adds with an explicit id, which keeps the
  // answer from reading as aliases only.
  const BUILT_IN_WITH_ID: ClaudeModelRow[] = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
    { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
    {
      value: "claude-sonnet-4-6[1m]",
      resolvedModel: "claude-sonnet-4-6",
      displayName: "Sonnet 4.6 (1M context)",
    },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
  ];

  it("names the model an alias points at by its version, not the alias's bare label", () => {
    expect(claudeCatalogIsBuiltInPicker(BUILT_IN_WITH_ID)).toBe(false);
    expect(claudeServedModels(BUILT_IN_WITH_ID)).toContainEqual({
      id: "claude-fable-5-1",
      name: "Claude Fable 5.1",
    });
  });

  it("keeps an alias label that already carries the version", () => {
    expect(claudeServedModels(RELISTED_ROWS)).toContainEqual({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
    });
    expect(
      claudeServedModels([
        { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
      ]),
    ).toEqual([{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }]);
  });
});

describe("reading the catalog from the client", () => {
  /** A stand-in session: records how it was opened, answers one list. */
  function fakeQuery(rows: ClaudeModelRow[]) {
    const seen: { options?: Options; prompted: SDKUserMessage[]; closed: number } = {
      prompted: [],
      closed: 0,
    };
    const factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      seen.options = params.options;
      // Draining the input is what a real session does; this one must find
      // nothing to send, which is why the read spends nothing.
      void (async () => {
        for await (const message of params.prompt) seen.prompted.push(message);
      })();
      return {
        supportedModels: async () => rows as never,
        close: () => {
          seen.closed += 1;
        },
      };
    };
    return { factory, seen };
  }

  it("asks the client for its models, sends no prompt, and closes the session", async () => {
    const { factory, seen } = fakeQuery(LIVE_ROWS);
    const rows = await readClaudeModelCatalog({ factory });
    expect(canonicalClaudeModelIds(rows)).toContain("claude-fable-5-1");
    expect(seen.prompted).toEqual([]);
    expect(seen.closed).toBe(1);
  });

  it("opens the session under the production credential boundary", async () => {
    const { factory, seen } = fakeQuery(LIVE_ROWS);
    await readClaudeModelCatalog({ factory });
    const env = seen.options?.env ?? {};
    // CD-1=B: the machine's default login, and nothing ambient. A set config
    // dir would read a different Keychain item than production does.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("infinitary");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // The user's own Claude settings are theirs; a crewmate run reads none
    // of them, so neither does the catalog this is checked against.
    expect(seen.options?.settingSources).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });

  it("fails, and still releases the session, when the client will not answer", async () => {
    const { seen, factory } = (() => {
      const base = fakeQuery([]);
      return {
        seen: base.seen,
        factory: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
          ...base.factory(params),
          supportedModels: () => new Promise<never>(() => {}),
        }),
      };
    })();
    await expect(readClaudeModelCatalog({ factory, timeoutMs: 10 })).rejects.toThrow(
      /did not list its models/,
    );
    // An unreadable catalog must never look like an empty one: it throws,
    // and the client it spawned does not outlive the attempt.
    expect(seen.closed).toBe(1);
  });
});
