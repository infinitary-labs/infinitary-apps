import { describe, expect, it } from "vitest";
import { changesFeed, feedLineFrom, feedRelativeAge } from "./feed";

/**
 * A line's English as Activity saved it, without the fact it keeps beside
 * it (docs/i18n.md, "Saved facts"; INF-3674's piece 3): the fact is
 * `src/shared/i18n/said.test.ts`'s, the words are this test's.
 */
const english = (line: ReturnType<typeof feedLineFrom>) => {
  if (!line) return line;
  const { said: _said, ...words } = line;
  return words;
};

describe("feedRelativeAge", () => {
  const now = 1_700_000_000_000;

  it("prints the same buckets the activity trail uses", () => {
    expect(feedRelativeAge(now, now)).toBe("now");
    expect(feedRelativeAge(now - 59_000, now)).toBe("now");
    expect(feedRelativeAge(now - 60_000, now)).toBe("1m");
    expect(feedRelativeAge(now - 3 * 60_000, now)).toBe("3m");
    expect(feedRelativeAge(now - 59 * 60_000, now)).toBe("59m");
    expect(feedRelativeAge(now - 60 * 60_000, now)).toBe("1h");
    expect(feedRelativeAge(now - 5 * 60 * 60_000, now)).toBe("5h");
    expect(feedRelativeAge(now - 24 * 60 * 60_000, now)).toBe("1d");
  });

  it("does not go negative when the clock is behind the line", () => {
    expect(feedRelativeAge(now + 10_000, now)).toBe("now");
  });
});

describe("authored Activity text", () => {
  it.each([
    "fm/task-42 is the branch to keep.",
    "src/index.ts contains the fix.",
    "pnpm test passed.",
    "iOS is the target.",
  ])("keeps deliberate lowercase names rather than applying a display transform: %s", (text) => {
    expect(english(feedLineFrom({ type: "firstmate_note", text }))?.text).toBe(text);
  });

  it("preserves a device's lowercase name", () => {
    expect(
      english(feedLineFrom({ type: "device_left", deviceId: "d1", name: "mini", kind: "work" }))
        ?.text,
    ).toBe("mini left.");
  });
});

describe("catalog action actor trail", () => {
  it("names whoever made the change, without claiming a captain click was Firstmate's", () => {
    expect(
      english(feedLineFrom({ type: "personalized", actor: "captain", text: "notifications off" })),
    ).toEqual({ kind: "info", text: "Captain · notifications off" });
    expect(
      english(feedLineFrom({ type: "personalized", actor: "firstmate", text: "notifications on" })),
    ).toEqual({ kind: "info", text: "First mate · notifications on" });
    expect(
      english(feedLineFrom({ type: "personalized", text: "switched to the light theme" }))?.text,
    ).toBe("First mate · personalized: switched to the light theme");
  });

  it("writes a settled run's step as a line and its withdrawal as none, and both change the feed", () => {
    const step = {
      type: "personalized" as const,
      actor: "captain" as const,
      text: "window wash 48% → 76%",
      run: { id: "run-1" },
    };
    expect(english(feedLineFrom(step))).toEqual({
      kind: "info",
      text: "Captain · window wash 48% → 76%",
    });
    expect(changesFeed(step)).toBe(true);
    const withdrawn = { ...step, run: { id: "run-1", withdrawn: true } };
    expect(english(feedLineFrom(withdrawn))).toBeNull();
    expect(changesFeed(withdrawn)).toBe(true);
    expect(changesFeed({ type: "past_card_shown", cardId: "card-1" })).toBe(false);
  });
});

describe("project setup actor trail", () => {
  it("attributes new setup and preserves historical un-attributed feed lines", () => {
    const event = {
      type: "repo_setup" as const,
      repoId: "site",
      name: "site",
      path: "/site",
      kind: "adopt" as const,
    };
    expect(english(feedLineFrom({ ...event, actor: "captain" }))?.text).toBe(
      "Captain · Project site · linked",
    );
    expect(english(feedLineFrom({ ...event, actor: "firstmate", kind: "clone" }))?.text).toBe(
      "First mate · Project site · cloned",
    );
    expect(english(feedLineFrom(event))?.text).toBe("Project site · linked");
  });
});

describe("a computer signed out of one of its own subscriptions", () => {
  const signedOut = { type: "device_signed_out", deviceId: "d1", who: "Mac mini" } as const;

  it("says so, and for Claude whether Firstmate signed out the login it made there", () => {
    expect(english(feedLineFrom({ ...signedOut, provider: "Codex" }))).toEqual({
      kind: "info",
      text: "Mac mini is signed out of Codex.",
    });
    expect(
      english(feedLineFrom({ ...signedOut, provider: "Claude", login: "signed-out" })),
    ).toEqual({
      kind: "info",
      text: "Infinitary signed Mac mini out of the Claude login it made.",
    });
    expect(english(feedLineFrom({ ...signedOut, provider: "Claude", login: "kept" }))).toEqual({
      kind: "info",
      text: "Infinitary stopped using Mac mini's Claude login. It stays, since Infinitary did not make it.",
    });
    expect(
      english(feedLineFrom({ ...signedOut, provider: "Claude", login: "not-signed-out" })),
    ).toEqual({
      kind: "warn",
      text: "Infinitary stopped using Mac mini's Claude login, but could not sign it out.",
    });
  });
});
