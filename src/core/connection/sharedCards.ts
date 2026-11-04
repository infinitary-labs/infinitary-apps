import { contractChange } from "./contractChanges";

/**
 * A peer that keeps shared-card contributions (docs/card-threads.md, "Shared
 * cards"): the expected revision, operation identity and named captain
 * message a write carries, the contributor on a thread line, and the
 * required-action text correction. An older peer would drop those fields and
 * write as if they were absent, so it is refused instead.
 */
export const SHARED_CARDS = contractChange("shared-cards");
