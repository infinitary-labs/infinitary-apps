import { inLanguage } from "@shared/i18n/current";
import { wordedCardText, wordSaidMarks } from "@shared/i18n/said";
import { describe, expect, it } from "vitest";
import {
  ANSWER_ONLY_REFUSED_TOOLS,
  actionTookEffect,
  type DeliveryEntry,
  judgeDelivery,
  noticeCard,
  noticeCardId,
  parseDeliveryFacts,
} from "./answerDelivery";

const at = 1;
const did = (
  kind: Extract<DeliveryEntry, { outcome: "action" }>["kind"],
  tool = "tool",
): DeliveryEntry => ({ outcome: "action", kind, tool, at });
const refusedCard = (reason: "crewmate-owns" | "card-refused" = "card-refused"): DeliveryEntry => ({
  outcome: "refused",
  tool: "emit_card",
  reason,
  at,
});

describe("what took effect after a message", () => {
  it.each([
    ["a card shown or revised", [did("card", "emit_card")]],
    ["closing words written in a card's replies", [did("reply")]],
    ["work started", [did("work", "spawn_crewmate")]],
    ["work steered, including a steer saved for a held account", [did("work", "steer_crewmate")]],
    ["a setting or operation recorded", [did("record", "update_task")]],
    ["a card closed", [did("close", "close_card")]],
    ["a reaction", [did("reaction", "emote")]],
    ["a reaction before a card was refused", [did("reaction"), refusedCard()]],
    ["a refused card and then a card shown", [refusedCard(), did("card", "emit_card")]],
    ["a refused card and then work steered", [refusedCard(), did("work")]],
  ])("counts %s", (_name, entries) => {
    expect(actionTookEffect(entries)).toBe(true);
  });

  it.each([
    ["nothing at all", []],
    ["a refused card", [refusedCard()]],
    ["a reaction after a refused card", [refusedCard("crewmate-owns"), did("reaction", "emote")]],
  ])("does not count %s", (_name, entries) => {
    expect(actionTookEffect(entries)).toBe(false);
  });
});

describe("the verdict for one message", () => {
  it("covers a pending, held or retrying message that has an action", () => {
    for (const state of ["pending", "held", "retrying"] as const) {
      expect(judgeDelivery(state, [did("card")])).toBe("covered");
    }
  });

  it("retries an uncovered message once, then raises the notice", () => {
    expect(judgeDelivery("pending", [])).toBe("retry");
    expect(judgeDelivery("held", [refusedCard()])).toBe("retry");
    expect(judgeDelivery("retrying", [refusedCard()])).toBe("notice");
  });

  it("never judges a message already covered, unresolved or from before the check", () => {
    for (const state of ["covered", "unresolved", "legacy"] as const) {
      expect(judgeDelivery(state, [])).toBeUndefined();
    }
  });
});

describe("the saved facts", () => {
  it("reads back what it wrote, and unreadable facts as none", () => {
    const facts = {
      entries: [did("card", "emit_card"), refusedCard("crewmate-owns")],
      retryOf: "abc12345",
    };
    expect(parseDeliveryFacts(JSON.stringify(facts))).toEqual(facts);
    expect(parseDeliveryFacts(null)).toEqual({ entries: [] });
    expect(parseDeliveryFacts("not json")).toEqual({ entries: [] });
    expect(
      parseDeliveryFacts(JSON.stringify({ entries: [{ outcome: "action", kind: "magic" }] })),
    ).toEqual({ entries: [] });
  });
});

describe("the output-only retry", () => {
  it("refuses every tool that changes work or settings, and none that only shows or looks", () => {
    for (const name of [
      "spawn_crewmate",
      "steer_crewmate",
      "interrupt_crewmate",
      "settle_task",
      "create_task",
      "update_task",
      "schedule_prompt",
      "cancel_schedule",
      "remember",
      "forget",
      "app_change",
      "personalize",
      "install_plugin",
      "flag_missed_escalation",
      "flag_duplicate",
    ]) {
      expect(ANSWER_ONLY_REFUSED_TOOLS.has(name), name).toBe(true);
    }
    for (const name of [
      "emit_card",
      "close_card",
      "emote",
      "crew_status",
      "tasks",
      "locate_project",
      "app_state",
      "supervision_log",
    ]) {
      expect(ANSWER_ONLY_REFUSED_TOOLS.has(name), name).toBe(false);
    }
  });
});

describe("the one notice", () => {
  // 9:58 AM in the test's time zone, as the captain's message was sent.
  const sent = new Date(2026, 10, 23, 9, 58).getTime();
  const words = (body: string) =>
    body
      .replace(/<template[^>]*><\/template>/g, "")
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .filter(Boolean);

  it("quotes only the captain's words, escaped, under a fixed id, with Ask again as the default", () => {
    const card = noticeCard(
      "abc12345",
      'ship it <script>alert("x")</script> & go',
      [refusedCard()],
      { at: sent },
    );
    expect(card.id).toBe(noticeCardId("abc12345"));
    expect(card.title).toBe("Your first mate may have missed your message");
    expect(card.body).toContain(
      "ship it &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; go",
    );
    expect(card.body).not.toContain("<script>");
    expect(card.actions).toEqual([
      {
        id: "ask-again",
        label: "Ask again",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "ask-again", arg: "abc12345" },
      },
      { id: "leave-it", label: "Leave it" },
    ]);
  });

  it("lights the captain's message with when they sent it, then one reason and the way out", () => {
    const card = noticeCard("a", "for the apps repo", [did("card", "emit_card")], {
      at: sent,
      withdrawnCard: "The panels plan is already in the apps repo",
    });
    expect(card.body.startsWith('<blockquote class="inf-lit">')).toBe(true);
    expect(words(card.body)).toEqual([
      "Your message, 9:58 AM",
      "for the apps repo",
      "Your first mate showed you “The panels plan is already in the apps repo” for it, then closed that card before you chose.",
      "Leave it if you already have what you need. Ask again sends it once more as a new message.",
    ]);
  });

  it.each([
    [
      "a typed refusal",
      [refusedCard("crewmate-owns")],
      "crewmate working on it already owns the card",
    ],
    [
      "no card or reply at all",
      [did("close", "close_card")],
      "The app saw no card or reply from your first mate for it.",
    ],
  ])("gives its reason from %s", (_, entries, reason) => {
    expect(noticeCard("a", "hello", entries, { at: sent }).body).toContain(reason);
  });

  it("gives no reason when a card was shown that it cannot name", () => {
    const lines = words(noticeCard("a", "hello", [did("card", "emit_card")], { at: sent }).body);
    expect(lines).toEqual([
      "Your message, 9:58 AM",
      "hello",
      "Leave it if you already have what you need. Ask again sends it once more as a new message.",
    ]);
  });

  it("is worded in the language the window speaks", () => {
    const card = noticeCard("a", "hello", [], { at: sent });
    inLanguage("de", () => {
      expect(wordedCardText(card.title, card.body)).toBe(
        "Dein erster Offizier hat deine Nachricht vielleicht übersehen",
      );
      expect(wordSaidMarks(card.body)).toContain(">Deine Nachricht, ");
    });
  });
});
