# Personal instructions and skills

Settings → Intelligence's Global instructions and skills switch is off by default.
The `personal-resources` action also lets the first mate change it when asked, through the shared catalog and its normal permission checks.
The home persists it under `personal-resources` in SettingsStore and applies it when the supervisor opens a new crewmate session, including a reopened task.
A running session keeps the choice it opened with; turning the switch off takes effect on the next session.
The first mate and one-shot model calls do not read personal resources.

## The home's files

The shared reader `src/core/session/personalResources.ts` runs inside each backend on the computer that holds the session.
On the home it reads the home folder of that macOS user; on a computer that runs work it reads the home's set kept there (below), never that computer's own home folder.
The first readable instruction file wins: `~/AGENTS.md`, `~/.claude/CLAUDE.md`, then `~/.codex/AGENTS.md`.
An absent, unreadable, non-file or oversized candidate falls through to the next.
The maximum is 128 KiB per instruction file or SKILL.md.
The reader lists at most 256 skills directly beneath `~/.agents/skills`, then `~/.claude/skills`; the first folder holding a name wins.
Project skill names take precedence over personal names, including in the personal workspace.
The `infinitary-axi` skill, which `infinitary-axi setup` writes for the person's own agents, is never listed: that command reads Infinitary as the person, never as the crew (`docs/axi-commands.md`).
Links are supported, so a user's files managed elsewhere remain usable.
The reader never writes to the home files or reads settings, MCP configuration, hooks, other agent folders or automatic notes, except which Claude Code plugins are on (below).
The placed open order carries only the optional `personalResources` boolean; the files themselves travel once per version, never with a task (below).
Personal instructions enter model prompts and session records like project instructions; existing placed-session record copies still return to the home.
A home with no files serves no personal file or skills.

## Claude Code plugins

The reader also serves the skills of the Claude Code plugins the person turned on (`src/core/claude/claudePlugins.ts`).
Which plugins are on is Claude Code's `enabledPlugins` setting, read through the client library's own settings reader with only the person's settings file asked for, the organization's tier over it; a plugin set false is off, and an installed plugin with no entry follows its manifest's `defaultEnabled`, on unless it says false.
Only that key and the organization's marketplace rules are kept; hooks, MCP, environment and every other key stay unread.
The setting is read again before every version of the set is taken, so each crewmate conversation and each send uses it; when a read fails the last read stands, and before any read answers no plugin is on.
Where each plugin is comes from Claude Code's `~/.claude/plugins/installed_plugins.json` (version 2), its user-scope `installPath`, so an update Claude Code installs in a new folder is read from there at once; plugins a project enables stay out.
A plugin folder the person saved under `~/.claude/skills` (one holding `.claude-plugin/plugin.json` and no SKILL.md of its own) counts as the plugin `<name>@skills-dir`, unless the organization's `strictKnownMarketplaces` (or `allowedMarketplaces`) leaves out a `skills-dir` entry or its `blockedMarketplaces` names one.
A plugin's skills are the folders in its `skills/`, the manifest's own `skills` paths inside the plugin, or a SKILL.md at its top.
Plugins are taken in id order, after the person's own skill folders: a name the project, the person's folders or an earlier plugin holds wins over a plugin's skill, on every provider.
A plugin's own files travel and are served with its skills: every top-level entry but `.claude-plugin`, `commands`, `agents`, `hooks`, `.mcp.json`, `.lsp.json`, `output-styles`, `workflows`, `themes`, `monitors`, `bin`, `settings.json`, `.git` and `node_modules`; its manifest travels alone, for its name and skill paths.
No hook, MCP server, agent, command, language server, program, monitor, output style, workflow or theme of a plugin reaches a crewmate.
The skill digest adds each plugin's id, skill names and SKILL.md text hashes, never its versioned folder, so an update that leaves a skill's text alone renews no reopened Claude conversation; with no plugin it is the digest it was before.

## One set, kept on each computer

The home reads its own files as one set (`src/core/session/personalSet.ts`): the instruction file the reader picks and every file of each skill it lists, by their paths under the home folder, skipping a skill's own `.git` folder.
Each turned-on plugin's files that travel follow, under `.claude/plugins/<plugin id>/` laid out as inside the plugin, whatever version the home has, so an update is a new version of the set under the same paths and nothing is linked by hand.
Its version is a fingerprint, the SHA-256 of each file's path, contents hash and executable bit in path order, so the same files give the same version on any computer.
A set travels whole in one order, so it is held to half a connection frame; a skill or plugin that would take it past that stays out whole and is named in the home's log once each time that changes.
Plugins are listed after every skill folder, so a large plugin never crowds out the person's own skills.
The budget is counted from each file's size as it is listed, so a skill too large to send (one holding its own packages, say) is never read.
`HomePersonalSet` lists the set again whenever it is asked and keeps the newest version, with since when the home has had it, in SettingsStore under `personal-version`.
It reads a file again only when its listing changed (its size, times, mode or inode), keeping each file's hash otherwise, and reads the whole set only when it sends one.

