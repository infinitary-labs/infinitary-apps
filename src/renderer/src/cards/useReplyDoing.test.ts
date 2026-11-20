import type { CardMessage } from "@shared/cards";
import type { TaskActivityRow } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { replyDoing } from "./useReplyDoing";

// INF-990 friction 3: replies asking INF-799's and INF-887's crewmates for
// code changes went 41 and 26 minutes with no sign of work. The thread's
// working row names what the crewmate does on the reply; the rows and
// words are INF-799's own (its reply at 7:27 PM, about 40 commands after).
const asked = new Date("2026-10-22T19:27:02-07:00").getTime();
const reply: CardMessage = {
  id: 7,
  cardId: "card-c7c984b8-1",
  who: "captain",
  text: "rename review to audit, research to deep research, and run the Haiku 5.5 evaluations",
  at: asked,
};
const brief: TaskActivityRow = {
  id: 1,
  at: asked - 3_600_000,
  kind: "progress",
  text: "Brief: rename the review and research modes.",
  actions: [{ at: asked - 600_000, text: "Ran pnpm typecheck" }],
};
const steer: TaskActivityRow = { id: 2, at: asked, kind: "steered", text: reply.text };

describe("what the crewmate is doing on the captain's reply", () => {
  it("names its newest action since the captain's reply", () => {
    const working = {
      ...steer,
      actions: [{ at: asked + 120_000, text: "Rename review to audit in the mode list" }],
    };
    expect(replyDoing({ activityLog: [brief, working] }, [reply])).toBe(
      "Rename review to audit in the mode list",
    );
  });

  it("names nothing before its first doing since the reply, so an older one never stands as work on it", () => {
    expect(replyDoing({ activityLog: [brief, steer] }, [reply])).toBeUndefined();
  });

  it("names nothing on a thread the captain has not written in, or before the record is read", () => {
    expect(replyDoing({ activityLog: [brief] }, [])).toBeUndefined();
    expect(replyDoing(undefined, [reply])).toBeUndefined();
  });
});
