import type { DecisionsView } from "@shared/decisions";
import { DECISION_STATE_VERSION, DEFAULT_DECISIONS } from "@shared/decisions";
import type { ModelSlotsView } from "@shared/modelSlots";
import type { RoutingSettings } from "@shared/quota";
import { reasoningWord } from "@shared/reasoning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { newModelNote } from "./levelDrops";
import { ModelsSection } from "./ModelsSection";
import { removeFromLevelOnly } from "./modelsWords";
import { ReasoningControl } from "./ReasoningControl";
import { USE_LEVEL_DEFAULT } from "./reasoningWords";

/**
 * The multi-slot rendering contract: an offering placed in more than one
 * slot renders once per membership, and the off group is exactly the
 * offerings with no membership at all.
 */

const ROUTING: RoutingSettings = { dynamicRouting: true, pins: [] };

/** A fresh install: the adapter's own walk, and no native model in sight. */
const DECISIONS: DecisionsView = {
  settings: DEFAULT_DECISIONS,
  stateVersion: DECISION_STATE_VERSION,
  natives: [
    {
      id: "jev",
      name: "Jev",
      vendor: "TypeSafe",
      keysUrl: "https://console.typesafe.ai/keys",
      state: "absent",
      keyStored: false,
      consented: false,
      last: null,
    },
  ],
};

function render(
  slots: ModelSlotsView,
  decisions: DecisionsView | null = DECISIONS,
  routing: RoutingSettings = ROUTING,
) {
  return renderToStaticMarkup(
    <ModelsSection
      slots={slots}
      routing={routing}
      decisions={decisions}
      open={true}
      onToggle={() => {}}
      focusAccountId={null}
      onFocused={() => {}}
      onSaveRouting={() => {}}
      onSetSlotMembership={() => Promise.resolve(true)}
      onResetSlots={() => {}}
      onSetDecisions={() => {}}
      onSetDecisionKey={() => Promise.resolve(true)}
      onRemoveDecisionKey={() => {}}
    />,
  );
}

describe("ModelsSection - multi-slot rendering", () => {
  it("renders an offering in every slot card it is placed in", () => {
    const slots: ModelSlotsView = {
      models: [
        {
          provider: "openai-codex",
          providerLabel: "Codex",
          id: "gpt-5.6-sol",
          label: "GPT 5.6 Sol",
          slots: ["high", "low"],
        },
      ],
      byName: [],
      usingDefaults: false,
    };
    const html = render(slots);
    const highGroup = html.match(/data-slot-group="high"[\s\S]*?data-slot-group="medium"/)?.[0];
    const lowGroup = html.match(/data-slot-group="low"[\s\S]*?data-slot-group="off"/)?.[0];
    expect(highGroup).toContain('data-model-row="openai-codex/gpt-5.6-sol"');
    expect(lowGroup).toContain('data-model-row="openai-codex/gpt-5.6-sol"');
  });

  it("puts a model with no membership in the off group, not any slot card", () => {
    const slots: ModelSlotsView = {
      models: [
        {
          provider: "openai-codex",
          providerLabel: "Codex",
          id: "gpt-5.6-luna",
          label: "GPT 5.6 Luna",
          slots: [],
        },
      ],
      byName: [],
      usingDefaults: false,
    };
    const html = render(slots);
    const offGroup = html.match(/data-slot-group="off"[\s\S]*$/)?.[0];
    expect(offGroup).toContain('data-model-row="openai-codex/gpt-5.6-luna"');
    for (const slot of ["premium", "high", "medium", "low"]) {
      const group = html.match(
        new RegExp(`data-slot-group="${slot}"[\\s\\S]*?data-slot-group="`),
      )?.[0];
      expect(group).not.toContain('data-model-row="openai-codex/gpt-5.6-luna"');
    }
  });
});

