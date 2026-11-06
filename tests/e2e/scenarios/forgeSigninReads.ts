import {
  READS_ANYWHERE_MARKER,
  WRITE_ASK_ANSWER_MARKER,
  WRITE_ASK_CARD_TITLE,
  WRITE_ASK_MARKER,
  WRITE_ASK_SENT_WAKE,
  writeAskCall,
} from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * The crewmate's reads and kept writes through the project's sign-in
 * (FI3-1571 pieces 3 and 4): reads past the old read list, and a write
 * that is kept, asked for on a card, and sent once.
 */
export const forgeSigninReads: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (latestUserTail.includes(READS_ANYWHERE_MARKER)) {
      // FI3-1571 piece 3: reads past the old read list, from a project
      // kept on this computer, through the github.com sign-in.
      const { results } = sinceLastUser(body);
      const next = JSON.parse(results[1] ?? "{}").nextPath as string | undefined;
      const reads = [
        "/notifications",
        "/repos/octo/website/pulls?per_page=1",
        next ?? "/repositories/0/pulls",
        "/graphql",
      ];
      const path = reads[results.length];
      if (path) return { calls: [{ name: "github_read", args: { path } }] };
      if (results.length === reads.length) {
        return {
          calls: [
            {
              name: "report",
              args: {
                text: results.join("\n"),
                summary: "Read the notifications and both pages through the github.com sign-in.",
              },
            },
          ],
        };
      }
      return { text: "Reads reported." };
    }
    if (
      latestUserTail.includes(WRITE_ASK_MARKER) ||
      latestUserTail.includes(WRITE_ASK_ANSWER_MARKER)
    ) {
      // FI3-1571 piece 4: a write that is kept, then asked for on a card.
      const { results } = sinceLastUser(body);
      const ask = results[0]?.match(/Kept as ask (wa[0-9a-f]+)/)?.[1];
      if (!results.length) {
        return { calls: [{ name: "github_write", args: writeAskCall(latestUserTail) }] };
      }
      if (results.length === 1 && ask) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "write-ask",
                title: WRITE_ASK_CARD_TITLE,
                body: "<p>This write is outside what I may send myself, so it waits on you.</p><p>It records what this task found where the people who need it will look.</p>",
                actions: [
                  { id: "send", effect: { kind: "request_write", ask } },
                  { id: "not-now", label: "Not now" },
                ],
              },
            },
          ],
        };
      }
      if (results.length <= 2) {
        return {
          calls: [
            {
              name: "report",
              args: { text: results.join("\n"), summary: "The write waits on the captain's card." },
            },
          ],
        };
      }
      return { text: "The write is waiting on the captain." };
    }
    if (latestUserTail.includes(WRITE_ASK_SENT_WAKE)) {
      // Once sent, the same ask on a revised card sends nothing again.
      const { results } = sinceLastUser(body);
      const ask = body.match(/Kept as ask (wa[0-9a-f]+)/)?.[1] ?? "";
      if (!results.length) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "write-ask",
                title: WRITE_ASK_CARD_TITLE,
                body: "<p>Asking again for the same write.</p><p>The first answer did not reach me, so I am checking it went.</p>",
                actions: [
                  { id: "send", effect: { kind: "request_write", ask } },
                  { id: "not-now", label: "Not now" },
                ],
              },
            },
          ],
        };
      }
      if (results.length === 1) {
        return {
          calls: [
            {
              name: "report",
              args: {
                text: `Asking again: ${results[0]}\nThe answer I heard: ${latestUserTail.match(/answered (\d{3})/)?.[1] ?? "none"}`,
                summary: "The captain sent the write once.",
              },
            },
          ],
        };
      }
      return { text: "The write was sent." };
    }
    return undefined;
  };
