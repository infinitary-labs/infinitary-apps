import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { placedTaskFolders } from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import {
  api,
  model,
  placed,
  png,
  type Step,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { PlacedTasks } from "./placedTasks";
import { PLACED_REQUEST_WAIT_MS } from "./toolWait";

/**
 * A crewmate's conversation held on a computer that runs work
 * (`tests/helpers/sessionHostWorld.ts`): how long a callback waits for the home, and a tool withdrawn when Claude gives up.
 */

sessionHostHooks();

describe("a conversation held on a computer that runs work", () => {
  // Intent: the captain's F2 backstop withdraws a Claude give-up callback even before our deadline.
  it("withdraws a tool when Claude gives up, and never resends it on return (INF-312 F2)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Wait for this report." } }] },
      { text: "Checking what happened before asking again." },
    ]);
    const from = api.requests.length;
    try {
      await at.order("inf:session:prompt", [
        { orderId: "provider-abort", task: TASK, text: "Report." },
      ]);
      await report.reached;
      await at.stopHome();
      controller.abort(new Error("The provider stopped waiting"));
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("conversation stopped waiting");
      await at.startHome();
      await at.inReach();
      report.open();
      await at.ended(1);
      expect(at.home.asked.filter((request) => request.channel === "inf:work:report")).toHaveLength(
        1,
      );
      console.info(
        "Claude give-up: callback withdrawn without advancing the 24-day timer; no resend on return.",
      );
    } finally {
      report.open();
    }
  });

  /** A saved-story completion card, the shape a crewmate's merge decision takes. */
  const completionCard: Step = {
    tools: [
      {
        name: "emit_card",
        args: {
          title: "Review this change",
          presentation: 1,
          actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
        },
      },
    ],
  };

  // Intent: review d0c421b2 F2: a completion refusal is an independent fact, not part of the cancelled tool.
  it("records a refused completion outside its cancelled invocation (INF-312 review)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.open();
    // The card asks after the events before it, so held here it never goes out.
    const events = at.home.hold("inf:work:events");
    model([completionCard, { text: "The completion was refused." }]);
    try {
      await at.order("inf:session:prompt", [
        { orderId: "refusal-cancel", task: TASK, text: "Show the review." },
      ]);
      await events.reached;
      await expect
        .poll(() =>
          new PlacedTasks(at.dataDir)
            .outbox(TASK, 0)
            .some((record) => record.event.type === "tool_start"),
        )
        .toBe(true);
      controller.abort(new Error("Claude stopped waiting"));
      events.open();
      await expect
        .poll(
          () =>
            at.home.effects.filter((effect) => effect.channel === "inf:work:card-refused").length,
        )
        .toBe(1);
      await at.ended(1);
      expect(at.home.asked.filter((request) => request.channel === "inf:work:card")).toEqual([]);
      expect(
        at.home.effects.find((effect) => effect.channel === "inf:work:card-refused")?.request
          .refusal,
      ).toMatchObject({ title: "Review this change", why: expect.stringContaining("not sent") });
    } finally {
      events.open();
    }
  });

  // Intent: INF-370 R1 - a completion card whose request went out may already be up, so it is not recorded as refused.
  it.each(["Claude gives up", "the 24 days pass"])(
    "records no refusal for a completion card the home may already show when %s (INF-370 R1)",
    async (cause) => {
      const controller = new AbortController();
      const at = await placed({ toolSignal: controller.signal });
      await at.open();
      const card = at.home.hold("inf:work:card");
      model([completionCard, { text: "Checking whether the card is up." }]);
      const from = api.requests.length;
      try {
        if (cause === "Claude gives up") {
          await at.order("inf:session:prompt", [
            { orderId: "unknown-card", task: TASK, text: "Show the review." },
          ]);
          await card.reached;
          controller.abort(new Error("Claude stopped waiting"));
        } else {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
          try {
            await at.order("inf:session:prompt", [
              { orderId: "unknown-card", task: TASK, text: "Show the review." },
            ]);
            await card.reached;
            await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
          } finally {
            vi.useRealTimers();
          }
        }
        await expect
          .poll(() =>
            JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
          )
          .toContain("may already be done");
        // The home shows it after the conversation stopped waiting.
        card.open();
        await at.ended(1);
        expect(at.home.effects.filter((effect) => effect.channel === "inf:work:card")).toHaveLength(
          1,
        );
        expect(
          at.home.asked.filter((request) => request.channel === "inf:work:card-refused"),
        ).toEqual([]);
      } finally {
        card.open();
      }
    },
  );

  // Intent: review d0c421b2 F1/F5: name a reachable check for changes and call a read a request.
  it.each([
    {
      channel: "inf:work:github-write",
      name: "github_write",
      args: { method: "POST", path: "/repos/fixture/site/issues", body: "{}" },
      words: "Read the affected item where your project lives",
    },
    {
      channel: "inf:work:tasks",
      name: "tasks",
      args: {},
      words: "the request was sent, but its answer did not arrive",
    },
    { channel: "inf:work:events", name: "tasks", args: {}, words: "the request was not sent" },
  ])(
    "explains an unanswered $channel accurately (INF-312 review)",
    async ({ channel, name, args, words }) => {
      const at = await placed();
      await at.open();
      const held = at.home.hold(channel);
      model([{ tools: [{ name, args }] }, { text: "Checking before asking again." }]);
      const from = api.requests.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await at.order("inf:session:prompt", [
          { orderId: `words:${name}`, task: TASK, text: "Check it." },
        ]);
        await held.reached;
        await expect
          .poll(() =>
            new PlacedTasks(at.dataDir)
              .outbox(TASK, 0)
              .some((record) => record.event.type === "tool_start"),
          )
          .toBe(true);
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
      } finally {
        vi.useRealTimers();
        held.open();
      }
      await at.ended(1);
      const transcript = JSON.stringify(
        api.requests.slice(from).map((request) => request.body.messages),
      );
      expect(transcript).toContain(words);
      if (name === "tasks") expect(transcript).not.toContain("the change was not sent");
    },
  );

  // Intent: INF-339 F1, the accepted limit covers a whole card callback, not each transfer.
  it("does not reset a card's deadline when one picture arrives between two absences (INF-312)", async () => {
    const day = PLACED_REQUEST_WAIT_MS / 24;
    const at = await placed({ retryMs: [day] });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    writeFileSync(join(folders.evidence, "first.png"), png());
    writeFileSync(join(folders.evidence, "second.png"), png(5));
    const first = at.home.hold("inf:work:picture");
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "Two pictures",
              body: ["first.png", "second.png"]
                .map((name) => `<img src="${join(folders.evidence, name)}" alt="${name}">`)
                .join(""),
            },
          },
        ],
      },
      { text: "Checked before showing the card again." },
    ]);
    const from = api.requests.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      await at.order("inf:session:prompt", [
        { orderId: "multipart-deadline", task: TASK, text: "Show it." },
      ]);
      await first.reached;
      const start = Date.now();
      const advanceToDay = (number: number) =>
        vi.advanceTimersByTimeAsync(Math.max(0, start + number * day - Date.now()));
      // The home opens again, and the computer reaches it at its next retry,
      // which only the advance here fires. The clock holds still meanwhile:
      // left advancing with real time, under load it can fire a retry due just
      // after the return first, and the advance then fires that attempt's own
      // dial or welcome timeout instead, a day before the next retry (INF-435).
      const returnHome = async () => {
        vi.setTimerTickMode("manual");
        try {
          await at.startHome();
          await vi.advanceTimersToNextTimerAsync();
          await at.inReach();
        } finally {
          vi.setTimerTickMode("interval");
        }
      };
      await at.stopHome();
      await advanceToDay(9);
      await returnHome();
      await advanceToDay(10);
      first.open();
      const second = at.home.hold("inf:work:picture");
      await second.reached;
      expect(
        at.home.effects.filter((effect) => effect.channel === "inf:work:picture"),
      ).toHaveLength(1);
      await at.stopHome();
      await advanceToDay(24);
      // The model hears the refusal at the original deadline, not 24 days after the first answer.
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("was not sent");
      expect(
        JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
      ).not.toContain("may already be done");
      await advanceToDay(29);
      await returnHome();
      await advanceToDay(30);
      second.open();
      await at.ended(1);
      expect(at.home.effects.filter((effect) => effect.channel === "inf:work:card")).toHaveLength(
        0,
      );
      console.info(
        "Multipart recovery: one picture answered on day 10; callback expired at day 24; no card on return at day 30.",
      );
    } finally {
      vi.useRealTimers();
      first.open();
    }
  });
});