describe("ModelsSection - slot taglines", () => {
  it("describes each bucket by current routing, not judged difficulty", () => {
    const html = render({
      models: [
        {
          provider: "openai-codex",
          providerLabel: "Codex",
          id: "gpt-5.6-sol",
          label: "GPT 5.6 Sol",
          slots: ["high"],
        },
      ],
      byName: [],
      usingDefaults: false,
    });
    const hint = (slot: string) => {
      const group = html.match(
        new RegExp(`data-slot-group="${slot}"[\\s\\S]*?data-slot-group="`),
      )?.[0];
      expect(group, slot).toBeTruthy();
      return group as string;
    };
    expect(hint("premium")).toContain(
      "Crew never picks this automatically; your first mate&#x27;s Auto may fall back to it after high and medium.",
    );
    expect(hint("high")).toContain(
      "Plans, research, reproduction, and work without a verified basis",
    );
    expect(hint("medium")).toContain(
      "Building or fixing from a verified plan, spec, or reproduction",
    );
    expect(hint("low")).toContain("Config, docs, cosmetic chores");
    // An ask for premium waits rather than running lower on its own
    // (crewSupervisor's reasoning wait), so the empty level says so.
    expect(hint("premium")).toContain(
      "Empty. Work that asks for premium waits until you add a model here or choose to run it lower.",
    );
    expect(html).not.toContain("Everyday work");
    expect(html).not.toContain("Quick fixes, triage");
  });
});

describe("ModelsSection - lean listing (docs/model-lists.md)", () => {
  it("never renders a by-name model as a row or in the summary's off count", () => {
    const html = render({
      models: [
        {
          provider: "xai",
          providerLabel: "Grok",
          id: "grok-4.7",
          label: "Grok 4.7",
          slots: ["high"],
        },
      ],
      byName: [
        {
          provider: "xai",
          providerLabel: "Grok",
          id: "grok-4.6",
          label: "Grok 4.6",
          slots: [],
        },
      ],
      usingDefaults: false,
    });
    expect(html).toContain("Grok 4.7");
    expect(html).not.toContain("Grok 4.6");
    expect(html).not.toContain("1 not in use");
  });

  it("points an empty Not in use lane at Add model while older models are unlisted", () => {
    // A fresh Grok-only install: the newest generation sits in medium and the
    // older bundled ones are reachable by name only.
    const grok = (id: string, label: string, slots: ModelSlotsView["models"][number]["slots"]) => ({
      provider: "xai",
      providerLabel: "Grok",
      id,
      label,
      slots,
    });
    const listed = [grok("grok-4.7", "Grok 4.7", ["medium"])];
    const unlisted = [
      grok("grok-4.6", "Grok 4.6", []),
      grok("grok-4.5", "Grok 4.5", []),
      grok("grok-4.3", "Grok 4.3", []),
    ];
    const off = (html: string) => html.match(/data-slot-group="off"[\s\S]*$/)?.[0] ?? "";

    const withUnlisted = off(render({ models: listed, byName: unlisted, usingDefaults: false }));
    expect(withUnlisted).toContain(
      "Every model shown is in a level. Find more from your subscriptions by name under Add model.",
    );
    expect(withUnlisted).not.toContain("Every model sits in a level.");

    const allListed = off(render({ models: listed, byName: [], usingDefaults: false }));
    expect(allListed).toContain("Every model sits in a level.");
    expect(allListed).not.toContain("Find more from your subscriptions");

    // A lane with a model in it shows the model, not either line.
    const withOff = off(
      render({
        models: [...listed, grok("grok-4.6", "Grok 4.6", [])],
        byName: unlisted.slice(1),
        usingDefaults: false,
      }),
    );
    expect(withOff).toContain('data-model-row="xai/grok-4.6"');
    expect(withOff).not.toContain("Every model");
  });
});

