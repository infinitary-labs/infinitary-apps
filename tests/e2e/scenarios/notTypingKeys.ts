import { browser } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/** Piece 1 of the accepted layers plan: real card controls and a disposable task browser. */
export const NOT_TYPING_MARKER = "check keys outside typing at ";
export const NOT_TYPING_TITLES = {
  inline: "Draft a project note",
  served: "Review a project note",
} as const;
export const NOT_TYPING_BODY =
  '<div role="region" aria-label="Note text" tabindex="0"><p>Keep the project note here.</p></div><label>Note <textarea name="note"></textarea></label><label>Find a word <input name="find"></label><div contenteditable="true" role="textbox" aria-label="Draft">A draft</div><label><input type="radio" name="status" value="ready"> Ready for review</label><button type="button" id="local">Keep reading</button>';

export const notTypingKeys: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !body.includes(NOT_TYPING_MARKER)) return undefined;
    if (calledTool(body, "report")) return undefined;
    if (!hasToolResults) {
      const url = body.match(/check keys outside typing at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      if (!url) throw new Error("The keyboard journey needs its disposable page address");
      return {
        calls: [
          browser("open", url),
          { name: "emit_card", args: { title: NOT_TYPING_TITLES.inline, body: NOT_TYPING_BODY } },
          {
            name: "emit_card",
            args: {
              title: NOT_TYPING_TITLES.served,
              body: `${NOT_TYPING_BODY}<script>document.getElementById('local').addEventListener('keydown', function(event) { if(event.key === 's') { event.preventDefault(); this.dataset.used = 'true'; } });</script>`,
            },
          },
        ],
      };
    }
    return {
      calls: [
        { name: "report", args: { text: "The two project notes and the task browser are ready." } },
      ],
    };
  };

/** Disposable answer and note for the captain's non-blocking risky-key warning rule. */
export const RISKY_KEYS_MARKER = "check warned card keys";
export const RISKY_KEYS_TITLES = {
  question: "Choose the project note",
  note: "The project note is ready",
} as const;

export const riskyKeys: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !body.includes(RISKY_KEYS_MARKER)) return undefined;
    if (calledTool(body, "report")) return undefined;
    if (!hasToolResults)
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: RISKY_KEYS_TITLES.question,
              body: '<div role="region" aria-label="Project note" tabindex="0"><p>Keep this disposable project note?</p></div>',
              actions: [
                { id: "keep", label: "Keep the note", default: true },
                { id: "leave", label: "Leave the note" },
              ],
            },
          },
          {
            name: "emit_card",
            args: {
              title: RISKY_KEYS_TITLES.note,
              body: "<p>The disposable project note is ready.</p>",
            },
          },
        ],
      };
    return {
      calls: [{ name: "report", args: { text: "The disposable question and note are ready." } }],
    };
  };
