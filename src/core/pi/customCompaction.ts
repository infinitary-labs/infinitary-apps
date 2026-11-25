import type { CustomCompaction } from "@shared/customApi";

/**
 * The compaction each custom connection states for its models, by provider
 * and model id. The custom account owner is its one writer, as it registers
 * a connection's models; a rolling session reads it when it budgets
 * compaction, since Pi's model definition has no place for it.
 */
const stated = new Map<string, Map<string, CustomCompaction>>();

export function setCustomCompaction(
  provider: string,
  models: Iterable<[string, CustomCompaction]>,
): void {
  const kept = new Map([...models].filter(([, compaction]) => Object.keys(compaction).length));
  if (kept.size) stated.set(provider, kept);
  else stated.delete(provider);
}

export function customCompaction(provider: string, model: string): CustomCompaction | undefined {
  return stated.get(provider)?.get(model);
}
