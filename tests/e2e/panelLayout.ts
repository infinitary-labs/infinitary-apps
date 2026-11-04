import { expect, type Page } from "@playwright/test";
import { movePanel } from "@shared/panelArrangement";
import type { SidePanelPlacement } from "@shared/plugins/manifest";
import type { Layout, PanelArrangement } from "@shared/preferences";

/**
 * The rails' one saved layout (INF-2344), read and written through the
 * window's own layout writer, the same path the captain's Settings take.
 */

/** The saved arrangement, once the core has written it in after launch. */
export async function savedArrangement(page: Page): Promise<PanelArrangement> {
  let arrangement: PanelArrangement | undefined;
  await expect
    .poll(async () => {
      arrangement = (await page.evaluate(() => window.infinitary.settings.getLayout())).arrangement;
      return arrangement !== undefined;
    })
    .toBe(true);
  if (!arrangement) throw new Error("The core wrote no arrangement");
  return arrangement;
}

/**
 * Moves one panel to a slot's middle, where a move without a neighbour
 * lands, and writes the other layout fields given in the same write.
 */
export async function movePanelTo(
  page: Page,
  id: string,
  slot: SidePanelPlacement,
  fields: Partial<Omit<Layout, "arrangement">> = {},
): Promise<void> {
  const arrangement = movePanel(await savedArrangement(page), id, { slot });
  const layout = await page.evaluate(() => window.infinitary.settings.getLayout());
  await page.evaluate((next) => window.infinitary.settings.setLayout(next), {
    ...layout,
    ...fields,
    arrangement,
  });
}
