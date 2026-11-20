Adds the orders `inf:sign-ins:forge-key` and `inf:sign-ins:forge-browser`, which sign a computer that runs work in to GitLab or GitHub Enterprise with a key or GitLab's browser code, kept only on that computer.
Adds optional `servers` to a computer's forges, and an optional `server` to each of its forge hosts and sign-ins, plus a sign-in's public `applicationId`.
Adds the requests `inf:devices:forge-sign-in-key` and `inf:devices:forge-sign-in-browser`, and lets `inf:sign-ins:forge-cli` name a GitHub Enterprise host that computer is not yet signed in to.
A computer without the change lists no `servers`, so the home offers it github.com alone and sends it none of these orders.
A home without the change never sends them, so the computer keeps signing in to github.com alone from there.
