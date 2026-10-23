/**
 * The words a program's ring summary reads (INF-1037), in a plain module a
 * journey can load: the count of its parts by state, as the captain wrote it,
 * "20 finished, 5 running, 0 waiting".
 */
export function partsCountWords(finished: number, running: number, waiting: number): string {
  return `${finished} finished, ${running} running, ${waiting} waiting`;
}
