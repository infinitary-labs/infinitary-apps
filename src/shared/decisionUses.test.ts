import { describe, expect, it } from "vitest";
import { DEFAULT_DECISIONS, type DecisionsSettings } from "./decisions";
import {
  DECISION_APPROVAL_VERSION,
  DECISION_FIRST_APPROVAL_VERSION,
  DECISION_USES,
  type DecisionUse,
  decisionUse,
  decisionUseSwitchedOn,
  decisionUsesView,
} from "./decisionUses";

/** A person who turned Jev on, at the approval screen they saw. */
function jevApproved(version: number): DecisionsSettings {
  return {
    ...DEFAULT_DECISIONS,
    answerer: { kind: "native", id: "jev" },
    egress: { jev: { enabled: true, consentedVersion: version } },
  };
}

function byId(view: ReturnType<typeof decisionUsesView>) {
  return Object.fromEntries(view.map((use) => [use.id, use]));
}

describe("decision model uses", () => {
  it("keeps task classification on and locked, and starts every default-on use on", () => {
    // Intent: the captain asked that mandated uses such as task
    // classification show their switch locked, and that most uses default on.
    const fresh = byId(decisionUsesView(DEFAULT_DECISIONS, {}));
    expect(fresh.kind).toMatchObject({ name: "Task classification", kind: "always-on", on: true });
    expect(fresh["reply-checks"]).toMatchObject({ kind: "default-on", on: true });
    // The uses INF-4000 added wait for the person's own OK (below).
    expect(fresh["event-screen"]).toMatchObject({ kind: "needs-ok", on: false });
    expect(fresh["card-reader"]).toMatchObject({ kind: "needs-ok", on: false });
    expect(Object.keys(fresh)).toEqual(DECISION_USES.map((use) => use.id));

    const switchedOff = byId(
      decisionUsesView(DEFAULT_DECISIONS, {
        kind: { on: false },
        "reply-checks": { on: false },
      }),
    );
    expect(switchedOff.kind?.on).toBe(true);
    expect(switchedOff["reply-checks"]?.on).toBe(false);
  });

  it("holds a use an older Jev or OpenRouter approval predates until the person allows it once", () => {
    // Intent: the captain asked that people who turned Jev or OpenRouter on
    // under the old approval screen get reply checks off until they consent,
    // while new approvals cover every use.
    const old = byId(decisionUsesView(jevApproved(DECISION_FIRST_APPROVAL_VERSION), {}));
    expect(old.kind).toMatchObject({ on: true, needsApproval: false });
    expect(old["reply-checks"]).toMatchObject({ on: false, needsApproval: true });

    const openRouterOld: DecisionsSettings = {
      ...DEFAULT_DECISIONS,
      answerer: { kind: "openrouter", model: "typesafe/jev-1.13" },
      egress: { openrouter: { enabled: true, consentedVersion: DECISION_FIRST_APPROVAL_VERSION } },
    };
    expect(byId(decisionUsesView(openRouterOld, {}))["reply-checks"]).toMatchObject({
      on: false,
      needsApproval: true,
    });

    const current = byId(decisionUsesView(jevApproved(DECISION_APPROVAL_VERSION), {}));
    expect(current["reply-checks"]).toMatchObject({ on: true, needsApproval: false });

    // The person's own models answer under no approval of their own.
    const own = {
      ...jevApproved(DECISION_FIRST_APPROVAL_VERSION),
      answerer: DEFAULT_DECISIONS.answerer,
    };
    expect(byId(decisionUsesView(own, {}))["reply-checks"]).toMatchObject({
      on: true,
      needsApproval: false,
    });
  });

  it("keeps a use that needs its own OK off until that disclosure is agreed", () => {
    // Intent: the captain asked that a use needing the person's agreement
    // start off and turn on only after its disclosure is shown; INF-4000's
    // event screen is the first listed use of that kind.
    const use = decisionUse("event-screen");
    if (!use?.disclosure) throw new Error("the event screen is listed with its disclosure");
    const version = use.disclosure.version;
    expect(decisionUseSwitchedOn(use, {})).toBe(false);
    expect(decisionUseSwitchedOn(use, { [use.id]: { on: true } })).toBe(false);
    expect(decisionUseSwitchedOn(use, { [use.id]: { on: true, agreed: version } })).toBe(true);
    expect(decisionUseSwitchedOn(use, { [use.id]: { on: false, agreed: version } })).toBe(false);
    // Until agreed, Settings is handed the disclosure for the consent dialog.
    expect(byId(decisionUsesView(DEFAULT_DECISIONS, {}))["event-screen"]?.disclosure).toEqual({
      version,
      text: [...use.disclosure.text],
    });
    expect(
      byId(decisionUsesView(DEFAULT_DECISIONS, { [use.id]: { on: true, agreed: version } }))[
        "event-screen"
      ],
    ).toMatchObject({ on: true });
  });
});
