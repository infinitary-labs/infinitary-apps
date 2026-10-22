# Integrations

The home answers four new requests, `inf:integrations:list`, `inf:integrations:configure`, `inf:integrations:remove` and `inf:integrations:check`, and sends one new push, `inf:integrations`, each carrying the integrations view (`src/shared/integrations.ts`).
A view that lists the change can draw Settings -> Integrations; one without it never asks, and GitHub's sign-in stays reachable through the existing forge requests.
