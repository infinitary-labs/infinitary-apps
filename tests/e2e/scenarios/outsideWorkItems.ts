import type { GithubWriteInput } from "../../../src/core/forge/api";
import { INTEGRATIONS_COMMAND } from "../../../src/core/integrations";
import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { browserShellMessages } from "../browserScript";
import { STUB_OPEN_ISSUE } from "../githubStub";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages, sinceLastUser } from "../providerRequest";

/**
 * Outside work items (docs/runbooks.md, "Outside work items"): the first mate
 * files the task that tells an outside item how the work ended, waiting on the
 * work, and that task's crewmate replies on the item and closes it once the
 * work merged and shipped.
 *
 * Two items: an issue on GitHub that strangers can write to, told by an unsafe
 * data reader through `github_write`, and a ticket in the captain's Notes
 * tracker, an MCP server, told by an ordinary crewmate through the
 * integrations command in its shell.
 */

/** The merged and released fix both items wait on, seeded before launch. */
export const OUTSIDE_FIX = {
  id: "coldfix1",
  title: "Stop the meter idling on a cold start",
  summary: "The meter now reads on a cold start instead of idling.",
  release: {
    version: "1.4.0",
    url: "https://github.com/octo/meterlab/releases/tag/v1.4.0",
    evidence: "The release's notes list the cold start fix.",
  },
};

/** The issue's address on GitHub, the one open issue the stand-in holds. */
export const OUTSIDE_ISSUE_URL = `https://github.com/octo/meterlab/issues/${STUB_OPEN_ISSUE}`;
// e2e-typed-words: the captain's own words that start the first mate's filing
export const OUTSIDE_ISSUE_ASK = "tell the cold start issue how its fix ended";
export const OUTSIDE_ISSUE_TITLE = "Tell the cold start issue how its fix ended";
/** The waiting task's goal, which its brief carries and its scripted crewmate answers. */
export const OUTSIDE_ISSUE_GOAL = `Reply on ${OUTSIDE_ISSUE_URL} with what changed and its first release, and close it, once the cold start fix ships.`;
export const OUTSIDE_ISSUE_REPLY =
  "Fixed in 1.4.0 (https://github.com/octo/meterlab/releases/tag/v1.4.0): the meter now reads on a cold start.";
/** The reader's two writes, in order: the reply, then the close. */
export const OUTSIDE_ISSUE_WRITES: GithubWriteInput[] = [
  {
    method: "POST",
    path: `/repos/octo/meterlab/issues/${STUB_OPEN_ISSUE}/comments`,
    body: JSON.stringify({ body: OUTSIDE_ISSUE_REPLY }),
  },
  {
    method: "PATCH",
    path: `/repos/octo/meterlab/issues/${STUB_OPEN_ISSUE}`,
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  },
];

/** The ticket in the captain's Notes tracker. */
// e2e-typed-words: the captain's own words that start the first mate's filing
export const OUTSIDE_TICKET_ASK = "tell the cold start ticket in my notes how its fix ended";
export const OUTSIDE_TICKET_TITLE = "Tell the cold start ticket how its fix ended";
export const OUTSIDE_TICKET_GOAL =
  "Add a note to the cold start ticket in the Notes tracker saying how its fix ended, once the fix ships.";
export const OUTSIDE_TICKET_NOTE =
  "Cold start ticket: fixed in 1.4.0, the meter now reads on a cold start.";
export const OUTSIDE_TICKET_REASON = "Tell the cold start ticket that its fix shipped in 1.4.0.";
/** What each crewmate's report opens with, so its outcome carries what it heard. */
export const OUTSIDE_ANSWERED = "Told the item: ";

