import { renderWake } from "../../../src/core/orchestrator/wakes";
import type { Scenario } from "../mockProvider";

/**
 * INF-1226: an answer task asks the captain's consent before it uses
 * something sensitive, and only then finds its answer. INF-1220 asked to
 * sign a test app with the Mac mini's Developer ID identity, and the
 * captain's "Allow signing on the Mac mini" closed the task answered before
 * anything was signed. A captain message carrying
 * the marker has the first mate start a task that only answers. Its
 * crewmate shows INF-1220's consent card, declared `continues`, and on the
 * captain's allow shows its answer on a card it does not go on from.
 */
export const ANSWER_CONSENT_MARKER = "find out once I allow it:";
export const ANSWER_CONSENT_TITLE = "whether the Mac mini can sign the Secrets test app";
/** INF-1220's consent card, its title and actions as the captain saw them. */
export const CONSENT_CARD_TITLE = "Allow signing the Secrets test app on the Mac mini?";
export const CONSENT_ALLOW = {
  id: "allow-mac-mini-signing",
  label: "Allow signing on the Mac mini",
} as const;
export const CONSENT_LEAVE = { id: "leave-blocked", label: "Leave blocked" } as const;
export const SIGNED_CARD_TITLE = "The Secrets test app is signed with your Developer ID identity";
export const SIGNED_CHOICE = { id: "noted", label: "Got it" } as const;
const SIGNED_RECHECK = { id: "recheck", label: "Check the signatures again" } as const;

/** What the crewmate is told when the captain allows, in the app's own words. */
export const CONSENT_ALLOWED_STEER = renderWake({
  facts: {
    kind: "card-choice",
    to: "crewmate",
    source: "chrome",
    card: { title: CONSENT_CARD_TITLE },
    choice: CONSENT_ALLOW,
  },
});

/** The same words as the request body carries them, quotes escaped. */
const ALLOWED_IN_BODY = JSON.stringify(CONSENT_ALLOWED_STEER).slice(1, -1);

export const answerConsent: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream || hasToolResults) return undefined;
    if (isFirstmate) {
      if (!latestUserTail.includes(ANSWER_CONSENT_MARKER)) return undefined;
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: ANSWER_CONSENT_TITLE,
              goal: "Sign the Secrets test app on the Mac mini once the captain allows it, and say whether it worked.",
              user_words: `${ANSWER_CONSENT_MARKER} ${ANSWER_CONSENT_TITLE}`,
              constraints: [{ kind: "read-only" }],
            },
          },
        ],
      };
    }
    if (!body.includes(ANSWER_CONSENT_MARKER)) return undefined;
    // The captain allowed it: the crewmate signs and shows its answer.
    if (latestUserTail.includes(ALLOWED_IN_BODY)) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: SIGNED_CARD_TITLE,
              body: "<p>The Mac mini signed the Secrets test app with Developer ID Application: Kun Chen.</p><p>Every signature names team 9T2J7MNUP9, with hardened runtime and a timestamp.</p>",
              actions: [{ ...SIGNED_CHOICE, default: true }, SIGNED_RECHECK],
            },
          },
          { name: "report", args: { text: "The Mac mini signed the Secrets test app." } },
        ],
      };
    }
    if (!latestUserTail.includes(ANSWER_CONSENT_MARKER)) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: CONSENT_CARD_TITLE,
            body: "<p>I rebuilt the unsigned Secrets test app on the Mac mini.</p><p>Signing it needs your permission to use your Developer ID identity there.</p>",
            continues: true,
            actions: [CONSENT_LEAVE, { ...CONSENT_ALLOW, default: true }],
          },
        },
        {
          name: "report",
          args: {
            text: "The unsigned test app is rebuilt; signing waits on the captain's consent.",
          },
        },
      ],
    };
  };
