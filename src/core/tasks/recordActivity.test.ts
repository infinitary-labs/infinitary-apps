import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { DROP_BEFORE_START, DROPPED_BEFORE_START_ACTIVITY } from "@shared/recordDrop";
import { type TaskEventView, taskEventKindSchema } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { CREWMATE_TAB_STEER_LEAD } from "../orchestrator/captainWakes";
import { renderWake, replyWordsSpan, type TypedWake } from "../orchestrator/wakes";
import { ACTIVITY_PLACES, condenseActivity, reportHeadline } from "./recordActivity";

let id = 0;
function event(
  kind: TaskEventView["kind"],
  text: string,
  data: Record<string, unknown> | null = null,
  actor: TaskEventView["actor"] = "host",
): TaskEventView {
  id += 1;
  return { id, at: id * 1000, actor, kind, text, data, ref: null, feed: false };
}

const label = (model: string) => (model === "openai/gpt-6-sol" ? "GPT-6 Sol" : model);
const read = (events: TaskEventView[]) =>
  condenseActivity(events, label).map((row) => [row.kind, row.text]);
/** Each row with the words folded under it. */
const folds = (events: TaskEventView[]) =>
  condenseActivity(events, label).map((row) => [
    row.text,
    (row.folded ?? []).map((line) => line.text),
  ]);

