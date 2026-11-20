import { SECRETS_USE_ENDED_LEAD } from "../../../src/core/orchestrator/wakes";
import { SECRETS_COMMAND } from "../../../src/core/secrets/commandWords";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { calledTool, sinceLastUser } from "../providerRequest";

export const PROTECTED_USE_PROMPT = "check the disposable staging credential";
export const PROTECTED_USE_TITLE = "Check the staging credential";
export const PROTECTED_USE_GOAL = "Run the isolated staging credential check through Secrets.";
export const PROTECTED_USE_DONE = "The staging credential check completed";
export const PROTECTED_USE_REPORT = "The approved recipient completed; its output stayed private.";

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const shell = (command: string): ScenarioAnswer => ({
  calls: [{ name: "bash", args: { command, description: "Check the protected request" } }],
});

/**
 * INF-1109: the actual supervisor grants the command, the task asks once and
 * ends its turn while waiting, and the durable completion wake resumes it.
 * Only model choices stand in here; no command grant, approval or wake is injected.
 */
export function protectedSecretUse(cwd: string, reference: string): Scenario {
  return () => {
    let requested = false;
    return ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (!wantsStream) return undefined;
      const { user, results } = sinceLastUser(body);
      if (isFirstmate) {
        if (!user.includes("[user]") || !user.includes(PROTECTED_USE_PROMPT)) return undefined;
        return results.length === 0
          ? {
              calls: [
                {
                  name: "spawn_crewmate",
                  args: {
                    title: PROTECTED_USE_TITLE,
                    goal: PROTECTED_USE_GOAL,
                    user_words: PROTECTED_USE_PROMPT,
                    constraints: [
                      {
                        kind: "read-only",
                        text: "Run the disposable check without changing project code.",
                      },
                    ],
                  },
                },
              ],
            }
          : { text: "Started the isolated credential check." };
      }
      if (!body.includes(PROTECTED_USE_GOAL)) return undefined;
      const ended = user.includes(SECRETS_USE_ENDED_LEAD) && user.includes(": completed.");
      if (ended) {
        const request = user
          .slice(user.lastIndexOf(SECRETS_USE_ENDED_LEAD) + SECRETS_USE_ENDED_LEAD.length)
          .trimStart()
          .match(/^([\w-]+): completed\./)?.[1];
        if (!request) return { text: "The receipt could not be read." };
        // INF-1109: a delayed inject's kept answer consumes the next command
        // without running status. Read status after consuming that receipt;
        // inspect only the latest result so the earlier receipt cannot loop.
        if (!calledTool(latestUserTail, "bash") || /^earlier: inject$/m.test(results.at(-1) ?? ""))
          return shell(`${SECRETS_COMMAND} status ${quote(request)}`);
        if (!results.some((result) => result.includes("completed")))
          return { text: "The current receipt did not confirm completion." };
        if (!calledTool(latestUserTail, "emit_card"))
          return {
            calls: [
              {
                name: "emit_card",
                args: {
                  title: PROTECTED_USE_DONE,
                  body: `<p>${PROTECTED_USE_REPORT}</p>`,
                },
              },
            ],
          };
        if (!calledTool(latestUserTail, "report"))
          return {
            calls: [
              {
                name: "report",
                args: {
                  text: PROTECTED_USE_REPORT,
                  summary: PROTECTED_USE_REPORT,
                },
              },
            ],
          };
        return { text: "Reported the completed check." };
      }
      if (requested) return { text: "The protected request is waiting." };
      requested = true;
      return shell(
        `cd ${quote(cwd)} && ${SECRETS_COMMAND} inject --env ${quote(JSON.stringify({ SERVICE_TOKEN: reference }))} --reason ${quote(PROTECTED_USE_GOAL)} --id supervisor-proof -- /bin/sh check.sh`,
      );
    };
  };
}
