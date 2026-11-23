import type { Scenario } from "../mockProvider";

/**
 * Install by talking (one plugin vehicle, Phase A): "add the panel from
 * <full folder path>" -> ONE install_plugin call naming that folder, and no
 * card of the Firstmate's own - the host's consent card is the only one.
 */
export const ADD_PANEL_PROMPT_MARKER = "add the panel from ";

export const installPanel: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (hasToolResults || !latestUserTail.includes(ADD_PANEL_PROMPT_MARKER)) return undefined;
    const after = latestUserTail.split(ADD_PANEL_PROMPT_MARKER)[1] ?? "";
    const spec = after.split(/["\\\n]/)[0]?.trim() ?? "";
    return {
      calls: [
        {
          name: "install_plugin",
          args: { from: "path", spec, evidence: `add the panel from ${spec}` },
        },
      ],
    };
  };
