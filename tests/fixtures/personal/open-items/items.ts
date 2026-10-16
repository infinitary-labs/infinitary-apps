import type { StoreValue } from "@firstmate/contracts";

/** A local helper, to prove a panel's relative import compiles and serves. */
export function asItems(value: StoreValue | undefined): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
