import { STARTER_SLOTS } from "@shared/modelSlots";
import type { ModelsCatalogView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { type AccountModels, ModelSlots, NEW_MARK_MS } from "./modelSlots";

function build(accounts: AccountModels[], catalog?: ModelsCatalogView) {
  const settings = new SettingsStore(openInMemoryDatabase());
  let rows = accounts;
  const slots = new ModelSlots({
    settings,
    accounts: () => rows,
    quotaModels: () => catalog,
  });
  return { slots, settings, setAccounts: (next: AccountModels[]) => (rows = next) };
}

const codex: AccountModels = {
  accountId: "acct-codex",
  accountLabel: "personal",
  providerId: "openai-codex",
  models: [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "openai-codex", id: "gpt-6-sol" },
    { provider: "openai-codex", id: "gpt-6-luna" },
    { provider: "openai-codex", id: "gemini-3.6-flash" },
  ],
};

const grok: AccountModels = {
  accountId: "acct-grok",
  accountLabel: "work",
  providerId: "xai",
  models: [{ provider: "xai", id: "grok-4.7" }],
};

/** A Grok account whose catalog still serves the generation 4.7 replaced. */
const grokLine: AccountModels = {
  accountId: "acct-grok-line",
  accountLabel: "team",
  providerId: "xai",
  models: [
    { provider: "xai", id: "grok-4.7" },
    { provider: "xai", id: "grok-4.6" },
    { provider: "xai", id: "grok-build-0.1" },
  ],
};

const claude: AccountModels = {
  accountId: "acct-claude",
  accountLabel: "max",
  providerId: "anthropic-claude",
  models: CLAUDE_MODELS.map((model) => ({ provider: "anthropic-claude", id: model.id })),
};

describe("the starter map", () => {
  it("names only Claude models the catalog offers, so no Claude row is inert", () => {
    const offered = new Set(CLAUDE_MODELS.map((model) => model.id));
    for (const id of Object.keys(STARTER_SLOTS["anthropic-claude"] ?? {})) {
      expect(offered, `${id} is not in CLAUDE_MODELS`).toContain(id);
    }
    expect(STARTER_SLOTS["anthropic-claude"]?.["claude-opus-5-5"]).toEqual(["high"]);
    expect(STARTER_SLOTS["anthropic-claude"]?.["claude-opus-5"]).toBeUndefined();
  });
});

