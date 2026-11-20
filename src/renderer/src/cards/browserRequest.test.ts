import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { card, DECIDE } from "../app/storeTestKit";
import { dockedCardOf, dockedRequestShown } from "./browserRequest";

/**
 * The docked request leads with its steps: the captain chose to leave its
 * "You asked" line off, since the column's room after a reply held only the
 * title and that line (INF-4587).
 */
describe("dockedRequestShown", () => {
  it("draws the crewmate's words without the You asked line or its choices", () => {
    const request = card({
      id: "sign-in",
      status: "ready",
      body: "<ol><li>Choose Team.</li></ol>",
      asked: { kind: "asked", text: "sign in to the account page", at: 1 },
    });
    const shown = dockedRequestShown(request);
    expect(shown.asked).toBeUndefined();
    expect(shown.actions).toEqual([]);
    expect(shown.body).toBe(request.body);
  });
});

const door = (overrides: Partial<Card> = {}): Card =>
  card({
    id: "try",
    status: "ready",
    actions: DECIDE,
    author: "crewmate",
    taskId: "t1",
    attachment: { kind: "browser", label: "Try it", taskId: "t1", session: "run-1", generation: 2 },
    ...overrides,
  });
const request = card({
  id: "ask",
  status: "ready",
  actions: DECIDE,
  author: "crewmate",
  taskId: "t1",
  attachment: {
    kind: "browser",
    label: "Open browser",
    taskId: "t1",
    session: "run-1",
    generation: 2,
    handoff: true,
  },
});
const raised = card({ id: "changed", status: "ready", author: "crewmate", taskId: "t1" });
/** Its crewmate ended it: it no longer docks. */
const ENDED: NonNullable<Card["ended"]> = {
  by: "crewmate",
  at: 3,
  line: "Its crewmate ended this card.",
};
const fromDoor = { cardId: "try", session: "run-1", generation: 2 };

/**
 * INF-4578's direction A, piece 3: a card that opens the browser through its
 * own button docks beside the page, and so does a card the task raises
 * while the Browser tab is shown.
 */
describe("dockedCardOf", () => {
  it("docks the card whose own browser button opened the view, and a project page's door too", () => {
    expect(dockedCardOf([door()], { browserTaskId: "t1", browserFrom: fromDoor })).toEqual({
      card: door(),
      request: false,
    });
    const play = door({
      attachment: { kind: "page", label: "Play", taskId: "t1", path: "index.html" },
    });
    expect(
      dockedCardOf([play], { browserTaskId: "t1", browserFrom: { cardId: "try" } })?.card,
    ).toBe(play);
  });

  it("docks the newest card raised while the view showed over the door, and the door once it is gone", () => {
    const entry = { browserTaskId: "t1", browserFrom: fromDoor, browserArrived: "changed" };
    expect(dockedCardOf([door(), raised], entry)?.card).toBe(raised);
    const ended: Card = { ...raised, ended: ENDED };
    expect(dockedCardOf([door(), ended], entry)?.card.id).toBe("try");
  });

  it("keeps a request's own rule and docks nothing for a card of another task or one that ended", () => {
    expect(
      dockedCardOf([request, raised], {
        browserTaskId: "t1",
        browserFrom: { cardId: "ask", session: "run-1", generation: 2 },
        browserArrived: "changed",
      }),
    ).toEqual({ card: request, request: true });
    // A request naming an older browser docks nothing, as before.
    expect(
      dockedCardOf([request], {
        browserTaskId: "t1",
        browserFrom: { cardId: "ask", session: "run-1", generation: 1 },
      }),
    ).toBeUndefined();
    // From the record, the task's open request docks.
    expect(dockedCardOf([request], { browserTaskId: "t1" })).toEqual({
      card: request,
      request: true,
    });
    expect(dockedCardOf([door()], { browserTaskId: "t2", browserFrom: fromDoor })).toBeUndefined();
    const closed = door({ ended: ENDED });
    expect(dockedCardOf([closed], { browserTaskId: "t1", browserFrom: fromDoor })).toBeUndefined();
  });
});
