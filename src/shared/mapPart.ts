/**
 * The Advanced architecture runbook's map part (`docs/runbooks.md`): a card
 * part whose JSON data block is the only thing filled. A crewmate fills it on
 * a card of its own; the host fills it on a merge card from a story's map view
 * (`docs/forge.md`, "A map view").
 */

const OPEN = '<script type="application/json" data-map>';

/** The part with its data block replaced by `block`, marked packed when it is deflated and in base64. */
export function fillMapPart(part: string, block: string, packed = false): string {
  const at = part.indexOf(OPEN);
  const end = part.indexOf("</script>", at);
  if (at < 0 || end < 0) throw new Error("The map part has no data block to fill.");
  const opening = packed ? OPEN.replace("data-map>", "data-map data-packed>") : OPEN;
  return `${part.slice(0, at)}${opening}\n${block}\n${part.slice(end)}`;
}
