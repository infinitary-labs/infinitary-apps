# A .env file

A `.env` file holds `NAME=value` lines; comments, blank lines, an `export` prefix and quoted or multi-line values are read as a `.env` loader reads them.
Infinitary reads the file itself, so you never open it.

## Which file

Move the file the captain names, by its absolute path, such as a project's `.env` in that project's folder.
Check only that it exists: `test -f '<path>'`. Never search for others.
A file whose values are encrypted (dotenvx, sops) holds no usable values: report it instead of bringing it.

## Bring

Leave `secrets` out, so Infinitary reads the file first and its card lists every name it found, for the captain to tick:

```sh
infinitary-secrets-axi bring --id dotenv-shop --reason 'Move the secrets in the .env file of the shop project into Secrets' --from '{"tool":".env file","source":{"file":"/Users/me/code/shop/.env"},"reads":"lines"}'
```

The card offers Read it first, then the names with their tick boxes; nothing is kept before the captain picks.
Names brought this way take no place: they are kept as the value used everywhere, and your report says so.
A second project's file with the same names would arrive as replacing the first project's values, so before bringing a second project's file this way, ask the captain on a card whether to go on.
When the captain named the secrets, or wants a project's place on them, list each one instead, with `place` where it belongs:

```sh
infinitary-secrets-axi bring --id dotenv-shop --reason 'Move the secrets in the .env file of the shop project into Secrets' --from '{"tool":".env file","source":{"file":"/Users/me/code/shop/.env"},"reads":"lines","secrets":[{"name":"STRIPE_KEY","place":"shop"}]}'
```

The file stays where it is, unchanged; say so in your report.
