import { BROWSER_COMMAND } from "../../../src/core/browser/commandWords";
import { type Scenario, SPAWN_PROMPT_MARKER, sinceLastUser } from "../mockProvider";
import { latestServedTurn } from "../providerRequest";

/** Approved direction C: the model reads the actual page without asking to sign in again. */
export const SAVED_SITE_VISIT = "read the saved club at ";

/** The model's short task title; the full address belongs in its goal and captain's words. */
export function savedSiteTitle(address: string): string {
  return `Read the club: ${new URL(address).searchParams.get("visit")}`;
}
export const savedSiteVisit: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (!wantsStream || !body.includes(SAVED_SITE_VISIT)) return undefined;
    const { results } = sinceLastUser(body);
    if (isFirstmate) {
      const turn = latestServedTurn(body);
      const words =
        turn?.segments.find((part) => part.kind === "user" && part.origin === "captain")?.body ??
        "";
      if (!words.includes(SPAWN_PROMPT_MARKER)) return undefined;
      // Read only the captain's framed words, never an earlier task quoted by context.
      const visits = [
        ...words.matchAll(
          /read the saved club at (http:\/\/127\.0\.0\.1:\d+\/(?:\?visit=[a-z-]+)?)/g,
        ),
      ];
      const visit = visits.at(-1)?.[1];
      if (!visit) return undefined;
      if (results.length > 0) return { text: "The crew is reading the club page." };
      const title = savedSiteTitle(visit);
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title,
              goal: `Read the club page at ${visit} and report its actual text.`,
              user_words: `${SPAWN_PROMPT_MARKER} ${SAVED_SITE_VISIT}${visit}`,
              shape: { rigor_ask: "quick" },
            },
          },
        ],
      };
    }
    const url = body.match(
      /read the saved club at (http:\/\/127\.0\.0\.1:\d+\/(?:\?visit=[a-z-]+)?)/,
    )?.[1];
    if (!url) return undefined;
    if (results.length === 0)
      return {
        calls: [
          {
            name: "bash",
            args: { command: `${BROWSER_COMMAND} open ${url}`, description: "Read the club page" },
          },
        ],
      };
    if (results.length === 1)
      return { calls: [{ name: "report", args: { text: results[0] ?? "No page reading" } }] };
    return { text: "Reported the club page." };
  };
