import type { FmEvent } from "@shared/events";
import { expect, it } from "vitest";
import { eventBatch } from "./eventBatch";

// INF-1348, accepted “All three”: a housekeeping pass announces once,
// preserving every feed line and transition rather than dropping news.
it("carries a pass in one message, in order, without losing the next pass", async () => {
  const sent: FmEvent[][] = [];
  const batch = eventBatch((events) => sent.push(events));
  const first: FmEvent = { type: "firstmate_note", text: "The review is ready." };
  const counts: FmEvent = { type: "crew_counts", working: 0, idle: 1, queued: 0 };
  const second: FmEvent = { type: "firstmate_note", text: "The checks passed." };
  batch.add(first);
  batch.add(counts);
  batch.add(second);
  expect(sent).toEqual([]);
  await Promise.resolve();
  expect(sent).toEqual([[first, counts, second]]);
  batch.add(counts);
  await Promise.resolve();
  expect(sent).toEqual([[first, counts, second], [counts]]);
});

it("flushes before another channel without duplicating or reordering announcements", async () => {
  const sent: (FmEvent[] | string)[] = [];
  const batch = eventBatch((events) => sent.push(events));
  const event: FmEvent = { type: "firstmate_note", text: "The review is ready." };
  batch.add(event);
  batch.flush();
  sent.push("cards");
  batch.add(event);
  await Promise.resolve();
  expect(sent).toEqual([[event], "cards", [event]]);
});
