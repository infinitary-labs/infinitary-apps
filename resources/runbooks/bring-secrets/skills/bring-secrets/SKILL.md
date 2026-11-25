---
name: bring-secrets
description: Move secrets the captain keeps in another tool (Automic Vault, a .env file, the macOS Keychain) into Secrets with no agent seeing a value. Read only when your task is such a move.
---

# Moving secrets into Secrets

The captain keeps secrets in another tool and wants them in Infinitary's Secrets.
You never see, hold or pass on a value: you find the names, and `infinitary-secrets-axi bring` asks Infinitary to run the other tool's command or read the named file itself.
Infinitary raises its own card with the exact command or file, your reason and one tick box per secret; on the captain's press it reads the output inside Infinitary, keeps each ticked value in Secrets, and tells you names, references and outcomes only.
Run `infinitary-secrets-axi bring --help` for the exact `--from` shape before your first bring.

## The rules

1. Never run a command in your own shell that prints, copies, exports or saves a value: no `cat`, `grep`, `head`, `source` or editor on a secrets file, no `security ... -w` or `-g`, no `av inject ... -- sh -c 'echo ...'`, no `printenv` or `env` inside another tool's run.
   Only a bring runs a command that hands over values, and its output never reaches your shell.
2. Never open a secrets file. Check only that it exists (`test -f`); its names reach you on Infinitary's card.
3. List names with the tool's own names-only command, as its recipe says, and nothing else.
4. Never search the disk for secrets files or tools: move what the captain named or what the recipe lists.
5. One bring per source: one command in one folder, or one file, with every name it holds on one card.
6. Leave the source untouched: never delete, rename, rewrite or lock anything in the other tool or the file.
7. Pass no `replace`: a name Secrets already keeps arrives unticked, and the captain ticks it there to replace it.
8. A bring that ends `failed` gives only a fixed explanation and, if the run reported one, its exit code. Never rerun the command in your own shell to see why: read the tool's help or status commands, which print no value, then report the exit code and ask the captain once on a card before bringing again, since the captain may have declined in the tool's own window.

## Where it runs

A bring runs on the computer your task runs on, and the tool must be installed there.
On a computer that runs work, Infinitary runs the tool there and sends its values to Secrets on the first mate's computer once: only the ticked ones for Bring into Secrets, or every value a `lines` source holds for Read it; `uses` is refused there.
When the bring answers `unavailable` saying bringing is offered only on the computer that keeps Secrets, that computer's Infinitary cannot carry it yet: stop, and report to the first mate with `needs_firstmate` that the move must run as a task on the first mate's computer, naming the tool.
When the tool is not installed on your task's computer (its recipe's install check fails), stop and report that, naming the tool and the computer where the captain keeps it.

## Names and places

A secret keeps the name the tool gives it unless the captain asks for another (`as`).
The value used everywhere takes no place; a value that belongs to one project takes that project's name as its place.
List Infinitary's projects and their folders with the `tasks` tool (`projects: true`).

## Waiting and the result

A bring answers `waiting` at once while its card waits for the captain: end your turn.
Its result reaches your inbox once: each secret's name, place and outcome (kept with its reference and version, skipped, not-found, empty, too-large, not-text, changed), or that nothing was brought.
`infinitary-secrets-axi status <id>` reads it again, and `cancel <id>` withdraws a waiting bring.
Your report lists the names kept, with their places and references, the names skipped or not found and why, and says the source was left as it was.

## Each tool

Read only the file for the tool you are moving from, beside this one:

- Automic Vault: `automic-vault.md`.
- A `.env` file: `dotenv.md`.
- The macOS Keychain: `keychain.md`.

Another tool fits a bring when its own documented command prints one value (`reads: value`), starts a program with the secrets in its environment (`reads: env0` with `/usr/bin/env -0` as that program), writes `NAME=value` lines (`reads: lines`), or hands over a JSON object with named text fields (`reads: json`).
Use it only from that tool's official documents, and say in your report that no recipe here covers it and it was tried for the first time.

### Named JSON fields and unlock keys

Use `reads: "json"` only for one top-level object. Name exact, case-sensitive fields in `secrets`; you may rename them with `as`. Do not inspect an export to discover fields: use the tool's official documentation or names the captain supplied. Nested paths, arrays and non-string values are not imported.

If a trusted tool's documented command needs an unlock key and can read it from a named environment variable, list just the reference from Secrets. Add `"uses":{"VAULT_SESSION":"vault-session"}` to the `--from` object, substituting the documented variable and the actual kept reference. Never put the value in `--from`, arguments, a file, a shell wrapper or the reason. If the key is not kept, ask the captain to keep it through `infinitary-secrets-axi ask`; never request a value in chat or run an unlock command that prints the key. Use the tool’s installed executable directly, with no file arguments, list exactly what to keep, and explain why the key is needed. The card names the key and the receiving program; the captain confirms the handover separately in the system prompt. Do not retry without asking. No additional tool recipe has been verified for these two options.