describe("ModelSlots.reconcile - first activation only", () => {
  it("seeds Claude's low starter without moving its other levels", () => {
    const { slots } = build([claude]);
    slots.reconcile();
    for (const [id, slot] of [
      ["claude-haiku-5-5", "low"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-opus-5-5", "high"],
      ["claude-fable-5-1", "premium"],
    ] as const) {
      expect(slots.slotsOf({ provider: "anthropic-claude", id })).toEqual([slot]);
    }
    expect(slots.routable(claude.models).models).toContainEqual(
      expect.objectContaining({ id: "claude-haiku-5-5", slot: "low" }),
    );
  });

  it("preserves saved Sonnet and legacy Haiku placements when Haiku 5.5 arrives", () => {
    const { slots, settings } = build([claude]);
    settings.setModelSlots({
      version: 1,
      assignments: {
        "anthropic-claude/claude-sonnet-5-5": ["low", "medium"],
        "anthropic-claude/claude-haiku-4-5": ["low"],
      },
      seen: ["anthropic-claude/claude-sonnet-5-5", "anthropic-claude/claude-haiku-4-5"],
    });
    slots.reconcile();
    expect(slots.slotsOf({ provider: "anthropic-claude", id: "claude-sonnet-5-5" })).toEqual([
      "low",
      "medium",
    ]);
    expect(slots.slotsOf({ provider: "anthropic-claude", id: "claude-haiku-4-5" })).toEqual([
      "low",
    ]);
    expect(slots.slotsOf({ provider: "anthropic-claude", id: "claude-haiku-5-5" })).toEqual([
      "low",
    ]);
  });

  it("does not turn on Haiku 5.5 if it was already seen and left off", () => {
    const { slots, settings } = build([claude]);
    settings.setModelSlots({
      version: 1,
      assignments: {},
      seen: ["anthropic-claude/claude-haiku-5-5"],
    });
    slots.reconcile();
    expect(slots.slotsOf({ provider: "anthropic-claude", id: "claude-haiku-5-5" })).toEqual([]);
  });

  it("seeds a new account from its provider's starter rows, and only those rows", () => {
    const { slots } = build([codex, grok]);
    expect(slots.reconcile()).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-astra" })).toEqual(["premium"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual([
      "high",
      "medium",
    ]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-sol" })).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-luna" })).toEqual(["low"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual([]);
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.7" })).toEqual(["medium"]);
  });

  it("seeds a Grok account with Grok 4.7 in medium and the older generation off", () => {
    const { slots } = build([grokLine]);
    expect(slots.reconcile()).toEqual([]);
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.7" })).toEqual(["medium"]);
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.6" })).toEqual([]);
    expect(slots.slotsOf({ provider: "xai", id: "grok-build-0.1" })).toEqual([]);
  });

  it("announces a live-catalog newcomer once and leaves an unmapped one off", () => {
    const { slots, setAccounts } = build([codex]);
    slots.reconcile();
    setAccounts([
      {
        ...codex,
        models: [...codex.models, { provider: "openai-codex", id: "gpt-7-sol" }],
      },
    ]);
    expect(slots.reconcile()).toEqual([{ providerId: "openai-codex", id: "gpt-7-sol" }]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-7-sol" })).toEqual([]);
    expect(slots.reconcile()).toEqual([]);
  });

  it("says nothing of an older generation arriving - it is reachable by name only", () => {
    // The Claude re-listing shape (2026-09-23): earlier generations of a
    // family the account already serves newer of are not news and get no row.
    const { slots, setAccounts } = build([codex]);
    slots.reconcile();
    setAccounts([
      {
        ...codex,
        models: [...codex.models, { provider: "openai-codex", id: "gpt-5.7-sol" }],
      },
    ]);
    expect(slots.reconcile()).toEqual([]);
    const view = slots.view();
    expect(view.models.some((model) => model.id === "gpt-5.7-sol")).toBe(false);
    expect(view.byName.map((model) => model.id)).toContain("gpt-5.7-sol");
  });

  it("announces nothing from an account still on the shipped catalog", () => {
    // A client-served account whose own read has not succeeded: what it
    // holds is Infinitary's shipped list, which is not news, only seen.
    let readSucceeded = false;
    const settings = new SettingsStore(openInMemoryDatabase());
    let rows: AccountModels[] = [claude];
    const slots = new ModelSlots({
      settings,
      accounts: () => rows,
      quotaModels: () => undefined,
      canAnnounce: () => readSucceeded,
    });
    slots.reconcile();
    const withNew: AccountModels = {
      ...claude,
      models: [...claude.models, { provider: "anthropic-claude", id: "claude-opus-6" }],
    };
    rows = [withNew];
    expect(slots.reconcile()).toEqual([]);
    // Seen now: the read that later brings the same model does not re-announce.
    readSucceeded = true;
    expect(slots.reconcile()).toEqual([]);
    rows = [
      {
        ...withNew,
        models: [...withNew.models, { provider: "anthropic-claude", id: "claude-sonnet-6" }],
      },
    ];
    expect(slots.reconcile()).toEqual([{ providerId: "anthropic-claude", id: "claude-sonnet-6" }]);
  });

  it("places a mapped newcomer and names the slot in the notice", () => {
    const partial: AccountModels = {
      ...codex,
      models: codex.models.filter((model) => model.id !== "gpt-6-astra"),
    };
    const { slots, setAccounts } = build([partial]);
    slots.reconcile();
    setAccounts([codex]);
    expect(slots.reconcile()).toEqual([
      { providerId: "openai-codex", id: "gpt-6-astra", slots: ["premium"] },
    ]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-astra" })).toEqual(["premium"]);
  });

  it("never overwrites a user's existing choice, including off", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "high", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "medium", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "low", true);
    slots.setSlotMembership("openai-codex/gpt-6-luna", "low", false);
    expect(slots.reconcile()).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual(["low"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-luna" })).toEqual([]);
  });
});

// INF-94: the board's "new" mark lived in memory and the next catalog read
// (the quota refresh at start) cleared it, so a person opening Settings did
// not see it. It is saved with the slots now, for a week or until the person
// changes the model's levels.
describe("ModelSlots - the board's new mark", () => {
  /** A Grok account that served 4.6 before, now bringing 4.7, which its starter level places. */
  function grokArrival() {
    const settings = new SettingsStore(openInMemoryDatabase());
    let clock = Date.parse("2026-10-18T09:00:00Z");
    let rows: AccountModels[] = [
      { ...grokLine, models: grokLine.models.filter((model) => model.id !== "grok-4.7") },
    ];
    const open = () =>
      new ModelSlots({
        settings,
        accounts: () => rows,
        quotaModels: () => undefined,
        now: () => clock,
      });
    open().reconcile();
    rows = [grokLine];
    const slots = open();
    expect(slots.reconcile()).toEqual([{ providerId: "xai", id: "grok-4.7", slots: ["medium"] }]);
    return { settings, slots, open, later: (ms: number) => (clock += ms) };
  }
  const isNew = (slots: ModelSlots) =>
    slots.view().models.find((model) => model.id === "grok-4.7")?.isNew === true;

  it("keeps an arrival's mark through the next catalog read and a restart", () => {
    const { slots, open, later } = grokArrival();
    expect(isNew(slots)).toBe(true);
    later(60_000);
    expect(slots.reconcile()).toEqual([]);
    expect(isNew(slots)).toBe(true);
    expect(isNew(open())).toBe(true);
    // Only the arrival is news: the generations seen before carry no mark.
    expect(
      slots
        .view()
        .models.filter((model) => model.isNew)
        .map((model) => model.id),
    ).toEqual(["grok-4.7"]);
  });

  it("takes the mark off once the person changes the model's levels", () => {
    const { slots, open } = grokArrival();
    slots.setSlotMembership("xai/grok-4.7", "high", true);
    expect(isNew(slots)).toBe(false);
    expect(isNew(open())).toBe(false);
  });

  it("lets the mark go a week after the model arrived", () => {
    const { slots, settings, later } = grokArrival();
    later(NEW_MARK_MS - 1);
    expect(isNew(slots)).toBe(true);
    later(1);
    expect(isNew(slots)).toBe(false);
    slots.reconcile();
    expect(settings.getModelSlots().arrived).toBeUndefined();
  });
});

describe("ModelSlots.setSlotMembership - add, remove, and multi-bucket", () => {
  it("places an offered model, moves it, and turns it off", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", true);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual(["low"]);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", false);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "high", true);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual(["high"]);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "high", false);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual([]);
  });

  it("holds the same offering in more than one bucket at once", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", true);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "high", true);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual([
      "low",
      "high",
    ]);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", false);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual(["high"]);
  });

  it("adding a slot already held is a no-op, not a duplicate", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", true);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "low", true);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual(["low"]);
  });

  it("ignores keys the live pool does not serve", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/not-a-real-model", "high", true);
    expect(slots.slotsOf({ provider: "openai-codex", id: "not-a-real-model" })).toEqual([]);
  });
});