describe("the record's condensed activity", () => {
  it("keeps check facts without a separate current verdict while leaving old event data intact (INF-1555 F12)", () => {
    const checks = {
      headSha: "pr604-version",
      absenceDeclared: false,
      items: [{ name: "unit-tests", state: "failure" }],
    };
    const events = [
      event("ci", "CI red", { ci: "red", checks, crewVerdict: "ready" }),
      event("ci", "CI red", { ci: "red", checks, crewVerdict: "red" }),
    ];
    expect(read(events)).toEqual([["ci", "Checks: failed."]]);
    expect(events.map((event) => event.data?.crewVerdict)).toEqual(["ready", "red"]);
  });

  it("folds host chores and non-terminal status under the row they led to, keeping what the crew and the captain said", () => {
    const events = [
      event("note", "a warm working copy was reused"),
      event("briefed", "Complete pinned scope with long card and report history"),
      event("note", "left a note for the captain", null, "crewmate"),
      event("status", "starting", { gate: null }),
      event("status", "held until the reset", { gate: { kind: "quota-reset" } }),
      event("ask", "how is it going?", null, "captain"),
      event("status", "dropped - not needed", { status: "dropped", reason: "cancelled" }),
    ];
    expect(read(events)).toEqual([
      ["note", "left a note for the captain"],
      ["ask", "how is it going?"],
      ["status", "dropped - not needed"],
    ]);
    expect(folds(events)).toEqual([
      ["left a note for the captain", ["a warm working copy was reused"]],
      ["how is it going?", ["starting", "held until the reset"]],
      ["dropped - not needed", []],
    ]);
  });

  it("shows a note its writer declared news and folds one declared bookkeeping, whoever wrote it", () => {
    expect(
      folds([
        event("dispatched", "crewmate 3 started", { assignee: "crewmate 3" }),
        event("note", "a fresh working copy of main at 1a2b3c4", { news: false }),
        event("note", "The captain approved merging #977 at 9f8e7d6.", { news: true }),
        event("note", "Cannot merge #977: it has a conflict.", { news: true, problem: "conflict" }),
        event("status", "done", { status: "done", reason: "merged" }),
        event("note", "working copy removed", { news: false }),
      ]),
    ).toEqual([
      ["crewmate 3 started.", []],
      [
        "The captain approved merging #977 at 9f8e7d6.",
        ["a fresh working copy of main at 1a2b3c4"],
      ],
      ["Cannot merge #977: it has a conflict.", []],
      // What no row followed yet folds under the newest one.
      ["done", ["working copy removed"]],
    ]);
  });

  it("reads a reply the captain typed under a card as the captain's words and the card's title", () => {
    const reply: TypedWake = {
      facts: {
        kind: "thread-reply",
        card: { id: "card-7", title: "The Mac check failed again" },
        words: "merge the fix first, then rerun it",
      },
    };
    const text = renderWake(reply);
    const steer = (data: Record<string, unknown>) => event("steered", text, data, "captain");
    const words = replyWordsSpan(reply);
    expect(words).toBeDefined();
    const titles = (cardId: string) =>
      cardId === "card-7" ? "The Mac check failed again" : undefined;
    expect(
      condenseActivity(
        [
          steer({ via: "thread", cardId: "card-7", words }),
          steer({ via: "thread", cardId: "card-gone", words }),
          // Recorded before the span was: the whole message still reads.
          steer({ via: "thread", cardId: "card-7" }),
        ],
        label,
        { cardTitle: titles },
      ).map((row) => row.text),
    ).toEqual([
      'You replied under "The Mac check failed again": merge the fix first, then rerun it',
      "You replied under a card: merge the fix first, then rerun it",
      text,
    ]);
    // Any other steer has no span: the record reads its message.
    expect(replyWordsSpan("Rebase on main first.")).toBeUndefined();
  });

  it("reads a line the captain typed in the Crewmate tab as his own words", () => {
    const typed: TypedWake = {
      facts: { kind: "crewmate-tab-line", words: "keep the toggle reachable with Tab" },
    };
    const text = renderWake(typed);
    const words = replyWordsSpan(typed);
    // The crewmate is told it was typed in the tab, then his words verbatim.
    expect(text.startsWith(CREWMATE_TAB_STEER_LEAD)).toBe(true);
    expect(words && text.slice(words.from, words.to)).toBe("keep the toggle reachable with Tab");
    expect(
      condenseActivity(
        [event("steered", text, { via: CREWMATE_TAB_VIA, cardId: null, words }, "captain")],
        label,
      ).map((row) => row.text),
    ).toEqual(["You told the crewmate: keep the toggle reachable with Tab"]);
  });

  it("names the panel a move came from, when a panel made it on the captain's click (FI3-1014 piece 4)", () => {
    expect(
      read([
        event(
          "note",
          "You queued this task. It starts by itself when nothing holds it.",
          { startPolicy: "when-ready", via: "task-card", panel: "Task desk" },
          "captain",
        ),
        event(
          "note",
          "You moved this task back to the backlog. It waits for your word.",
          { startPolicy: "on-request", via: "task-card" },
          "captain",
        ),
      ]),
    ).toEqual([
      [
        "note",
        "You queued this task. It starts by itself when nothing holds it. From the Task desk panel.",
      ],
      ["note", "You moved this task back to the backlog. It waits for your word."],
    ]);
  });

  it("says a move to another model by the models' names, and why when the backend moved it (FI3-967)", () => {
    const named = (model: string) =>
      ({
        "anthropic-claude/claude-opus-5-5": "Claude Opus 5.5",
        "anthropic-claude/claude-opus-4-8": "Claude Opus 4.8",
      })[model] ?? model;
    expect(
      condenseActivity(
        [
          event("note", "moved from claude-opus-5-5 to claude-opus-4-8 after ...", {
            servedModel: "anthropic-claude/claude-opus-4-8",
            from: "anthropic-claude/claude-opus-5-5",
            fallback: { from: "anthropic-claude/claude-opus-5-5", category: "cyber" },
          }),
          event("note", "moved from claude-opus-4-8 to claude-opus-5-5", {
            servedModel: "anthropic-claude/claude-opus-5-5",
            from: "anthropic-claude/claude-opus-4-8",
          }),
        ],
        named,
      ).map((row) => row.text),
    ).toEqual([
      "Moved from Claude Opus 5.5 to Claude Opus 4.8 after Claude Opus 5.5's safeguards stopped a reply.",
      "Moved from Claude Opus 4.8 to Claude Opus 5.5.",
    ]);
  });

  it("reads a captain drop of unstarted work as who closed it, from the typed fact", () => {
    expect(
      read([
        event(
          "status",
          "dropped - No longer wanted",
          { status: "dropped", reason: "cancelled", [DROP_BEFORE_START]: true },
          "captain",
        ),
      ]),
    ).toEqual([["status", DROPPED_BEFORE_START_ACTIVITY]]);
  });

  it("reads historical check results and folds repeats without reviving an allowance", () => {
    const events = [
      event("pr_opened", "Pushed the branch fm/task-ab12 to origin", {
        changeLabel: "fm/task-ab12",
      }),
      event("ci", "CI red", { ci: "red", ciRounds: 1 }),
      event("ci", "CI red", { ci: "red", ciRounds: 1 }),
      event("ci", "CI no-pr", { ci: "no-pr" }),
      event("ci", "CI pending", { ci: "pending" }),
      event("ci", "CI red", { ci: "red", ciRounds: 2 }),
    ];
    expect(read(events)).toEqual([
      ["pr_opened", "Pushed the branch fm/task-ab12."],
      ["ci", "The checks failed on branch fm/task-ab12, recorded round 1."],
      ["ci", "The checks are running on branch fm/task-ab12."],
      ["ci", "The checks failed on branch fm/task-ab12, recorded round 2."],
    ]);
    expect(folds(events)[2]?.[1]).toEqual([
      "The checks failed on branch fm/task-ab12, recorded round 1.",
      "The checks failed on branch fm/task-ab12.",
    ]);
  });

  it("says a pull request merged outside the app as that, not as a check result", () => {
    expect(
      read([
        event("pr_opened", "PR #23", { changeLabel: "#23", prNumber: 23 }),
        event("ci", "CI green", { ci: "green" }),
        event("ci", "CI merged", { ci: "merged" }),
      ]),
    ).toEqual([
      ["pr_opened", "Opened pull request #23."],
      ["ci", "The checks passed on pull request #23."],
      ["ci", "The pull request #23 was merged outside the app."],
    ]);
  });

  it("folds the progress line just before a report under it, and reads the report as its headline", () => {
    const events = [
      event("dispatched", "crewmate 3 started", { assignee: "crewmate 3", model: null }),
      event("note", "dependencies installed", { news: false }),
      event("progress", "Tests pass; writing it up.", null, "crewmate"),
      event("report", "Intent\nFix it.\nWhat changed\nFixed the search. More.", {}, "crewmate"),
      event("progress", "Rebased.", null, "crewmate"),
      event("report", "Rebased and green.", { summary: "Rebased; green again." }, "crewmate"),
    ];
    expect(read(events)).toEqual([
      ["dispatched", "crewmate 3 started."],
      ["report", "Fixed the search."],
      ["report", "Rebased; green again."],
    ]);
    // The report no longer hides the update before it.
    expect(folds(events)).toEqual([
      ["crewmate 3 started.", []],
      ["Fixed the search.", ["dependencies installed", "Tests pass; writing it up."]],
      ["Rebased; green again.", ["Rebased."]],
    ]);
  });

  it("folds what the crewmate did under the row it led to, and what it did since under the newest row", () => {
    const events = [
      event("dispatched", "crewmate 3 started", { assignee: "crewmate 3" }),
      event("progress", "The journey opens the panel too early.", null, "crewmate"),
      event("progress", "Passes alone; running it three times.", null, "crewmate"),
      event("report", "It passed three runs.", { summary: "It passed three runs." }, "crewmate"),
    ];
    const [dispatched, found, rerun, report] = events.map((each) => each.at) as [
      number,
      number,
      number,
      number,
    ];
    const did = (at: number, text: string) => ({ at, text });
    const actions = [
      did(dispatched + 100, "Read the failing journey's log"),
      did(found + 100, "Edited tests/e2e/knowledge-references.spec.ts"),
      did(rerun + 100, "Run the journey three times in a row"),
      did(report, "Push the branch"),
      did(report + 100, "Open the pull request's page"),
    ];
    const rows = condenseActivity(events, label, { actions });
    expect(
      rows.map((row) => [
        row.text,
        (row.folded ?? []).map((line) => line.text),
        (row.actions ?? []).map((line) => line.text),
      ]),
    ).toEqual([
      ["crewmate 3 started.", [], []],
      ["The journey opens the panel too early.", [], ["Read the failing journey's log"]],
      // The update the report restates folds under it, and so does what led to that update.
      [
        "It passed three runs.",
        ["Passes alone; running it three times."],
        [
          "Edited tests/e2e/knowledge-references.spec.ts",
          "Run the journey three times in a row",
          "Push the branch",
          "Open the pull request's page",
        ],
      ],
    ]);
  });

  it("marks the words that name a pull request with a page, on the task's own lines and a linked task's", () => {
    const page = "https://github.com/o/r/pull/965";
    const events = [
      event("pr_opened", "opened #965", { prNumber: 965, changeLabel: "#965", prUrl: page }),
      event("ci", "CI red", { ci: "red" }),
      event("progress", "Fixed the lint the checks found on #965.", null, "crewmate"),
      event("progress", "Read #9650 and #977 for context.", null, "crewmate"),
      event("merged", `Merged #965 on GitHub. ${page}`, { status: "done", reason: "merged" }),
    ];
    const waitedOn = {
      ...event("merged", "merged", { prNumber: 977 }),
      from: {
        id: "other",
        key: "FI3-9",
        change: "#977",
        changeUrl: "https://github.com/o/r/pull/977",
      },
      relation: "blocker" as const,
    };
    const rows = condenseActivity(events, label, { concerned: [waitedOn] });
    const linked = rows.map((row) => [
      row.text,
      row.change && row.text.slice(row.change.from, row.change.to),
      row.change?.url,
    ]);
    expect(linked).toEqual([
      ["Opened pull request #965.", "pull request #965", page],
      ["The checks failed on pull request #965.", "pull request #965", page],
      ["Fixed the lint the checks found on #965.", "#965", page],
      // Another number, or the number inside a longer one, is not this pull request.
      ["Read #9650 and #977 for context.", undefined, undefined],
      // The host's receipt names the pull request once, linked, not its address.
      ["Merged pull request #965.", "pull request #965", page],
      [
        "FI3-9, which this task waits for, merged pull request #977.",
        "pull request #977",
        "https://github.com/o/r/pull/977",
      ],
    ]);
  });

  it("links no pull request without a page on the web, nor a branch a plain Git host keeps", () => {
    for (const data of [
      { prNumber: 12, changeLabel: "#12" },
      { prNumber: 12, changeLabel: "#12", prUrl: "http://example.test/pull/12" },
      { changeLabel: "fm/task-ab12" },
    ]) {
      const rows = condenseActivity([event("pr_opened", "opened", data)], label);
      expect(rows.map((row) => row.change)).toEqual([undefined]);
    }
  });

  it("folds what the crewmate did only under the task's own rows, never under another task's", () => {
    const events = [
      event("dispatched", "crewmate 3 started", { assignee: "crewmate 3" }),
      event("progress", "Reading the log.", null, "crewmate"),
    ];
    const [started, reading] = events.map((each) => each.at) as [number, number];
    const blocker = {
      ...event("merged", "merged", { prNumber: 9 }),
      at: started + 10,
      from: { id: "other", key: "FI3-9" },
      relation: "blocker" as const,
    };
    const rows = condenseActivity(events, label, {
      concerned: [blocker],
      actions: [
        { at: started + 5, text: "Read the log" },
        { at: reading + 5, text: "Run the tests" },
      ],
    });
    expect(rows.map((row) => [row.kind, row.actions?.map((line) => line.text)])).toEqual([
      ["dispatched", undefined],
      ["merged", undefined],
      ["progress", ["Read the log", "Run the tests"]],
    ]);
  });

  it("prefers a report's own summary, re-reading one stored with its Intent heading", () => {
    const report =
      "**Intent:** find tasks by key.\n**What changed:** Search reads keys. Tests too.";
    expect(reportHeadline(report, "Search reads keys now.")).toBe("Search reads keys now.");
    expect(reportHeadline(report, "**Intent:** find tasks by key.")).toBe("Search reads keys.");
    expect(reportHeadline(report, null)).toBe("Search reads keys.");
    expect(reportHeadline("Done. All green.", undefined)).toBe("Done.");
  });

  it("leaves out only the evidence: every other event is a row or folds under one, once", () => {
    // Every kind, in every shape its typed facts can take here.
    const shapes: [
      TaskEventView["kind"],
      Record<string, unknown> | null,
      TaskEventView["actor"],
    ][] = [];
    for (const kind of taskEventKindSchema.options) {
      shapes.push([kind, null, "host"], [kind, null, "crewmate"]);
    }
    shapes.push(
      ["note", { news: true }, "host"],
      ["note", { news: false }, "crewmate"],
      ["note", { servedModel: "openai/gpt-6-sol" }, "host"],
      ["status", { status: "done" }, "host"],
      ["status", { status: "dropped", [DROP_BEFORE_START]: true }, "captain"],
      ["ci", { ci: "green" }, "host"],
      ["ci", { ci: "green" }, "host"],
      ["ci", { ci: "no-pr" }, "host"],
      ["progress", null, "crewmate"],
      ["report", { summary: "Done." }, "crewmate"],
      ["steered", { words: { from: 0, to: 3 }, cardId: "c" }, "captain"],
      ["pr_opened", { prNumber: 4 }, "crewmate"],
    );
    // Each order: as listed, reversed, minor events first, and minor events alone.
    const minor = shapes.filter(([kind, data]) => ACTIVITY_PLACES[kind] === "folded" && !data);
    const rest = shapes.filter((shape) => !minor.includes(shape));
    const orders = [shapes, [...shapes].reverse(), [...minor, ...rest], minor];
    for (const order of orders) {
      const events = order.map(([kind, data, actor]) => event(kind, `${kind} text`, data, actor));
      // What the crewmate did: before each event, at some, and after the last.
      const actions = events.flatMap(({ at }, index) => [
        { at: at - 500, text: `action ${index} before` },
        ...(index % 3 === 0 ? [{ at, text: `action ${index} at` }] : []),
      ]);
      actions.push({ at: (events.at(-1)?.at ?? 0) + 500, text: "action after" });
      const rows = condenseActivity(events, label, { cardTitle: () => "A card", actions });
      const read = rows.flatMap((row) => [row.id, ...(row.folded ?? []).map((line) => line.id)]);
      const kept = events.filter((each) => ACTIVITY_PLACES[each.kind] !== "evidence");
      expect([...read].sort((a, b) => a - b)).toEqual(kept.map((each) => each.id));
      // Each action folds once, in time order, under a row recorded at or after it.
      expect(rows.flatMap((row) => row.actions ?? [])).toEqual(actions);
      for (const row of rows.slice(0, -1)) {
        for (const action of row.actions ?? []) expect(action.at).toBeLessThanOrEqual(row.at);
      }
    }
  });

  it("gives every kind the place the table in docs/task-record.md gives it", () => {
    const doc = readFileSync(join(__dirname, "../../../docs/task-record.md"), "utf8");
    const section = doc.slice(doc.indexOf("## What Activity holds"));
    const table = Object.fromEntries(
      [...section.matchAll(/^\| `([a-z_]+)` \| (row|folded|evidence) \|/gm)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    expect(table).toEqual(ACTIVITY_PLACES);
  });
});
