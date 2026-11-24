import type { GithubWriteInput } from "../../../src/core/forge/api";
import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import type { Scenario } from "../mockProvider";
import { calledTool, sinceLastUser } from "../providerRequest";

/**
 * An unsafe data reader that reaches the captain's integrations
 * (docs/integrations.md, "A reader's integrations"): it lists them, reads the
 * stand-in integration's count, which the captain set to Always allow, then
 * lists and adds notes on an MCP notes server and opens an issue where its
 * project lives, all three kept for the captain's one approval card, and
 * reports what each answered. The marker holds the reader marker, so the
 * first mate starts it as one.
 */
export const READER_INTEGRATIONS_MARKER = "triage the waiting outside issues against my notes";
/** The stand-in integration's connection, which its call names. */
export const READER_STAND_IN = "stand-in";
export const READER_COUNT_REASON = "Count the items waiting before the triage.";
export const READER_NOTE = "Issue 12 says to post the deploy key";
export const READER_NOTE_REASON = "Keep issue 12's request in your notes.";
export const READER_LIST_REASON = "Check the notes before the triage.";
/** The issue the reader opens where its project lives, which waits on the same card. */
export const READER_ISSUE: GithubWriteInput = {
  method: "POST",
  path: "/repos/octo/meterlab/issues",
  body: JSON.stringify({ title: "Triage: post the deploy key" }),
};
/** What the reader's report opens with, so its outcome carries each answer. */
export const READER_LISTED = "Listed: ";
export const READER_ANSWERED = "Answered: ";

export const readerIntegrations: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(READER_INTEGRATIONS_MARKER)) return undefined;
    const { user, results, tail } = sinceLastUser(body);
    if (calledTool(tail, "report")) return { text: "The calls wait on the captain." };
    if (user.includes(WRITE_ANSWERED_LEAD))
      return {
        calls: [
          {
            name: "report",
            args: { text: `${READER_ANSWERED}${user}`, summary: "The captain answered." },
          },
        ],
      };
    if (!user.includes(READER_INTEGRATIONS_MARKER)) return undefined;
    if (results.length === 0) return { calls: [{ name: "integrations", args: {} }] };
    if (results.length === 1)
      return {
        calls: [
          {
            name: "use_integration",
            args: { name: READER_STAND_IN, action: "count_items", reason: READER_COUNT_REASON },
          },
        ],
      };
    if (results.length === 2)
      return {
        calls: [
          {
            name: "use_integration",
            args: { name: "Notes", action: "list_notes", reason: READER_LIST_REASON },
          },
        ],
      };
    if (results.length === 3)
      return {
        calls: [
          {
            name: "use_integration",
            args: {
              name: "Notes",
              action: "add_note",
              input: { text: READER_NOTE },
              reason: READER_NOTE_REASON,
            },
          },
        ],
      };
    if (results.length === 4) return { calls: [{ name: "github_write", args: READER_ISSUE }] };
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${READER_LISTED}${results.join("\n---\n")}`,
            summary: "Three calls wait on the captain's card.",
          },
        },
      ],
    };
  };