describe("ModelSlots.reset - both grains", () => {
  it("resets one provider without touching a sibling", () => {
    const { slots } = build([codex, grok]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "high", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "medium", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "low", true);
    slots.setSlotMembership("xai/grok-4.7", "medium", false);
    slots.setSlotMembership("xai/grok-4.7", "low", true);
    slots.reset("xai");
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.7" })).toEqual(["medium"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual(["low"]);
  });

  it("resets every provider to the starter map, leaving seen and pins alone", () => {
    const { slots, settings } = build([codex, grok]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "high", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "medium", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "low", true);
    slots.setSlotMembership("xai/grok-4.7", "medium", false);
    slots.setSlotMembership("openai-codex/gemini-3.6-flash", "medium", true);
    const seenBefore = settings.getModelSlots().seen.slice();
    slots.reset();
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual([
      "high",
      "medium",
    ]);
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.7" })).toEqual(["medium"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gemini-3.6-flash" })).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6-astra" })).toEqual(["premium"]);
    expect(settings.getModelSlots().seen).toEqual(seenBefore);
  });
});

describe("ModelSlots.routable - the fallback ladder", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "openai-codex", id: "gemini-3.6-flash" },
  ];

  it("narrows to the slotted subset when there is one", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    const routable = slots.routable(available);
    expect(routable.models).toEqual([
      { provider: "openai-codex", id: "gpt-6.1-sol", slot: "high" },
      { provider: "openai-codex", id: "gpt-6.1-sol", slot: "medium" },
    ]);
    expect(routable.note).toBe("2 of 2 available models have a slot");
  });

  it("falls back to the starter map when NOTHING is slotted", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "high", false);
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "medium", false);
    slots.setSlotMembership("openai-codex/gpt-6-astra", "premium", false);
    slots.setSlotMembership("openai-codex/gpt-6-luna", "low", false);
    const routable = slots.routable(available);
    expect(routable.models).toEqual([
      { provider: "openai-codex", id: "gpt-6.1-sol", slot: "high" },
      { provider: "openai-codex", id: "gpt-6.1-sol", slot: "medium" },
    ]);
    expect(routable.note).toMatch(/using the starter map/);
  });

  it("falls back to the listed models, not a catalog's first id", () => {
    // An OpenRouter-only install with nothing slotted: the whole catalog is
    // 388 ids, and its first is an old model nobody chose.
    const openrouter: AccountModels = {
      accountId: "acct-or",
      accountLabel: "Key",
      providerId: "openrouter",
      models: [
        { provider: "openrouter", id: "anthropic/claude-3-haiku" },
        { provider: "openrouter", id: "~anthropic/claude-sonnet-latest" },
        { provider: "openrouter", id: "openai/gpt-3.5-turbo:batch" },
      ],
    };
    const { slots } = build([openrouter]);
    const routable = slots.routable(openrouter.models);
    expect(routable.models).toEqual([
      { provider: "openrouter", id: "~anthropic/claude-sonnet-latest", slot: "medium" },
    ]);
    expect(routable.note).toBe(
      "no slotted or starter-map model is available; using every listed model",
    );
  });

  it("falls back to the whole signed-in pool rather than routing nothing", () => {
    const { slots } = build([codex]);
    const orphan = [{ provider: "openrouter", id: "some/experimental-model" }];
    const routable = slots.routable(orphan);
    expect(routable.models).toEqual([
      { provider: "openrouter", id: "some/experimental-model", slot: "medium" },
    ]);
    expect(routable.note).toBe(
      "no slotted, starter-map or listed model is available; using every signed-in model",
    );
  });

  it("returns one row per membership for an offering placed in more than one slot", () => {
    const { slots } = build([codex]);
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-6.1-sol", "low", true);
    const routable = slots.routable(available);
    expect(routable.models).toEqual(
      expect.arrayContaining([
        { provider: "openai-codex", id: "gpt-6.1-sol", slot: "high" },
        { provider: "openai-codex", id: "gpt-6.1-sol", slot: "medium" },
        { provider: "openai-codex", id: "gpt-6.1-sol", slot: "low" },
      ]),
    );
    expect(routable.models).toHaveLength(3);
  });
});

