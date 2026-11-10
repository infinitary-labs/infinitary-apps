import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it } from "vitest";
import { integrationApprovalCard } from "../orchestrator/integrationApprovalCard";
import { frameWithoutTaskAllow, readsTaskAllow } from "./taskAllow";

// INF-2993: a view that does not list `integration-task-allow` reads a
// request_write's choices strictly, so the home leaves Allow for the rest of
// this task off every card it sends that view, which shows the other three.
describe("a card frame for a view without Allow for the rest of this task (INF-2993)", () => {
  const ask: IntegrationAsk = {
    id: "pulls",
    kind: "integration",
    integration: "github",
    connection: "c-github",
    place: "GitHub",
    action: "write",
    label: "Change something on GitHub",
    description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
    effect: "changes",
    reason: "Open the proof pull request the task asks for.",
    signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
    input: JSON.stringify({ method: "POST", path: "/repos/octo/queue-proof-4ca5/pulls" }),
    scope: {
      key: "POST /repos/octo/queue-proof-4ca5",
      words: "POST requests to octo/queue-proof-4ca5",
    },
    at: 1,
  };

  it("leaves that button off a pushed card and passes every other frame as it is", () => {
    const card = integrationApprovalCard(ask, {
      id: "task-1",
      title: "Open the proof pull request",
    });
    const frame = JSON.stringify({ channel: "inf:cards:changed", payload: { cards: [card] } });
    const sent = JSON.parse(frameWithoutTaskAllow(frame));
    expect(
      sent.payload.cards[0].actions.map(
        (action: { effect: { integration: string } }) => action.effect.integration,
      ),
    ).toEqual(["deny", "once", "always"]);
    expect(sent.payload.cards[0].title).toBe(card.title);
    const { scope: _none, ...unscoped } = ask;
    const other = JSON.stringify({
      channel: "inf:cards:changed",
      payload: { cards: [integrationApprovalCard(unscoped, { id: "task-1", title: "t" })] },
    });
    expect(frameWithoutTaskAllow(other)).toBe(other);
  });
});

// INF-3042: the major absorbs the named addition; older views still negotiate it.
it("recognizes task-wide Allow by major or the older advertised name", () => {
  expect(readsTaskAllow("15.0.0", [])).toBe(true);
  expect(readsTaskAllow("14.0.0", ["integration-task-allow"])).toBe(true);
  expect(readsTaskAllow("14.0.0", [])).toBe(false);
});
