import { describe, expect, it } from "vitest";
import { CARD_MEDIA_HOST, cardMediaUrl } from "../cardPictures";
import { CARD_ANSWERS_MAX_BYTES } from "../cards";
import { APP_FRAME_SCHEME } from "../csp";
import {
  ACTION_VALUE_MAX_BYTES,
  FRAME_BRIDGE_SCRIPT,
  FRAME_BRIDGE_VERSION,
  FRAME_DEMO_SOURCE,
  FRAME_DEMO_SRC_MAX,
  FRAME_ERROR_CODES,
  frameMessageSchema,
  frameRequestSchema,
} from "./bridge";

describe("bridge v2", () => {
  it("is version 2 and exposes exactly the verbs of the contract", () => {
    expect(FRAME_BRIDGE_VERSION).toBe(2);
    for (const verb of ["subscribe", "action", "fetch", "onTheme", "stage"]) {
      expect(FRAME_BRIDGE_SCRIPT).toContain(`${verb}: function`);
    }
    // The v1 affordances agent-authored card bodies rely on stay, under
    // Infinitary's names and Firstmate 3000's (a data-fm- hook is read as
    // its data-inf- twin).
    expect(FRAME_BRIDGE_SCRIPT).toContain("window.infAction");
    expect(FRAME_BRIDGE_SCRIPT).toContain("window.fmAction");
    expect(FRAME_BRIDGE_SCRIPT).toContain("[data-inf-action]");
    expect(FRAME_BRIDGE_SCRIPT).toContain('var OTHERS = ["fm"]');
    expect(FRAME_BRIDGE_SCRIPT).toContain("Object.freeze(fm)");
    expect(FRAME_BRIDGE_SCRIPT).not.toContain("</script");
    expect(FRAME_BRIDGE_SCRIPT).toContain("document.body.getBoundingClientRect().height");
    expect(ACTION_VALUE_MAX_BYTES).toBe(4_096);
    // A footer click's answers ride the same bound as a frame value.
    expect(CARD_ANSWERS_MAX_BYTES).toBe(ACTION_VALUE_MAX_BYTES);
  });

  it("parses the closed frame-to-host envelope and nothing else", () => {
    expect(frameMessageSchema.safeParse({ fm: 2, type: "ready" }).success).toBe(true);
    expect(frameMessageSchema.safeParse({ fm: 2, type: "resize", height: 10 }).success).toBe(true);
    // A held page's drawing says so (FI3-871).
    expect(
      frameMessageSchema.safeParse({ fm: 2, type: "resize", height: 10, held: true }).success,
    ).toBe(true);
    expect(
      frameMessageSchema.safeParse({ fm: 2, type: "resize", height: 10, held: "yes" }).success,
    ).toBe(false);
    expect(frameMessageSchema.safeParse({ fm: 2, type: "link", href: "https://x" }).success).toBe(
      true,
    );
    expect(
      frameMessageSchema.safeParse({ fm: 2, type: "request", id: 1, verb: "action" }).success,
    ).toBe(true);
    expect(frameMessageSchema.safeParse({ fm: 1, type: "ready" }).success).toBe(false);
    expect(frameMessageSchema.safeParse({ type: "ready" }).success).toBe(false);
    expect(
      frameMessageSchema.safeParse({ fm: 2, type: "request", id: 0, verb: "action" }).success,
    ).toBe(false);
    expect(frameMessageSchema.safeParse({ fm: 2, type: "eval", code: "1" }).success).toBe(false);
    // The watchdog's answer carries the ping's sequence number and nothing else.
    expect(frameMessageSchema.safeParse({ fm: 2, type: "pong", seq: 3 }).success).toBe(true);
    expect(frameMessageSchema.safeParse({ fm: 2, type: "pong" }).success).toBe(false);
    // A card body's form reading (contract 4.22): the count and the answers,
    // and the `seq` of the collect it answers when it answers one.
    const reading = {
      fm: 2,
      type: "answers",
      answered: 1,
      of: 1,
      changed: 0,
      picked: 0,
      answers: [{ name: "wash", values: ["clear"], labels: ["Clear"], changed: false }],
    };
    expect(frameMessageSchema.safeParse(reading).success).toBe(true);
    expect(frameMessageSchema.safeParse({ ...reading, seq: 4 }).success).toBe(true);
    expect(frameMessageSchema.safeParse({ ...reading, answered: -1 }).success).toBe(false);
    const { picked: _picked, ...uncounted } = reading;
    expect(frameMessageSchema.safeParse(uncounted).success).toBe(false);
    expect(
      frameMessageSchema.safeParse({
        ...reading,
        answers: [{ name: "wash", values: ["clear"], changed: false, script: "x" }],
      }).success,
    ).toBe(false);
    // Words written under a Something else row (FI3-1002) ride the answer,
    // up to the field's own 500 characters.
    const written = (text: string) => ({
      ...reading,
      answers: [{ name: "wash", values: [], changed: true, written: text }],
    });
    expect(frameMessageSchema.safeParse(written("A light wash")).success).toBe(true);
    expect(frameMessageSchema.safeParse(written("x".repeat(500))).success).toBe(true);
    expect(frameMessageSchema.safeParse(written("x".repeat(501))).success).toBe(false);
    expect(frameMessageSchema.safeParse(written("")).success).toBe(false);
    // A linked task key (FI3-594): what happened on it, the key, and where
    // it sits when the pointer rests on it - a key, never free text.
    const rest = {
      fm: 2,
      type: "task",
      document: "d",
      gesture: "rest",
      key: "FI3-572",
      box: { top: 1, right: 60, bottom: 18, left: 4 },
    };
    expect(frameMessageSchema.safeParse(rest).success).toBe(true);
    expect(
      frameMessageSchema.safeParse({
        fm: 2,
        type: "task",
        document: "d",
        gesture: "open",
        key: "SCR-1",
      }).success,
    ).toBe(true);
    expect(frameMessageSchema.safeParse({ ...rest, gesture: "merge" }).success).toBe(false);
    expect(frameMessageSchema.safeParse({ ...rest, key: "fi3-572" }).success).toBe(false);
    expect(frameMessageSchema.safeParse({ ...rest, key: "FI3-572 or anything" }).success).toBe(
      false,
    );
    expect(
      frameMessageSchema.safeParse({
        ...rest,
        box: { top: 1, right: 2, bottom: 3, left: Number.NaN },
      }).success,
    ).toBe(false);
    // An Escape a card body did not use: the document it came from, nothing more.
    expect(frameMessageSchema.safeParse({ fm: 2, type: "escape", document: "d" }).success).toBe(
      true,
    );
    expect(frameMessageSchema.safeParse({ fm: 2, type: "escape" }).success).toBe(false);
  });

  it("parses each verb's payload with defaults, refusing anything undeclared", () => {
    expect(frameRequestSchema.parse({ verb: "subscribe", sub: 1, read: "feed.recent" })).toEqual({
      verb: "subscribe",
      sub: 1,
      read: "feed.recent",
      args: {},
    });
    expect(
      frameRequestSchema.parse({ verb: "fetch", alias: "jira", request: { path: "/x" } }),
    ).toEqual({ verb: "fetch", alias: "jira", request: { method: "GET", path: "/x" } });
    expect(
      frameRequestSchema.safeParse({ verb: "fetch", alias: "jira", request: { url: "https://x" } })
        .success,
    ).toBe(false);
    expect(frameRequestSchema.safeParse({ verb: "unsubscribe" }).success).toBe(false);
    expect(
      frameRequestSchema.safeParse({ verb: "invoke", channel: "inf:cards:list" }).success,
    ).toBe(false);
  });

  it("keeps the refusal vocabulary closed", () => {
    expect([...FRAME_ERROR_CODES]).toContain("capability_not_granted");
    expect([...FRAME_ERROR_CODES]).toContain("read_not_declared");
    expect(new Set(FRAME_ERROR_CODES).size).toBe(FRAME_ERROR_CODES.length);
  });
});

