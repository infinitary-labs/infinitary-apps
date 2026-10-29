# GitHub through GitHub CLI

The `inf:forges:sign-in-cli` request signs a GitHub host in through the person's own GitHub CLI, and answers whether the sign-in was kept.
The `inf:forges` view gains an optional `githubCli` flag, true where GitHub CLI is installed on the home, and each sign-in row an optional `way`, `cli` for a sign-in through GitHub CLI.
An older view never sees the flag or the field, so it offers no GitHub CLI line and shows such a sign-in as the app's own.
An older home refuses the request as unknown, and a view on it offers no GitHub CLI line because the flag never arrives.
