import { describe, expect, it } from "vitest";
import { shownCard } from "./stack";
import { card, DECIDE } from "./storeTestKit";

describe("shownCard", () => {
  it("picks the card at cardIndex among visible cards", () => {
    const stack = [
      card({ id: "n1", status: "ready", title: "One", body: "a" }),
      card({ id: "n2", status: "ready", actions: DECIDE, title: "Two", body: "b" }),
    ];
    expect(shownCard(stack, 0)?.id).toBe("n1");
    expect(shownCard(stack, 1)?.id).toBe("n2");
    expect(shownCard(stack, 9)?.id).toBe("n2");
  });
});
