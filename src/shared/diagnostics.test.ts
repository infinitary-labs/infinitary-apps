import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_EVENT_NAMES,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_FIELD_TYPES,
  DIAGNOSTIC_VERSION_FIELD,
  type DiagnosticEventSpec,
  diagnosticDataViolation,
  FTUE_MILESTONES,
} from "./diagnostics";

/**
 * The no-PII / no-UGC policy (`src/shared/diagnostics.ts`, `docs/sharing.md`
 * "The policy"), as tests over the allowlist itself. If an event ever gains
 * a free-form field, a field of a type outside enum/boolean/number, or an
 * enum whose values are not code words, these fail. The bodies each event
 * can produce are checked through the real builder in
 * `src/core/telemetry.test.ts` ("every body the allowlist can produce").
 */

/** A code word: lower snake case, short. Never text a person could have written. */
const CODE_WORD = /^[a-z][a-z0-9_]{0,31}$/;

function specOf(name: string): DiagnosticEventSpec {
  return DIAGNOSTIC_EVENTS[name as keyof typeof DIAGNOSTIC_EVENTS];
}

describe("the allowlist", () => {
  it("names every event with a code word, and the first-run funnel with ftue_", () => {
    for (const name of DIAGNOSTIC_EVENT_NAMES) expect(name).toMatch(CODE_WORD);
    expect(FTUE_MILESTONES).toEqual([
      "ftue_first_launch",
      "ftue_gate_shown",
      "ftue_signed_in",
      "ftue_first_turn",
      "ftue_first_spawn_started",
      "ftue_first_spawn_succeeded",
      "ftue_first_disposal",
    ]);
  });

  it("declares only enum, boolean and number fields - no string type exists to declare", () => {
    expect([...DIAGNOSTIC_FIELD_TYPES]).toEqual(["enum", "boolean", "number"]);
    for (const name of DIAGNOSTIC_EVENT_NAMES) {
      for (const [field, spec] of Object.entries(specOf(name).fields)) {
        expect(field).toMatch(CODE_WORD);
        expect(DIAGNOSTIC_FIELD_TYPES as readonly string[]).toContain(spec.type);
        // The version and the install ID are the builder's, never an event's own.
        expect([DIAGNOSTIC_VERSION_FIELD, "id"]).not.toContain(field);
        if (spec.type === "enum") {
          expect(spec.values.length).toBeGreaterThan(0);
          for (const value of spec.values) expect(value).toMatch(CODE_WORD);
        }
      }
    }
  });

  it("is exactly the event set the captain asked for, field by field", () => {
    const shape = Object.fromEntries(
      DIAGNOSTIC_EVENT_NAMES.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(specOf(name).fields).map(([field, spec]) => [
            field,
            spec.type === "enum" ? [...spec.values] : spec.type,
          ]),
        ),
      ]),
    );
    // Widening what leaves means changing this expectation, the alpha
    // notice and docs/sharing.md together, in review.
    expect(shape).toEqual({
      app_launch: {},
      main_agent_turn_end: { trigger: ["captain", "operation"] },
      main_agent_turn_failed: {
        trigger: ["captain", "operation"],
        reason: ["sign_in", "time_limit", "provider", "no_session", "error"],
      },
      ftue_first_launch: {},
      ftue_gate_shown: {},
      ftue_signed_in: {},
      ftue_first_turn: {},
      ftue_first_spawn_started: {},
      ftue_first_spawn_succeeded: {},
      ftue_first_disposal: {
        outcome: [
          "landed",
          "merged",
          "released",
          "answered",
          "settled",
          "finished",
          "cancelled",
          "discarded",
          "failed",
          "superseded",
        ],
      },
      // INF-2631: a phone's events, handed to its computer.
      ios_launch: { device: ["iphone", "ipad"] },
      ios_opened: { device: ["iphone", "ipad"] },
      ios_ftue_joined: { device: ["iphone", "ipad"] },
      ios_ftue_first_message: { device: ["iphone", "ipad"] },
      ios_message_sent: { device: ["iphone", "ipad"] },
      ios_card_answered: { device: ["iphone", "ipad"] },
    });
  });
});

describe("diagnosticDataViolation", () => {
  it("allows exactly the declared fields and the version", () => {
    expect(diagnosticDataViolation("app_launch", { version: "0.1.0" })).toBeNull();
    expect(
      diagnosticDataViolation("main_agent_turn_end", {
        trigger: "captain",
        version: "1.2.3-beta.1",
      }),
    ).toBeNull();
  });

  it("refuses free text, unknown fields, unknown events and a missing or odd version", () => {
    const refused: [string, unknown][] = [
      ["main_agent_turn_end", { trigger: "fix the login bug in acme-web", version: "0.1.0" }],
      ["main_agent_turn_end", { trigger: "captain", version: "0.1.0", prompt: "hello" }],
      ["main_agent_turn_end", { version: "0.1.0" }],
      ["main_agent_turn_end", { trigger: "captain" }],
      ["main_agent_turn_end", { trigger: "captain", version: "Kun's MacBook" }],
      ["main_agent_turn_end", { trigger: ["captain"], version: "0.1.0" }],
      ["app_launch", { version: "0.1.0", id: "3f2b8c1e-5a4d-4e7f-9b21-0c6d8e4f1a27" }],
      ["app_launch", { version: "0.1.0", hostname: "kuns-mac.local" }],
      ["conversation", { version: "0.1.0" }],
      ["toString", { version: "0.1.0" }],
      ["app_launch", null],
      ["app_launch", "0.1.0"],
    ];
    for (const [name, data] of refused) {
      expect(diagnosticDataViolation(name, data), `${name} ${JSON.stringify(data)}`).not.toBeNull();
    }
  });
});