describe("ModelsSection - where a control sits says how far it reaches", () => {
  const sol = {
    provider: "openai-codex",
    providerLabel: "Codex",
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    slots: ["high", "medium"] as ModelSlotsView["models"][number]["slots"],
  };
  const luna = { ...sol, id: "gpt-6-luna", label: "GPT-6 Luna", slots: [] };
  const slots: ModelSlotsView = { models: [sol, luna], byName: [], usingDefaults: false };
  const group = (html: string, slot: string) =>
    html.match(new RegExp(`data-slot-group="${slot}"[\\s\\S]*?(data-slot-group="|$)`))?.[0] ?? "";

  it("gives a pill inside a level only that level's remove, and no menu", () => {
    const html = render(slots);
    expect(group(html, "high")).toContain('aria-label="Remove GPT-6.1 Sol from high"');
    expect(group(html, "high")).not.toContain("from medium");
    expect(group(html, "medium")).toContain('aria-label="Remove GPT-6.1 Sol from medium"');
    // A model in no level has nothing to leave.
    expect(group(html, "off")).toContain('data-model-row="openai-codex/gpt-6-luna"');
    expect(group(html, "off")).not.toContain("Remove GPT-6 Luna");
    expect(html).not.toContain("GPT-6.1 Sol actions");
  });

  it("counts models in no level as not in use in the header", () => {
    expect(render(slots)).toContain("high 1 · medium 1 · 1 not in use");
  });

  it("says all crew work goes to a model set to always use, in the order routing tries them", () => {
    const html = render(slots, DECISIONS, {
      dynamicRouting: true,
      pins: [
        { provider: "codex", id: "gpt-6-luna" },
        { provider: "codex", id: "gpt-6.1-sol" },
      ],
    });
    const banner = html.match(/data-models-banner[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(banner).toContain("All crew work goes to");
    expect(banner.indexOf("GPT-6 Luna")).toBeLessThan(banner.indexOf("GPT-6.1 Sol"));
    expect(banner).toContain("if it cannot take the work");
    expect(banner).toContain("Levels are skipped while always use is on.");
    expect(html).toContain("2 always use ✱");
    // The ✱ stays on the pill, in every level the model sits in.
    expect(group(html, "high")).toContain('aria-label="GPT-6.1 Sol ✱"');
  });

  it("does not claim the work while Dynamic routing is off", () => {
    const html = render(slots, DECISIONS, {
      dynamicRouting: false,
      pins: [{ provider: "codex", id: "gpt-6.1-sol" }],
    });
    expect(html).toContain("It applies when Dynamic routing is on.");
    expect(html).not.toContain("All crew work goes to");
  });

  it("shows no banner when no model is set to always use", () => {
    expect(render(slots)).not.toContain("data-models-banner");
  });
});

describe("ModelsSection - the decision row names only the model answering", () => {
  const slots: ModelSlotsView = {
    models: [
      {
        provider: "openai-codex",
        providerLabel: "Codex",
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        slots: [],
      },
      {
        provider: "openai-codex",
        providerLabel: "Codex",
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        slots: ["low"],
      },
    ],
    byName: [],
    usingDefaults: false,
  };
  const pinned = (pin: DecisionsView["pinned"]): DecisionsView => ({
    ...DECISIONS,
    settings: {
      ...DEFAULT_DECISIONS,
      answerer: { kind: "adapted", offering: "openai-codex/gpt-6-luna" },
    },
    ...(pin ? { pinned: pin } : {}),
  });
  const row = (html: string) =>
    html.match(/data-decision-row="answerer"[\s\S]*?Decision model actions/)?.[0] ?? "";
  const header = (html: string) => html.match(/fm-subs-disclose-head[\s\S]*?<\/button>/)?.[0] ?? "";

  it("names a pick that is not in use while it is the model answering", () => {
    const html = render(slots, pinned("ready"));
    expect(row(html)).toContain("GPT-6 Luna");
    expect(header(html)).toContain("decisions GPT-6 Luna");
  });

  it("says a pick that cannot answer is unavailable and that the cheapest model answers", () => {
    const html = render(slots, pinned("fallback"));
    expect(row(html)).not.toContain("GPT-6 Luna");
    expect(row(html)).toContain("chosen model unavailable · using your cheapest slotted model");
    expect(header(html)).toContain("decisions auto");
    expect(header(html)).not.toContain("gpt-6-luna");
  });

  it("says nothing answers when a held pick cannot", () => {
    const html = render(slots, pinned("held"));
    expect(row(html)).not.toContain("GPT-6 Luna");
    expect(row(html)).toContain("chosen model unavailable · decisions go unanswered");
    expect(row(html)).toContain('data-tone="warn"');
    expect(header(html)).toContain("decisions unanswered");
  });
});

describe("inline reasoning capability states", () => {
  const model = {
    provider: "test",
    providerLabel: "Test",
    id: "one",
    label: "One",
    slots: ["high" as const],
  };
  it("offers backend choices without a redundant effective-level hint", () => {
    const html = renderToStaticMarkup(
      <ReasoningControl
        model={{
          ...model,
          reasoningCapabilities: { levels: ["low", "medium", "high"] },
          reasoning: { high: { chosen: "xhigh", effective: { level: "high", lower: "capped" } } },
        }}
        slot="high"
      />,
    );
    expect(html).toContain('value="xhigh" disabled=""');
    expect(html).toContain(`<option value="">${USE_LEVEL_DEFAULT}</option>`);
    expect(html).not.toContain('class="fm-models-hint"');
    expect(html.match(/<option /g)).toHaveLength(5);
  });
  it("fixed models and unknown capabilities have no invented menu, and lost choices can be cleared", () => {
    for (const fixed of ["off", "default"] as const) {
      const html = renderToStaticMarkup(
        <ReasoningControl
          model={{ ...model, reasoningCapabilities: { levels: [], fixed } }}
          slot="high"
        />,
      );
      expect(html).not.toContain("<select");
      expect(html).toContain(renderToStaticMarkup(<span>{reasoningWord({ level: fixed })}</span>));
    }
    const html = renderToStaticMarkup(
      <ReasoningControl
        model={{ ...model, reasoning: { high: { chosen: "high" } } }}
        slot="high"
      />,
    );
    expect(html).not.toContain("<select");
    expect(html).toContain(USE_LEVEL_DEFAULT);
    expect(html).not.toContain("Saved High · choices unavailable");
  });
});

// INF-27 (FI3-1540): a fact that sits inside a pill reaches the keyboard and
// assistive technology through the control that holds it, not a native title.
describe("ModelsSection - facts a pill holds", () => {
  const slots: ModelSlotsView = {
    models: [
      {
        provider: "xai",
        providerLabel: "Grok",
        id: "grok-4.7",
        label: "Grok 4.7",
        slots: ["medium"],
        isNew: true,
      },
    ],
    byName: [],
    usingDefaults: false,
  };
  const pillOf = (html: string) =>
    html.match(/data-model-row="xai\/grok-4.7"[\s\S]*?×<\/button><\/span>/)?.[0] ?? "";

  /** The words a pill's name is described by, ahead of the board's instruction, in order. */
  const describedBy = (html: string, key: string) => {
    const pill =
      html.match(new RegExp(`data-model-row="${key}"[\\s\\S]*?<\\/span><\\/span>`))?.[0] ?? "";
    const ids = pill.match(/fm-models-chip-name"[^>]*aria-describedby="([^"]+)"/)?.[1] ?? "";
    return ids
      .split(" ")
      .map((id) =>
        id === "models-board-hint"
          ? "hint"
          : (html.match(new RegExp(`id="${id}" hidden="">([^<]*)</span>`))?.[1] ?? "?"),
      );
  };

  it("reads a new model's provider, its new mark and its note first in its pill's description", () => {
    const html = render(slots);
    expect(describedBy(html, "xai/grok-4.7")).toEqual([
      `Grok, new. ${newModelNote({ slots: ["medium"] })}`,
      "hint",
    ]);
    // A description by reference leaves aria-description unread, so none is set.
    expect(pillOf(html)).not.toContain('aria-description="Grok');
    expect(pillOf(html)).not.toContain("title=");
  });

  // INF-94: Not in use is where the note's "not in use" is true, so a new
  // model there carries it too, as the "new" mark it explains does.
  it("reads a new model's note on its pill in Not in use", () => {
    const html = render({
      models: [
        {
          provider: "xai",
          providerLabel: "Grok",
          id: "grok-4.7",
          label: "Grok 4.7",
          slots: [],
          isNew: true,
        },
      ],
      byName: [],
      usingDefaults: false,
    });
    expect(html.indexOf('data-model-row="xai/grok-4.7"')).toBeGreaterThan(
      html.indexOf('data-slot-group="off"'),
    );
    expect(describedBy(html, "xai/grok-4.7")).toEqual([
      `Grok, new. ${newModelNote({ slots: [] })}`,
      "hint",
    ]);
  });

  it("reads a placed model's provider in its pill's description", () => {
    const html = render({
      models: [
        {
          provider: "xai",
          providerLabel: "Grok",
          id: "grok-4.7",
          label: "Grok 4.7",
          slots: ["medium"],
        },
      ],
      byName: [],
      usingDefaults: false,
    });
    expect(describedBy(html, "xai/grok-4.7")).toEqual(["Grok", "hint"]);
  });

  it("says the × takes the model from that level only in its description", () => {
    const pill = pillOf(render(slots));
    expect(pill).toContain('aria-label="Remove Grok 4.7 from medium"');
    expect(pill).toContain(`aria-description="${removeFromLevelOnly("medium")}"`);
  });
});

// INF-910 direction A applies to every shared board chip, without renaming its controls.
describe("ModelsSection - muted provider display", () => {
  it("separates provider words in every level and Not in use, preserving full accessible names", () => {
    const models: ModelSlotsView["models"] = [
      {
        provider: "anthropic-claude",
        providerLabel: "Claude",
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        slots: ["premium", "high", "medium", "low"],
      },
      {
        provider: "openai-codex",
        providerLabel: "Codex",
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        slots: [],
      },
      { provider: "xai", providerLabel: "Grok", id: "grok-4.7", label: "Grok 4.7", slots: [] },
      {
        provider: "openrouter",
        providerLabel: "OpenRouter",
        id: "anthropic/claude-fable-latest",
        label: "Anthropic: Claude Fable Latest",
        slots: [],
      },
    ];
    const html = render({ models, byName: [], usingDefaults: false });
    expect(
      html.match(/<span>Claude<\/span><span class="fm-models-chip-label">Fable 5.1<\/span>/g),
    ).toHaveLength(4);
    expect(html.match(/aria-label="Claude Fable 5.1"/g)).toHaveLength(4);
    for (const [provider, label] of [
      ["Codex", "GPT-6 Astra"],
      ["Grok", "4.7"],
      ["OpenRouter", "Anthropic: Claude Fable Latest"],
    ]) {
      expect(html).toContain(
        `<span>${provider}</span><span class="fm-models-chip-label">${label}</span>`,
      );
    }
    expect(html).toContain('aria-label="Remove Claude Fable 5.1 from premium"');
  });

  it("renders a provider-only label once without empty model text and retains its pinned star", () => {
    const slots: ModelSlotsView = {
      models: [
        {
          provider: "anthropic-claude",
          providerLabel: "Claude",
          id: "claude",
          label: "Claude",
          slots: ["high"],
        },
      ],
      byName: [],
      usingDefaults: false,
    };
    const html = render(slots);
    expect(html).toContain("<span>Claude</span>");
    expect(html).not.toContain('<span class="fm-models-chip-label"></span>');
    const pinned = render(slots, DECISIONS, {
      ...ROUTING,
      pins: [{ provider: "claude", id: "claude" }],
    });
    expect(pinned).toContain('aria-label="Claude ✱"');
    expect(pinned).toContain('<span class="fm-models-chip-label"> ✱</span>');
  });
});
