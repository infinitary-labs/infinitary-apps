import { z } from "zod";

/**
 * The live reads a crewmate's card declared (`reads` on emit_card,
 * docs/ui-plugins.md "A card's reads"): names of the read catalog its
 * body's own script may subscribe to through `inf.subscribe`, as a panel's
 * manifest names them. The home checks each against the panels' list when
 * the card is emitted; the window grants only what the open card carries.
 * Plain names here, so a view built before a read joined that list still
 * reads the card.
 */
export const cardReadsSchema = z.array(z.string().min(1).max(64)).max(64);

/**
 * The views of the app's record a crewmate's card declared (`sql` on
 * emit_card): the grant its body's `sql` read runs under, as a panel's
 * manifest declares it. The home keeps only published views when the card
 * is emitted; plain names here keep the view list out of the phone's bundle.
 */
export const cardViewsSchema = z.array(z.string().min(1).max(64)).max(64);

/**
 * A card's live reads (`cards.live_reads_json`), spread into the card and its
 * offer: absent on every card that declared none, and on every card of the
 * first mate or the host.
 */
export const cardLiveReadsShape = {
  reads: cardReadsSchema.optional(),
  sql: cardViewsSchema.optional(),
};
