/**
 * The wake the Heartbeat runbook asks for by naming it in its manifest's
 * `wakes` (docs/runbooks.md, "Built-ins"; docs/automation.md, "The
 * heartbeat"): while any runbook that is on names it, the host keeps one
 * rule that brings the first mate a beat. The host never names the runbook
 * that asks; a personal copy keeps the wake.
 */
export const HEARTBEAT_WAKE = "heartbeat";

/**
 * The id of the one rule the heartbeat wake brings. A rule anyone makes gets
 * an eight-character random id, so this id never names another rule, and a
 * rule saved under it reads as brought with no column of its own.
 */
export const HEARTBEAT_RULE_ID = "heartbeat";
