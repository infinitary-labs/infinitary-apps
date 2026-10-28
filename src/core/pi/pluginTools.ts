import { HERE } from "@shared/deviceNames";
import { Type } from "typebox";
import type { PluginInstallRequest } from "../plugins/pluginInstaller";
import { boundTool, stringEnum } from "../session/tools";

/**
 * The Firstmate's `install_plugin` tool (one plugin vehicle, Phase A item
 * 3; captain's A2a: install by talking). "Add the token watch panel from
 * npm" is ONE call naming where it comes from; the host fetches it, pins
 * it, checks it, and puts one consent card in front of the captain. The
 * tool never adds anything itself: only the captain's click on that card
 * does, so the tool's text tells the Firstmate to say nothing more.
 *
 * Captain-turn only, like `personalize remove`: code from elsewhere comes
 * in on his word, never on a scheduled or operational wake. Refusals are
 * tool text, never throws.
 */
export type InstallPluginDelegate = {
  install: (request: PluginInstallRequest) => Promise<string>;
  isCaptainTurn: () => boolean;
};

type Params = {
  from: PluginInstallRequest["source"];
  spec: string;
  evidence: string;
  action?: "add" | "remove";
};

export function createInstallPluginTool(delegate: InstallPluginDelegate) {
  return boundTool({
    name: "install_plugin",
    label: "Add a panel or runbook",
    description: [
      `Add a panel or runbook on the captain's word: from npm (a package, optionally @version), a git address (optionally #tag, branch or commit), or a folder on ${HERE.this} (a full path).`,
      "The host fetches, pins and checks it; only the captain's consent card adds it. Say nothing more.",
      "Runbooks carry guidance, HTML parts and pictures, not scripts. A declared replacement turns the named built-in off.",
      "A panel inside stays inert: add its folder separately for its own consent. Panel updates with unchanged grants need no new card; runbook updates always ask.",
      "To remove an added runbook, use action remove and its id as spec. Acts only on the captain's own turn.",
    ].join(" "),
    parameters: Type.Object({
      from: Type.Optional(stringEnum(["npm", "git", "path"])),
      action: Type.Optional(stringEnum(["add", "remove"])),
      spec: Type.String({
        description:
          "The package, git address or full folder path to add; the added runbook id to remove",
      }),
      evidence: Type.String({ description: "The captain's words that asked for this" }),
    }),
    run: async (params) => {
      const { from = "path", spec, action } = params as Params;
      if (!delegate.isCaptainTurn()) {
        return {
          text: "Only the captain's own turn adds or removes a panel or runbook from elsewhere. Surface it to the captain instead.",
        };
      }
      if (from !== "npm" && from !== "git" && from !== "path") {
        return { text: `Unknown source "${String(from)}". Use npm, git, or path.` };
      }
      return {
        text: await delegate.install({
          source: from,
          spec: String(spec ?? ""),
          ...(action ? { action } : {}),
        }),
      };
    },
  });
}