describe("ModelSlots.view", () => {
  const catalog: ModelsCatalogView = {
    generatedAt: "now",
    models: [
      { provider: "codex", id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { provider: "codex", id: "gpt-6-astra", label: "GPT-6 Astra" },
    ],
  };

  it("is slot-first, one row per offering, with the provider on the row", () => {
    const second: AccountModels = { ...codex, accountId: "acct-codex-2", accountLabel: "side" };
    const { slots } = build([codex, second], catalog);
    slots.reconcile();
    const view = slots.view();
    const sol = view.models.filter((model) => model.id === "gpt-6.1-sol");
    expect(sol).toHaveLength(1);
    expect(sol[0]?.providerLabel).toBe("Codex");
    expect(sol[0]?.slots).toEqual(["high", "medium"]);
    const astra = view.models.find((model) => model.id === "gpt-6-astra");
    expect(astra?.slots).toEqual(["premium"]);
    const flash = view.models.find((model) => model.id === "gemini-3.6-flash");
    expect(flash?.slots).toEqual([]);
    expect(view.usingDefaults).toBe(false);
  });

  it("reports usingDefaults when nothing currently available is assigned", () => {
    const { slots } = build([codex], catalog);
    expect(slots.view().usingDefaults).toBe(true);
  });

  it("orders provider, family, newest generation first, then tier", () => {
    const { slots } = build([codex, grokLine], catalog);
    slots.reconcile();
    expect(slots.view().models.map((model) => `${model.provider}/${model.id}`)).toEqual([
      // Codex: the 6.1 generation leads; the older 6 variants follow in
      // tier order (premium, low), then the gemini family.
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6-luna",
      "openai-codex/gemini-3.6-flash",
      // Grok: provider labels sort A-Z. Grok 4.7 is the grok family's row
      // and Grok Build its own family's; older Grok 4.6 is by name only.
      "xai/grok-4.7",
      "xai/grok-build-0.1",
    ]);
    // GPT-6 Sol and Grok 4.6 are older generations: served but reachable
    // only by name when the person has not kept them.
    expect(slots.view().byName.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai-codex/gpt-6-sol",
      "xai/grok-4.6",
    ]);
  });
});

