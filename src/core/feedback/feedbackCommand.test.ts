import { FEEDBACK_LINK_MAX } from "@shared/feedback";
import type { FeedbackAskFacts } from "@shared/writeAsk";
import { describe, expect, it } from "vitest";
import type { FeedbackDiagnostics } from "./diagnostics";
import { type FeedbackHost, taskFeedback } from "./feedbackCommand";

/**
 * Intent: the approved /feedback plan's draft - the host checks the words,
 * adds the typed diagnostics and the hidden mark, and keeps the draft for
 * the captain's click with a GitHub sign-in, or answers a filled-in
 * new-issue link of at most 8,000 characters without one. Nothing is sent
 * here: the one effect is keeping a write. The facts are shaped as a Mac
 * with a phone and a long-running task reads them.
 */
const FACTS: FeedbackDiagnostics = {
  app: { version: "0.8.6-alpha.23", channel: "alpha", install: "app", language: "en" },
  system: { name: "macOS", release: "25.2.0", chip: "arm64" },
  computers: [{ system: "macOS", version: "0.8.6-alpha.23" }],
  phones: [{ version: "0.8.6" }],
  models: ["anthropic", "openai-codex", "anthropic"],
  projectHosts: ["github", "github", "this computer"],
  task: {
    kind: "work",
    status: "active",
    care: "careful",
    steps: Array.from({ length: 300 }, (_, index) => ({
      minute: index * 1.5,
      kind: index % 3 === 0 ? "progress" : index % 3 === 1 ? "card_raised" : "tool_call",
    })),
  },
};

const WORDS = [
  "## What happened",
  "",
  "I replied under a merge card while its checks were running. The reply box lost focus after the first word, and the next keys moved between cards instead.",
  "",
  "## What I expected",
  "",
  "The reply box keeps focus until I send or press Escape.",
].join("\n");

function host(signedIn: boolean) {
  const kept: Array<{ taskId: string; path: string; body: string; feedback: FeedbackAskFacts }> =
    [];
  const fake: FeedbackHost = {
    repository: "infinitary-labs/infinitary-apps",
    diagnostics: (taskKey) =>
      taskKey === undefined
        ? { ...FACTS, task: undefined }
        : taskKey === "INF-812"
          ? FACTS
          : { unknownTask: taskKey },
    held: async () => [{ kind: "sign-in", value: "mtorres-dev" }],
    signedIn: () => signedIn,
    searchIssues: async () => [],
    keep: (taskId, write) => {
      kept.push({ taskId, ...write });
      return `ask-${kept.length}`;
    },
  };
  return { fake, kept };
}

