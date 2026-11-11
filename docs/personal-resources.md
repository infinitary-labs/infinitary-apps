# Personal instructions and skills

Settings → Intelligence's Global instructions and skills switch is off by default.
The `personal-resources` action also lets the first mate change it when asked, through the shared catalog and its normal permission checks.
The home persists it under `personal-resources` in SettingsStore and applies it when the supervisor opens a new crewmate session, including a reopened task.
A running session keeps the choice it opened with; turning the switch off takes effect on the next session.
The first mate and one-shot model calls do not read personal resources.

## Each Mac's own files

The shared reader `src/core/session/personalResources.ts` runs inside each backend on the Mac that holds the session, under the home folder of that macOS user.
The first readable instruction file wins: `~/AGENTS.md`, `~/.claude/CLAUDE.md`, then `~/.codex/AGENTS.md`.
An absent, unreadable, non-file or oversized candidate falls through to the next.
The maximum is 128 KiB per instruction file or SKILL.md.
The reader lists at most 256 skills directly beneath `~/.agents/skills`, then `~/.claude/skills`; the first folder holding a name wins.
Project skill names take precedence over personal names, including in the personal workspace.
The `infinitary-axi` skill, which `infinitary-axi setup` writes for the person's own agents, is never listed: that command reads Infinitary as the person, never as the crew (`docs/axi-commands.md`).
Links are supported, so a user's files managed elsewhere remain usable.
The reader never writes to the home files or reads settings, MCP configuration, hooks, other agent folders or automatic notes.
No instruction or skill file is transported: the placed open order carries only the optional `personalResources` boolean.
Personal instructions enter model prompts and session records like project instructions; existing placed-session record copies still return to the home.
A Mac with no files serves no personal file or skills.

## Ranking

The personal file is framed as `personal_instructions` with its local path.
Crew rules win on delivery, scope, safety, credentials, tools, approvals and unrelated work.
The project's or personal workspace's own instructions win over crew rules on how tests are written and run.
Personal instructions win on style and judgment otherwise.
The project's or personal workspace's own instructions and skills take precedence over personal resources.
A personal skill does not authorize a different sign-in route, MCP or hooks.
The backend serves this ranking even when skills exist without an instruction file.

## Serving and recording

Pi receives the explicit personal file and user skills through its hand-built loader, beside project resources.
The loader still has no extensions and never enables MCP discovery.
Claude appends the explicit file after project instructions and stages skill folder links in `personal-skills` in the session's own staging folder beside its record, under `personal:<skill>`.
Only the app-owned staging folder is rebuilt; user files remain untouched.
Claude settings sources stay empty, strict MCP stays on, and hooks are disabled when either skills plugin is served.

Pi records a `personal-resources` custom entry in its session record when it opens.
Claude adds `personalResources` to its served sidecar stamp after a prompt is acknowledged.
Both carry a SHA-256 of the instruction text and a digest of the selected skill names, paths and SKILL.md text hashes.
The skill digest describes the index read at attachment, not a copy or a snapshot of supporting files a skill may read later.
Claude stages the files again at each attachment.
A reopened Claude session whose personal digests or opt-in changed starts a fresh conversation through the existing renewal seam, preserving its previous record, because the client otherwise restores its old opening prompt.
Its first prompt says why and points the crewmate at its task's record and earlier transcript, as every renewed crewmate's does (`docs/claude-client.md`).

## Checks

`personalResources.test.ts` covers discovery order, missing files, links, size caps, project name precedence and digest changes in disposable homes.
The Pi coding resource tests and Claude boxed-client integration tests inspect actual provider requests and skill loading, with personal hooks, environment and MCP kept out.
`tests/e2e/personal-resources.spec.ts` turns on the switch by keyboard, checks a crewmate's served prompt and verifies the saved choice across a restart.
Placed-session tests hold the flag's production sender and receiver to the same contract.
