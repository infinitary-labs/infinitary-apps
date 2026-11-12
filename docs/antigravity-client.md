# The Antigravity client

Infinitary runs crewmates on a person's Google AI plan through the Antigravity program they installed (`agy`), in its mode for other apps, `agy acp`.
The captain granted this exception to the rule that every supported subscription runs through Pi (`docs/principles.md`); Claude is the other exception (`docs/claude-client.md`).
Every Antigravity touchpoint stays behind `src/core/antigravity/`.

## What it may and may not do

The program holds the person's Google sign-in, and only the program uses it.
Infinitary never reads the program's saved sign-in, never calls Google itself, never names itself as another client, never switches the program's sign-in, and never touches its AI credits setting.
It names itself `infinitary` in the protocol's `initialize`.
It offers Gemini models only: a session moves off a non-Gemini default to a Gemini model the sign-in offers, and refuses a non-Gemini model asked for by name.
A program that lists no models keeps its own model only when that one is Gemini.
When the program moves a conversation to another model on its own, the session asks for its Gemini model back.
When the program refuses, the session ends a running turn with the Gemini-only words and stops the program, so the next prompt starts it again and chooses a Gemini model or refuses.
Tests use scripted stand-ins for the program (`tests/helpers/agyStandIn.ts` for `agy acp`, `tests/helpers/agyCommandStandIn.ts` for its sign-in and usage report), never a real Google sign-in.

## Finding and starting the program

The app ships and downloads no program.
`resolveAgyExecutable` looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, then the search path of the host's environment, and never runs a path inside the app's own archive.
The program's documentation does not name where its installer puts `agy`, so those folders are the usual install homes, not a documented promise.
A session starts `agy acp` in the task's working copy with the task's shell environment (`withTaskShell`).
The program must be 1.5.1 or later, the release that fixed cancel and resume after 1.5.0 added `agy acp`, and must reach MCP servers over HTTP.
The installed program (1.5.6) names no MCP capability in its `initialize` answer, yet lists an HTTP tool server's tools before it answers `session/new`; so a program that says it serves HTTP is trusted, and any other must list the tools when the conversation opens (`AcpToolServer.takeListed`).
A missing program, an older one, one that says it has no MCP over HTTP or never lists the app's tools, and a signed-out one (the protocol's `auth_required`) each refuse the session with plain words (`ANTIGRAVITY_WORDS`).

## The protocol

The Agent Client Protocol is JSON-RPC 2.0, one message per line on the program's stdin and stdout (`acpConnection.ts`).
A session opens with `session/new`, or reopens its recorded conversation with `session/resume` (or `session/load` on a program that offers only that), and chooses its model and thinking level with `session/set_config_option`.
A recorded conversation the program cannot reopen starts a new one; the session then names the new conversation, and the crew carries it as a conversation that could not be reopened: a note on the task's record, and the restart notice with the brief on its first prompt (`CrewSessions.openCrewmate`).
A turn is one `session/prompt`; the program streams `session/update` notifications for words, thinking and tool calls, and answers the prompt with its stop reason and usage.
Every permission question the program asks is answered with its allow-once option, as a Claude crewmate runs with its permissions skipped.
Allow-always is taken only when the program offers no allow-once, since a remembered grant could leave rules in the person's Antigravity settings or the working copy.
A stop is `session/cancel`; a program that does not end the turn within ten seconds is stopped, and its exit ends the turn.

## The app's tools

The app's tools reach the program as an MCP server on this computer's loopback (`acpToolServer.ts`), named `infinitary`, with the same names, descriptions and schemas Pi and Claude serve.
Each session's server has its own 256-bit key, handed to the program only inside `session/new`, never on a command line.
A request without the key, one naming another host, or one carrying an origin is refused before it is read, the task channel's rules (`docs/axi-commands.md`).
Each call is checked against its tool's schema before it runs.

## Instructions

The protocol has no field for a system prompt, so the crewmate's instructions arrive at the head of its conversation's first prompt, and again at the head of the next prompt after they change.
The same session's conversation, reopened after the program stops, holds what it was sent already.
A new session that reopens a recorded conversation, as after an app restart, serves them again, since the earlier session's instructions and staged skill folders may be gone.
The instructions carry the working copy's own instruction file (`AGENTS.md`, else `CLAUDE.md`) and its project skills, read through `src/core/session/projectResources.ts` as Pi and Claude read them.
With the personal opt-in on, the instructions also carry the person's own instructions and skills, read through `src/core/session/personalResources.ts` as Pi and Claude read them.
Even then, the crewmate is told not to use the tools of MCP servers the program loads from the person's own Antigravity folder (`ANTIGRAVITY_PERSONAL_MCP`), since Pi and Claude never offer personal MCP servers either.
With it off, nothing the program documents for `agy acp` stops it loading the rules, skills, hooks and MCP servers in the person's own Antigravity folder (`~/.gemini`): its custom agent settings that leave them out (`inheritCustomizations`) apply only to an agent file in a folder it scans, and hooks load regardless.
The app writes nothing into that folder or the working copy, and moving the program's home would move its sign-in, so the crewmate is instead told to leave those rules, skills and servers alone (`ANTIGRAVITY_PERSONAL_OFF`); that is an instruction, not a block.
Runbook skills are written beside the record and listed in the instructions with where each one's `SKILL.md` is, after the project and personal skills, leaving out any a skill before them names.

