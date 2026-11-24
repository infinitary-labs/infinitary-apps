import type { IntegrationKind } from "@shared/integrations";

/**
 * What the integrations service tells an unsafe data reader's model
 * (docs/integrations.md, "A reader's integrations"). Every line here is
 * served only to that model, never shown to a person, so it stays English
 * (docs/i18n.md, "What stays English").
 */

/**
 * The label an unsafe data reader's integration answers are fenced with
 * when their kind and connection declare none: every answer it receives is
 * marked whole.
 */
export const READER_INTEGRATION_FENCE = "integration-data";

/**
 * The kinds that reach where projects live: a reader reaches its own
 * project through its read tool alone, so it never calls these.
 */
export const READER_REFUSED_KINDS: ReadonlySet<IntegrationKind> = new Set([
  "github",
  "gitlab",
  "github-enterprise",
  "bitbucket",
]);

export const READER_WORDS = {
  // i18n-exempt: served only to the reader's model.
  forge:
    "Refused: an unsafe data reader reaches where its own project lives through github_read alone, never through an integration. Nothing was read.",
  // i18n-exempt: served only to the reader's model, as a kept ask's outcome.
  onlyOnce: "an unsafe data reader's call runs only once, on Only this time, so it did not run",
  // i18n-exempt: served only to the reader's model.
  file: (name: string, action: string) =>
    `Not run: ${name}'s ${action} saves a file into a task's hand-over folder, which an unsafe data reader cannot open.`,
  // i18n-exempt: served only to the reader's model.
  kept: (name: string, action: string, ask: string, joined: boolean) =>
    `Not run: this task reads words strangers can write, so ${name}'s ${action} waits for the captain. ${joined ? `The app added ask ${ask} to this task's approval card already waiting.` : `The app raised this task's approval card for ask ${ask}.`} Do not emit another card or repeat the call. You will hear the outcome once through write-answered.`,
} as const;
