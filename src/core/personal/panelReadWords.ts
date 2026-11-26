import type { PanelFailingRead, PanelRead } from "@shared/personal/manifest";

/** One read of a panel's, as the first mate's words name it (served text, English). */
export function panelReadWords(read: PanelRead): string {
  // i18n-exempt: served to the first mate and crew, never shown to a person
  if (read.kind === "background") return `its background job "${read.task}"`;
  // i18n-exempt: served to the first mate and crew, never shown to a person
  if (read.kind === "call") return `${read.place}'s ${read.action}`;
  // i18n-exempt: served to the first mate and crew, never shown to a person
  return `${read.place}'s ${read.event} event`;
}

/** One failing read with its span, as the first mate reads it. */
export function failingReadWords(row: PanelFailingRead): string {
  // i18n-exempt: served to the first mate and crew, never shown to a person
  return `${panelReadWords(row.read)} has failed since ${row.since}, ${row.tries} tries in a row`;
}
