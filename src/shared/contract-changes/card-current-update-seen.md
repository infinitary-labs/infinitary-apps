Cards optionally carry `currentUpdateId` and `currentUpdateSeen`, identifying and acknowledging the exact released update separately from the lifecycle-wide `seen` fact.
The new `inf:cards:seen-update(cardId, lifecycleId, updateId)` request records that sighting and broadcasts the owner's current state.
The existing two-argument `inf:cards:seen` request and historical offer sightings keep their meanings and cannot acknowledge a newer same-offer answer.
The healthcheck optionally lists the home's named contract changes, matching the connection welcome.
Updated views send the new request only when the home advertises `card-current-update-seen`; otherwise they keep legacy offer sightings and local unread behavior.
Older native readers ignore the optional fields; older strict desktop readers receive snapshots omitting those fields on list, push and replay until their hello advertises this change.
Both retain existing card actions without any new version restriction.
An optional `interim` fact on message references keeps an interim author line from releasing a new update.
