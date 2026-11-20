import { describe, expect, it, vi } from "vitest";
import { ContributionError, ContributionRegistry } from "./registry";

type Item = { id: string; pluginId: string; order: number };

describe("ContributionRegistry", () => {
  it("refuses a duplicate id loudly, naming both owners", () => {
    const registry = new ContributionRegistry<Item>("card-kind");
    registry.register({ id: "note", pluginId: "firstmate", order: 0 });
    expect(() => registry.register({ id: "note", pluginId: "other", order: 0 })).toThrow(
      ContributionError,
    );
    expect(() => registry.register({ id: "note", pluginId: "other", order: 0 })).toThrow(
      'card-kind: "note" from "other" is already registered by "firstmate"',
    );
  });

  it("keeps the snapshot identity until a change, and notifies subscribers", () => {
    const registry = new ContributionRegistry<Item>("settings-section");
    const before = registry.list();
    expect(registry.list()).toBe(before);
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const remove = registry.register({ id: "a", pluginId: "p", order: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.list()).not.toBe(before);
    expect(Object.isFrozen(registry.list())).toBe(true);
    unsubscribe();
    remove();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale removal handle after the id was re-registered", () => {
    const registry = new ContributionRegistry<Item>("side-panel");
    const removeOld = registry.register({ id: "a", pluginId: "p", order: 0 });
    removeOld();
    registry.register({ id: "a", pluginId: "q", order: 1 });
    removeOld();
    expect(registry.get("a")?.pluginId).toBe("q");
  });
});
