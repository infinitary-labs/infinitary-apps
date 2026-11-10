import { expect, it } from "vitest";
import { historyBreak } from "../scripts/shipped-queue-history";
import { GITHUB_QUEUE_SOURCES, GITLAB_QUEUE_SOURCES } from "../src/core/queue/shipped";

// INF-3443: a branch that started before the default branch appended a
// queue version, and changed no version list, was refused as having
// rewritten history; the local check now compares it with where it started.
// The lists are the default branch's real published history.
const published = GITHUB_QUEUE_SOURCES;
const older = published.slice(0, -1);
// A real hash the GitHub list does not hold, as a branch's own new version.
const own = GITLAB_QUEUE_SOURCES.at(-1) as string;

it("accepts a branch that started before the default branch's newest version and left its list alone", () => {
  expect(historyBreak(older, published, older)).toBeUndefined();
});

it("accepts a branch that appends a version after everything it and the default branch hold", () => {
  expect(historyBreak([...published, own], published, published)).toBeUndefined();
  // A pull request's merged result started from the default branch itself.
  expect(historyBreak([...older, own], older, older)).toBeUndefined();
});

it("refuses a branch that drops a version it started from, though the list matches an older default branch", () => {
  expect(historyBreak(older, published, published)).toEqual({
    kind: "rewrote",
    version: published.length,
  });
});

it("refuses a branch that rewrites a version it started from", () => {
  const rewritten = older.map((sha, index) => (index === 1 ? own : sha));
  expect(historyBreak(rewritten, published, older)).toEqual({ kind: "rewrote", version: 2 });
});

it("refuses an older branch whose own new version takes one the default branch has since published", () => {
  expect(historyBreak([...older, own], published, older)).toEqual({
    kind: "taken",
    version: published.length,
  });
});