describe("the feedback command's draft", () => {
  it("keeps the exact issue for the click, with the diagnostics and the mark", async () => {
    const { fake, kept } = host(true);
    const answer = await taskFeedback(fake, "task-1").draft({
      kind: "bug",
      title: "Reply box loses focus while checks run",
      body: WORDS,
      task: "INF-812",
    });
    expect(answer.refused).toBeUndefined();
    expect(answer.data).toMatchObject({ ask: "ask-1" });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      taskId: "task-1",
      path: "/repos/infinitary-labs/infinitary-apps/issues",
      feedback: { kind: "bug", title: "Reply box loses focus while checks run" },
    });
    const sent = JSON.parse(kept[0]?.body ?? "{}") as { title: string; body: string };
    expect(sent.title).toBe("Reply box loses focus while checks run");
    expect(sent.body.startsWith(WORDS)).toBe(true);
    expect(sent.body).toContain("- App: Infinitary 0.8.6-alpha.23 · alpha · app · en");
    expect(sent.body).toContain("- Model connections: anthropic, openai-codex");
    expect(sent.body).toContain("- Project hosts: github ×2, this computer");
    expect(sent.body).toContain("- Task: work · active · careful");
    expect(
      sent.body
        .trimEnd()
        .endsWith("<!-- infinitary-feedback v1 kind=bug version=0.8.6-alpha.23 -->"),
    ).toBe(true);
  });

  it("keeps a comment on a close match instead of a new issue", async () => {
    const { fake, kept } = host(true);
    await taskFeedback(fake, "task-1").draft({
      kind: "bug",
      title: "Reply box loses focus while checks run",
      body: WORDS,
      commentOn: 412,
    });
    expect(kept[0]?.path).toBe("/repos/infinitary-labs/infinitary-apps/issues/412/comments");
    expect(Object.keys(JSON.parse(kept[0]?.body ?? "{}"))).toEqual(["body"]);
    expect(kept[0]?.feedback.commentOn).toBe(412);
  });

  it("refuses words holding a personal detail and keeps nothing", async () => {
    const { fake, kept } = host(true);
    const answer = await taskFeedback(fake, "task-1").draft({
      kind: "bug",
      title: "Focus lost for mtorres-dev",
      body: WORDS,
    });
    expect(answer.refused).toBe("refused");
    expect(answer.text).toContain('- sign-in: "mtorres-dev"');
    expect(kept).toEqual([]);
  });

  it("answers a filled-in link of at most 8,000 characters without a sign-in, shortening the steps first", async () => {
    const { fake, kept } = host(false);
    // Long enough that the task's every step no longer fits beside it.
    const words = `${WORDS}\n\n${"Each reply after that lost focus the same way. ".repeat(145)}`;
    const answer = await taskFeedback(fake, "task-1").draft({
      kind: "idea",
      title: "Let me pin a card",
      body: words,
      task: "INF-812",
    });
    expect(kept).toEqual([]);
    const link = String(answer.data?.link);
    expect(link.length).toBeLessThanOrEqual(FEEDBACK_LINK_MAX);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/infinitary-labs/infinitary-apps/issues/new",
    );
    expect(url.searchParams.get("title")).toBe("Let me pin a card");
    const body = url.searchParams.get("body") ?? "";
    const steps = (text: string) =>
      (/- Steps \(minute: kind\): (.*)/.exec(text)?.[1] ?? "").split(", ").filter(Boolean).length;
    // The words go whole; the earliest steps went to fit, the full draft keeps every one.
    expect(body.startsWith(words.trim())).toBe(true);
    expect(body).not.toContain("The rest was too long for a link");
    expect(steps(String(answer.data?.body))).toBe(300);
    expect(steps(body)).toBeLessThan(300);
    expect(steps(body)).toBeGreaterThan(0);
    expect(body).toContain("kind=idea");
  });

  it("cuts long words with a note when even no steps leave room", async () => {
    const { fake } = host(false);
    const long = `${WORDS}\n\n${"The card moved again after the checks finished. ".repeat(400)}`;
    const answer = await taskFeedback(fake, "task-1").draft({
      kind: "bug",
      title: "Cards move after checks finish",
      body: long,
    });
    const link = String(answer.data?.link);
    expect(link.length).toBeLessThanOrEqual(FEEDBACK_LINK_MAX);
    const body = new URL(link).searchParams.get("body") ?? "";
    expect(body).toContain("The rest was too long for a link");
    expect(body).toContain("<!-- infinitary-feedback v1 kind=bug");
  });

  it("refuses words longer than GitHub takes for an issue and keeps nothing", async () => {
    const { fake, kept } = host(true);
    const answer = await taskFeedback(fake, "task-1").draft({
      kind: "bug",
      title: "Cards move after checks finish",
      body: "The card moved again after the checks finished. ".repeat(1400),
    });
    expect(answer.refused).toBe("invalid");
    expect(kept).toEqual([]);
  });

  it("refuses a task the record does not hold", async () => {
    const { fake } = host(true);
    const answer = await taskFeedback(fake, "task-1").diagnostics({ task: "INF-9" });
    expect(answer.refused).toBe("invalid");
  });
});
