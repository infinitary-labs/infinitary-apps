import type { LastRound } from "@shared/lastTurn";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LastTurnRound, PICTURE_ONLY_WORDS, WORKING_WORDS } from "./LastTurn";

/**
 * The last turn's words and states (docs/composer.md "The last turn"): what
 * each line of a round says for each shape of turn, read off the rendered
 * markup. The journey that drives turns through them is
 * `tests/e2e/last-turn.spec.ts`.
 */
type Bubble = {
  state: string | null;
  title: string | null;
  words: string;
  /** The ember dots show somewhere on the line. */
  dots: boolean;
  /** A reply the working dots follow. */
  working: boolean;
};

function render(
  round: LastRound,
  options: { busy?: boolean; older?: boolean } = {},
): { html: string; you?: Bubble; mate?: Bubble } {
  const html = renderToStaticMarkup(
    <LastTurnRound round={round} busy={options.busy ?? false} older={options.older ?? false} />,
  );
  const bubble = (who: "you" | "firstmate"): Bubble | undefined => {
    // Each line is its own row, so a line's markup ends where its row does.
    const found = html.match(
      new RegExp(`<([a-z]+)([^>]*data-last-turn-bubble="${who}"[^>]*)>(.*?)</div>`),
    );
    if (!found) return undefined;
    const [, , open = "", inner = ""] = found;
    const attr = (name: string) => open.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    return {
      state: attr("data-state"),
      title: attr("title"),
      words: inner.match(/data-last-turn-words="">([^<]*)</)?.[1] ?? "",
      dots: inner.includes("data-last-turn-dots"),
      working: attr("data-working") !== null,
    };
  };
  return { html, you: bubble("you"), mate: bubble("firstmate") };
}

describe("a round of the last turn above the input", () => {
  it("shows the Firstmate working while it is busy with no reply yet, with the dots and the working words", () => {
    const { you, mate } = render(
      { you: "How is the alpha coming along?", reply: null },
      { busy: true },
    );
    expect(you).toMatchObject({
      words: "How is the alpha coming along?",
      title: "How is the alpha coming along?",
    });
    expect(mate).toEqual({
      state: "working",
      title: WORKING_WORDS,
      words: WORKING_WORDS,
      dots: true,
      working: false,
    });
  });

  // INF-1771, the captain's ask: "'working' should not block the user from
  // seeing the last message if there is one", built as the approved "three
  // dots right after the reply's words".
  it("keeps the reply's words while the Firstmate works, with the dots after them", () => {
    const { mate } = render(
      { you: "Check the Linux lane", reply: { text: "Noted" } },
      { busy: true },
    );
    expect(mate).toEqual({
      state: "reply",
      title: "Noted",
      words: "Noted",
      dots: true,
      working: true,
    });
  });

  it("shows the reply once the turn has ended, read out once, and a problem in its own state", () => {
    const reply = render({ you: "Remember that I squash", reply: { text: "Noted" } });
    expect(reply.mate).toEqual({
      state: "reply",
      title: "Noted",
      words: "Noted",
      dots: false,
      working: false,
    });
    expect(reply.html).toMatch(/role="status"[^>]*>Noted</);
    const problem = render({
      you: "Merge it",
      reply: { text: "Something went wrong", problem: true },
    });
    expect(problem.mate).toMatchObject({ state: "problem", words: "Something went wrong" });
  });

  it("names a message of pictures alone, and leaves the Firstmate's line out until it works or replies", () => {
    const { you, mate } = render({ you: "", reply: null });
    expect(you).toMatchObject({ words: PICTURE_ONLY_WORDS });
    expect(mate).toBeUndefined();
  });

  // INF-1770's plan: the older round is drawn faded, never read out, and the
  // working signal belongs to the newest round alone.
  it("marks the older round, never reads it out, and keeps the working dots off it", () => {
    const { html, mate } = render(
      { you: "Remember that I squash", reply: { text: "Noted" } },
      { busy: true, older: true },
    );
    expect(html).toMatch(/^<div[^>]*data-older=""/);
    expect(html).not.toContain('role="status"');
    expect(mate).toMatchObject({ state: "reply", dots: false, working: false });
  });

  // INF-1103, the captain's Approve and build on INF-1102's plan: the reply
  // line is a button that opens the whole reply; the captain's own line and
  // the working words stay plain text.
  it("makes a finished or failed reply line the one button, and leaves the rest plain text", () => {
    const working = render({ you: "Cut another alpha", reply: null }, { busy: true });
    expect(working.html).not.toMatch(/<(button|a|input)\b/);
    expect(working.html).not.toMatch(/\b(tabindex|href)=|role="(button|link)"/);
    for (const reply of [{ text: "Got it" }, { text: "Something went wrong", problem: true }]) {
      for (const older of [false, true]) {
        const { html } = render({ you: "Cut another alpha", reply }, { older });
        expect(html.match(/<button\b[^>]*>/g)).toEqual([
          expect.stringMatching(/data-last-turn-bubble="firstmate"/),
        ]);
        expect(html).toMatch(/<span[^>]*data-last-turn-bubble="you"/);
      }
    }
  });
});
