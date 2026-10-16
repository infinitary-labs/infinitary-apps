import { describe, expect, it } from "vitest";
import { workRequests } from "./work";

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
});