describe("the demo message", () => {
  const recording = cardMediaUrl(`${"t".repeat(64)}-${"a".repeat(32)}`, "mp4");
  const poster = {
    src: "app-frame://images/t1-x.png",
    alt: "Dragging a row",
    width: 640,
    height: 360,
  };

  it("knows where the host serves recordings, and has room for the longest name it mints", () => {
    expect(FRAME_DEMO_SOURCE).toBe(`${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`);
    expect(recording.length).toBeLessThanOrEqual(FRAME_DEMO_SRC_MAX);
  });

  it("carries the recording, its poster and caption, and whether to play, and nothing malformed", () => {
    const demo = {
      fm: 2,
      type: "demo",
      src: recording,
      poster,
      caption: "Drag a row",
      durationMs: 3000,
      play: true,
    };
    expect(frameMessageSchema.safeParse(demo).success).toBe(true);
    expect(frameMessageSchema.safeParse({ ...demo, play: false, caption: "" }).success).toBe(true);
    for (const broken of [
      { ...demo, play: "yes" },
      { ...demo, src: "" },
      { ...demo, src: `${FRAME_DEMO_SOURCE}${"a".repeat(FRAME_DEMO_SRC_MAX)}` },
      { ...demo, durationMs: -1 },
      { ...demo, poster: { ...poster, width: -1 } },
      { ...demo, caption: "x".repeat(5_000) },
    ]) {
      expect(frameMessageSchema.safeParse(broken).success).toBe(false);
    }
  });
});
