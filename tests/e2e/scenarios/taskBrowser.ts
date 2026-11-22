import { HERE } from "../../../src/shared/deviceNames";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { browser, knownRefOf, lookingAgain, refOf, toolAnswers } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/**
 * The task browser (docs/task-browser.md, task-browser e2e). A brief
 * carrying this marker, a page this Mac serves and a name ("check the
 * sign-up page at http://127.0.0.1:PORT/ as Sam") drives the task's own
 * browser the way a crewmate would: open it there, type the name into the
 * Name field by the ref the outline gave it, click Send by its ref, reload,
 * photograph the page, close the browser, and report what the page said at
 * each step - read off the tool results, never assumed.
 */
export const TASK_BROWSER_PROMPT_MARKER = "check the sign-up page at ";
export const MOCK_BROWSER_REPORT_PREFIX = "The sign-up page said";
export const MOCK_BROWSER_PICTURE = "signed-up";
export function mockBrowserSaw(first: string, sent: string, reloaded?: string): string {
  const words = `"${first}" first, "${sent}" after Send`;
  return reloaded === undefined ? words : `${words} and "${reloaded}" after a reload`;
}
/** The words the report puts after each address the browser blocked. */
export const MOCK_BROWSER_BLOCKED = {
  privately: "on a private network",
  atConnection: " at the connection",
  plain: "over plain http",
  local: "on this Mac",
} as const;

function taskBrowserStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/check the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const found = (at: number, pattern: RegExp): string | undefined =>
    answers[at]?.match(pattern)?.[1];
  const missing = (what: string): ScriptedCall[] => [
    {
      name: "report",
      args: {
        text: `${MOCK_BROWSER_REPORT_PREFIX} nothing with ${what}: ${(answers.at(-1) ?? "").slice(0, 400)}`,
      },
    },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(answers[0], "textbox", "Name");
      return ref ? [browser("fill", `@${ref}`, name)] : missing("a Name field");
    }
    case 2: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("a Send button");
    }
    case 3: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("a Send button");
    }
    case 4:
      return [browser("reload")];
    case 5:
      return [browser("screenshot", MOCK_BROWSER_PICTURE)];
    case 6:
      return [browser("stop")];
    case 7: {
      const state = /text "((?:Not signed up yet|Signed up as [^"]+))"/;
      const first = found(0, state);
      const after = found(2, /text "(Thanks, [^"]+)"/);
      const reloaded = found(4, state);
      const reach = found(0, /text "(This page (?:cannot )?reach(?:es)? the app)"/);
      const privately = found(
        0,
        new RegExp(
          `Blocked what the page asked for on ${HERE.this}'s network or another private one: (.+?)\\. This`,
        ),
      );
      const plain = found(
        0,
        /Blocked what the page asked for from websites over plain http: (.+?)\. This/,
      );
      // Refusals drain into the next browser answer, not necessarily open's.
      const local = answers
        .map((_, index) =>
          found(
            index,
            new RegExp(
              `Blocked what the page asked for from other servers on ${HERE.this}: (.+?)\\. Open`,
            ),
          ),
        )
        .find((host) => host !== undefined);
      const atConnection = answers[0]?.includes("refused at the connection")
        ? MOCK_BROWSER_BLOCKED.atConnection
        : "";
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_REPORT_PREFIX} ${mockBrowserSaw(`${first}`, `${after}`, `${reloaded}`)}, and "${reach}". It blocked ${privately} ${MOCK_BROWSER_BLOCKED.privately}${atConnection}, ${plain} ${MOCK_BROWSER_BLOCKED.plain}, and ${local} ${MOCK_BROWSER_BLOCKED.local}. Browser answers:\n${answers.slice(0, 5).join("\n\n")}`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

export const taskBrowser: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(TASK_BROWSER_PROMPT_MARKER)) return undefined;
    const step = calledTool(body, "report") ? undefined : lookingAgain(body, taskBrowserStep);
    return step ? { calls: step } : { text: "done" };
  };
