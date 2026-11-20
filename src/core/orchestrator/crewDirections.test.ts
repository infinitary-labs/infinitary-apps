/**
 * What a crewmate's conversation holds of its standing directions
 * (`crewDirections.ts`), at the one rule no turn test reaches cheaply: a
 * conversation whose folds the host cannot hear - one held on a computer
 * that does not list `conversation-folds` - is served the set on every turn.
 * INF-2599, the captain: "Send a crewmate its directions once, and again
 * only when they change"; a fold the home never hears would otherwise leave
 * that crewmate without them.
 */

import { describe, expect, it } from "vitest";
import { renderDirections } from "../knowledge/directions";
import { handedDirections, heardDirections, servesDirections } from "./crewDirections";

const BLOCK =
  renderDirections([
    {
      id: "review-once",
      kind: "direction",
      text: "Do not re-review a task only because main moved.",
      scope: "repo-meter",
      scopeName: "meter",
      origin: "captain-turn",
      authority: "instruction",
      revision: 1,
      updatedAt: 1_762_400_000_000,
    },
  ]) ?? "";

describe("a crewmate conversation's standing directions", () => {
  it("serves a conversation whose folds go unheard on every turn, and holds a read one whose folds are heard", () => {
    const served = `Count the long presses too.\n\n${BLOCK}`;
    const read = heardDirections(handedDirections("conversation-1", BLOCK, served), {
      type: "request_started",
    });
    expect(read?.read).toBe(true);
    expect(servesDirections(read, "conversation-1", BLOCK, false)).toBe(true);
    expect(servesDirections(read, "conversation-1", BLOCK, true)).toBe(false);
  });
});
