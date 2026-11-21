import { browserCommand } from "../browser/commandWords";

/** How the wake for a page nothing answers at opens; a scripted stand-in recognizes it by it. */
export const PAGE_UNANSWERED_OPENING = "The captain opened your task's page in its browser";

/**
 * Nothing answers at the page the captain opened in a task's browser, in
 * its crewmate's words (docs/task-browser.md, "When nothing answers"): what
 * was observed, with the next move left to the crewmate. Served only to the
 * crewmate, so it stays English.
 */
export function pageUnansweredWords(facts: { site: string; url: string }): string {
  return `${PAGE_UNANSWERED_OPENING} at ${facts.url} and is waiting there, but nothing answers at ${facts.site}: a connection to it was refused on the computer that runs this task, so the program that served it has stopped. If the captain should still see it, start it again, running it in the background so it outlives your command, and open ${facts.url} again with ${browserCommand("open <url>")}; the captain's view shows the page once it loads. You are told this once for this outage.`;
}
