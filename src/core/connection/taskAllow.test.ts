import { cardSchema } from "@shared/cards";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";
import { firstmatePauseCard } from "../orchestrator/hostCards";
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

// INF-4104 piece 2, the captain's ruling on its review: an older desktop
// reads a host effect's operation strictly, so the home leaves the Keep
// going on credits button off every card it sends a view that does not
// list the change, in pushes and in the list and show answers; a desktop
// listing it and the phone, which reads the operation as text, get it.
it("sends the Keep going on credits button only to views that read it", async () => {
  const card = cardSchema.parse({
    ...firstmatePauseCard("card-firstmate-paused", {
      pause: "no_headroom",
      body: "<p>Claude has used up its allowance until 9:00 PM.</p>",
      accountId: "claude-personal",
      providerName: "Claude",
      credits: { usedPercent: 12 },
    }),
    createdAt: 1000,
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:cards:list") return [card];
      if (channel === "inf:cards:show") return card;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: PROTOCOL_VERSION,
    changes: ["keep-going-on-credits"],
  });
  const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
  const ids = (value: unknown) =>
    (value as { actions: { id: string }[] }).actions.map((action) => action.id);
  const without = ["recheck-allowance", "open-settings"];
  expect(ids((await old.invoke("inf:cards:list", []))[0])).toEqual(without);
  expect(ids(await old.invoke("inf:cards:show", [card.id]))).toEqual(without);
  expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
  expect(await current.invoke("inf:cards:show", [card.id])).toEqual(card);
  expect((await phone.invoke("inf:cards:list", []))[0]).toEqual(card);
  at.events.emit("inf:cards", [card]);
  const oldPush = await old.push((push) => push.channel === "inf:cards");
  expect(ids((oldPush.payload as unknown[])[0])).toEqual(without);
  expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  expect((await phone.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
  await old.close();
  await current.close();
  await phone.close();
});
