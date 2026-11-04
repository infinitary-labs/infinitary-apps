import { test } from "vitest";
import { quietMessagesStory } from "./quietMessages";

/** INF-1968 and INF-2217 in the dark look (./quietMessages.ts). */
test("quiet messages brighten to read without changing the cyan mark or layout in dark", async () => {
  await quietMessagesStory("dark");
});
