import { describe, expect, it } from "vitest";
import { placedSecretsSchema, workRequests } from "./work";

describe("what a computer that runs work tells its home", () => {
  const events = workRequests["inf:work:events"].request;
  const told = (event: unknown) =>
    events.safeParse([{ task: "t1", events: [{ seq: 1, at: 1, event }] }]);

  it("carries the optional card continuity declaration without adding it to ordinary cards", () => {
    const request = workRequests["inf:work:card"].request;
    const ordinary = { title: "A round", body: "<p>Choose.</p>", actions: [] };
    const read = (card: unknown) => request.safeParse([{ task: "t1", callId: "c1", card }]);
    expect(read({ ...ordinary, holdsPlace: true }).data?.[0].card).toEqual({
      ...ordinary,
      holdsPlace: true,
    });
    expect(read(ordinary).data?.[0].card).not.toHaveProperty("holdsPlace");
    expect(read({ ...ordinary, holdsPlace: "true" }).success).toBe(false);
  });

  it("carries a browser handoff's sign-in mark to the home", () => {
    const request = workRequests["inf:work:card"].request;
    const handoff = {
      site: "app.notion.example",
      reason: "The settings open only with your sign-in.",
      after: "I read the settings list.",
      signIn: true,
    };
    const card = { title: "Sign in once", body: "<p>Sign in.</p>", actions: [] };
    const read = request.safeParse([
      { task: "t1", callId: "c1", card: { ...card, browserHandoff: handoff } },
    ]);
    expect(read.data?.[0].card.browserHandoff).toEqual(handoff);
  });

  it("carries an owner-only input read witness without exposing the message", () => {
    const read = { type: "input_read", textSha256: "message-fingerprint" };
    expect(told(read).data?.[0].events[0]?.event).toEqual(read);
    expect(told({ type: "input_read" }).success).toBe(false);
  });

  it("carries the model now answering, with the fallback that moved it (FI3-967)", () => {
    const moved = {
      type: "model_served",
      model: { provider: "anthropic-claude", id: "claude-opus-4-8" },
      fallback: {
        from: { provider: "anthropic-claude", id: "claude-opus-5-5" },
        category: "cyber",
      },
    };
    expect(told(moved).data?.[0].events[0]?.event).toEqual(moved);
    expect(
      told({ type: "model_served", model: { provider: "anthropic-claude", id: "claude-opus-5-5" } })
        .success,
    ).toBe(true);
    expect(told({ type: "model_served" }).success).toBe(false);
  });

  // Source: R6 of INF-1644: a same-major work computer may run a build whose hold registry differs.
  it("carries a recovery way whose hold the home's build does not know", () => {
    const report = workRequests["inf:work:report"].request;
    const way = {
      action: "Push one more repair",
      approach: "workaround",
      hold: "repairs",
      evidence: "The checks failed on the same version",
      nextFact: "Read the next check result",
    };
    const read = report.safeParse([
      {
        task: "t1",
        callId: "c1",
        text: "The checks still fail.",
        declared: { recoveryWays: [way] },
      },
    ]);
    expect(read.data?.[0].declared?.recoveryWays).toEqual([way]);
    expect(
      report.safeParse([
        {
          task: "t1",
          callId: "c1",
          text: "The checks still fail.",
          declared: { recoveryWays: [{ ...way, hold: "" }] },
        },
      ]).success,
    ).toBe(false);
  });
});

// INF-3042: home answers are open; later additive metadata must not hide the catalog.
it("reads known Secrets metadata while ignoring later answer fields", () => {
  const secret = { ref: "planning", label: "Planning calendar", version: "2", environment: "Work" };
  expect(
    placedSecretsSchema.parse({ secrets: [{ ...secret, rotation: "manual" }], revision: 3 }),
  ).toEqual({ secrets: [secret] });
  expect(placedSecretsSchema.safeParse({ secrets: [{ ...secret, version: null }] }).success).toBe(
    false,
  );
});
