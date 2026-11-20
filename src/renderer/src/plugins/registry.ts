import type { ContributionSlot } from "@shared/plugins/manifest";

/**
 * One registry per contribution slot (docs/ui-plugins.md). A registry is a
 * keyed set with two properties the host leans on:
 *
 * - ids are unique, and a duplicate is refused loudly with the owner named;
 * - `list()` is a frozen snapshot whose identity changes only on a change,
 *   so React can subscribe with `useSyncExternalStore` and nothing else in
 *   the app has to know when a contribution arrives.
 */

export type Contribution = {
  readonly id: string;
  /** The manifest id of the plugin that contributed it. */
  readonly pluginId: string;
};

export class ContributionError extends Error {
  constructor(
    readonly slot: ContributionSlot,
    message: string,
  ) {
    super(`${slot}: ${message}`);
    this.name = "ContributionError";
  }
}

export class ContributionRegistry<T extends Contribution> {
  private readonly items = new Map<string, T>();
  private snapshot: readonly T[] = Object.freeze([]);
  private readonly listeners = new Set<() => void>();

  constructor(readonly slot: ContributionSlot) {}

  /** Registers one contribution; the returned function removes it again. */
  register(item: T): () => void {
    const existing = this.items.get(item.id);
    if (existing) {
      throw new ContributionError(
        this.slot,
        `"${item.id}" from "${item.pluginId}" is already registered by "${existing.pluginId}"`,
      );
    }
    this.items.set(item.id, item);
    this.publish();
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id);
        this.publish();
      }
    };
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** Stable until the next registration or removal, in registration order. */
  readonly list = (): readonly T[] => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(): void {
    this.snapshot = Object.freeze([...this.items.values()]);
    for (const listener of this.listeners) listener();
  }
}