`PersonalSync` (`src/core/placed/personalSync.ts`) keeps each computer that runs work on the home's version, while the switch is on, through the `inf:session:personal` order.
Each computer's roster says which version it keeps; the home sends its set only when that is not the version it has now, one send at a time per computer.
It sends at each contact, before a placed open that reads personal resources, when the switch turns on, and when a read of the set finds a new version.
Both sides speak the `personal-sync` contract change (`src/shared/contract-changes/personal-sync.md`): a home sends only to a computer that lists it, and a computer reads the kept set only for a home that lists it, reading its own home folder for an older home as before.
Plugin files go only to a computer that lists the `personal-plugins` change (`src/shared/contract-changes/personal-plugins.md`); a computer without it is sent the set without them, under that set's own version, and is sent nothing more while neither changes.

On the computer, `PersonalCopy` (`src/core/helper/personalCopy.ts`) is the one writer over `personal/` in its work folder (`docs/helper.md`).
It accepts only the three instruction files, files inside a skill folder and files inside a plugin's folder under `.claude/plugins/<plugin id>/`, writes the set into a fresh folder, keeps it only when what it wrote has the fingerprint the home named, then points `current` at it with one rename and removes every other version.
The reader reads `current` in place of the home folder, its plugins from the set's plugin folder alone and never that computer's own Claude settings, so a computer out of reach keeps the version it last received, and one that has received none serves no personal file or skills.
A conversation already open keeps what it opened with; the next one reads the newest kept version.

When a crewmate's conversation opens with the switch on, the supervisor writes which version it read, and on which computer, to the task's timeline (`personal` in the note's data): another computer by its name, or `home` for the computer where the first mate lives.
The Info tab names the newest of those as Global instructions and skills: the version's first twelve characters, since when the home has had it, and the computer, `home` worded as this computer in the window's language, or by the home's name in a view of it.
A timeline's fold keeps the newest such version on its `compacted` row, so a long task still names it.

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
Plugin skills follow the person's own skills by their bare names, and the appended personal section names each plugin's folder as its skills' `${CLAUDE_PLUGIN_ROOT}` and a skill's own folder as `${CLAUDE_SKILL_DIR}`.
The loader still has no extensions and never enables MCP discovery.
Claude appends the explicit file after project instructions and stages skill folder links in `personal-skills` in the session's own staging folder beside its record, under `personal:<skill>`.
It stages each plugin in `plugin-skills/<plugin id>` as a local plugin under the plugin's own name, listed as `<plugin>:<skill>`: a manifest the app writes, links to its skill folders, and links to (or for a file, a copy of) its other own entries, so `${CLAUDE_PLUGIN_ROOT}` reaches them; a plugin named `project`, `personal` or `runbooks`, or a name another staged plugin took, stays out and is named in the session's log.
Only the app-owned staging folder is rebuilt; user files remain untouched.
Claude settings sources stay empty, strict MCP stays on, and hooks are disabled whenever any skills plugin is served.

Pi records a `personal-resources` custom entry in its session record when it opens.
Claude adds `personalResources` to its served sidecar stamp after a prompt is acknowledged.
Both carry a SHA-256 of the instruction text and a digest of the selected skill names, paths and SKILL.md text hashes.
The skill digest describes the index read at attachment, not a copy or a snapshot of supporting files a skill may read later.
Claude stages the files again at each attachment.
A reopened Claude session whose personal digests or opt-in changed starts a fresh conversation through the existing renewal seam, preserving its previous record, because the client otherwise restores its old opening prompt.
Its first prompt says why and points the crewmate at its task's record and earlier transcript, as every renewed crewmate's does (`docs/claude-client.md`).

## Checks

`personalResources.test.ts` covers discovery order, missing files, links, size caps, project name precedence and digest changes in disposable homes.
It also covers plugins in disposable homes with a version 2 install record and a stand-in settings reader: on, off, unset with each default, blocked by the organization, an update's new folder with an unchanged digest, a plugin folder under `~/.claude/skills` and name precedence (`tests/helpers/claudePluginHome.ts` lays a plugin out as claude-security is).
The Pi coding resource tests and Claude boxed-client integration tests inspect actual provider requests and skill loading, with personal hooks, environment and MCP kept out.
They also serve a turned-on plugin read through the real settings reader: Pi lists its skill by its bare name with its folder named, and the boxed Claude client lists `<plugin>:<skill>`, loads it with `${CLAUDE_PLUGIN_ROOT}` naming a script that exists, and runs none of the plugin's hooks or MCP servers.
`tests/e2e/personal-resources.spec.ts` turns on the switch by keyboard, checks a crewmate's served prompt and verifies the saved choice across a restart.
Placed-session tests hold the flag's production sender and receiver to the same contract.
`personalCopy.test.ts` covers keeping, replacing and refusing a set on a computer, and a plugin's files kept under its id with its other parts left out and one fingerprint on both sides.
`personalSync.test.ts` checks a computer without `personal-plugins` is sent the set without plugin files, once.
`sessionHostPersonal.test.ts` sends the home's set through the real connection and helper, edits it on the home, and checks one fingerprint on both computers and a crewmate's served prompt with the computer's own files unread.
`placedPersonal.test.ts` also carries a plugin's skill to the computer's crewmate from the kept set and a plugin update in one send.
`placedPersonal.test.ts` drives the home's own triggers - its contact with the computer, conversations opening there and an edit on the home - and checks one send per version, never one per task, and the crewmate's served prompt.
`crewSessions.test.ts`, `taskProtocol.detail.test.ts` and `record.frame.test.ts` cover the version a task read, from the note to the Info tab.
`cleanUp.test.ts` checks a removal takes the kept set with the rest.
