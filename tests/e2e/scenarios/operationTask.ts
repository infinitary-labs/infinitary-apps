import { toolAnswers } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, contextRepos, providerMessages } from "../providerRequest";
export const OPERATION_ASK = "Set the chosen local service state to ready and verify it.";
export const OPERATION_TITLE = "Set the local service state";
export const OPERATION_EVIDENCE = "Read service.status after setting the chosen state: ready.";
export const OPERATION_CLOSE = "Record the verified service operation";
/** INF-1430: scripted effect and judgment; real file tools, dispatch, report and close. */
export const operationTask: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (!hasToolResults && latestUserTail.includes(OPERATION_ASK))
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: OPERATION_TITLE,
                goal: OPERATION_ASK,
                user_words: OPERATION_ASK,
                repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                in_folder: true,
                constraints: [{ kind: "operation" }],
              },
            },
          ],
        };
      if (!hasToolResults && latestUserTail.includes(OPERATION_CLOSE)) {
        const match = latestUserTail.match(/operation task ([a-z0-9]+)/);
        return {
          calls: [
            {
              name: "settle_task",
              args: {
                task_id: match?.[1] ?? "missing",
                mode: "done",
                why: "finished",
                evidence: OPERATION_EVIDENCE,
                closing_sentence: "The chosen service is ready.",
              },
            },
          ],
        };
      }
      return undefined;
    }
    if (!body.includes(OPERATION_ASK)) return undefined;
    if (calledTool(body, "report")) return { text: "The service state was verified." };
    if (!calledTool(body, "write"))
      return { calls: [{ name: "write", args: { path: "service.status", content: "ready\n" } }] };
    if (!calledTool(body, "read"))
      return { calls: [{ name: "read", args: { path: "service.status" } }] };
    if (!toolAnswers(providerMessages(body)).join("\n").includes("ready"))
      throw new Error("Operation never read its result");
    return {
      calls: [
        {
          name: "report",
          args: { text: OPERATION_EVIDENCE, summary: "The local service is ready." },
        },
      ],
    };
  };
