# Bitbucket sign-in

The home integrations view admits the integration kind `bitbucket`, one row for bitbucket.org's sign-in with its `host`.
A forges view lists a server of kind `bitbucket` in its `servers`, and a sign-in by key may name that kind; both are strings, so no shape changes there.
Like the GitLab and GitHub Enterprise addition, the integrations view is home-only and an older paired view receives its push unchecked.
A computer without the change lists no `bitbucket` server, so the home offers it no Bitbucket sign-in and never sends it `inf:sign-ins:forge-key` for one.
A home without the change never offers a computer's Bitbucket sign-in, so the computer keeps the person's own git sign-in for bitbucket.org as before.
`inf:forges:projects-listed` answers a host's projects with `complete`, false where the listing stopped at its page budget; `inf:forges:projects` still answers the projects alone.
A view of an older home has no such request there, so it lists through `inf:forges:projects` and says nothing about a listing cut short.
