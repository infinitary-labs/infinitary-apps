import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import { SCREEN_ADDRESS, screenActionOf, screenBody } from "./screen";

/**
 * The reset on the screens shown when Infinitary cannot open (docs/reset.md,
 * "Where a reset can start"): its question starts on Keep everything, so a
 * stray Return keeps everything, as the Settings row's question does.
 */
const words = { title: "Title", message: "Message", next: "Next" };

describe("the reset screen", () => {
  it("reads only its own buttons' answers", () => {
    expect(screenActionOf(`${SCREEN_ADDRESS}?do=reset`)).toBe("reset");
    expect(screenActionOf(`${SCREEN_ADDRESS}?do=wipe`)).toBeUndefined();
    expect(screenActionOf("https://example.com/?do=reset")).toBeUndefined();
  });

  it("asks before it resets, with Keep everything focused", () => {
    const body = screenBody({ kind: "question" });
    expect(body).toContain(m.settingsGeneralResetQuestion());
    expect(body).toMatch(/value="keep"[^>]*autofocus/);
    expect(body).not.toMatch(/value="reset"[^>]*autofocus/);
  });

  it("offers Try again first where the app could not start, and only reset on a refusal", () => {
    expect(screenBody({ kind: "offer", words, again: true })).toMatch(
      /value="again"[^>]*autofocus.*value="ask".*value="quit"/s,
    );
    const refusal = screenBody({ kind: "offer", words, again: false });
    expect(refusal).toContain('value="ask"');
    expect(refusal).not.toContain('value="again"');
  });
});
