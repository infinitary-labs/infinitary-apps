import { describe, expect, it } from "vitest";
import type { StarAskRecord } from "../../shared/releaseTracking";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { recordStarPageOpened, type StarAskFacts, starAskDue } from "./starAsk";

/**
 * The star ask's rules, as the captain chose them on INF-6429: after three
 * finished tasks, at most three times, 30 or more days apart, and never
 * again once the github.com sign-in shows a star or the page was opened.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 18);

const due = (facts: Partial<Omit<StarAskFacts, "ask">> & { ask?: Partial<StarAskRecord> } = {}) =>
  starAskDue({
    listsChanges: true,
    thirdCrewmateDoneAt: NOW - 10 * DAY,
    githubSignedIn: false,
    now: NOW,
    ...facts,
    ask: { shownAt: [], openedAt: null, star: null, ...facts.ask },
  });

describe("whether a note carries the ask", () => {
  it("does for a person whose crew finished three tasks and who was never asked", () => {
    expect(due()).toBe(true);
  });

  it("does not on a note that lists no changes, or before the crew's third finished task", () => {
    expect(due({ listsChanges: false })).toBe(false);
    expect(due({ thirdCrewmateDoneAt: undefined })).toBe(false);
  });

  it("waits 30 days after the last ask, and stops after three", () => {
    expect(due({ ask: { shownAt: [NOW - 29 * DAY] } })).toBe(false);
    expect(due({ ask: { shownAt: [NOW - 30 * DAY] } })).toBe(true);
    expect(due({ ask: { shownAt: [NOW - 90 * DAY, NOW - 60 * DAY] } })).toBe(true);
    expect(due({ ask: { shownAt: [NOW - 120 * DAY, NOW - 90 * DAY, NOW - 60 * DAY] } })).toBe(
      false,
    );
  });

  it("stops for good once the project was starred or its page opened", () => {
    expect(due({ ask: { star: { starred: true, readAt: NOW - DAY } } })).toBe(false);
    expect(due({ ask: { openedAt: NOW - 40 * DAY } })).toBe(false);
  });

  it("with a GitHub sign-in, waits for the sign-in's answer and follows it", () => {
    expect(due({ githubSignedIn: true })).toBe(false);
    expect(due({ githubSignedIn: true, ask: { star: { starred: false, readAt: NOW } } })).toBe(
      true,
    );
  });
});

describe("opening the project's page", () => {
  it("keeps the first visit", () => {
    const settings = new SettingsStore(openInMemoryDatabase());
    recordStarPageOpened(settings, NOW);
    recordStarPageOpened(settings, NOW + DAY);
    expect(settings.getReleaseTracking().starAsk).toEqual({
      shownAt: [],
      openedAt: NOW,
      star: null,
    });
  });
});
