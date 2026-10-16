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
};

export function createInstallPluginTool(delegate: InstallPluginDelegate) {
  return boundTool({
    name: "install_plugin",
    label: "Add a panel",
    description: [
      "Add a panel someone else made, on the captain's word: from npm (a package, optionally",
      `@version), a git address (optionally #tag, branch or commit), or a folder on ${HERE.this}`,
      "(a full path). The host fetches and pins it, checks it can be held, and asks the",
      "captain on one card what it can read; it goes in only if he says yes there, with one",
      "feed line. An unchanged ask updates a panel already added without asking again.",
      "Acts only on the captain's own turn.",
    ].join(" "),
    parameters: Type.Object({
      from: stringEnum(["npm", "git", "path"]),
      spec: Type.String({
        description: "The package spec, git address, or full folder path, as the captain named it",
      }),
      evidence: Type.String({ description: "The captain's words that asked for this" }),
    }),
    run: async (params) => {
      const { from, spec } = params as Params;
      if (!delegate.isCaptainTurn()) {
        return {
          text: "Only the captain's own turn adds a panel from elsewhere. Surface it to the captain instead.",
        };
      }
      if (from !== "npm" && from !== "git" && from !== "path") {
        return { text: `Unknown source "${String(from)}". Use npm, git, or path.` };
      }
      return { text: await delegate.install({ source: from, spec: String(spec ?? "") }) };
    },
  });
}
