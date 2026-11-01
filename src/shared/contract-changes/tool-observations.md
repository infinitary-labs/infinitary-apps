# Completed-operation observations

A work computer may send owner-only `tool_observation` events with ordered compact argument/result digests and durable source references.
It sends them only to a home listing `tool-observations`; an older home receives the existing display events without repetition coverage.
The home consumes the facts through task-owned indexed state and the existing durable inbox, never through report sorting.
