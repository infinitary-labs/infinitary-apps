# Secrets on a computer that keeps a copy

A home can keep its Secrets with the copy on a computer that keeps one, sealed with that computer's own lock (docs/devices.md, "Secrets on a computer that keeps a copy").
The order `inf:standby:lock` is asked of a computer that keeps a copy, only when its hello lists this change; it asks the person there to confirm once and answers its lock's public half.
A view asks `inf:standby:keep-secrets`; a home from before answers none of it, and a view from before shows no Keep Secrets there.
A home's `inf:standby:views` carries each copy's `secrets` and its `inf:standby:ready` its `missing` sign-ins; a view from before reads neither.