## The record

The app keeps its own record of each conversation in the Pi session dialect (`antigravityRecord.ts`), so every reader of a rolling session reads it through `src/core/storage/sessionReader.ts` with nothing of its own.
It never reads the program's own conversation store.
The task keeps the conversation's id as its resume token, `antigravity:<id>`, so a Claude conversation's id never reopens as an Antigravity one.
The record file is named by the id without its prefix, `<id>.jsonl` in the task's sessions folder, and the task names that file (`recordNameOf`, `src/core/session/session.ts`).

## What it can deliver

`ANTIGRAVITY_CONTROL_PROFILE` says what the session honestly delivers.
A steer waits for the next turn, since steering a running turn is not proven on the program.
The only typed failure is the `refusal` stop, read as a spent plan; every other failure is prose.
Background work runs inside the program, out of the host's sight.

## Signing in

Antigravity is a crew-only provider in the catalog (`google-antigravity`, `src/shared/providers.ts`), backed by `AntigravityAuthBackend` (`antigravityAuth.ts`).
Its chip is off, with "install Antigravity first", on a computer without the program.
Pressing it shows Google's terms before anything starts, in the catalog entry's own words (`signInWarning`, `ANTIGRAVITY_SIGN_IN_WORDS` in `src/shared/antigravity.ts`): five sentences, links to Google's terms and to Google's forum reply, and "Sign in with Google" beside "Not now" (design skill `components/core/ConnectChips`).
Only "Sign in with Google" runs the program's own sign-in, `agy acp --login`.
The program opens no browser: it prints Google's sign-in link and waits on its stdin for the code Google's page shows after the person signs in.
The app opens that link in the browser, also shows it in the sign-in's aside, and asks for the code in one prompt, which it writes to the program's stdin; the program's exit says whether it signed in.
Stopping the sign-in stops the program.
The program keeps one sign-in for the whole user, so the vault keeps one Antigravity account at most and runs one sign-in at a time (`MACHINE_LOGINS`, `src/core/pi/accountVault.ts`), as it does for Claude.
Removing the account never signs the program out.
Nothing asks Google whether the sign-in still holds: a session that meets the protocol's sign-in error records the typed `signed_out` cut-off, which withholds the account until its row's Sign in runs the program's sign-in again (`docs/quota.md`, "Typed cut-offs").

## The model list

An Antigravity account serves the shipped Gemini list (`ANTIGRAVITY_MODELS`, `antigravityModels.ts`) until one of its sessions has opened a conversation.
Each session hands over the models the program offered that sign-in when its conversation opened, and `AntigravityOffers` keeps the Gemini ones as the account's list, read by the served-models catalog (`docs/model-lists.md`).
Nothing starts the program just to ask for its models.

## The allowance

The program's print-mode usage report, `agy -p /usage --output-format json --print-timeout 20s`, answers without starting a turn, spending any of the plan or leaving a conversation behind (`antigravityUsage.ts`).
It runs only on the person's press: opening Settings → Intelligence (`inf:quota:opened`), pressing Recheck allowance (the first mate's recheck) or finishing a sign-in, which asks for the same recheck; never on a timer and never while the account is signed out, since a signed-out program opens a browser to sign in.
It runs with the program's automatic update off (`AGY_CLI_DISABLE_AUTO_UPDATE`) and its account line hidden (`AGY_CLI_HIDE_ACCOUNT_INFO`).
Its JSON names each model group (`command.data.groups`) with its limits (`buckets`), each a `window` ("weekly"), a `remaining_fraction` and a `reset_time`.
The Gemini group's weekly limit becomes the account's `seven_day` window in the pushed quota store (`usageReport.ts`, `docs/quota.md`), shown with its age like any pushed reading; the other group (Claude and GPT models) and a limit of any other length are left out, and with no reading the row says nothing was read rather than drawing a meter.
`agy acp` lists no usage command for other apps, so a running session is never asked.
A spent plan stops work through the typed `refusal` stop, above.

## What is not here yet

Antigravity runs crewmates only: the first mate's seat and the one-shot roles are refused, and a computer that runs work for another neither signs in to Antigravity nor runs an Antigravity conversation.
