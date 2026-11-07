import type { CardAction } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { bridgeActionIds } from "./bridgeActions";

/**
 * The gate the sanitizer's removal came with (captain decision, 2026-09-15):
 * a card body may raise its card's plain actions, never the ones the host
 * runs. The body is agent-authored and runs its own script at mount, so an
 * effect reachable from there would merge a PR the captain had not read.
 */
describe("which actions a card body may raise", () => {
  const actions: CardAction[] = [
    { id: "merge-pr55", label: "Merge PR", effect: { kind: "merge", after: "close" } },
    { id: "discard", label: "Discard", effect: { kind: "settle", mode: "discard" } },
    { id: "open-subs", label: "Subscriptions", effect: { kind: "open", target: "subscriptions" } },
    { id: "retry", label: "Retry", effect: { kind: "host", op: "retry-firstmate" } },
    { id: "explain", label: "Explain more", keepsOpen: true },
    { id: "await-queue", label: "Await the queue", default: true },
  ];

  it("withholds every effect-bearing id and keeps the replies to the author", () => {
    expect(bridgeActionIds(actions)).toEqual(["explain", "await-queue"]);
  });

  it("withholds an id when any action sharing it carries an effect", () => {
    expect(
      bridgeActionIds([
        { id: "land", label: "Land", effect: { kind: "merge", after: "close" } },
        { id: "land", label: "Ask the author" },
      ]),
    ).toEqual([]);
  });
});
