A computer that runs work signs in to GitHub through its own GitHub CLI's sign-in.
Its forges in `inf:work:sign-ins` add an optional `githubCli`, true while GitHub CLI is installed there, and each sign-in row an optional `way`, `cli` for one made through it.
The home asks such a computer the new order `inf:sign-ins:forge-cli` with a host, and the computer answers whether it kept the sign-in, never a token; Settings asks it through the new request `inf:devices:forge-sign-in-cli`.
A computer without this change sends no `githubCli`, so the home offers it the code alone and never sends it the order.
