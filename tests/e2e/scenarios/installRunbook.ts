import type { Scenario } from "../mockProvider";

export const ADD_RUNBOOK_PROMPT_MARKER = "add the runbook from ";
export const REMOVE_RUNBOOK_PROMPT_MARKER = "remove the runbook ";

/** INF-1177: talking uses the existing installer; only its host card adds guidance. */
export const installRunbook: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const remove = latestUserTail.includes(REMOVE_RUNBOOK_PROMPT_MARKER);
    const marker = remove ? REMOVE_RUNBOOK_PROMPT_MARKER : ADD_RUNBOOK_PROMPT_MARKER;
    if (!latestUserTail.includes(marker)) return undefined;
    const spec =
      latestUserTail
        .split(marker)[1]
        ?.split(/["\\\n]/)[0]
        ?.trim() ?? "";
    return {
      calls: [
        {
          name: "install_plugin",
          args: {
            from: "path",
            spec,
            evidence: marker + spec,
            ...(remove ? { action: "remove" } : {}),
          },
        },
      ],
    };
  };
