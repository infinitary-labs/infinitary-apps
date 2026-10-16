import { COMPLETION_CARD_HEADINGS } from "../../src/shared/cardHeadings";

/**
 * Fixture markup only; each caller supplies its task's own section content.
 * A fixture that shows no picture states why, in a hidden sentence, so it
 * clears the card check's picture rule (contract v4.69) without drawing.
 */
export function completionCardBody(
  why: string,
  changed: string,
  before: string,
  after: string,
): string {
  const sections = [
    why,
    changed,
    before,
    after.includes("<img")
      ? after
      : `${after}<p data-inf-no-picture hidden>This fixture shows no picture.</p>`,
  ];
  return COMPLETION_CARD_HEADINGS.map(
    (heading, index) => `<h3>${heading}</h3>${sections[index]}`,
  ).join("");
}
