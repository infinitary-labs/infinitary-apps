import { contractChange } from "./contractChanges";

/**
 * A peer that keeps shared-card contributions (docs/card-threads.md, "Shared
 * cards"): the expected revision, operation identity and named captain
 * message a write carries, the contributor on a thread line, and the
 * required-action text correction. An older peer would drop those fields and
 * write as if they were absent, so it is refused instead.
 */
export const SHARED_CARDS = contractChange("shared-cards");

/**
 * A home that ends an answer on a crewmate's `signs_off` line (INF-2845,
 * `thread-sign-off.md`). An older home would drop the mark and keep the
 * line as an ordinary answer, so a mark sent there is refused instead.
 */
export const THREAD_SIGN_OFF = contractChange("thread-sign-off");
