import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedArgs } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * INF-2510, the captain's INF-1868 answer 2: "Only repositories the app
 * manages as projects, for example dotfiles-private while working on INF".
 * A crewmate working in one project opens its change in another project the
 * app manages, from the branch pushed there, reads its checks and offers it
 * on its completion card.
 */
export const OTHER_PROJECT_MARKER = "open the aliases change in dotfiles";
/** The other managed project, by the name the app lists it under. */
export const OTHER_PROJECT = "dotfiles-private";
/** The branch pushed to the other project, which the change opens from. */
export const OTHER_BRANCH = "fm/dotfiles-aliases";
export const OTHER_TITLE = "fix: keep the shell aliases";
export const OTHER_CARD_TITLE = "The shell aliases are kept";

const finishCard: ScriptedArgs<"emit_card"> = {
  title: OTHER_CARD_TITLE,
  body: completionCardBody(
    "<p>The captain asked for the shell aliases in the dotfiles project.</p>",
    "<p>The aliases file keeps the shell aliases.</p>",
    "<p>The shell started without the aliases.</p>",
    "<p>The shell starts with the aliases.</p>",
  ),
  actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
};

export const otherProjectChange: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !latestUserTail.includes(OTHER_PROJECT_MARKER))
      return undefined;
    const { results } = sinceLastUser(body);
    switch (results.length) {
      case 0:
        return {
          calls: [
            {
              name: "open_change",
              args: {
                title: OTHER_TITLE,
                body: "Keeps the shell aliases the captain asked for.",
                repository: OTHER_PROJECT,
                branch: OTHER_BRANCH,
              },
            },
          ],
        };
      case 1:
        return { calls: [{ name: "check_change", args: {} }] };
      case 2:
        return {
          calls: [
            { name: "emit_card", args: finishCard },
            { name: "report", args: { text: "The aliases change is ready to merge." } },
          ],
        };
      default:
        return { text: "The aliases change is offered to the captain." };
    }
  };
