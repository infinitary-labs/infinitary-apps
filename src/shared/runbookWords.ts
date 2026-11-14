/** The Runbooks tab's words, shared with its keyboard journeys. */
export const RUNBOOK_VIEW_NOTE =
  "View a read-only temporary copy. Ask the first mate to customize it for you.";
export const RUNBOOK_EXAMPLES = [
  "Give every crewmate a skill for writing release notes in plain words.",
  "Make a runbook that tells the first mate I prefer short answers.",
  "Copy Common workflows and make it always plan before building.",
  "Add the runbook at a web address or folder someone shared.",
] as const;

/** The runbooks in one line, as the phone's Settings row says them: "5 on", then "2 off" when any is. */
export function runbooksSummary(books: readonly { enabled: boolean; error?: string }[]): string {
  const usable = books.filter((book) => !book.error);
  const on = usable.filter((book) => book.enabled).length;
  const off = usable.length - on;
  return off > 0 ? `${on} on · ${off} off` : `${on} on`;
}
