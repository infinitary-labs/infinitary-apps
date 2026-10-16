import { describe, expect, it } from "vitest";
import { FirstmateMachine } from "./machine";
import { REPLY_DURATION_MS, REPLY_EMOTES, replyFrame } from "./replies";

describe("reply emotes", () => {
  it("start and end at rest, so entering and leaving one never pops", () => {
    for (const emote of REPLY_EMOTES) {
      for (const et of [0, 1]) {
        const f = replyFrame(emote, et);
        expect(f.pitch, `${emote} pitch at ${et}`).toBeCloseTo(0, 3);
        expect(f.rot, `${emote} rot at ${et}`).toBeCloseTo(0, 3);
        expect(f.tx, `${emote} tx at ${et}`).toBeCloseTo(0, 3);
        expect(f.ty, `${emote} ty at ${et}`).toBeCloseTo(0, 3);
        expect(f.sx, `${emote} sx at ${et}`).toBeCloseTo(1, 3);
        expect(f.sy, `${emote} sy at ${et}`).toBeCloseTo(1, 3);
        expect(f.lid, `${emote} lid at ${et}`).toBeCloseTo(0, 3);
        expect(f.happy, `${emote} happy at ${et}`).toBeLessThan(0.5);
        // The salute's snap lands a whole quarter turn, which maps the
        // tesseract onto itself; anything else would jump at the end.
        const quarter = Math.PI / 2;
        const rest = ((f.spin % quarter) + quarter) % quarter;
        expect(Math.min(rest, quarter - rest), `${emote} spin at ${et}`).toBeCloseTo(0, 3);
      }
    }
  });

  it("play at once outside a turn, for their own duration, and return home", () => {
    for (const emote of REPLY_EMOTES) {
      const m = new FirstmateMachine(0, () => 0.5);
      expect(m.requestEmote(emote, 100)).toBe(true);
      expect(m.update(100).state).toBe(emote);
      const end = 100 + REPLY_DURATION_MS[emote];
      expect(m.update(end - 1).state).toBe(emote);
      expect(m.update(end).state).toBe("idle");
    }
  });

  it("wait for the voice: listening refuses them and cuts one short", () => {
    const m = new FirstmateMachine(0, () => 0.5);
    m.setInputs({ listening: true, busy: false }, 0);
    expect(m.requestEmote("nod", 10)).toBe(false);
    m.setInputs({ listening: false, busy: false }, 20);
    expect(m.requestEmote("nod", 30)).toBe(true);
    m.setInputs({ listening: true, busy: false }, 200);
    expect(m.update(200).state).toBe("listening");
  });
});