/** The first mate files each item's waiting task, in one create_task call, on the captain's words. */
export const outsideWorkItemsFirstmate: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    const { user, results } = sinceLastUser(body);
    const issue = user.includes(OUTSIDE_ISSUE_ASK);
    if (!issue && !user.includes(OUTSIDE_TICKET_ASK)) return undefined;
    if (results.length) return { text: "Filed; it waits on the fix." };
    return {
      calls: [
        {
          name: "create_task",
          args: issue
            ? {
                title: OUTSIDE_ISSUE_TITLE,
                goal: OUTSIDE_ISSUE_GOAL,
                user_words: OUTSIDE_ISSUE_ASK,
                repo_id: "repo-meterlab",
                blocked_by: [OUTSIDE_FIX.id],
                start_policy: "when-ready",
                side_effect: true,
                unsafe_data_reader: true,
                constraints: [{ kind: "read-only" }],
              }
            : {
                title: OUTSIDE_TICKET_TITLE,
                goal: OUTSIDE_TICKET_GOAL,
                user_words: OUTSIDE_TICKET_ASK,
                repo_id: "repo-meterlab",
                blocked_by: [OUTSIDE_FIX.id],
                start_policy: "when-ready",
                side_effect: true,
              },
        },
      ],
    };
  };

/** The issue's waiting task: an unsafe data reader that reads the issue, replies and closes it. */
export const outsideIssueCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(OUTSIDE_ISSUE_GOAL)) return undefined;
    const { user, results, tail } = sinceLastUser(body);
    if (calledTool(tail, "report")) return { text: "The writes wait on the captain." };
    if (user.includes(WRITE_ANSWERED_LEAD))
      return {
        calls: [
          {
            name: "report",
            args: { text: `${OUTSIDE_ANSWERED}${user}`, summary: "The captain answered." },
          },
        ],
      };
    if (!user.includes(OUTSIDE_ISSUE_GOAL)) return undefined;
    if (results.length === 0)
      return {
        calls: [
          {
            name: "github_read",
            args: { path: `/repos/octo/meterlab/issues/${STUB_OPEN_ISSUE}` },
          },
        ],
      };
    const write = OUTSIDE_ISSUE_WRITES[results.length - 1];
    if (write) return { calls: [{ name: "github_write", args: write }] };
    return {
      calls: [
        {
          name: "report",
          args: {
            text: results.join("\n---\n"),
            summary: "The reply and the close wait on the captain's card.",
          },
        },
      ],
    };
  };

/**
 * The ticket's waiting task: an ordinary crewmate that adds its note through
 * the integrations command, whose card the app raises under the Notes rule.
 */
export const outsideTicketCrew: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(OUTSIDE_TICKET_GOAL)) return undefined;
    const current = sinceLastUser(body);
    if (calledTool(current.tail, "report")) return { text: "Waiting for the captain." };
    if (
      current.user.includes(WRITE_ANSWERED_LEAD) ||
      current.user.startsWith("[fm-op] the captain's click on ask")
    )
      return { calls: [{ name: "report", args: { text: `${OUTSIDE_ANSWERED}${current.user}` } }] };
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `${INTEGRATIONS_COMMAND} call Notes add_note '${JSON.stringify({ text: OUTSIDE_TICKET_NOTE })}' --reason '${OUTSIDE_TICKET_REASON}'`,
            },
          },
        ],
      };
    // The shell can return its job receipt before the command reaches the app.
    const shell = browserShellMessages(providerMessages(body));
    if (shell.pending) return { text: "The integrations command is still running." };
    const answer = shell.readings.findLast((message) => message.role === "tool")?.text ?? "";
    if (/^running: /m.test(answer) || /^code: BUSY$/m.test(answer))
      return { calls: [{ name: "bash", args: { command: INTEGRATIONS_COMMAND } }] };
    const ask = /approval card for ask (ia[a-f0-9]+)/.exec(answer)?.[1];
    if (ask)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: "The app is asking for the note.",
              summary: "The app is asking for the note.",
              waiting_on_captain: {
                reason: "Choose whether the note may be added",
                card_id: `integration-ask-${ask}`,
              },
            },
          },
        ],
      };
    return { calls: [{ name: "report", args: { text: `${OUTSIDE_ANSWERED}${answer}` } }] };
  };
