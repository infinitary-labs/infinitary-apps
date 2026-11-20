# Automic Vault

Automic Vault keeps secrets in the macOS Keychain and never prints one.
It hands secrets only to a program it starts (`av inject +NAME ... -- <program>`), after its own approval window names the asking and receiving programs.
A bring makes Infinitary start `av inject` with `/usr/bin/env -0` as the receiving program and read what it prints, so the captain presses twice: once on Infinitary's card and once in Automic Vault's window.
One name can hold a value used everywhere (Automic Vault's Global Value) and a value for each project folder (a Project Value); Automic Vault picks the nearest project folder at or above the folder the command runs in, and the global value when none matches.

This recipe follows Automic Vault's published documents; it has not been tried against the app yet, so say in your report what happened at each step.

## Names

1. Check that it is installed on this computer: `av --version`. If it is missing, report that and stop.
2. Check whether this version knows project values: `av list --project-directory=/ --json`.
   A version that answers with a usage line and exit code 2 is an older one, with no project values, no `--json` and no descriptor mode: follow "An older Automic Vault" below instead of the rest of this section.
3. Names with the value used everywhere: that same `av list --project-directory=/ --json`.
   It prints an array of `name`, `source` (`global`, `project` or `missing`) and, for a project value, `projectDirectory`; never a value.
   Keep the names whose `source` is `global`.
4. For each Infinitary project, by its folder from the `tasks` tool: `av list --project-directory='<project folder>' --json`.
   Keep the names whose `source` is `project`: they are that project's values.
   A `projectDirectory` above the project's folder is a value several folders share; it is still the value this project uses, so bring it with this project's place.

Each `av list` may raise Automic Vault's own approval window on this Mac; the captain approves it there.
Automic Vault never hands out its hardened sign-ins, SSH keys or GPG keys: they are out of scope.

## Bring

One bring for the value used everywhere, run in `/`, with no place:

```sh
infinitary-secrets-axi bring --id av-global --reason 'Move the secrets the captain keeps in Automic Vault into Secrets' --from '{"tool":"Automic Vault","source":{"run":["av","inject","--allow-missing-keys","+API_TOKEN","+DATABASE_URL","--","/usr/bin/env","-0"],"folder":"/"},"reads":"env0","secrets":[{"name":"API_TOKEN"},{"name":"DATABASE_URL"}]}'
```

One bring per project with project values, run in that project's folder, each secret with the project's name as its place:

```sh
infinitary-secrets-axi bring --id av-shop --reason 'Move the Automic Vault values of the shop project into Secrets' --from '{"tool":"Automic Vault","source":{"run":["av","inject","--allow-missing-keys","+API_TOKEN","--","/usr/bin/env","-0"],"folder":"/Users/me/code/shop"},"reads":"env0","secrets":[{"name":"API_TOKEN","place":"shop"}]}'
```

Every name of one bring goes in one `av inject`, so one approval in Automic Vault covers them all.
Keep `--allow-missing-keys` in every bring: without it, one name Automic Vault does not hold fails the whole bring, and with it that name alone ends `not-found`.
A name it holds but refuses or cannot read still fails the whole bring, even with the flag.
Bring the projects one at a time: wait for each result before the next card.

## Names the receiving program keeps, and large values

The program Infinitary starts keeps a few of its own variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TZ`, `TMPDIR`, `TERM`).
A secret with one of those names goes on its own through Automic Vault's descriptor mode, read as one exact value:

```sh
infinitary-secrets-axi bring --id av-global-tmpdir --reason 'Move the Automic Vault secret named TMPDIR into Secrets' --from '{"tool":"Automic Vault","source":{"run":["av","inject","--mode=fd","+TMPDIR:3","--","/bin/cat","/dev/fd/3"],"folder":"/"},"reads":"value","secrets":[{"name":"TMPDIR"}]}'
```

Descriptor mode needs a fresh approval in Automic Vault each time, accepts no `--allow-missing-keys`, and each value must fit a pipe's buffer.
A bring that ends `failed` carries only its exit code, which cannot tell values too large for the environment from a refused name or a declined approval in Automic Vault's window.
Report the exit code and ask the captain once on a card before splitting its names across smaller brings, since each smaller bring raises one more card and approval.
A single value too large for both the environment and a pipe fits no bring: report its name instead.

## An older Automic Vault

An older version (such as 2.7) keeps only values used everywhere, so there are no project values to bring.
Its `av list` prints the saved names; bring them all in one bring with no place, run in `/`, as the value used everywhere:

```sh
infinitary-secrets-axi bring --id av-global --reason 'Move the secrets the captain keeps in Automic Vault into Secrets' --from '{"tool":"Automic Vault","source":{"run":["av","inject","+API_TOKEN","+DATABASE_URL","--","/usr/bin/env","-0"],"folder":"/"},"reads":"env0","secrets":[{"name":"API_TOKEN"},{"name":"DATABASE_URL"}]}'
```

Leave out `--allow-missing-keys`: the names come straight from `av list`, and this recipe has not confirmed an older version takes the flag.
If the bring ends `failed`, report its exit code and ask the captain once on a card before bringing the names one per bring to find the one that fails, since each raises one more card and approval.
It has no descriptor mode, so a secret named like one of the receiving program's own variables cannot be brought: report its name.
Say in your report that project values need a newer Automic Vault, which the captain can install to move them.
