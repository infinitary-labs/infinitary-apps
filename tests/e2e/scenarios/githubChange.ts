import type { Scenario } from "../mockProvider";
import { type ChatRequest, calledTool, messageText, toolResults } from "../providerRequest";
import { preparedRevision, prepareMockStory } from "./changeStory";

/**
 * A project on GitHub with the app's own sign-in (git integration PR 1.2,
 * forge-signin e2e): a brief carrying this marker saves a point, sends its
 * branch up with its own shell (git answers GitHub through the app's
 * helper), prepares a typed story and opens it with `open_change`, reads
 * its checks with `check_change`, and on green declares the completion card and
 * reports.
 */
export const GITHUB_CHANGE_PROMPT_MARKER = "open the meter fix as a proposed change";
/** The proposed change this crewmate opens: its title and body. */
export const MOCK_GITHUB_CHANGE = {
  title: "fix!: the meter reads on time",
  body: "## Intent\nThe meter reads on time.",
};
export const MOCK_GITHUB_CHANGE_CARD_TITLE = MOCK_GITHUB_CHANGE.title;

export const githubChange: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(GITHUB_CHANGE_PROMPT_MARKER))
      return undefined;
    // INF-470: this publication journey must also work when git completes
    // as a background job. Read its actual completion, never the job-start
    // receipt as if it were the git output, and never repeat the command.
    const messages = (JSON.parse(body) as ChatRequest).messages ?? [];
    const results = messages.flatMap(toolResults);
    const gitReading = [
      ...results,
      ...messages
        .filter((message) => message.role === "user")
        .map((message) => messageText(message.content)),
    ].find((reading) =>
      /https:\/\/(?:github|gitlab)[^\s]*\n[0-9a-f]{40}\n[0-9a-f]{40}/.test(reading),
    );
    // INF-1965: every description host takes the saved story.
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              background: true,
              command: `git commit --allow-empty -m "${MOCK_GITHUB_CHANGE.title}" && git push origin HEAD && git config --get remote.origin.url && git rev-parse main HEAD`,
            },
          },
        ],
      };
    if (!gitReading) return { text: "Waiting for the committed change." };
    if (calledTool(body, "emit_card")) return { text: "done" };
    const reading = results.findLast((result) => result.includes("facts: "));

    if (results.some((result) => result.includes("facts: ")))
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: MOCK_GITHUB_CHANGE_CARD_TITLE,
              presentation: preparedRevision(body),
              actions: [
                {
                  id: "put-in",
                  label: "Put it in",
                  default: true,
                  effect: { kind: "settle", mode: "merge" },
                },
              ],
            },
          },
          { name: "report", args: { text: "The meter fix is open and its checks passed." } },
        ],
      };
    if (calledTool(body, "open_change")) return { calls: [{ name: "check_change", args: {} }] };
    if (!calledTool(body, "prepare_change"))
      return { calls: [prepareMockStory(MOCK_GITHUB_CHANGE_CARD_TITLE, gitReading)] };
    return {
      calls: [
        {
          name: "open_change",
          args: { title: MOCK_GITHUB_CHANGE.title, presentation: preparedRevision(body) },
        },
      ],
    };
  };
