# Automation on an integration's event

An Automation rule's `spec` admits a fifth kind, `event`, naming an integration by its id and one of the events it declares (`docs/automation.md`, "Events"), which `inf:automation:save` and `inf:automation:preview` accept and `automation.list` answers.
A rule gains an optional `when`, the words for what an event rule listens for, and a run an optional `events`, how many events it carried.
The integrations view gains `events` on each integration, what it can tell.
An older view never sends an event rule; it lists one the home holds with no words for its schedule, and draws no When choice for events.
