import { PERSONAL_WORKSPACE_NAME } from "../../../src/core/paths";
import type { Scenario } from "../mockProvider";
import { contextRepos } from "../providerRequest";

export const CONFIGURE_REPO_PROMPT_MARKER = "make the repository ";

export const UNREGISTER_REPO_PROMPT_MARKER = "unregister the repository ";

export const AMBIGUOUS_PROMPT_MARKER = "which project should take this";

/** The one decision card the mock Firstmate asks with on an ambiguous request. */
export const MOCK_WHICH_PROJECT_TITLE = "Which project?";

/**
 * The first mate's project moves on the captain's words: unregister a
 * repository, configure one, and ask which project takes an ambiguous ask.
 */
export const workspaceInference: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(UNREGISTER_REPO_PROMPT_MARKER)) {
      const named = latestUserTail.match(/unregister the repository ([\w][\w.-]*)/)?.[1] as string;
      const repo = contextRepos(body).find(([name]) => name === named);
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-remove",
              value: { repoId: repo?.[1] ?? named },
              evidence: latestUserTail,
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(CONFIGURE_REPO_PROMPT_MARKER)) {
      const named = latestUserTail.match(
        /make the repository ([\w][\w.-]*) autonomous/,
      )?.[1] as string;
      const repo = contextRepos(body).find(([name]) => name === named);
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-settings",
              on_words: true,
              value: { repoId: repo?.[1] ?? named, changes: { autonomy: true } },
              evidence: latestUserTail,
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(AMBIGUOUS_PROMPT_MARKER)) {
      // The ask path: one concise decision card naming the plausible
      // repositories from the context block.
      const repoNames = contextRepos(body)
        .map(([name]) => name)
        .filter((name) => name !== PERSONAL_WORKSPACE_NAME)
        .slice(0, 2);
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: MOCK_WHICH_PROJECT_TITLE,
              body:
                "<p>Two repositories plausibly match this request.</p>" +
                `<ul>${repoNames.map((name) => `<li>${name}</li>`).join("")}</ul>`,
              actions: repoNames.map((name, index) => ({
                id: name,
                label: name,
                ...(index === 0 ? { default: true } : {}),
              })),
            },
          },
        ],
      };
    }
    return undefined;
  };
