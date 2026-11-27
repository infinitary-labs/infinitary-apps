import type { GithubWriteInput } from "../../../src/core/forge/api";
import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { STUB_OPEN_ISSUE } from "../githubStub";
import type { Scenario } from "../mockProvider";
import { calledTool, sinceLastUser } from "../providerRequest";

/**
 * A kept write passed by a yes that still stands (INF-6987's approved plan,
 * piece A1; docs/forge.md, "A write that asks"): the first mate files a
 * side-effect task that posts one reply on meterlab's open issue, and its
 * crewmate names the captain's heard project direction as the write's
 * allowance, or names none and asks on a card.
 */

/** The captain's project direction for an intake round's send tasks, the docs site's example. */
export const INTAKE_DIRECTION = {
  id: "intake-replies",
  text: "Intake send tasks may post replies that plainly follow our intake method, and nothing else; anything odd or ambiguous waits for my click.",
} as const;

export const KEPT_REPLY = "Thanks for the report: the cold start fix shipped in 1.4.0.";
export const KEPT_REPLY_WRITE: GithubWriteInput = {
  method: "POST",
  path: `/repos/octo/meterlab/issues/${STUB_OPEN_ISSUE}/comments`,
  body: JSON.stringify({ body: KEPT_REPLY }),
};

/** One send task per journey: the one that names the direction, and the one that names no yes. */
export const SEND_ON_DIRECTION = {
  // e2e-typed-words: the captain's own words that start the first mate's filing
  ask: "post the drafted reply on the cold start issue under my intake direction",
  title: "Post the drafted reply on the cold start issue",
  goal: `Post the drafted reply on https://github.com/octo/meterlab/issues/${STUB_OPEN_ISSUE} under the intake direction.`,
  allowance: `d:${INTAKE_DIRECTION.id}`,
} as const;
export const SEND_ON_CLICK = {
  // e2e-typed-words: the captain's own words that start the first mate's filing
  ask: "post the drafted reply on the cold start issue once I say so",
  title: "Post the reply on the cold start issue once allowed",
  goal: `Post the drafted reply on https://github.com/octo/meterlab/issues/${STUB_OPEN_ISSUE} once the captain allows it.`,
} as const;

export const KEPT_REPLY_CARD_TITLE = "Post the reply on the cold start issue?";
/** What the crewmate's report opens with once its write was sent or answered. */
export const KEPT_REPLY_OUTCOME = "The reply's write answered: ";

/** The first mate files the send task the captain named, as a side-effect task with no wait. */
export const keptWriteFirstmate: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    const { user, results } = sinceLastUser(body);
    const send = [SEND_ON_DIRECTION, SEND_ON_CLICK].find((one) => user.includes(one.ask));
    if (!send) return undefined;
    if (results.length) return { text: "Filed." };
    return {
      calls: [
        {
          name: "create_task",
          args: {
            title: send.title,
            goal: send.goal,
            user_words: send.ask,
            repo_id: "repo-meterlab",
            blocked_by: [],
            start_policy: "when-ready",
            side_effect: true,
            constraints: [{ kind: "read-only" }],
          },
        },
      ],
    };
  };

/**
 * The send task's crewmate: one `github_write`, naming the direction when its
 * goal says so; a write kept for the click goes up on a card whose button
 * sends that ask.
 */
export const keptWriteCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const send = [SEND_ON_DIRECTION, SEND_ON_CLICK].find((one) => body.includes(one.goal));
    if (!send) return undefined;
    const { user, results, tail } = sinceLastUser(body);
    if (calledTool(tail, "report")) return { text: "Done." };
    if (user.includes(WRITE_ANSWERED_LEAD))
      return {
        calls: [
          {
            name: "report",
            args: { text: `${KEPT_REPLY_OUTCOME}${user}`, summary: "The reply went." },
          },
        ],
      };
    if (!user.includes(send.goal)) return undefined;
    if (results.length === 0)
      return {
        calls: [
          {
            name: "github_write",
            args: {
              ...KEPT_REPLY_WRITE,
              ...("allowance" in send ? { allowance: send.allowance } : {}),
            },
          },
        ],
      };
    const ask = results[0]?.match(/Kept as ask (wa[0-9a-f]+)/)?.[1];
    if (results.length === 1 && ask)
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "reply-ask",
              title: KEPT_REPLY_CARD_TITLE,
              body: "<p>The cold start fix shipped in 1.4.0, so the issue can hear how it ended.</p><p>The reply thanks the reporter and names the release.</p>",
              actions: [
                { id: "send", effect: { kind: "request_write", ask } },
                { id: "not-now", label: "Not now" },
              ],
            },
          },
        ],
      };
    if (ask) return { text: "The reply waits on the captain's card." };
    return {
      calls: [
        {
          name: "report",
          args: { text: `${KEPT_REPLY_OUTCOME}${results.join("\n")}`, summary: "The reply went." },
        },
      ],
    };
  };