describe("ModelSlots.nameOf - the one model-name lookup", () => {
  it("names a model by the row Settings shows, listed or by name, else its bare id", () => {
    const catalog: ModelsCatalogView = {
      generatedAt: "now",
      models: [
        { provider: "codex", id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
        { provider: "codex", id: "gpt-6-sol", label: "GPT-6 Sol" },
      ],
    };
    const { slots } = build([codex], catalog);
    slots.reconcile();
    // Listed, and reachable only by name: the same lookup either way.
    expect(slots.view().models.some((model) => model.id === "gpt-6.1-sol")).toBe(true);
    expect(slots.view().byName.some((model) => model.id === "gpt-6-sol")).toBe(true);
    expect(slots.nameOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toBe("GPT-6.1 Sol");
    expect(slots.nameOf({ provider: "openai-codex", id: "gpt-6-sol" })).toBe("GPT-6 Sol");
    // No account serves it: the bare id, never the provider-prefixed key.
    expect(slots.nameOf({ provider: "fm-mock", id: "mock-1" })).toBe("mock-1");
  });

  it("names a model the quota catalog does not know by its own name, maker prefix dropped", () => {
    // OpenRouter has no quota catalog: before the one lookup the record
    // named this model by its raw id while the crew summary named it.
    const openrouter: AccountModels = {
      accountId: "acct-or",
      accountLabel: "router",
      providerId: "openrouter",
      models: [
        {
          provider: "openrouter",
          id: "google/gemini-3-pro-image",
          name: "Google: Nano Banana Pro",
        },
      ],
    };
    const { slots } = build([openrouter]);
    expect(slots.nameOf({ provider: "openrouter", id: "google/gemini-3-pro-image" })).toBe(
      "Nano Banana Pro",
    );
  });
});

describe("ModelSlots listing - kept models stay listed", () => {
  it("keeps an older generation listed while it sits in a slot", () => {
    const { slots } = build([grokLine]);
    slots.reconcile();
    slots.setSlotMembership("xai/grok-4.6", "low", true);
    const view = slots.view();
    expect(view.models.map((model) => model.id)).toContain("grok-4.6");
    expect(view.byName.map((model) => model.id)).not.toContain("grok-4.6");
  });

  it("keeps a pinned or Firstmate model listed", () => {
    const settings = new SettingsStore(openInMemoryDatabase());
    const kept = [{ provider: "xai", id: "grok-4.6" }];
    const slots = new ModelSlots({
      settings,
      accounts: () => [grokLine],
      quotaModels: () => undefined,
      kept: () => kept,
    });
    expect(slots.view().models.map((model) => model.id)).toContain("grok-4.6");
    expect(slots.listedOf(grokLine.models).map((model) => model.id)).toContain("grok-4.6");
  });

  it("labels a row by its own provider, and by the runtime's name when the quota catalog has none", () => {
    // Every Pi runtime reads the app's models.json, so a custom provider's
    // model rides an OpenRouter account's snapshot - it is not OpenRouter's.
    const openrouter: AccountModels = {
      accountId: "acct-or",
      accountLabel: "Key",
      providerId: "openrouter",
      models: [
        {
          provider: "openrouter",
          id: "~anthropic/claude-opus-latest",
          name: "Anthropic: Claude Opus Latest",
        },
        { provider: "local-lab", id: "llama-9" },
      ],
    };
    const { slots } = build([openrouter]);
    const rows = slots.view().models;
    expect(rows.find((row) => row.id === "~anthropic/claude-opus-latest")).toMatchObject({
      providerLabel: "OpenRouter",
      label: "Anthropic: Claude Opus Latest",
    });
    expect(rows.find((row) => row.id === "llama-9")).toMatchObject({
      providerLabel: "local-lab",
      label: "llama-9",
    });
  });

  it("lists every model of a provider it does not track - the user's own models.json", () => {
    const { slots } = build([codex]);
    const custom = [
      { provider: "local-lab", id: "llama-9" },
      { provider: "local-lab", id: "llama-8" },
    ];
    expect(slots.listedOf(custom)).toEqual(custom);
  });
});

describe("ModelSlots.departures - only successful reads say a model left", () => {
  const snapshot = (ids: string[]) => ({
    accountId: "acct-grok-line",
    providerId: "xai",
    ids,
  });

  it("records the first successful read without announcing anything", () => {
    const { slots, settings } = build([grokLine]);
    expect(slots.departures([snapshot(["grok-build-0.1", "grok-4.7"])])).toEqual([]);
    expect(settings.getServedBaselines()["acct-grok-line"]).toEqual(["grok-4.7", "grok-build-0.1"]);
  });

  it("announces a listed or kept model the next successful read no longer serves", () => {
    const { slots } = build([grokLine]);
    slots.reconcile();
    slots.setSlotMembership("xai/grok-4.6", "low", true);
    slots.departures([snapshot(["grok-build-0.1", "grok-4.7", "grok-4.6", "grok-4.5"])]);
    expect(slots.departures([snapshot(["grok-build-0.1", "grok-4.7"])])).toEqual([
      // Kept: announced with the slot it sat in, which it keeps.
      { providerId: "xai", id: "grok-4.6", slots: ["low"] },
    ]);
    // grok-4.5 was an older generation nobody kept: it leaves silently.
    expect(slots.slotsOf({ provider: "xai", id: "grok-4.6" })).toEqual(["low"]);
  });

  it("never treats an empty snapshot as a read", () => {
    const { slots, settings } = build([grokLine]);
    slots.departures([snapshot(["grok-build-0.1", "grok-4.7"])]);
    expect(slots.departures([snapshot([])])).toEqual([]);
    expect(settings.getServedBaselines()["acct-grok-line"]).toEqual(["grok-4.7", "grok-build-0.1"]);
  });

  it("says a model left once, not on every pass", () => {
    const { slots } = build([grokLine]);
    slots.departures([snapshot(["grok-build-0.1", "grok-4.7"])]);
    expect(slots.departures([snapshot(["grok-build-0.1"])])).toHaveLength(1);
    expect(slots.departures([snapshot(["grok-build-0.1"])])).toEqual([]);
  });

  it("tags a computer's model with that computer and starts it not in use", () => {
    const { slots } = build([
      {
        accountId: "mini:acct",
        accountLabel: "Studio",
        providerId: "fm-custom-0123456789abcdef",
        place: "Mac mini",
        models: [{ provider: "fm-custom-0123456789abcdef", id: "qwen" }],
      },
    ]);
    const row = slots.view().models.find((model) => model.id === "qwen");
    expect(row).toMatchObject({ place: "Mac mini", slots: [], label: "qwen" });
  });
});

describe("per-offering, served-level reasoning choices", () => {
  it("keeps independent choices across owners, providers, removal and membership moves", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const other = {
      ...codex,
      accountId: "other",
      providerId: "other",
      models: [{ provider: "other", id: "gpt-6.1-sol" }],
    };
    const make = () =>
      new ModelSlots({
        settings,
        accounts: () => [codex, other],
        quotaModels: () => undefined,
        reasoningCapabilities: () => ({ levels: ["low", "medium", "high", "xhigh"] }),
      });
    const slots = make();
    slots.reconcile();
    const key = "openai-codex/gpt-6.1-sol";
    slots.setReasoning(key, "high", "high");
    slots.setReasoning(key, "medium", "low");
    slots.setReasoning("other/gpt-6.1-sol", "high", "medium");
    slots.setSlotMembership(key, "high", false);
    slots.setSlotMembership(key, "low", true);
    const reopened = make();
    expect(
      reopened.reasoningChoice({ provider: "openai-codex", id: "gpt-6.1-sol" }, "low"),
    ).toBeUndefined();
    reopened.setSlotMembership(key, "high", true);
    expect(
      reopened
        .view()
        .models.find((row) => row.provider === "openai-codex" && row.id === "gpt-6.1-sol")
        ?.reasoning,
    ).toMatchObject({
      high: { chosen: "high", effective: { level: "high" } },
      medium: { chosen: "low", effective: { level: "low" } },
    });
    expect(reopened.reasoningChoice({ provider: "other", id: "gpt-6.1-sol" }, "high")).toBe(
      "medium",
    );
    reopened.setReasoning(key, "high", null);
    expect(
      reopened.reasoningChoice({ provider: "openai-codex", id: "gpt-6.1-sol" }, "high"),
    ).toBeUndefined();
    expect(
      reopened.reasoningChoice({ provider: "openai-codex", id: "gpt-6.1-sol" }, "medium"),
    ).toBe("low");
    db.close();
  });
  it("preserves unsupported saved choices, explains the cap and refuses invalid writes", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    let levels: import("@shared/modelSlots").ReasoningChoice[] = ["low", "medium", "high", "xhigh"];
    const slots = new ModelSlots({
      settings,
      accounts: () => [codex],
      quotaModels: () => undefined,
      reasoningCapabilities: () => ({ levels }),
    });
    slots.reconcile();
    const key = "openai-codex/gpt-6.1-sol";
    slots.setReasoning(key, "high", "xhigh");
    levels = ["low", "medium", "high"];
    expect(slots.view().models.find((row) => row.id === "gpt-6.1-sol")?.reasoning?.high).toEqual({
      chosen: "xhigh",
      effective: { level: "high", lower: "capped" },
    });
    expect(() => slots.setReasoning(key, "high", "xhigh")).toThrow("no longer offers");
    expect(slots.reasoningChoice({ provider: "openai-codex", id: "gpt-6.1-sol" }, "high")).toBe(
      "xhigh",
    );
    expect(() => slots.setReasoning("missing/model", "high", "low")).toThrow("not available");
    slots.setReasoning(key, "high", null);
    expect(slots.view().models.find((row) => row.id === "gpt-6.1-sol")?.reasoning?.high).toEqual({
      effective: { level: "high", lower: "capped" },
    });
    db.close();
  });
});
