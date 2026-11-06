import { SETUP_CARD_FAILED_WORDS } from "../../../src/core/orchestrator/captainWakes";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * The agent-operated fleet: "manage my folder at <path>" (app_change
 * project-setup adopt), "manage the remote repository at <url>" (app_change
 * project-setup clone) and "start a new project <name>" (app_change
 * project-setup init) each make the mock Firstmate set up one project.
 */
export const ADOPT_REPO_PROMPT_MARKER = "manage my folder at ";
export const CLONE_REPO_PROMPT_MARKER = "manage the remote repository at ";
export const INIT_REPO_PROMPT_MARKER = "start a new project ";

/** The first mate adopts, clones or starts the named project, and offers a sign-in when a clone needs one. */
export const projectSetup: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes(ADOPT_REPO_PROMPT_MARKER)) {
      const path = latestUserTail.match(/manage my folder at ([^"\\]+)/)?.[1]?.trim() as string;
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-setup",
              value: { kind: "adopt", path },
              evidence: latestUserTail,
            },
          },
        ],
      };
    }
    // The captain's Add project on a clone's setup card could not
    // clone it without a sign-in: the card's answer carries the
    // typed refusal, and the Firstmate offers its ways on one card.
    if (latestUserTail.includes(SETUP_CARD_FAILED_WORDS)) {
      const json = sinceLastUser(body).user.match(/```json\n([\s\S]*?)\n```/)?.[1];
      const refusal = json ? JSON.parse(json) : undefined;
      if (refusal?.refused === "not-signed-in") {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: "Sign in before cloning your project",
                body: "<p>The app needs your sign-in before it can clone this project.</p><p>The clone failed without your GitHub sign-in. Sign in opens Projects with a code, then you can try again.</p>",
                standalone: true,
                // A clone has no project to keep on this Mac, so its one
                // way out stands beside a choice to leave it for now: a
                // decision gives 2 or 3 actions.
                actions: [
                  ...refusal.ways.map(
                    (
                      way: {
                        label: string;
                        effect: { kind: string; target: string; signIn: string };
                      },
                      index: number,
                    ) => ({
                      id: `clone-sign-in-${index}`,
                      label: way.label,
                      effect: {
                        kind: way.effect.kind,
                        target: way.effect.target,
                        sign_in: way.effect.signIn,
                      },
                      default: index === 0,
                    }),
                  ),
                  ...(refusal.ways.length < 2
                    ? [{ id: "clone-later", label: "Leave it for now" }]
                    : []),
                ],
              },
            },
          ],
        };
      }
    }
    if (latestUserTail.includes(CLONE_REPO_PROMPT_MARKER)) {
      const origin = latestUserTail
        .match(/manage the remote repository at ([^"\\]+)/)?.[1]
        ?.trim() as string;
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-setup",
              value: { kind: "clone", origin },
              evidence: latestUserTail,
            },
          },
        ],
      };
    }
    if (latestUserTail.includes(INIT_REPO_PROMPT_MARKER)) {
      const name = latestUserTail.match(/start a new project ([\w.-]+)/)?.[1] as string;
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "project-setup",
              value: { kind: "init", name },
              evidence: latestUserTail,
            },
          },
        ],
      };
    }
    return undefined;
  };
