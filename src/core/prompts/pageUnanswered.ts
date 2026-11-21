import { browserCommand } from "../browser/commandWords";

/** How the wake for a page nothing answers at opens; a scripted stand-in recognizes it by it. */
export const PAGE_UNANSWERED_OPENING = "The captain opened your task's page in its browser";

/**
 * Nothing answers at the page the captain opened in a task's browser, in
 * its crewmate's words (docs/task-browser.md, "When nothing answers"): what
 * was observed, with the next move left to the crewmate. Served only to the
 * crewmate, so it stays English.
 */
export function pageUnansweredWords(facts: {
  site: string;
  url: string;
  start?: { command: string; exit?: number | null; ranOut?: true; log: string };
}): string {
  const start = facts.start;
  const ran = start
    ? ` Infinitary ran the --start command you saved for it, \`${start.command}\`, but ${start.ranOut ? "nothing answered within the seconds you gave, so it stopped it" : `it exited (code ${start.exit ?? "none"}) before anything answered`}; its output is in ${start.log}.`
    : "";
  return `${PAGE_UNANSWERED_OPENING} at ${facts.url} and is waiting there, but nothing answers at ${facts.site}: a connection to it was refused on the computer that runs this task, so the program that served it has stopped.${ran} If the captain should still see it, start it again, running it in the background so it outlives your command, and open ${facts.url} again with ${browserCommand("open <url>")}, or with ${browserCommand("open <url> --start '<command>' --within <seconds>")} so Infinitary starts it itself next time; the captain's view shows the page once it loads. You are told this once for this outage.`;
}
