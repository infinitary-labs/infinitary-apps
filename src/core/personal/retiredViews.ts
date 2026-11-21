import { SQL_VIEWS } from "@shared/sql";

/**
 * The line for a manifest naming views this version does not publish: the
 * app's data moved on (the panel reads a `_vN` past its two releases), the
 * panel is newer than the app, or the name was never one. Plain words,
 * naming what it asked for and what there is.
 */
export function retiredViewsLine(id: string, names: readonly string[]): string {
  const parts = (name: string) => {
    const match = /^(.*)_v([0-9]+)$/.exec(name);
    return { stem: match?.[1] ?? name, version: Number(match?.[2] ?? 0) };
  };
  const published = SQL_VIEWS.map(parts);
  const compared = names.map((name) => {
    const asked = parts(name);
    const current = published.find((view) => view.stem === asked.stem);
    return current ? Math.sign(asked.version - current.version) : null;
  });
  // i18n-exempt: a panel's manifest error, served to the agent building it, which stays English
  const why = compared.some((sign) => sign !== null && sign < 0)
    ? "this panel was written for an older version of the app's data"
    : compared.some((sign) => sign !== null && sign > 0)
      ? "this panel was written for a newer version of the app than this one"
      : "this panel asks for data the app does not publish";
  // i18n-exempt: the same manifest error line, served to the agent building the panel
  return `${id}/manifest.json sql: ${why} (${names.join(", ")}; this version publishes ${SQL_VIEWS.join(", ")})`;
}
