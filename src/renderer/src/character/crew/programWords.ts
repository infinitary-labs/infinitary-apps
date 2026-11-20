import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
/**
 * The words a program's ring summary reads (INF-1037), in a plain module a
 * journey can load: the count of its parts by state, as the captain wrote it,
 * "20 finished, 5 running, 0 waiting".
 */
export function partsCountWords(finished: number, running: number, waiting: number): string {
  return m.crewPartsCount({
    finished: formatNumber(finished),
    running: formatNumber(running),
    waiting: formatNumber(waiting),
  });
}
