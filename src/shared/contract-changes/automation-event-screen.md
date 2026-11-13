An event rule's spec optionally carries `waitsFor`, what the rule waits for in words, and a run in an automation's history optionally carries `screened`, how many of its events the event screen kept from the first mate (`docs/automation.md`, "The event screen").
A run whose every event was screened reads as `cancelled` with no `cancelReason`, so an older view shows it as taken back before the first mate read it.
An older view does not show `waitsFor`, and saving the rule from its Settings sheet leaves the rule without it, so the rule is no longer screened.
