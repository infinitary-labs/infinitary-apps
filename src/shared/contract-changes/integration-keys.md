# Integration keys

The home answers one new request, `inf:integrations:secret`, which keeps or forgets the captain's key for one of an integration's slots and answers with the integrations view.
The integrations view gains an optional `secrets` list on each integration, naming each slot and whether a value is kept for it, never the value.
A view without the change draws no keys and never asks; an integration whose kind declares no slot carries no list.
